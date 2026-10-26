import type { Conversation } from '@sminfotech/comms-sdk';
import type { ReactElement } from 'react';
import { useInbox } from '../hooks.js';
import { useComms } from '../provider.js';
import { cx, timeShort, type CommsStyle } from '../util.js';
import { Avatar } from './Avatar.js';

export interface DmInboxClassNames {
  empty?: string;
  item?: string;
  itemActive?: string;
  avatar?: string;
  text?: string;
  preview?: string;
  badge?: string;
}

export interface DmInboxProps {
  activeId?: string | null;
  onSelect: (conversation: Conversation) => void;
  /** Pass conversations from your own `useInbox()` to share one subscription; otherwise the inbox loads its own. */
  conversations?: Conversation[];
  emptyText?: string;
  className?: string;
  style?: CommsStyle;
  classNames?: DmInboxClassNames;
}

function preview(c: Conversation, myId: string): string {
  const m = c.lastMessage;
  if (!m) return 'No messages yet';
  if (m.deletedAt) return 'Message deleted';
  if (m.type === 'SYSTEM') return `📞 ${m.body}`;
  return `${m.senderId === myId ? 'You: ' : ''}${m.body}`;
}

function OwnInbox(props: Omit<DmInboxProps, 'conversations'>) {
  const { conversations } = useInbox();
  return <InboxList {...props} conversations={conversations} />;
}

export function DmInbox(props: DmInboxProps): ReactElement {
  return props.conversations ? <InboxList {...props} conversations={props.conversations} /> : <OwnInbox {...props} />;
}

function InboxList({
  conversations,
  activeId,
  onSelect,
  emptyText = 'No conversations yet.',
  className,
  style,
  classNames,
}: DmInboxProps & { conversations: Conversation[] }) {
  const { me, avatarColor } = useComms();
  if (!conversations.length) {
    return (
      <p className={cx('comms-muted', 'comms-small', className, classNames?.empty)} style={style}>
        {emptyText}
      </p>
    );
  }
  return (
    <div className={cx('comms-inbox', className)} style={style}>
      {conversations.map((c) => {
        const active = c.id === activeId;
        return (
          <button
            key={c.id}
            className={cx('comms-inbox-item', active && 'is-active', classNames?.item, active && classNames?.itemActive)}
            onClick={() => onSelect(c)}
          >
            <Avatar
              name={c.otherUser.displayName}
              color={avatarColor(c.otherUser)}
              online={c.otherUser.online}
              className={classNames?.avatar}
            />
            <div className={cx('comms-inbox-text', classNames?.text)}>
              <div className="comms-row">
                <strong>{c.otherUser.displayName}</strong>
                <span className="comms-muted comms-small">{timeShort(c.lastMessageAt)}</span>
              </div>
              <div className="comms-row">
                <span className={cx('comms-preview', c.lastMessage?.type === 'SYSTEM' && 'is-system', classNames?.preview)}>
                  {preview(c, me.id)}
                </span>
                {c.unreadCount > 0 && <span className={cx('comms-badge', classNames?.badge)}>{c.unreadCount}</span>}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
