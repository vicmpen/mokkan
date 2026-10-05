import path from 'node:path';
import { checkOptions, fishQuote, headerLine, initFileFor, oscFormats, oscModesFor, xdgConfigHome, type NotifyShell, type SnippetOptions } from './types.js';

function fishOscFunction(opts: SnippetOptions): string[] {
  const modes = oscModesFor(opts.osc);
  if (modes.length === 0) return [];
  // In fish single quotes `\\` is one backslash, so printf's `\\` is written `\\\\`.
  const f = oscFormats('\\\\\\\\');
  const emit = (m: '9' | '777' | '99', i: string): string[] => [
    `${i}if test -n "$TMUX"`,
    `${i}    printf '${f[m].tmux}' $argv[1]`,
    `${i}else`,
    `${i}    printf '${f[m].plain}' $argv[1]`,
    `${i}end`,
  ];
  const lines = ['function __mokkan_osc'];
  if (modes.length === 1) {
    lines.push(...emit(modes[0]!, '    '));
  } else {
    lines.push(
      '    set -l m 9',
      '    switch "$TERM_PROGRAM"',
      '        case kitty',
      '            set m 99',
      "        case 'foot*'",
      '            set m 777',
      '    end',
      '    switch "$TERM"',
      '        case xterm-kitty',
      '            set m 99',
      "        case 'foot*'",
      '            set m 777',
      '    end',
      '    switch $m',
      ...modes.flatMap((m) => [`        case ${m === '9' ? "'*'" : m}`, ...emit(m, '            ')]),
      '    end',
    );
  }
  lines.push('end');
  return lines;
}

/**
 * fish 3.1 or later (`string collect`). The conf.d drop-in (`rcLine`) is a stable file that only sources
 * `init.fish`, so a new version or setting rewrites the generated file in the state directory and never the user's
 * config. The background poll is guarded with `test -x` because fish itself reports a missing command, not the
 * redirected child; `disown` keeps fish from printing "Job … has ended".
 */
export const fish: NotifyShell = {
  name: 'fish',
  installStyle: 'drop-in',
  rcFile: (env) => path.join(xdgConfigHome(env), 'fish', 'conf.d', 'mokkan.fish'),
  initFile: (env) => initFileFor(env, 'fish'),
  rcLine: () => [
    '# managed by mokkan: sources the notify prompt hook; remove with: mokkan notify remove',
    'status is-interactive; or exit',
    'set -l __mokkan_init "$HOME/.config/mokkan/notify/init.fish"',
    'test -n "$XDG_CONFIG_HOME"; and set __mokkan_init "$XDG_CONFIG_HOME/mokkan/notify/init.fish"',
    'test -r "$__mokkan_init"; and source "$__mokkan_init"',
    '',
  ].join('\n'),
  snippet(opts) {
    checkOptions(opts);
    const osc = fishOscFunction(opts);
    const node = fishQuote(opts.node);
    return [
      headerLine(opts),
      'status is-interactive; or exit',
      'if test -n "$XDG_CONFIG_HOME"',
      '    set -g __mokkan_dir "$XDG_CONFIG_HOME/mokkan/notify"',
      'else',
      '    set -g __mokkan_dir "$HOME/.config/mokkan/notify"',
      'end',
      'set -q __mokkan_tty[1]; or set -g __mokkan_tty /dev/tty',
      "set -q __mokkan_shown; or set -g __mokkan_shown ''",
      ...osc,
      'function __mokkan_prompt --on-event fish_prompt',
      '    test "$MOKKAN_NOTIFY" = 0; and return 0',
      '    set -l last',
      '    test -r "$__mokkan_dir/stamp"; and read last <"$__mokkan_dir/stamp"',
      "    string match -qr '^[0-9]{1,15}$' -- \"$last\"; or set last 0",
      '    set -l now (date +%s)',
      `    if test (math $now - $last) -ge ${opts.interval}; and test -x ${node}`,
      `        command ${node} ${fishQuote(opts.cli)} notify poll </dev/null >/dev/null 2>&1 &`,
      '        disown $last_pid 2>/dev/null',
      '    end',
      '    set -l cur',
      '    test -r "$__mokkan_dir/shell.txt"; and set cur (string collect <"$__mokkan_dir/shell.txt")',
      '    test "x$cur" = "x$__mokkan_shown"; and return 0',
      '    set -g __mokkan_shown "$cur"',
      '    test -n "$cur"; or return 0',
      '    set_color magenta; echo mokkan:; set_color normal',
      "    printf '%s\\n' \"$cur\"",
      ...(osc.length === 0 ? [] : [
        '    if test -n "$SSH_CONNECTION" -a -r "$__mokkan_dir/osc.txt"',
        '        # fish itself reports a redirection that fails (no controlling terminal), so check first.',
        '        if test "$__mokkan_tty" = /dev/tty -a -t 1; or test "$__mokkan_tty" != /dev/tty -a -w "$__mokkan_tty"',
        '            while read -l line',
        '                test -n "$line"; and __mokkan_osc "$line"',
        '            end <"$__mokkan_dir/osc.txt" 2>/dev/null >"$__mokkan_tty"',
        '        end',
        '    end',
      ]),
      'end',
      '',
    ].join('\n');
  },
};
