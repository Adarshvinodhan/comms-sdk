import type { CallType, Conversation } from '@comms/sdk';
import type { ReactElement, ReactNode } from 'react';
import { useCall } from '../provider.js';
import { cx, type CommsStyle } from '../util.js';

export interface CallButtonProps {
  conversation: Pick<Conversation, 'id' | 'otherUser'>;
  type: CallType;
  className?: string;
  style?: CommsStyle;
  children?: ReactNode;
}

/** Starts an audio or video call; disabled while another call is in progress. */
export function CallButton({ conversation, type, className, style, children }: CallButtonProps): ReactElement {
  const { state, start } = useCall();
  return (
    <button
      className={cx('comms-btn', className)}
      style={style}
      disabled={state !== null}
      onClick={() => void start(conversation.id, type, conversation.otherUser.displayName)}
    >
      {children ?? (type === 'VIDEO' ? '🎥 Video call' : '🎙️ Audio call')}
    </button>
  );
}
