import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, reactionOf, summarizeReactions, type Conversation } from '@sminfotech/comms-sdk';
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useMessages, type SendFilesOptions } from '../hooks.js';
import { useComms } from '../provider.js';
import { cx, formatBytes, timeShort, type CommsStyle } from '../util.js';
import { MessageAttachments } from './Attachments.js';
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
  attach?: string;
  files?: string;
  file?: string;
  media?: string;
  document?: string;
  voice?: string;
  input?: string;
  send?: string;
  edit?: string;
  reactions?: string;
  reaction?: string;
  reactionPicker?: string;
  reactionOption?: string;
  avatar?: string;
  audioCall?: string;
  videoCall?: string;
}

/** Quick-pick emoji shown by `DmThread`'s reaction picker. */
export const DEFAULT_REACTIONS: readonly string[] = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

export interface DmThreadProps {
  conversation: Conversation;
  /** Show audio/video call buttons in the header. Default true. */
  showCallButtons?: boolean;
  /** Emoji offered in the reaction picker, or `false` to hide reacting (existing reactions still show). Default `DEFAULT_REACTIONS`. */
  reactions?: readonly string[] | false;
  /** Extra content for the header, e.g. app-specific context. */
  headerExtra?: ReactNode;
  className?: string;
  style?: CommsStyle;
  classNames?: DmThreadClassNames;
}

export function DmThread({
  conversation,
  showCallButtons = true,
  reactions: quickReactions = DEFAULT_REACTIONS,
  headerExtra,
  className,
  style,
  classNames,
}: DmThreadProps): ReactElement {
  const { me, avatarColor, notify } = useComms();
  const other = conversation.otherUser;
  const { messages, loading, hasOlder, loadOlder, send, sendFiles, edit, remove, react, setTyping, otherTyping, lastSeenOwnId } =
    useMessages(conversation);

  const [draft, setDraft] = useState('');
  const [picks, setPicks] = useState<{ file: File; url: string }[]>([]);
  const picksRef = useRef(picks);
  picksRef.current = picks;
  const [recording, setRecording] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordChunks = useRef<Blob[]>([]);
  const recordStarted = useRef(0);
  const discardRecord = useRef(false);

  useEffect(
    () => () => {
      picksRef.current.forEach((pick) => URL.revokeObjectURL(pick.url));
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        discardRecord.current = true;
        recorderRef.current.stop();
      }
    },
    [],
  );
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!picking) return;
    pickerRef.current?.scrollIntoView({ block: 'nearest' });
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!pickerRef.current?.contains(target) && !target?.closest('[data-comms-react-toggle]')) setPicking(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPicking(null);
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [picking]);

  function pick(messageId: string, emoji: string) {
    setPicking(null);
    void react(messageId, emoji);
  }

  function reactorNames(userIds: string[]): string {
    return userIds.map((id) => (id === me.id ? 'You' : id === other.id ? other.displayName : 'Someone')).join(', ');
  }
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
    if (recording) return;
    const caption = draft.trim();
    if (!caption && picks.length === 0) return;
    stickToBottom.current = true;
    if (picks.length) {
      void sendFiles(
        picks.map((pick) => pick.file),
        { caption },
      );
      picks.forEach((pick) => URL.revokeObjectURL(pick.url));
      setPicks([]);
    } else {
      void send(caption);
    }
    setDraft('');
  }

  function addFiles(list: FileList | null) {
    if (!list?.length) return;
    setPicks((current) => {
      const next = [...current];
      for (const file of list) {
        if (next.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
          notify({ kind: 'error', text: `You can send up to ${MAX_ATTACHMENTS_PER_MESSAGE} files at once` });
          break;
        }
        if (file.size > MAX_ATTACHMENT_BYTES) {
          notify({ kind: 'error', text: `${file.name || 'A file'} exceeds the 50 MB limit` });
          continue;
        }
        if (file.size <= 0) {
          notify({ kind: 'error', text: `${file.name || 'A file'} is empty` });
          continue;
        }
        next.push({ file, url: URL.createObjectURL(file) });
      }
      return next;
    });
  }

  function removeFile(index: number) {
    setPicks((current) => {
      const removed = current[index];
      if (removed) URL.revokeObjectURL(removed.url);
      return current.filter((_, i) => i !== index);
    });
  }

  async function toggleRecording() {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      discardRecord.current = false;
      recorderRef.current.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4')
          ? 'audio/mp4'
          : '';
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recordChunks.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) recordChunks.current.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        recorderRef.current = null;
        setRecording(false);
        const discarded = discardRecord.current;
        discardRecord.current = false;
        const blob = new Blob(recordChunks.current, { type: recorder.mimeType || 'audio/webm' });
        recordChunks.current = [];
        if (discarded || blob.size <= 0) return;
        const ext = blob.type.includes('mp4') ? 'm4a' : 'webm';
        const file = new File([blob], `voice-note.${ext}`, { type: blob.type || 'audio/webm' });
        const durationMs = Date.now() - recordStarted.current;
        stickToBottom.current = true;
        const options: SendFilesOptions = { voice: true, durationMs };
        void sendFiles([file], options);
      };
      recordStarted.current = Date.now();
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch (e) {
      notify({ kind: 'error', text: (e as Error).message || 'Microphone is unavailable' });
    }
  }

  function cancelRecording() {
    discardRecord.current = true;
    recorderRef.current?.stop();
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
          const canReact = quickReactions !== false && !m.pending && !m.failed && !m.deletedAt;
          const summary = summarizeReactions(m.reactions, me.id);
          const myReaction = reactionOf(m.reactions, me.id);
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
                  {m.deletedAt ? (
                    <em className="comms-muted">Message deleted</em>
                  ) : (
                    <>
                      {(m.attachments?.length ?? 0) > 0 && (
                        <MessageAttachments
                          attachments={m.attachments}
                          localUrls={m.localUrls}
                          classNames={{ media: classNames?.media, document: classNames?.document, voice: classNames?.voice }}
                        />
                      )}
                      {m.body}
                    </>
                  )}
                </div>
              )}
              {summary.length > 0 && (
                <div className={cx('comms-reactions', classNames?.reactions)}>
                  {summary.map((s) => (
                    <button
                      key={s.emoji}
                      type="button"
                      className={cx('comms-reaction', s.mine && 'is-mine', classNames?.reaction)}
                      title={reactorNames(s.userIds)}
                      aria-label={`${s.emoji} ${reactorNames(s.userIds)}`}
                      aria-pressed={s.mine}
                      disabled={!canReact}
                      onClick={() => void react(m.id, s.emoji)}
                    >
                      {s.emoji}
                      {s.count > 1 && <span className="comms-reaction-count">{s.count}</span>}
                    </button>
                  ))}
                </div>
              )}
              <div className={cx('comms-meta', 'comms-muted', 'comms-small', classNames?.meta)}>
                {m.pending
                  ? m.uploadProgress != null
                    ? `Sending… ${Math.round(m.uploadProgress * 100)}%`
                    : 'Sending…'
                  : m.failed
                    ? 'Failed to send'
                    : timeShort(m.createdAt)}
                {m.editedAt && !m.deletedAt && ' · edited'}
                {canReact && editing?.id !== m.id && (
                  <>
                    {' · '}
                    <button
                      className="comms-link"
                      data-comms-react-toggle=""
                      aria-expanded={picking === m.id}
                      onClick={() => setPicking((cur) => (cur === m.id ? null : m.id))}
                    >
                      react
                    </button>
                  </>
                )}
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
              {canReact && picking === m.id && (
                <div
                  ref={pickerRef}
                  role="group"
                  aria-label="React to message"
                  className={cx('comms-reaction-picker', classNames?.reactionPicker)}
                >
                  {quickReactions.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      className={cx('comms-reaction-option', myReaction === emoji && 'is-selected', classNames?.reactionOption)}
                      aria-pressed={myReaction === emoji}
                      onClick={() => pick(m.id, emoji)}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
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
        {picks.length > 0 && (
          <div className={cx('comms-file-picks', classNames?.files)}>
            {picks.map((pick, index) => (
              <div key={pick.url} className={cx('comms-file-pick', classNames?.file)}>
                {pick.file.type.startsWith('image/') ? (
                  <img src={pick.url} alt="" />
                ) : (
                  <span className="comms-file-pick-name">{pick.file.name || 'file'}</span>
                )}
                <button type="button" className="comms-file-pick-remove" aria-label={`Remove ${pick.file.name || 'file'}`} onClick={() => removeFile(index)}>
                  ×
                </button>
                <span className="comms-muted comms-small">{formatBytes(pick.file.size)}</span>
              </div>
            ))}
          </div>
        )}
        {recording && <div className={cx('comms-recording', classNames?.voice)}>Recording voice note…</div>}
        <div className="comms-composer-row">
          <button
            type="button"
            className={cx('comms-icon-btn', classNames?.attach)}
            aria-label="Attach a file"
            disabled={recording}
            onClick={() => fileRef.current?.click()}
          >
            <PaperclipIcon />
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <input
            className={cx('comms-input', classNames?.input)}
            placeholder={picks.length ? 'Add a caption' : `Message ${other.displayName}`}
            value={draft}
            maxLength={4000}
            disabled={recording}
            onChange={(e) => {
              setDraft(e.target.value);
              setTyping(e.target.value.length > 0);
            }}
            onBlur={() => setTyping(false)}
          />
          <button
            type="button"
            className={cx('comms-icon-btn', recording && 'is-recording', classNames?.voice)}
            aria-label={recording ? 'Stop and send voice note' : 'Record a voice note'}
            disabled={picks.length > 0}
            onClick={() => void toggleRecording()}
          >
            <MicIcon />
          </button>
          {recording ? (
            <button type="button" className="comms-btn comms-btn--ghost" onClick={cancelRecording}>
              Cancel
            </button>
          ) : (
            <button className={cx('comms-btn', classNames?.send)} type="submit" disabled={!draft.trim() && picks.length === 0}>
              Send
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function PaperclipIcon(): ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path
        d="M21.4 11.6 12 21a5 5 0 0 1-7.1-7.1l9.2-9.2a3.5 3.5 0 0 1 5 5L9.9 19a2 2 0 0 1-2.8-2.8l8.4-8.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MicIcon(): ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M6 11a6 6 0 0 0 12 0M12 17v4" strokeLinecap="round" />
    </svg>
  );
}
