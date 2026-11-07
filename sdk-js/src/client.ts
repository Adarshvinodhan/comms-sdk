import { io, type Socket } from 'socket.io-client';
import { CommsApiError, parseResponse } from './errors.js';
import {
  MAX_ATTACHMENT_BYTES,
  type Attachment,
  type Call,
  type CallJoin,
  type CallType,
  type CommsEventName,
  type CommsEvents,
  type CommsSession,
  type CommsUser,
  type Conversation,
  type Message,
  type Page,
  type ReactionEvent,
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

/** A text message, or a file message that points at uploads from `uploadAttachment`. */
export interface SendMessageOptions {
  body?: string;
  attachmentIds?: string[];
  /** Idempotency key. Generated when omitted. */
  clientMsgId?: string;
}

export interface UploadAttachmentOptions {
  /** Mark an audio file as a voice note. */
  voice?: boolean;
  /** Playback length in milliseconds, for audio and video. */
  durationMs?: number;
  /** Used when `file` is a Blob without a name. */
  fileName?: string;
  /** Bytes uploaded so far and the total, while the request is in flight. */
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
}

type Ack<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
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

  private async requestBlob(path: string, signal?: AbortSignal, retried = false): Promise<Blob> {
    const session = this.currentSession;
    const res = await fetch(`${session.apiUrl}${path}`, {
      headers: { authorization: `Bearer ${session.chatToken}` },
      signal,
    });
    if (res.status === 401 && !retried) {
      await this.refreshSession();
      return this.requestBlob(path, signal, true);
    }
    if (!res.ok) await parseResponse(res);
    return res.blob();
  }

  private postForm<T>(path: string, form: FormData, opts: UploadAttachmentOptions = {}, retried = false): Promise<T> {
    if (opts.signal?.aborted) return Promise.reject(new DOMException('Upload aborted', 'AbortError'));
    const session = this.currentSession;
    return new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${session.apiUrl}${path}`);
      xhr.setRequestHeader('authorization', `Bearer ${session.chatToken}`);
      xhr.responseType = 'text';
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) opts.onProgress?.(event.loaded, event.total);
      };
      const onAbort = () => xhr.abort();
      opts.signal?.addEventListener('abort', onAbort);
      const finish = () => opts.signal?.removeEventListener('abort', onAbort);
      xhr.onload = () => {
        finish();
        if (xhr.status === 401 && !retried) {
          this.refreshSession().then(() => this.postForm<T>(path, form, opts, true)).then(resolve, reject);
          return;
        }
        const res = new Response(xhr.responseText, { status: xhr.status || 500, statusText: xhr.statusText });
        parseResponse<T>(res).then(resolve, reject);
      };
      xhr.onerror = () => {
        finish();
        reject(new CommsApiError(0, 'NETWORK', 'Upload failed'));
      };
      xhr.onabort = () => {
        finish();
        reject(new DOMException('Upload aborted', 'AbortError'));
      };
      xhr.send(form);
    });
  }

  /** Emits over the socket and falls back to `viaRest` when disconnected or unacknowledged. `viaRest` must be safe to repeat. */
  private emitOrRest<T>(event: string, payload: unknown, viaRest: () => Promise<T>): Promise<T> {
    const socket = this.socket;
    if (!socket?.connected) return viaRest();
    return new Promise<T>((resolve, reject) => {
      socket.timeout(this.options.sendTimeoutMs ?? 5000).emit(event, payload, (err: Error | null, res: Ack<T>) => {
        if (!err && res?.ok) return resolve(res.data);
        if (!err && res && !res.ok) return reject(Object.assign(new Error(res.error.message), { code: res.error.code }));
        viaRest().then(resolve, reject);
      });
    });
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
   *
   * Pass a string to send text, or `{ attachmentIds, body? }` to send files already uploaded
   * with `uploadAttachment`. The caption is optional.
   */
  sendMessage(conversationId: string, body: string, clientMsgId?: string): Promise<Message>;
  sendMessage(conversationId: string, options: SendMessageOptions): Promise<Message>;
  sendMessage(
    conversationId: string,
    bodyOrOptions: string | SendMessageOptions,
    clientMsgId: string = crypto.randomUUID(),
  ): Promise<Message> {
    const options: SendMessageOptions =
      typeof bodyOrOptions === 'string'
        ? { body: bodyOrOptions, clientMsgId }
        : { ...bodyOrOptions, clientMsgId: bodyOrOptions.clientMsgId ?? crypto.randomUUID() };
    const id = options.clientMsgId ?? clientMsgId;
    const body = typeof bodyOrOptions === 'string' ? { body: bodyOrOptions } : options.body ? { body: options.body } : {};
    const files = options.attachmentIds?.length ? { attachmentIds: options.attachmentIds } : {};
    if (!('body' in body) && !('attachmentIds' in files)) {
      return Promise.reject(new CommsApiError(400, 'VALIDATION_ERROR', 'Message needs text or an attachment'));
    }
    const payload = { ...body, ...files, clientMsgId: id };
    return this.emitOrRest<Message>('message.send', { conversationId, ...payload }, () =>
      this.request('POST', `/v1/conversations/${conversationId}/messages`, payload),
    );
  }

  /**
   * Uploads one file (max 50 MB) into a conversation. Send it by passing the returned id to `sendMessage`.
   * Uploads always use HTTP; the socket only carries the id.
   */
  uploadAttachment(conversationId: string, file: Blob, options: UploadAttachmentOptions = {}): Promise<Attachment> {
    if (file.size <= 0) return Promise.reject(new CommsApiError(400, 'VALIDATION_ERROR', 'File is empty'));
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return Promise.reject(new CommsApiError(400, 'VALIDATION_ERROR', 'File exceeds the 50 MB limit'));
    }
    const fileName = options.fileName ?? (file instanceof File && file.name ? file.name : 'file');
    const form = new FormData();
    if (options.voice) form.append('voice', 'true');
    if (options.durationMs != null) form.append('durationMs', String(Math.round(options.durationMs)));
    form.append('file', file, fileName);
    return this.postForm<Attachment>(`/v1/conversations/${conversationId}/attachments`, form, options);
  }

  /** Downloads an attachment. The blob's type is the file's mime type. */
  fetchAttachment(attachmentId: string, signal?: AbortSignal): Promise<Blob> {
    return this.requestBlob(`/v1/attachments/${attachmentId}`, signal);
  }

  /** Deletes an upload that was never sent. */
  discardAttachment(attachmentId: string): Promise<{ id: string; deleted: boolean }> {
    return this.request('DELETE', `/v1/attachments/${attachmentId}`);
  }

  editMessage(messageId: string, body: string): Promise<Message> {
    return this.request('PATCH', `/v1/messages/${messageId}`, { body });
  }

  deleteMessage(messageId: string): Promise<Message> {
    return this.request('DELETE', `/v1/messages/${messageId}`);
  }

  /**
   * Sets your reaction to `emoji` (replacing any previous one), or removes it with `null`.
   * Idempotent, so it sends over the socket and falls back to REST like `sendMessage`.
   */
  react(messageId: string, emoji: string | null): Promise<ReactionEvent> {
    const path = `/v1/messages/${messageId}/reaction`;
    return this.emitOrRest<ReactionEvent>('message.react', { messageId, emoji }, () =>
      emoji === null ? this.request('DELETE', path) : this.request('PUT', path, { emoji }),
    );
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
