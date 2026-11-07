# @sminfotech/comms-sdk

Framework-agnostic browser client for the comms service: direct messages, reactions, presence, typing, read receipts, and LiveKit-backed audio/video calls.

Using React? Install [`@sminfotech/comms-react`](https://www.npmjs.com/package/@sminfotech/comms-react) instead. It wraps this client in a provider, hooks, and ready-made components.

## Install

```bash
npm install @sminfotech/comms-sdk
```

## How auth works

The browser never sees your tenant API key. Your own backend exchanges its logged-in user for a short-lived comms session, and the client asks for a fresh one whenever the chat token is about to expire.

```ts
// Your backend (Node). Keep COMMS_API_KEY server-side.
app.post('/api/comms-session', async (req, res) => {
  const user = req.user; // however your app authenticates
  const r = await fetch(`${process.env.COMMS_API_URL}/v1/sessions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.COMMS_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ externalUserId: user.id, displayName: user.name, avatarUrl: user.avatarUrl }),
  });
  res.status(r.status).json(await r.json());
});
```

The response is a `CommsSession`: `{ user, chatToken, expiresAt, apiUrl, wsUrl }`.

## Usage

```ts
import { CommsClient } from '@sminfotech/comms-sdk';

const client = new CommsClient({
  getSession: () => fetch('/api/comms-session', { method: 'POST' }).then((r) => r.json()),
});

await client.start();

const conversations = await client.inbox();
const { items, nextCursor } = await client.messages(conversations[0].id);

client.on('message.new', (msg) => console.log('new message', msg));
await client.sendMessage(conversations[0].id, 'Hello!');

client.stop();
```

## Options

| Option | Description |
| --- | --- |
| `getSession` | Required. Returns a `CommsSession` from your backend. Called on start and before the chat token expires. |
| `initialSession` | A session you already fetched, so `start()` skips the first `getSession()` call. |
| `sendTimeoutMs` | How long to wait for a socket acknowledgement before sending over REST instead. Default `5000`. |

## API

**Session and connection**

- `start()` loads a session if needed and opens the realtime connection.
- `stop()` closes the connection and stops token renewal.
- `refreshSession()` fetches a new session. Concurrent calls share one request.
- `currentSession`, `me`, `connected`
- `onConnectionChange(listener)`, `onSessionChange(listener)` return an unsubscribe function.
- `on(event, listener)` subscribes to a realtime event and returns an unsubscribe function. It works before `start()`.

**Conversations and messages**

- `inbox()`, `conversation(id)`
- `messages(conversationId, { before?, limit? })` returns newest first. Pass `nextCursor` as `before` to page back.
- `sendMessage(conversationId, body, clientMsgId?)` sends over the socket and falls back to REST. The server deduplicates on `clientMsgId`, so retries are safe.
- `sendMessage(conversationId, { body?, attachmentIds?, clientMsgId? })` sends a file message. `body` is an optional caption. `attachmentIds` are ids from `uploadAttachment` (1–30). A string body is still the text-only call.
- `uploadAttachment(conversationId, file, { voice?, durationMs?, fileName?, onProgress?, signal? })` uploads one file (`Blob` or `File`) as multipart and returns the `Attachment`. Files over 50 MB or empty are rejected before the request. `onProgress(loaded, total)` reports upload bytes. Pass `voice: true` for a voice note (audio only).
- `fetchAttachment(attachmentId, signal?)` downloads the bytes as a `Blob`. Use this for `<img>`, `<video>`, and `<audio>`: the relative `attachment.url` needs the chat token, which a plain `src` cannot send.
- `discardAttachment(attachmentId)` deletes an upload you have not sent yet.
- `editMessage(messageId, body)`, `deleteMessage(messageId)`
- `react(messageId, emoji | null)` sets your reaction, replacing any previous one, or removes it with `null`. One reaction per user per message, like WhatsApp. It is idempotent, so it sends over the socket and falls back to REST. Resolves to `{ conversationId, messageId, userId, emoji, reactions }`.
- `markRead(conversationId)`
- `setTyping(conversationId, isTyping)` is throttled, so it is safe to call on every keystroke.

**Reactions**

Every `Message` has `reactions: { userId, emoji, reactedAt }[]`, oldest first. Two helpers make rendering easier:

- `summarizeReactions(reactions, myUserId?)` groups them into `{ emoji, count, userIds, mine }[]` for chips like "👍 2".
- `reactionOf(reactions, userId)` returns that user's emoji or `null`.

**Attachments**

Every `Message` has `attachments: Attachment[]`, in send order. Text, system, and deleted messages have `[]`. A message with files has `type: "FILE"` and may still have a caption in `body`.

```ts
const file = await client.uploadAttachment(conversationId, photo, {
  onProgress: (loaded, total) => console.log(loaded, total),
});
await client.sendMessage(conversationId, { attachmentIds: [file.id], body: 'Look' });

const blob = await client.fetchAttachment(file.id);
const src = URL.createObjectURL(blob);
```

`MAX_ATTACHMENT_BYTES` is 50 MB and `MAX_ATTACHMENTS_PER_MESSAGE` is 30. Kinds are `IMAGE`, `VIDEO`, `AUDIO`, `VOICE`, and `DOCUMENT`.

To toggle like WhatsApp, where tapping your current emoji removes it:

```ts
import { reactionOf } from '@sminfotech/comms-sdk';

const current = reactionOf(message.reactions, client.me.id);
await client.react(message.id, current === emoji ? null : emoji);
```

Keep threads in sync by replacing the message's `reactions` with the payload of `message.reaction`.

**Calls**

- `startCall(conversationId, 'AUDIO' | 'VIDEO')`, `acceptCall(callId)`, `rejoinCall(callId)` return a `CallJoin` with `livekitUrl` and `livekitToken` for joining the LiveKit room.
- `declineCall(callId)`, `cancelCall(callId)`, `endCall(callId)`
- `liveCall()` returns the user's ringing or ongoing call, or `null`.
- `call(callId)`, `calls({ conversationId?, before?, limit? })`

## Realtime events

| Event | Payload |
| --- | --- |
| `message.new`, `message.updated`, `message.deleted` | `Message` |
| `message.reaction` | `{ conversationId, messageId, userId, emoji, reactions }`. `emoji` is `null` when `userId` removed theirs, and `reactions` is the message's full list after the change. |
| `typing` | `{ conversationId, userId, isTyping }` |
| `conversation.read` | `{ conversationId, userId, lastReadAt }` |
| `presence` | `{ userId, online, lastSeenAt }` |
| `call.invite` | `{ call, caller }` |
| `call.accepted`, `call.active`, `call.ended`, `call.missed`, `call.declined`, `call.cancelled`, `call.busy` | `{ call }` |

## Errors

Failed requests throw `CommsApiError` with `status`, `code` (for example `CALL_BUSY` or `UNAUTHORIZED`), `message`, and optional `details`. A `401` triggers one session refresh and retry before the error is thrown.

```ts
import { CommsApiError } from '@sminfotech/comms-sdk';

try {
  await client.startCall(conversationId, 'VIDEO');
} catch (e) {
  if (e instanceof CommsApiError && e.code === 'CALL_BUSY') showBusy();
}
```

## License

MIT
