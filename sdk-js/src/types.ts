export interface CommsUser {
  id: string;
  externalUserId: string;
  displayName: string;
  avatarUrl: string | null;
  online: boolean;
  lastSeenAt: string | null;
}

export type MessageType = 'TEXT' | 'FILE' | 'SYSTEM';

/** One user's reaction. A user has at most one reaction per message. */
export interface MessageReaction {
  userId: string;
  emoji: string;
  reactedAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string | null;
  type: MessageType;
  body: string | null;
  metadata: Record<string, unknown>;
  clientMsgId: string | null;
  /** Oldest first. Always empty on deleted and system messages. */
  reactions: MessageReaction[];
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}

export interface Conversation {
  id: string;
  otherUser: CommsUser;
  metadata: Record<string, unknown>;
  lastMessageAt: string | null;
  myLastReadAt: string | null;
  otherLastReadAt: string | null;
  createdAt: string;
  lastMessage?: Message | null;
  unreadCount: number;
}

export type CallType = 'AUDIO' | 'VIDEO';

export type CallStatus =
  | 'RINGING'
  | 'ACCEPTED'
  | 'ACTIVE'
  | 'ENDED'
  | 'MISSED'
  | 'DECLINED'
  | 'BUSY'
  | 'FAILED'
  | 'CANCELLED';

export const LIVE_CALL_STATUSES: readonly CallStatus[] = ['RINGING', 'ACCEPTED', 'ACTIVE'];

export interface Call {
  id: string;
  conversationId: string;
  callerId: string;
  calleeId: string;
  caller?: CommsUser;
  callee?: CommsUser;
  type: CallType;
  status: CallStatus;
  ringingAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  durationSec: number | null;
  createdAt: string;
}

/** Everything needed to join the LiveKit room for a call. */
export interface CallJoin {
  call: Call;
  livekitUrl: string;
  livekitToken: string;
}

/** What the app's backend returns after calling `POST /v1/sessions` on the comms service. */
export interface CommsSession {
  user: CommsUser;
  chatToken: string;
  expiresAt: string;
  apiUrl: string;
  wsUrl: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface TypingEvent {
  conversationId: string;
  userId: string;
  isTyping: boolean;
}

/** A reaction was set, changed or removed. `reactions` is the message's full list after the change. */
export interface ReactionEvent {
  conversationId: string;
  messageId: string;
  userId: string;
  /** `null` when `userId` removed their reaction. */
  emoji: string | null;
  reactions: MessageReaction[];
}

export interface ReadEvent {
  conversationId: string;
  userId: string;
  lastReadAt: string;
}

export interface PresenceEvent {
  userId: string;
  online: boolean;
  lastSeenAt: string;
}

export interface CallEvent {
  call: Call;
}

export interface CallInviteEvent {
  call: Call;
  caller: CommsUser;
}

/** Realtime events pushed by the comms service over Socket.IO. */
export interface CommsEvents {
  'message.new': Message;
  'message.updated': Message;
  'message.deleted': Message;
  'message.reaction': ReactionEvent;
  typing: TypingEvent;
  'conversation.read': ReadEvent;
  presence: PresenceEvent;
  'call.invite': CallInviteEvent;
  'call.accepted': CallEvent;
  'call.active': CallEvent;
  'call.ended': CallEvent;
  'call.missed': CallEvent;
  'call.declined': CallEvent;
  'call.cancelled': CallEvent;
  'call.busy': CallEvent;
}

export type CommsEventName = keyof CommsEvents;

export type CallFinishedEvent = 'call.ended' | 'call.missed' | 'call.declined' | 'call.cancelled' | 'call.busy';

export const CALL_FINISHED_EVENTS: readonly CallFinishedEvent[] = [
  'call.ended',
  'call.missed',
  'call.declined',
  'call.cancelled',
  'call.busy',
];
