import type { ReactElement } from 'react';
import { cx, initials, type CommsStyle } from '../util.js';

export interface AvatarClassNames {
  presence?: string;
}

export interface AvatarProps {
  name: string;
  /** Sets `--comms-avatar-bg`. Omit it to use the theme variable. */
  color?: string;
  /** Shows a presence dot when defined. */
  online?: boolean;
  /** Sets `--comms-avatar-size`. Omit it to use the theme variable (default 36px). */
  size?: number;
  className?: string;
  style?: CommsStyle;
  classNames?: AvatarClassNames;
}

export function Avatar({ name, color, online, size, className, style, classNames }: AvatarProps): ReactElement {
  const theme: CommsStyle = {
    ...(size != null ? { '--comms-avatar-size': `${size}px` } : {}),
    ...(color ? { '--comms-avatar-bg': color } : {}),
    ...style,
  };
  return (
    <span className={cx('comms-avatar', className)} style={theme}>
      {initials(name)}
      {online !== undefined && (
        <span
          className={cx('comms-presence', online ? 'is-online' : 'is-offline', classNames?.presence)}
          title={online ? 'Online' : 'Offline'}
        />
      )}
    </span>
  );
}
