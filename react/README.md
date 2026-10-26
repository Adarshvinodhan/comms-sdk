# @sminfotech/comms-react

React provider, hooks, and components for the comms service: DM inbox and threads, presence, typing, read receipts, incoming-call ringing, and LiveKit audio/video calls.

Built on [`@sminfotech/comms-sdk`](https://www.npmjs.com/package/@sminfotech/comms-sdk). Every component can be themed or restyled, and every component has a headless hook if you want your own markup.

## Install

```bash
npm install @sminfotech/comms-react @livekit/components-react @livekit/components-styles livekit-client
```

Requires React 18 or newer.

## Quick start

Your backend creates the session with its tenant API key (see [How auth works](https://www.npmjs.com/package/@sminfotech/comms-sdk#how-auth-works)). The browser only ever receives the short-lived chat token.

```tsx
import '@livekit/components-styles';
import '@sminfotech/comms-react/styles.css';
import { CallLayer, CommsProvider, DmInbox, DmThread, type Conversation } from '@sminfotech/comms-react';
import { useState } from 'react';

const getSession = () => fetch('/api/comms-session', { method: 'POST' }).then((r) => r.json());

export function Messages() {
  return (
    <CommsProvider getSession={getSession} fallback={<p>Connecting…</p>} onNotice={(n) => console.log(n.text)}>
      <Chat />
      <CallLayer />
    </CommsProvider>
  );
}

function Chat() {
  const [active, setActive] = useState<Conversation | null>(null);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', height: '100vh' }}>
      <DmInbox activeId={active?.id} onSelect={setActive} />
      {active && <DmThread key={active.id} conversation={active} />}
    </div>
  );
}
```

Mount `<CallLayer />` once, anywhere inside the provider. It shows the incoming-call modal, the rejoin prompt, and the full-screen call.

## Components

| Component | What it renders |
| --- | --- |
| `CommsProvider` | Starts the client, keeps the socket and token alive, and provides context. Renders `fallback` until ready. |
| `DmInbox` | Conversation list with avatar, last message preview, unread badge, and time. Calls `onSelect`. |
| `DmThread` | One conversation: header, history with "Load older", composer, edit/delete, typing, "Seen", and call buttons. |
| `CallLayer` | Incoming-call modal, rejoin prompt, and the LiveKit call screen. In-call chat is not saved. |
| `CallButton` | Starts an audio or video call. Disabled while another call is in progress. |
| `CallHistory` | Incoming and outgoing calls with status, duration, and time. |
| `Avatar` | Initials with an optional online/offline dot. |

### `CommsProvider` props

| Prop | Description |
| --- | --- |
| `getSession` | Required. Returns a `CommsSession` from your backend. |
| `initialSession` | A session you already have, used for the first render. |
| `onNotice` | Receives `{ kind: 'info' \| 'error', text }` for call outcomes and errors. Hook it up to your toasts. |
| `avatarColor` | `(user) => string \| undefined` per-user avatar color. Defaults to a stable hash color. |
| `fallback` | Rendered until the session is loaded. |
| `className`, `style` | Applied to the `.comms-root` theme wrapper. |

## Hooks

Use these to build your own UI. They must be called inside `CommsProvider`.

- `useComms()` returns `{ client, session, me, connected, notify, avatarColor, calls }`.
- `useInbox()` returns `{ conversations, loading, reload }`, kept live for new messages, edits, reads, and presence.
- `useMessages(conversation)` returns `{ messages, loading, hasOlder, loadOlder, send, edit, remove, setTyping, otherTyping, lastSeenOwnId }`. Sends are optimistic.
- `useCall()` returns `{ state, historyVersion, start, accept, decline, hangup, rejoin }`. `state.phase` is `incoming`, `outgoing`, `in-call`, or `rejoin`.
- `useCallHistory({ conversationId? })` returns `{ calls, loading, hasMore, loadMore }`.
- `useCommsEvent(event, handler)` subscribes to any realtime event from `@sminfotech/comms-sdk`.

## Styling

There are three levels. Use as many as you need.

### 1. Theme variables

`CommsProvider` renders a `.comms-root` wrapper with `display: contents`, so it never affects your layout. Set `--comms-*` variables on it in a stylesheet loaded after `@sminfotech/comms-react/styles.css`:

```css
.comms-root {
  --comms-surface: #ffffff;
  --comms-surface-2: #f0f2f5;
  --comms-border: #e9edef;
  --comms-text: #111b21;
  --comms-muted: #667781;
  --comms-accent: #00a884;
  --comms-bubble-mine: #d9fdd3;
  --comms-bubble-mine-text: #111b21;
  --comms-bubble-radius: 8px;
}
```

Or pass them inline:

```tsx
<CommsProvider getSession={getSession} style={{ '--comms-accent': '#e11d48' }}>
```

Set variables on a descendant to theme one area, for example a dark call screen:

```css
.comms-call-screen {
  --comms-surface: #202c33;
  --comms-text: #e9edef;
  --comms-call-bg: #0b141a;
}
```

| Group | Variables |
| --- | --- |
| Palette | `--comms-surface`, `--comms-surface-2`, `--comms-surface-3`, `--comms-border`, `--comms-text`, `--comms-muted`, `--comms-accent`, `--comms-accent-text`, `--comms-ok`, `--comms-danger`, `--comms-radius` |
| Thread and inbox | `--comms-header`, `--comms-chat-bg`, `--comms-hover`, `--comms-active`, `--comms-active-border`, `--comms-link`, `--comms-input-bg`, `--comms-badge`, `--comms-badge-text` |
| Bubbles | `--comms-bubble-mine`, `--comms-bubble-mine-text`, `--comms-bubble-theirs`, `--comms-bubble-theirs-text`, `--comms-bubble-radius`, `--comms-bubble-shadow`, `--comms-system-bg`, `--comms-system-text`, `--comms-failed` |
| Avatar and presence | `--comms-avatar-size`, `--comms-avatar-bg`, `--comms-avatar-text`, `--comms-offline` |
| Calls | `--comms-call-bg`, `--comms-backdrop`, `--comms-z-call`, `--comms-z-modal` |

Derived variables such as `--comms-header` and the bubble colors follow the palette unless you set them yourself.

### 2. Class names

Every component accepts `className` and `style` for its root. The larger ones also take a `classNames` map for inner parts, which works with Tailwind or CSS modules:

```tsx
<DmThread
  conversation={active}
  className="h-full"
  classNames={{
    header: 'border-b-0 shadow-sm',
    bubble: 'text-sm',
    mine: 'items-end',
    input: 'rounded-full',
    send: 'rounded-full',
  }}
/>
```

| Component | `classNames` keys |
| --- | --- |
| `DmThread` | `header`, `avatar`, `audioCall`, `videoCall`, `messages`, `loadOlder`, `empty`, `message`, `mine`, `theirs`, `failed`, `bubble`, `meta`, `system`, `typing`, `edit`, `composer`, `input`, `send` |
| `DmInbox` | `empty`, `item`, `itemActive`, `avatar`, `text`, `preview`, `badge` |
| `CallHistory` | `empty`, `item`, `missed`, `more` |
| `CallLayer` | `backdrop`, `modal`, `pulse`, `actions`, `decline`, `accept`, `end`, `rejoin`, `screen`, `header`, `hangup`, `room` |
| `Avatar` | `presence` |

Your classes are added alongside the built-in `comms-*` classes. When both set the same property, the stylesheet loaded last wins, so import `@sminfotech/comms-react/styles.css` before your own CSS. With Tailwind you may need the `!` modifier for properties the default stylesheet already sets.

### 3. Your own stylesheet

Skip `@sminfotech/comms-react/styles.css` entirely and style the `comms-*` classes yourself. State classes are always present: `is-mine`, `is-theirs`, `is-failed`, `is-active`, `is-missed`, `is-online`, `is-offline`, and `is-system`.

For full control over markup, build on the hooks above.

## License

MIT
