import { osascript } from './macos-osascript.js';
import { terminalNotifier } from './macos-terminal-notifier.js';
import { gdbus } from './linux-gdbus.js';
import { kdialog } from './linux-kdialog.js';
import { notifySend } from './linux-notify-send.js';
import type { NotifyBackend } from './types.js';

export type { NotifyBackend } from './types.js';

/** Every desktop backend, in preference order: the first available one on the platform is used. */
export const BACKENDS: readonly NotifyBackend[] = [terminalNotifier, osascript, notifySend, gdbus, kdialog];
