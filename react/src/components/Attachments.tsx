import type { Attachment } from '@sminfotech/comms-sdk';
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { useComms } from '../provider.js';
import { cx, formatBytes, formatDuration } from '../util.js';

const blobUrls = new Map<string, Promise<string>>();

function mediaUrl(load: () => Promise<Blob>, attachmentId: string): Promise<string> {
  const cached = blobUrls.get(attachmentId);
  if (cached) return cached;
  const pending = load()
    .then((blob) => URL.createObjectURL(blob))
    .catch((err: unknown) => {
      blobUrls.delete(attachmentId);
      throw err;
    });
  blobUrls.set(attachmentId, pending);
  return pending;
}

export interface MessageAttachmentsClassNames {
  media?: string;
  document?: string;
  voice?: string;
}

export interface MessageAttachmentsProps {
  attachments: readonly Attachment[];
  /** Object URLs for files still uploading from this browser. */
  localUrls?: Readonly<Record<string, string>>;
  className?: string;
  classNames?: MessageAttachmentsClassNames;
}

export function MessageAttachments({ attachments, localUrls, className, classNames }: MessageAttachmentsProps): ReactElement | null {
  if (!attachments.length) return null;
  return (
    <div className={cx('comms-attachments', className)}>
      {attachments.map((attachment) => (
        <AttachmentView key={attachment.id} attachment={attachment} localUrl={localUrls?.[attachment.id]} classNames={classNames} />
      ))}
    </div>
  );
}

function AttachmentView({
  attachment,
  localUrl,
  classNames,
}: {
  attachment: Attachment;
  localUrl?: string;
  classNames?: MessageAttachmentsClassNames;
}): ReactElement {
  if (attachment.kind === 'DOCUMENT') return <DocumentCard attachment={attachment} className={classNames?.document} />;
  return (
    <MediaSrc attachment={attachment} localUrl={localUrl}>
      {(src) =>
        attachment.kind === 'IMAGE' ? (
          <img className={cx('comms-media', classNames?.media)} src={src} alt={attachment.fileName} />
        ) : attachment.kind === 'VIDEO' ? (
          <video className={cx('comms-media', classNames?.media)} src={src} controls playsInline preload="metadata" />
        ) : (
          <div className={cx('comms-voice', classNames?.voice)}>
            <span className="comms-small">
              {attachment.kind === 'VOICE' ? 'Voice note' : 'Audio'}
              {attachment.durationMs != null && attachment.durationMs > 0
                ? ` · ${formatDuration(Math.max(1, Math.round(attachment.durationMs / 1000)))}`
                : ''}
            </span>
            <audio src={src} controls preload="metadata" />
          </div>
        )
      }
    </MediaSrc>
  );
}

function MediaSrc({
  attachment,
  localUrl,
  children,
}: {
  attachment: Attachment;
  localUrl?: string;
  children: (src: string) => ReactNode;
}): ReactElement {
  const { client } = useComms();
  const [src, setSrc] = useState<string | null>(localUrl ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (localUrl) {
      setSrc(localUrl);
      return;
    }
    let cancelled = false;
    setFailed(false);
    mediaUrl(() => client.fetchAttachment(attachment.id), attachment.id)
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [attachment.id, client, localUrl]);

  if (failed) return <p className="comms-muted comms-small">Couldn't load {attachment.fileName}</p>;
  if (!src) return <p className="comms-muted comms-small">Loading…</p>;
  return <>{children(src)}</>;
}

function DocumentCard({ attachment, className }: { attachment: Attachment; className?: string }): ReactElement {
  const { client, notify } = useComms();
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    try {
      const blob = await client.fetchAttachment(attachment.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = attachment.fileName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      notify({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" className={cx('comms-doc', className)} onClick={() => void download()} disabled={busy}>
      <span className="comms-doc-icon" aria-hidden="true">
        📄
      </span>
      <span className="comms-doc-text">
        <span className="comms-doc-name">{attachment.fileName}</span>
        <span className="comms-muted comms-small">{busy ? 'Downloading…' : formatBytes(attachment.sizeBytes)}</span>
      </span>
    </button>
  );
}
