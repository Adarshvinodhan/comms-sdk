import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  reactionOf,
  type Attachment,
  type AttachmentKind,
  type Call,
  type Conversation,
  type Message,
  type MessageReaction,
} from '@sminfotech/comms-sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useComms, useCommsEvent } from './provider.js';

export interface InboxState {
  conversations: Conversation[];
  loading: boolean;
  reload: () => Promise<void>;
}

export type ThreadMessage = Message & {
  pending?: boolean;
  failed?: boolean;
  /** 0–1 while files for this outgoing message are uploading. */
  uploadProgress?: number;
  /** Object URLs for files that have not been confirmed by the server yet. */
  localUrls?: Readonly<Record<string, string>>;
};

export interface SendFilesOptions {
  caption?: string;
  /** Send the single audio file as a voice note. */
  voice?: boolean;
  durationMs?: number;
}

export interface MessagesState {
  /** Oldest first, including optimistic (pending/failed) messages. */
  messages: ThreadMessage[];
  loading: boolean;
  hasOlder: boolean;
  loadOlder: () => Promise<void>;
  send: (text: string) => Promise<void>;
  /** Uploads each file (max 50 MB, max 30) and sends them as one message. */
  sendFiles: (files: File[], options?: SendFilesOptions) => Promise<void>;
  /** Resolves true when the edit was saved. */
  edit: (messageId: string, body: string) => Promise<boolean>;
  remove: (messageId: string) => Promise<void>;
  /** Toggles your reaction: sets `emoji`, or removes it when it already is your reaction. Optimistic. */
  react: (messageId: string, emoji: string) => Promise<void>;
  setTyping: (isTyping: boolean) => void;
  otherTyping: boolean;
  /** Id of the newest own message the other user has read, for a "Seen" marker. */
  lastSeenOwnId: string | undefined;
}

export interface CallHistoryState {
  calls: Call[];
  loading: boolean;
  hasMore: boolean;
  loadMore: () => Promise<void>;
}

/** Inbox with live updates: new messages, read receipts and presence. */
export function useInbox(): InboxState {
  const { client, notify } = useComms();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      setConversations(await client.inbox());
    } catch (e) {
      notify({ kind: 'error', text: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, [client, notify]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadSoon = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void reload(), 250);
  }, [reload]);

  useEffect(() => {
    void reload();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [reload]);

  useCommsEvent('message.new', reloadSoon);
  useCommsEvent('message.updated', reloadSoon);
  useCommsEvent('message.deleted', reloadSoon);
  useCommsEvent('conversation.read', reloadSoon);
  useCommsEvent('message.reaction', (r) =>
    setConversations((list) =>
      list.map((c) =>
        c.lastMessage?.id === r.messageId ? { ...c, lastMessage: { ...c.lastMessage, reactions: r.reactions } } : c,
      ),
    ),
  );
  useCommsEvent('presence', (p) =>
    setConversations((list) =>
      list.map((c) =>
        c.otherUser.id === p.userId ? { ...c, otherUser: { ...c.otherUser, online: p.online, lastSeenAt: p.lastSeenAt } } : c,
      ),
    ),
  );

  return { conversations, loading, reload };
}

function kindOf(file: File): AttachmentKind {
  if (file.type.startsWith('image/')) return 'IMAGE';
  if (file.type.startsWith('video/')) return 'VIDEO';
  if (file.type.startsWith('audio/')) return 'AUDIO';
  return 'DOCUMENT';
}

function upsert(list: ThreadMessage[], msg: ThreadMessage): ThreadMessage[] {
  const idx = list.findIndex((m) => m.id === msg.id || (msg.clientMsgId && m.clientMsgId === msg.clientMsgId));
  if (idx === -1) return [...list, msg].sort((a, b) => (a.id < b.id ? -1 : 1));
  const next = list.slice();
  next[idx] = msg;
  return next;
}

function patchReactions(list: ThreadMessage[], messageId: string, reactions: MessageReaction[]): ThreadMessage[] {
  return list.map((m) => (m.id === messageId ? { ...m, reactions } : m));
}

/** `reactions` with `userId`'s entry replaced in place, appended, or removed (`emoji: null`). */
function withReaction(reactions: MessageReaction[], userId: string, emoji: string | null): MessageReaction[] {
  if (emoji === null) return reactions.filter((r) => r.userId !== userId);
  const reactedAt = new Date().toISOString();
  return reactions.some((r) => r.userId === userId)
    ? reactions.map((r) => (r.userId === userId ? { ...r, emoji, reactedAt } : r))
    : [...reactions, { userId, emoji, reactedAt }];
}

/**
 * Headless DM thread: history with pagination, optimistic sends, edits, deletes,
 * typing indicator and read receipts. `DmThread` is built on this.
 */
export function useMessages(conversation: Conversation): MessagesState {
  const { client, me, notify } = useComms();
  const conversationId = conversation.id;
  const otherId = conversation.otherUser.id;

  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  useEffect(
    () => () => {
      for (const message of messagesRef.current) {
        for (const url of Object.values(message.localUrls ?? {})) URL.revokeObjectURL(url);
      }
    },
    [conversationId],
  );
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [otherTyping, setOtherTyping] = useState(false);
  const [otherLastReadAt, setOtherLastReadAt] = useState(conversation.otherLastReadAt);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const markRead = useCallback(() => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') {
      void client.markRead(conversationId).catch(() => {});
    }
  }, [client, conversationId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    client
      .messages(conversationId)
      .then((page) => {
        if (cancelled) return;
        setMessages(page.items.slice().reverse());
        setCursor(page.nextCursor);
        markRead();
      })
      .catch((e: Error) => notify({ kind: 'error', text: e.message }))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [client, conversationId, markRead, notify]);

  const loadOlder = useCallback(async () => {
    if (!cursor) return;
    const page = await client.messages(conversationId, { before: cursor });
    setMessages((m) => [...page.items.slice().reverse(), ...m]);
    setCursor(page.nextCursor);
  }, [client, conversationId, cursor]);

  useCommsEvent('message.new', (msg) => {
    if (msg.conversationId !== conversationId) return;
    setMessages((list) => upsert(list, msg));
    if (msg.senderId !== me.id) {
      setOtherTyping(false);
      markRead();
    }
  });
  useCommsEvent('message.updated', (msg) => {
    if (msg.conversationId === conversationId) setMessages((list) => upsert(list, msg));
  });
  useCommsEvent('message.deleted', (msg) => {
    if (msg.conversationId === conversationId) setMessages((list) => upsert(list, msg));
  });
  useCommsEvent('message.reaction', (r) => {
    if (r.conversationId === conversationId) setMessages((list) => patchReactions(list, r.messageId, r.reactions));
  });
  useCommsEvent('typing', (t) => {
    if (t.conversationId !== conversationId || t.userId !== otherId) return;
    setOtherTyping(t.isTyping);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    if (t.isTyping) typingTimer.current = setTimeout(() => setOtherTyping(false), 5000);
  });
  useCommsEvent('conversation.read', (r) => {
    if (r.conversationId === conversationId && r.userId === otherId) setOtherLastReadAt(r.lastReadAt);
  });

  const send = useCallback(
    async (text: string) => {
      const body = text.trim();
      if (!body) return;
      client.setTyping(conversationId, false);
      const clientMsgId = crypto.randomUUID();
      const pending: ThreadMessage = {
        // Sorts after real (UUIDv7) ids until the server copy replaces it.
        id: `zzzz-pending-${clientMsgId}`,
        conversationId,
        senderId: me.id,
        type: 'TEXT',
        body,
        metadata: {},
        clientMsgId,
        attachments: [],
        reactions: [],
        createdAt: new Date().toISOString(),
        editedAt: null,
        deletedAt: null,
        pending: true,
      };
      setMessages((list) => [...list, pending]);
      try {
        const saved = await client.sendMessage(conversationId, body, clientMsgId);
        setMessages((list) => upsert(list, saved));
      } catch (e) {
        setMessages((list) => list.map((m) => (m.clientMsgId === clientMsgId ? { ...m, pending: false, failed: true } : m)));
        notify({ kind: 'error', text: (e as Error).message });
      }
    },
    [client, conversationId, me.id, notify],
  );

  const sendFiles = useCallback(
    async (files: File[], options: SendFilesOptions = {}) => {
      if (!files.length) return;
      if (files.length > MAX_ATTACHMENTS_PER_MESSAGE) {
        notify({ kind: 'error', text: `You can send up to ${MAX_ATTACHMENTS_PER_MESSAGE} files at once` });
        return;
      }
      const tooBig = files.find((file) => file.size > MAX_ATTACHMENT_BYTES);
      if (tooBig) {
        notify({ kind: 'error', text: `${tooBig.name || 'A file'} exceeds the 50 MB limit` });
        return;
      }
      const empty = files.find((file) => file.size <= 0);
      if (empty) {
        notify({ kind: 'error', text: `${empty.name || 'A file'} is empty` });
        return;
      }

      client.setTyping(conversationId, false);
      const clientMsgId = crypto.randomUUID();
      const caption = options.caption?.trim() ?? '';
      const voice = Boolean(options.voice) && files.length === 1;
      const localUrls: Record<string, string> = {};
      const attachments: Attachment[] = files.map((file, index) => {
        const id = `local-${clientMsgId}-${index}`;
        localUrls[id] = URL.createObjectURL(file);
        return {
          id,
          kind: voice ? 'VOICE' : kindOf(file),
          fileName: file.name || (voice ? 'voice-note' : 'file'),
          mimeType: file.type || 'application/octet-stream',
          sizeBytes: file.size,
          durationMs: voice ? (options.durationMs ?? null) : null,
          url: '',
        };
      });
      const pending: ThreadMessage = {
        id: `zzzz-pending-${clientMsgId}`,
        conversationId,
        senderId: me.id,
        type: 'FILE',
        body: caption || null,
        metadata: {},
        clientMsgId,
        attachments,
        reactions: [],
        createdAt: new Date().toISOString(),
        editedAt: null,
        deletedAt: null,
        pending: true,
        uploadProgress: 0,
        localUrls,
      };
      setMessages((list) => [...list, pending]);

      const uploaded: string[] = [];
      const patchProgress = (uploadProgress: number) =>
        setMessages((list) => list.map((m) => (m.clientMsgId === clientMsgId ? { ...m, uploadProgress } : m)));
      try {
        for (let index = 0; index < files.length; index += 1) {
          const file = files[index]!;
          const saved = await client.uploadAttachment(conversationId, file, {
            voice,
            durationMs: voice ? options.durationMs : undefined,
            onProgress: (loaded, total) => patchProgress((index + (total > 0 ? loaded / total : 0)) / files.length),
          });
          uploaded.push(saved.id);
        }
        const saved = await client.sendMessage(conversationId, {
          ...(caption ? { body: caption } : {}),
          attachmentIds: uploaded,
          clientMsgId,
        });
        for (const url of Object.values(localUrls)) URL.revokeObjectURL(url);
        setMessages((list) => upsert(list, saved));
      } catch (e) {
        await Promise.all(uploaded.map((id) => client.discardAttachment(id).catch(() => {})));
        setMessages((list) =>
          list.map((m) => (m.clientMsgId === clientMsgId ? { ...m, pending: false, failed: true, uploadProgress: undefined } : m)),
        );
        notify({ kind: 'error', text: (e as Error).message });
      }
    },
    [client, conversationId, me.id, notify],
  );

  const edit = useCallback(
    async (messageId: string, body: string) => {
      try {
        const updated = await client.editMessage(messageId, body);
        setMessages((list) => upsert(list, updated));
        return true;
      } catch (e) {
        notify({ kind: 'error', text: (e as Error).message });
        return false;
      }
    },
    [client, notify],
  );

  const remove = useCallback(
    async (messageId: string) => {
      try {
        const updated = await client.deleteMessage(messageId);
        setMessages((list) => upsert(list, updated));
      } catch (e) {
        notify({ kind: 'error', text: (e as Error).message });
      }
    },
    [client, notify],
  );

  const react = useCallback(
    async (messageId: string, emoji: string) => {
      const msg = messagesRef.current.find((m) => m.id === messageId);
      if (!msg) return;
      const previous = msg.reactions;
      const next = reactionOf(previous, me.id) === emoji ? null : emoji;
      setMessages((list) => patchReactions(list, messageId, withReaction(previous, me.id, next)));
      try {
        const res = await client.react(messageId, next);
        setMessages((list) => patchReactions(list, messageId, res.reactions));
      } catch (e) {
        setMessages((list) => patchReactions(list, messageId, previous));
        notify({ kind: 'error', text: (e as Error).message });
      }
    },
    [client, me.id, notify],
  );

  const setTyping = useCallback((isTyping: boolean) => client.setTyping(conversationId, isTyping), [client, conversationId]);

  const lastSeenOwnId = otherLastReadAt
    ? [...messages].reverse().find((m) => m.senderId === me.id && !m.pending && m.createdAt <= otherLastReadAt)?.id
    : undefined;

  return {
    messages,
    loading,
    hasOlder: cursor !== null,
    loadOlder,
    send,
    sendFiles,
    edit,
    remove,
    react,
    setTyping,
    otherTyping,
    lastSeenOwnId,
  };
}

/** Call history (newest first), refreshed whenever a call finishes. */
export function useCallHistory(opts: { conversationId?: string } = {}): CallHistoryState {
  const { client, calls: controller } = useComms();
  const [calls, setCalls] = useState<Call[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    client
      .calls({ conversationId: opts.conversationId })
      .then((page) => {
        if (cancelled) return;
        setCalls(page.items);
        setCursor(page.nextCursor);
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [client, opts.conversationId, controller.historyVersion]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    const page = await client.calls({ conversationId: opts.conversationId, before: cursor });
    setCalls((c) => [...c, ...page.items]);
    setCursor(page.nextCursor);
  }, [client, cursor, opts.conversationId]);

  return { calls, loading, hasMore: cursor !== null, loadMore };
}
