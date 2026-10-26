import { AudioConference, LiveKitRoom, VideoConference } from '@livekit/components-react';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useCall } from '../provider.js';
import { cx, type CommsStyle } from '../util.js';

function Elapsed({ since }: { since: string | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!since) return null;
  const sec = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000));
  return <span>{`${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`}</span>;
}

export interface CallLayerClassNames {
  backdrop?: string;
  modal?: string;
  pulse?: string;
  actions?: string;
  decline?: string;
  accept?: string;
  end?: string;
  rejoin?: string;
  screen?: string;
  header?: string;
  hangup?: string;
  room?: string;
}

export interface CallLayerProps {
  /** Shown in the call header. Default: "Messages in this call aren't saved". */
  inCallNote?: string;
  /** Applied to whichever surface is showing: the backdrop or the call screen. */
  className?: string;
  style?: CommsStyle;
  classNames?: CallLayerClassNames;
}

/**
 * Renders the incoming-call modal, the rejoin prompt, and the full-screen call (LiveKit)
 * for whatever call is in progress. Mount it once, anywhere inside `<CommsProvider>`.
 * In-call chat uses LiveKit's built-in chat and is never sent to the comms API.
 */
export function CallLayer({
  inCallNote = "Messages in this call aren't saved",
  className,
  style,
  classNames,
}: CallLayerProps): ReactElement | null {
  const { state, accept, decline, hangup, rejoin } = useCall();
  const hungUp = useRef(false);
  useEffect(() => {
    hungUp.current = false;
  }, [state?.call.id]);

  if (!state) return null;
  const kind = state.call.type === 'VIDEO' ? 'video' : 'audio';

  if (state.phase === 'incoming') {
    return (
      <div className={cx('comms-modal-backdrop', className, classNames?.backdrop)} style={style}>
        <div className={cx('comms-modal', classNames?.modal)}>
          <div className={cx('comms-pulse', classNames?.pulse)}>{kind === 'video' ? '🎥' : '🎙️'}</div>
          <h3>{state.peerName}</h3>
          <p className="comms-muted">Incoming {kind} call…</p>
          <div className={cx('comms-actions', classNames?.actions)}>
            <button className={cx('comms-btn', 'comms-btn--danger', classNames?.decline)} onClick={() => void decline()}>
              Decline
            </button>
            <button className={cx('comms-btn', 'comms-btn--success', classNames?.accept)} onClick={() => void accept()}>
              Accept
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (state.phase === 'rejoin' || !state.join) {
    return (
      <div className={cx('comms-modal-backdrop', className, classNames?.backdrop)} style={style}>
        <div className={cx('comms-modal', classNames?.modal)}>
          <h3>
            Ongoing {kind} call with {state.peerName}
          </h3>
          <p className="comms-muted">This call is still live. Rejoin it or end it.</p>
          <div className={cx('comms-actions', classNames?.actions)}>
            <button className={cx('comms-btn', 'comms-btn--danger', classNames?.end)} onClick={() => void hangup()}>
              End call
            </button>
            <button className={cx('comms-btn', 'comms-btn--success', classNames?.rejoin)} onClick={() => void rejoin()}>
              Rejoin
            </button>
          </div>
        </div>
      </div>
    );
  }

  const status =
    state.call.status === 'RINGING' ? `Ringing ${state.peerName}…` : state.call.status === 'ACCEPTED' ? 'Connecting…' : 'Live';

  const hangupOnce = () => {
    if (hungUp.current) return;
    hungUp.current = true;
    void hangup();
  };

  return (
    <div className={cx('comms-call-screen', className, classNames?.screen)} style={style}>
      <header className={cx('comms-call-header', classNames?.header)}>
        <div>
          <strong>
            {kind === 'video' ? '🎥' : '🎙️'} {state.peerName}
          </strong>
          <span className="comms-muted comms-small">
            {' '}
            · {status} {state.call.status === 'ACTIVE' && <Elapsed since={state.call.answeredAt} />}
          </span>
        </div>
        <span className="comms-muted comms-small">{inCallNote}</span>
        <button className={cx('comms-btn', 'comms-btn--danger', classNames?.hangup)} onClick={hangupOnce}>
          {state.call.status === 'RINGING' ? 'Cancel' : 'End call'}
        </button>
      </header>
      <LiveKitRoom
        className={cx('comms-call-room', classNames?.room)}
        data-lk-theme="default"
        serverUrl={state.join.livekitUrl}
        token={state.join.livekitToken}
        connect
        audio
        video={state.call.type === 'VIDEO'}
        onDisconnected={hangupOnce}
      >
        {state.call.type === 'VIDEO' ? <VideoConference /> : <AudioConference />}
      </LiveKitRoom>
    </div>
  );
}
