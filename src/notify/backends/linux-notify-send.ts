import { escapeMarkup } from '../sanitize.js';
import { needsCommand, type NotifyBackend } from './types.js';

/** libnotify's notify-send. The body is Pango markup on GNOME and KDE, so it is escaped; the summary is plain. */
export const notifySend: NotifyBackend = {
  name: 'linux-notify-send',
  platforms: ['linux'],
  available: needsCommand(['linux'], 'notify-send'),
  command: (title, body) => ({
    file: 'notify-send',
    args: ['--app-name=mokkan', '--', title, escapeMarkup(body)],
  }),
};
