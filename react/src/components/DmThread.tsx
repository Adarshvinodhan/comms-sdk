import type { Conversation } from '@comms/sdk';
import { useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useMessages } from '../hooks.js';
import { useComms } from '../provider.js';
import { cx, timeShort, type CommsStyle } from '../util.js';
import { Avatar } from './Avatar.js';
import { CallButton } from './CallButton.js';

export interface DmThreadClassNames {
  header?: string;
  messages?: string;
  loadOlder?: string;
  empty?: string;
  message?: string;
  mine?: string;
  theirs?: string;
  failed?: string;
  bubble?: string;
  meta?: string;
  system?: string;
  typing?: string;
  composer?: string;
  input?: string;
  send?: string;
  edit?: string;
  avatar?: string;
  audioCall?: string;
  videoCall?: string;
}

export interface DmThreadProps {
  conversation: Conversation;
  /** Show audio/video call buttons in the header. Default true. */
  showCallButtons?: boolean;
  /** Extra content for the header, e.g. app-specific context. */
  headerExtra?: ReactNode;
  className?: string;
  style?: CommsStyle;
  classNames?: DmThreadClassNames;
}

export function DmThread({ conversation, showCallButtons = true, headerExtra, className, style, classNames }: DmThreadProps): ReactElement {
  const { me, avatarColor } = useComms();
  const other = conversation.otherUser;
  const { messages, loading, hasOlder, loadOlder, send, edit, remove, setTyping, otherTyping, lastSeenOwnId } =
    useMessages(conversation);

  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const restoreFrom = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (restoreFrom.current !== null) {
      el.scrollTop = el.scrollHeight - restoreFrom.current;
      restoreFrom.current = null;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, otherTyping]);

  async function older() {
    restoreFrom.current = listRef.current?.scrollHeight ?? 0;
    await loadOlder();
  }

  function submit() {
    if (!draft.trim()) return;
    stickToBottom.current = true;
    void send(draft);
    setDraft('');
  }

  async function saveEdit() {
    if (editing && (await edit(editing.id, editing.body))) setEditing(null);
  }

  return (
    <div className={cx('comms-thread', className)} style={style}>
      <header className={cx('comms-thread-header', classNames?.header)}>
        <Avatar name={other.displayName} color={avatarColor(other)} online={other.online} className={classNames?.avatar} />
        <div className="comms-grow">
          <strong>{other.displayName}</strong>
          <div className="comms-muted comms-small">
            {other.online ? 'Online' : other.lastSeenAt ? `Last seen ${timeShort(other.lastSeenAt)}` : 'Offline'}
            {headerExtra}
          </div>
        </div>
        {showCallButtons && (
          <>
            <CallButton conversation={conversation} type="AUDIO" className={classNames?.audioCall} />
            <CallButton conversation={conversation} type="VIDEO" className={classNames?.videoCall} />
          </>
        )}
      </header>

      <div
        className={cx('comms-messages', classNames?.messages)}
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {hasOlder && (
          <button className={cx('comms-btn', 'comms-btn--ghost', 'comms-load-older', classNames?.loadOlder)} onClick={() => void older()}>
            Load older messages
          </button>
        )}
        {loading && <p className="comms-muted comms-center">Loading history…</p>}
        {!loading && messages.length === 0 && (
          <p className={cx('comms-muted', 'comms-center', classNames?.empty)}>No messages yet. Say hi 👋</p>
        )}
        {messages.map((m) => {
          if (m.type === 'SYSTEM') {
            return (
              <div key={m.id} className={cx('comms-system-msg', classNames?.system)}>
                📞 {m.body} <span className="comms-muted comms-small">· {timeShort(m.createdAt)}</span>
              </div>
            );
          }
          const mine = m.senderId === me.id;
          return (
            <div
              key={m.id}
              className={cx(
                'comms-msg',
                mine ? 'is-mine' : 'is-theirs',
                m.failed && 'is-failed',
                classNames?.message,
                mine ? classNames?.mine : classNames?.theirs,
                m.failed && classNames?.failed,
              )}
            >
              {editing && editing.id === m.id ? (
                <div className={cx('comms-edit-box', classNames?.edit)}>
                  <input
                    className={cx('comms-input', classNames?.input)}
                    value={editing.body}
                    autoFocus
                    onChange={(e) => setEditing({ id: m.id, body: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveEdit();
                      if (e.key === 'Escape') setEditing(null);
                    }}
                  />
                  <button className="comms-btn comms-btn--small" onClick={() => void saveEdit()}>
                    Save
                  </button>
                  <button className="comms-btn comms-btn--ghost comms-btn--small" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <div className={cx('comms-bubble', classNames?.bubble)}>
                  {m.deletedAt ? <em className="comms-muted">Message deleted</em> : m.body}
                </div>
              )}
              <div className={cx('comms-meta', 'comms-muted', 'comms-small', classNames?.meta)}>
                {m.pending ? 'Sending…' : m.failed ? 'Failed to send' : timeShort(m.createdAt)}
                {m.editedAt && !m.deletedAt && ' · edited'}
                {mine && !m.pending && !m.failed && !m.deletedAt && editing?.id !== m.id && (
                  <>
                    {' · '}
                    <button className="comms-link" onClick={() => setEditing({ id: m.id, body: m.body ?? '' })}>
                      edit
                    </button>
                    {' · '}
                    <button className="comms-link" onClick={() => void remove(m.id)}>
                      delete
                    </button>
                  </>
                )}
                {lastSeenOwnId === m.id && ' · Seen'}
              </div>
            </div>
          );
        })}
        {otherTyping && (
          <div className={cx('comms-typing', 'comms-muted', 'comms-small', classNames?.typing)}>{other.displayName} is typing…</div>
        )}
      </div>

      <form
        className={cx('comms-composer', classNames?.composer)}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          className={cx('comms-input', classNames?.input)}
          placeholder={`Message ${other.displayName}`}
          value={draft}
          maxLength={4000}
          onChange={(e) => {
            setDraft(e.target.value);
            setTyping(e.target.value.length > 0);
          }}
          onBlur={() => setTyping(false)}
        />
        <button className={cx('comms-btn', classNames?.send)} type="submit" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
