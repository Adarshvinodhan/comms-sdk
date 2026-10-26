# @comms/sdk

Framework-agnostic browser client for the comms service: direct messages, presence, typing, read receipts, and LiveKit-backed audio/video calls.

Using React? Install [`@comms/react`](https://www.npmjs.com/package/@comms/react) instead. It wraps this client in a provider, hooks, and ready-made components.

## Install

```bash
npm install @comms/sdk
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
import { CommsClient } from '@comms/sdk';

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
- `editMessage(messageId, body)`, `deleteMessage(messageId)`
- `markRead(conversationId)`
- `setTyping(conversationId, isTyping)` is throttled, so it is safe to call on every keystroke.

**Calls**

- `startCall(conversationId, 'AUDIO' | 'VIDEO')`, `acceptCall(callId)`, `rejoinCall(callId)` return a `CallJoin` with `livekitUrl` and `livekitToken` for joining the LiveKit room.
- `declineCall(callId)`, `cancelCall(callId)`, `endCall(callId)`
- `liveCall()` returns the user's ringing or ongoing call, or `null`.
- `call(callId)`, `calls({ conversationId?, before?, limit? })`

## Realtime events

| Event | Payload |
| --- | --- |
| `message.new`, `message.updated`, `message.deleted` | `Message` |
| `typing` | `{ conversationId, userId, isTyping }` |
| `conversation.read` | `{ conversationId, userId, lastReadAt }` |
| `presence` | `{ userId, online, lastSeenAt }` |
| `call.invite` | `{ call, caller }` |
| `call.accepted`, `call.active`, `call.ended`, `call.missed`, `call.declined`, `call.cancelled`, `call.busy` | `{ call }` |

## Errors

Failed requests throw `CommsApiError` with `status`, `code` (for example `CALL_BUSY` or `UNAUTHORIZED`), `message`, and optional `details`. A `401` triggers one session refresh and retry before the error is thrown.

```ts
import { CommsApiError } from '@comms/sdk';

try {
  await client.startCall(conversationId, 'VIDEO');
} catch (e) {
  if (e instanceof CommsApiError && e.code === 'CALL_BUSY') showBusy();
}
```

## License

MIT
