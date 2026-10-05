import { escapeMarkup } from '../sanitize.js';
import { needsCommand, type NotifyBackend } from './types.js';

/**
 * `gdbus call` parses every argument as GVariant text, so plain text that happens to be valid GVariant (`'x'`,
 * `123`, `true`, `[]`) would change. Each argument is therefore written as a typed GVariant literal: strings are
 * double-quoted with `\` and `"` escaped and every non-printable character as `\uXXXX`. No argument starts with
 * `-`, so none can be read as a gdbus option.
 */
export function gvariantString(text: string): string {
  let out = '"';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (ch === '"' || ch === '\\') out += `\\${ch}`;
    else if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029) {
      out += `\\u${cp.toString(16).padStart(4, '0')}`;
    } else out += ch;
  }
  return `${out}"`;
}

/** org.freedesktop.Notifications.Notify(app_name, replaces_id, app_icon, summary, body, actions, hints, timeout). */
export const gdbus: NotifyBackend = {
  name: 'linux-gdbus',
  platforms: ['linux'],
  available: needsCommand(['linux'], 'gdbus'),
  command: (title, body) => ({
    file: 'gdbus',
    args: [
      'call', '--session', '--dest', 'org.freedesktop.Notifications', '--object-path', '/org/freedesktop/Notifications',
      '--method', 'org.freedesktop.Notifications.Notify',
      gvariantString('mokkan'), 'uint32 0', gvariantString(''), gvariantString(title), gvariantString(escapeMarkup(body)),
      '@as []', '@a{sv} {}', 'int32 -1',
    ],
  }),
};
