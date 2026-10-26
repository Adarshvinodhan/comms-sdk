import { io, type Socket } from 'socket.io-client';
import { parseResponse } from './errors.js';
import type {
  Call,
  CallJoin,
  CallType,
  CommsEventName,
  CommsEvents,
  CommsSession,
  CommsUser,
  Conversation,
  Message,
  Page,
} from './types.js';

export interface CommsClientOptions {
  /**
   * Fetches a fresh session from the app's own backend (which calls `POST /v1/sessions`
   * on the comms service with its tenant API key). Called on start and whenever the chat token expires.
   */
  getSession: () => Promise<CommsSession>;
  /** Skip the first `getSession()` call when the app already has a session. */
  initialSession?: CommsSession;
  /** How long to wait for a socket acknowledgement before falling back to REST. Default 5000 ms. */
  sendTimeoutMs?: number;
}

type Ack = { ok: true; data: Message } | { ok: false; error: { code: string; message: string } };
type Listener<E extends CommsEventName> = (payload: CommsEvents[E]) => void;

const REFRESH_MARGIN_MS = 60_000;
const TYPING_THROTTLE_MS = 2000;

export class CommsClient {
  private session: CommsSession | null;
  private socket: Socket | null = null;
  private refreshInflight: Promise<CommsSession> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionListeners = new Set<(connected: boolean) => void>();
  private sessionListeners = new Set<(session: CommsSession) => void>();
  private lastTypingSent = new Map<string, number>();
  private listeners = new Set<{ event: string; fn: (payload: unknown) => void }>();

  constructor(private readonly options: CommsClientOptions) {
    this.session = options.initialSession ?? null;
  }

  // ───────────────────────── Session ─────────────────────────

  /** Current session; throws if `start()` has not resolved yet. */
  get currentSession(): CommsSession {
    if (!this.session) throw new Error('CommsClient not started: call start() first');
    return this.session;
  }

  get me(): CommsUser {
    return this.currentSession.user;
  }

  get connected(): boolean {
    return this.socket?.connected ?? false;
  }

  /** Loads a session if needed and opens the realtime connection. */
  async start(): Promise<CommsSession> {
    if (!this.session) await this.refreshSession();
    this.scheduleRefresh();
    this.connectSocket();
    return this.currentSession;
  }

  /** Closes the realtime connection and stops token renewal. */
  stop(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.listeners.clear();
    this.socket = null;
    this.connectionListeners.forEach((l) => l(false));
  }

  /** Fetches a new chat token via the app backend. Concurrent calls share one request. */
  refreshSession(): Promise<CommsSession> {
    this.refreshInflight ??= this.options
      .getSession()
      .then((s) => {
        this.session = s;
        this.scheduleRefresh();
        this.sessionListeners.forEach((l) => l(s));
        return s;
      })
      .finally(() => {
        this.refreshInflight = null;
      });
    return this.refreshInflight;
  }

  onConnectionChange(listener: (connected: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  onSessionChange(listener: (session: CommsSession) => void): () => void {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  private scheduleRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (!this.session) return;
    const ms = new Date(this.session.expiresAt).getTime() - Date.now() - REFRESH_MARGIN_MS;
    this.refreshTimer = setTimeout(() => void this.refreshSession().catch(() => {}), Math.max(ms, 10_000));
  }

  // ───────────────────────── Realtime ─────────────────────────

  private connectSocket() {
    if (this.socket) return;
    const socket = io(this.currentSession.wsUrl, {
      autoConnect: false,
      auth: (cb) => cb({ token: this.session?.chatToken }),
    });
    socket.on('connect', () => this.connectionListeners.forEach((l) => l(true)));
    socket.on('disconnect', () => this.connectionListeners.forEach((l) => l(false)));
    socket.on('connect_error', async (err) => {
      this.connectionListeners.forEach((l) => l(false));
      if (err.message === 'UNAUTHORIZED') {
        await this.refreshSession().catch(() => {});
        setTimeout(() => socket.connect(), 500);
      }
    });
    for (const { event, fn } of this.listeners) socket.on(event, fn);
    this.socket = socket;
    socket.connect();
  }

  /** Subscribe to a realtime event (works before `start()` too). Returns an unsubscribe function. */
  on<E extends CommsEventName>(event: E, listener: Listener<E>): () => void {
    const entry = { event: event as string, fn: listener as (payload: unknown) => void };
    this.listeners.add(entry);
    this.socket?.on(entry.event, entry.fn);
    return () => {
      this.listeners.delete(entry);
      this.socket?.off(entry.event, entry.fn);
    };
  }

  // ───────────────────────── HTTP ─────────────────────────

  private async request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const session = this.currentSession;
    const res = await fetch(`${session.apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${session.chatToken}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !retried) {
      await this.refreshSession();
      return this.request<T>(method, path, body, true);
    }
    return parseResponse<T>(res);
  }

  // ───────────────────────── Conversations & messages ─────────────────────────

  async inbox(): Promise<Conversation[]> {
    return (await this.request<{ conversations: Conversation[] }>('GET', '/v1/conversations')).conversations;
  }

  conversation(conversationId: string): Promise<Conversation> {
    return this.request('GET', `/v1/conversations/${conversationId}`);
  }

  /** Newest first. Pass the returned `nextCursor` as `before` to load older messages. */
  async messages(conversationId: string, opts: { before?: string; limit?: number } = {}): Promise<Page<Message>> {
    const q = new URLSearchParams({ limit: String(opts.limit ?? 30) });
    if (opts.before) q.set('before', opts.before);
    const res = await this.request<{ messages: Message[]; nextCursor: string | null }>(
      'GET',
      `/v1/conversations/${conversationId}/messages?${q}`,
    );
    return { items: res.messages, nextCursor: res.nextCursor };
  }

  /**
   * Sends over the socket and falls back to REST if there is no acknowledgement in time.
   * `clientMsgId` makes the retry safe: the server deduplicates on it.
   */
  sendMessage(conversationId: string, body: string, clientMsgId: string = crypto.randomUUID()): Promise<Message> {
    const viaRest = () =>
      this.request<Message>('POST', `/v1/conversations/${conversationId}/messages`, { body, clientMsgId });
    const socket = this.socket;
    if (!socket?.connected) return viaRest();
    return new Promise<Message>((resolve, reject) => {
      socket
        .timeout(this.options.sendTimeoutMs ?? 5000)
        .emit('message.send', { conversationId, body, clientMsgId }, (err: Error | null, res: Ack) => {
          if (!err && res?.ok) return resolve(res.data);
          if (!err && res && !res.ok) return reject(Object.assign(new Error(res.error.message), { code: res.error.code }));
          viaRest().then(resolve, reject);
        });
    });
  }

  editMessage(messageId: string, body: string): Promise<Message> {
    return this.request('PATCH', `/v1/messages/${messageId}`, { body });
  }

  deleteMessage(messageId: string): Promise<Message> {
    return this.request('DELETE', `/v1/messages/${messageId}`);
  }

  markRead(conversationId: string): Promise<{ conversationId: string; userId: string; lastReadAt: string }> {
    return this.request('POST', `/v1/conversations/${conversationId}/read`, {});
  }

  /** Throttled; safe to call on every keystroke. */
  setTyping(conversationId: string, isTyping: boolean): void {
    const now = Date.now();
    const last = this.lastTypingSent.get(conversationId) ?? 0;
    if (isTyping && now - last < TYPING_THROTTLE_MS) return;
    this.lastTypingSent.set(conversationId, isTyping ? now : 0);
    this.socket?.emit('typing', { conversationId, isTyping });
  }

  // ───────────────────────── Calls ─────────────────────────

  startCall(conversationId: string, type: CallType): Promise<CallJoin> {
    return this.request('POST', `/v1/conversations/${conversationId}/calls`, { type });
  }

  acceptCall(callId: string): Promise<CallJoin> {
    return this.request('POST', `/v1/calls/${callId}/accept`);
  }

  declineCall(callId: string): Promise<Call> {
    return this.request('POST', `/v1/calls/${callId}/decline`);
  }

  cancelCall(callId: string): Promise<Call> {
    return this.request('POST', `/v1/calls/${callId}/cancel`);
  }

  /** Ends a live call for both sides (cancels or declines if it is still ringing). Idempotent. */
  endCall(callId: string): Promise<Call> {
    return this.request('POST', `/v1/calls/${callId}/end`);
  }

  /** Fresh LiveKit token to rejoin a live call, e.g. after a page reload. */
  rejoinCall(callId: string): Promise<CallJoin> {
    return this.request('POST', `/v1/calls/${callId}/token`);
  }

  async liveCall(): Promise<Call | null> {
    return (await this.request<{ call: Call | null }>('GET', '/v1/calls/live')).call;
  }

  call(callId: string): Promise<Call> {
    return this.request('GET', `/v1/calls/${callId}`);
  }

  /** Newest first, across all conversations unless `conversationId` is given. */
  async calls(opts: { conversationId?: string; before?: string; limit?: number } = {}): Promise<Page<Call>> {
    const q = new URLSearchParams({ limit: String(opts.limit ?? 20) });
    if (opts.before) q.set('before', opts.before);
    const path = opts.conversationId ? `/v1/conversations/${opts.conversationId}/calls` : '/v1/calls';
    const res = await this.request<{ calls: Call[]; nextCursor: string | null }>('GET', `${path}?${q}`);
    return { items: res.calls, nextCursor: res.nextCursor };
  }
}
