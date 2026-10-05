import { needsCommand, type NotifyBackend } from './types.js';

/**
 * The script is constant; title and body are `on run` arguments. They are read from the end of argv, so the
 * result is the same whether or not osascript passes the `--` (which keeps a title starting with `-` from being
 * read as an option) through to the script.
 */
export const OSASCRIPT_LINES = [
  'on run argv',
  'display notification (item -1 of argv) with title (item -2 of argv)',
  'end run',
];

export const osascript: NotifyBackend = {
  name: 'macos-osascript',
  platforms: ['macos'],
  // Part of every macOS install; notifications are attributed to Script Editor.
  available: async (facts) => facts.os === 'macos',
  command: (title, body) => ({
    file: 'osascript',
    args: [...OSASCRIPT_LINES.flatMap((line) => ['-e', line]), '--', title, body],
  }),
};
