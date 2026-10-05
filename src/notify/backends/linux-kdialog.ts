import { needsCommand, type NotifyBackend } from './types.js';

/** KDE's kdialog: a passive popup for 10 seconds. Qt takes the argument after an option as its value. */
export const kdialog: NotifyBackend = {
  name: 'linux-kdialog',
  platforms: ['linux'],
  available: needsCommand(['linux'], 'kdialog'),
  command: (title, body) => ({
    file: 'kdialog',
    args: ['--title', title, '--passivepopup', body, '10'],
  }),
};
