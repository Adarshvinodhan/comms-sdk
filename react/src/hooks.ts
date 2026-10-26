import type { Call, Conversation, Message } from '@comms/sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useComms, useCommsEvent } from './provider.js';

export interface InboxState {
  conversations: Conversation[];
  loading: boolean;
  reload: () => Promise<void>;
}

export type ThreadMessage = Message & { pending?: boolean; failed?: boolean };

export interface MessagesState {
  /** Oldest first, including optimistic (pending/failed) messages. */
  messages: ThreadMessage[];
  loading: boolean;
  hasOlder: boolean;
  loadOlder: () => Promise<void>;
  send: (text: string) => Promise<void>;
  /** Resolves true when the edit was saved. */
  edit: (messageId: string, body: string) => Promise<boolean>;
  remove: (messageId: string) => Promise<void>;
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
  useCommsEvent('presence', (p) =>
    setConversations((list) =>
      list.map((c) =>
        c.otherUser.id === p.userId ? { ...c, otherUser: { ...c.otherUser, online: p.online, lastSeenAt: p.lastSeenAt } } : c,
      ),
    ),
  );

  return { conversations, loading, reload };
}

function upsert(list: ThreadMessage[], msg: ThreadMessage): ThreadMessage[] {
  const idx = list.findIndex((m) => m.id === msg.id || (msg.clientMsgId && m.clientMsgId === msg.clientMsgId));
  if (idx === -1) return [...list, msg].sort((a, b) => (a.id < b.id ? -1 : 1));
  const next = list.slice();
  next[idx] = msg;
  return next;
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
    edit,
    remove,
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
