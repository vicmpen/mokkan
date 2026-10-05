import { needsCommand, type NotifyBackend } from './types.js';

/**
 * terminal-notifier reads its options through NSUserDefaults, which parses a value as a property list (`(a,b)`,
 * `{…}`, `<…>`, `"…"`) and may take a value starting with `-` for an option; it also strips one leading `\` from the
 * message. A value whose first character could trigger any of that gets an invisible WORD JOINER in front, which
 * no property list starts with, so the text shows unchanged.
 */
const RISKY_START = /^[-[({<"'\\\s]/;

export function guardDefaultsValue(text: string): string {
  return text === '' || RISKY_START.test(text) ? `⁠${text}` : text;
}

export const terminalNotifier: NotifyBackend = {
  name: 'macos-terminal-notifier',
  platforms: ['macos'],
  available: needsCommand(['macos'], 'terminal-notifier'),
  command: (title, body) => ({
    file: 'terminal-notifier',
    args: ['-title', guardDefaultsValue(title), '-message', guardDefaultsValue(body), '-group', 'mokkan'],
  }),
};
