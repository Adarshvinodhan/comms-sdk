import {
  CALL_FINISHED_EVENTS,
  CommsApiError,
  CommsClient,
  type Call,
  type CallFinishedEvent,
  type CallJoin,
  type CallType,
  type CommsEventName,
  type CommsEvents,
  type CommsSession,
  type CommsUser,
} from '@sminfotech/comms-sdk';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { cx, type CommsStyle } from './util.js';

export interface Notice {
  kind: 'info' | 'error';
  text: string;
}

export type CallPhase = 'incoming' | 'outgoing' | 'in-call' | 'rejoin';

export interface CallState {
  phase: CallPhase;
  call: Call;
  /** Present once this device can join the LiveKit room. */
  join?: CallJoin;
  peerName: string;
}

export interface CallController {
  state: CallState | null;
  /** Bumps whenever a call finishes; use it to refresh call history views. */
  historyVersion: number;
  start: (conversationId: string, type: CallType, peerName: string) => Promise<void>;
  accept: () => Promise<void>;
  decline: () => Promise<void>;
  hangup: () => Promise<void>;
  rejoin: () => Promise<void>;
}

interface CommsContextValue {
  client: CommsClient;
  session: CommsSession;
  me: CommsUser;
  connected: boolean;
  notify: (notice: Notice) => void;
  avatarColor: (user: Pick<CommsUser, 'id' | 'externalUserId' | 'displayName'>) => string | undefined;
  calls: CallController;
}

const CommsContext = createContext<CommsContextValue | null>(null);

const FINISHED_TEXT: Record<CallFinishedEvent, string> = {
  'call.ended': 'Call ended',
  'call.missed': 'Call was not answered',
  'call.declined': 'Call declined',
  'call.cancelled': 'Call cancelled',
  'call.busy': 'User is busy',
};

export interface CommsProviderProps {
  /** Returns a session from your backend (which calls `POST /v1/sessions` with its tenant API key). */
  getSession: () => Promise<CommsSession>;
  /** Use an already fetched session for the first render. */
  initialSession?: CommsSession;
  /** Toasts for call outcomes and errors. */
  onNotice?: (notice: Notice) => void;
  /** Avatar background color per user (defaults to a stable hash color). */
  avatarColor?: (user: Pick<CommsUser, 'id' | 'externalUserId' | 'displayName'>) => string | undefined;
  /** Rendered until the session is loaded and the client has started. */
  fallback?: ReactNode;
  /**
   * Merged onto `.comms-root`. The root is `display: contents`, so this is for
   * theme classes, not layout. Set `--comms-*` here or with `style`.
   */
  className?: string;
  /** Inline theme overrides. Custom properties inherit into the tree. */
  style?: CommsStyle;
  children: ReactNode;
}

const PALETTE = ['#6366f1', '#0ea5e9', '#14b8a6', '#f59e0b', '#ec4899', '#8b5cf6', '#22c55e', '#ef4444'];

function hashColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

export function CommsProvider({
  getSession,
  initialSession,
  onNotice,
  avatarColor,
  fallback = null,
  className,
  style,
  children,
}: CommsProviderProps): ReactElement {
  const getSessionRef = useRef(getSession);
  getSessionRef.current = getSession;
  const onNoticeRef = useRef(onNotice);
  onNoticeRef.current = onNotice;
  const initialRef = useRef(initialSession);

  const [client, setClient] = useState<CommsClient | null>(null);
  const [session, setSession] = useState<CommsSession | null>(initialSession ?? null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const c = new CommsClient({ getSession: () => getSessionRef.current(), initialSession: initialRef.current });
    let cancelled = false;
    const offConn = c.onConnectionChange(setConnected);
    const offSession = c.onSessionChange(setSession);
    c.start()
      .then((s) => {
        if (cancelled) return;
        setSession(s);
        setClient(c);
      })
      .catch((err: Error) => onNoticeRef.current?.({ kind: 'error', text: err.message }));
    return () => {
      cancelled = true;
      offConn();
      offSession();
      c.stop();
      setClient(null);
    };
  }, []);

  const notify = useCallback((n: Notice) => onNoticeRef.current?.(n), []);
  const colorFn = useCallback(
    (u: Pick<CommsUser, 'id' | 'externalUserId' | 'displayName'>) => avatarColor?.(u) ?? hashColor(u.externalUserId || u.id),
    [avatarColor],
  );

  return (
    <div className={cx('comms-root', className)} style={style}>
      {!client || !session ? (
        fallback
      ) : (
        <ReadyProvider client={client} session={session} connected={connected} notify={notify} avatarColor={colorFn}>
          {children}
        </ReadyProvider>
      )}
    </div>
  );
}

function ReadyProvider({
  client,
  session,
  connected,
  notify,
  avatarColor,
  children,
}: Omit<CommsContextValue, 'calls' | 'me'> & { children: ReactNode }) {
  const calls = useCallController(client, session.user, notify);
  const value = useMemo(
    () => ({ client, session, me: session.user, connected, notify, avatarColor, calls }),
    [client, session, connected, notify, avatarColor, calls],
  );
  return <CommsContext.Provider value={value}>{children}</CommsContext.Provider>;
}

function useCallController(client: CommsClient, me: CommsUser, notify: (n: Notice) => void): CallController {
  const [state, setState] = useState<CallState | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const ref = useRef(state);
  ref.current = state;

  useEffect(() => {
    client
      .liveCall()
      .then((live) => {
        if (!live || ref.current) return;
        const peer = live.callerId === me.id ? live.callee : live.caller;
        const peerName = peer?.displayName ?? 'Someone';
        setState(
          live.status === 'RINGING' && live.calleeId === me.id
            ? { phase: 'incoming', call: live, peerName }
            : { phase: 'rejoin', call: live, peerName },
        );
      })
      .catch(() => {});

    const offs = [
      client.on('call.invite', ({ call, caller }) => {
        if (!ref.current) setState({ phase: 'incoming', call, peerName: caller.displayName });
      }),
      client.on('call.accepted', ({ call }) => {
        const cur = ref.current;
        if (!cur || cur.call.id !== call.id) return;
        // Accepted on another device of mine: stop ringing here.
        if (cur.phase === 'incoming') return setState(null);
        setState({ ...cur, call, phase: cur.join ? 'in-call' : cur.phase });
      }),
      client.on('call.active', ({ call }) => {
        const cur = ref.current;
        if (cur && cur.call.id === call.id) setState({ ...cur, call, phase: cur.join ? 'in-call' : cur.phase });
      }),
      ...CALL_FINISHED_EVENTS.map((evt) =>
        client.on(evt, ({ call }: CommsEvents[typeof evt]) => {
          setHistoryVersion((v) => v + 1);
          const cur = ref.current;
          if (cur && cur.call.id === call.id) {
            setState(null);
            notify({ kind: 'info', text: FINISHED_TEXT[evt] });
          }
        }),
      ),
    ];
    return () => offs.forEach((off) => off());
  }, [client, me.id, notify]);

  const start = useCallback(
    async (conversationId: string, type: CallType, peerName: string) => {
      if (ref.current) return;
      try {
        const join = await client.startCall(conversationId, type);
        setState({ phase: 'outgoing', call: join.call, join, peerName });
      } catch (e) {
        const busy = e instanceof CommsApiError && e.code === 'CALL_BUSY';
        notify({ kind: 'error', text: busy ? `${peerName} is in another call` : (e as Error).message });
        setHistoryVersion((v) => v + 1);
      }
    },
    [client, notify],
  );

  const accept = useCallback(async () => {
    const cur = ref.current;
    if (!cur) return;
    try {
      const join = await client.acceptCall(cur.call.id);
      setState({ ...cur, phase: 'in-call', call: join.call, join });
    } catch (e) {
      setState(null);
      notify({ kind: 'error', text: (e as Error).message });
    }
  }, [client, notify]);

  const rejoin = useCallback(async () => {
    const cur = ref.current;
    if (!cur) return;
    try {
      const join = await client.rejoinCall(cur.call.id);
      setState({ ...cur, phase: join.call.status === 'RINGING' ? 'outgoing' : 'in-call', call: join.call, join });
    } catch (e) {
      setState(null);
      notify({ kind: 'error', text: (e as Error).message });
    }
  }, [client, notify]);

  const decline = useCallback(async () => {
    const cur = ref.current;
    setState(null);
    if (cur) await client.declineCall(cur.call.id).catch(() => {});
  }, [client]);

  const hangup = useCallback(async () => {
    const cur = ref.current;
    setState(null);
    if (cur) await client.endCall(cur.call.id).catch(() => {});
    setHistoryVersion((v) => v + 1);
  }, [client]);

  return useMemo(
    () => ({ state, historyVersion, start, accept, decline, hangup, rejoin }),
    [state, historyVersion, start, accept, decline, hangup, rejoin],
  );
}

export function useComms(): CommsContextValue {
  const ctx = useContext(CommsContext);
  if (!ctx) throw new Error('useComms must be used inside <CommsProvider>');
  return ctx;
}

/** Call state and actions (start, accept, decline, hang up, rejoin). */
export function useCall(): CallController {
  return useComms().calls;
}

/** Subscribe to a realtime event with an always-fresh handler. */
export function useCommsEvent<E extends CommsEventName>(event: E, handler: (payload: CommsEvents[E]) => void): void {
  const { client } = useComms();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => client.on(event, (p) => ref.current(p)), [client, event]);
}
