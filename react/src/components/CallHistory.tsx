import type { Call } from '@sminfotech/comms-sdk';
import type { ReactElement } from 'react';
import { useCallHistory } from '../hooks.js';
import { useComms } from '../provider.js';
import { cx, formatDuration, timeShort, type CommsStyle } from '../util.js';

const STATUS_LABEL: Record<Call['status'], string> = {
  RINGING: 'Ringing',
  ACCEPTED: 'Connecting',
  ACTIVE: 'Live',
  ENDED: 'Completed',
  MISSED: 'Missed',
  DECLINED: 'Declined',
  BUSY: 'Busy',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

export interface CallHistoryClassNames {
  empty?: string;
  item?: string;
  missed?: string;
  more?: string;
}

export interface CallHistoryProps {
  /** Limit to one conversation; omit for all of the user's calls. */
  conversationId?: string;
  emptyText?: string;
  className?: string;
  style?: CommsStyle;
  classNames?: CallHistoryClassNames;
}

export function CallHistory({
  conversationId,
  emptyText = 'No calls yet.',
  className,
  style,
  classNames,
}: CallHistoryProps): ReactElement {
  const { me } = useComms();
  const { calls, loading, hasMore, loadMore } = useCallHistory({ conversationId });

  if (loading) return <p className={cx('comms-muted', 'comms-small', className)} style={style}>Loading…</p>;
  if (!calls.length) {
    return (
      <p className={cx('comms-muted', 'comms-small', className, classNames?.empty)} style={style}>
        {emptyText}
      </p>
    );
  }
  return (
    <ul className={cx('comms-call-list', className)} style={style}>
      {calls.map((c) => {
        const outgoing = c.callerId === me.id;
        const peer = outgoing ? c.callee : c.caller;
        const missedForMe = !outgoing && (c.status === 'MISSED' || c.status === 'CANCELLED');
        return (
          <li
            key={c.id}
            className={cx('comms-call-item', missedForMe && 'is-missed', classNames?.item, missedForMe && classNames?.missed)}
          >
            <span title={outgoing ? 'Outgoing' : 'Incoming'}>{outgoing ? '↗' : '↙'}</span>
            <span>{c.type === 'VIDEO' ? '🎥' : '🎙️'}</span>
            <div className="comms-grow">
              <strong>{peer?.displayName}</strong>
              <div className="comms-muted comms-small">
                {STATUS_LABEL[c.status]}
                {c.durationSec != null && ` · ${formatDuration(c.durationSec)}`} · {timeShort(c.createdAt)}
              </div>
            </div>
          </li>
        );
      })}
      {hasMore && (
        <button className={cx('comms-btn', 'comms-btn--ghost', 'comms-btn--small', classNames?.more)} onClick={() => void loadMore()}>
          Load more
        </button>
      )}
    </ul>
  );
}
