import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  checkOptions, headerLine, home, initFileFor, oscFormats, oscModesFor, shQuote, type NotifyShell, type SnippetOptions,
} from './types.js';

/**
 * `__mokkan_osc TEXT`: one OSC notification for the current terminal (shared by zsh and bash, whose printf both take
 * `\033`-style escapes). For `auto` the sequence is picked from TERM/TERM_PROGRAM at print time; with TMUX set it is
 * wrapped for tmux passthrough.
 */
export function shOscFunction(opts: SnippetOptions, prelude: string[] = []): string[] {
  const modes = oscModesFor(opts.osc);
  if (modes.length === 0) return [];
  const f = oscFormats('\\\\');
  const emit = (m: '9' | '777' | '99', indent: string): string =>
    `${indent}if [[ -n \${TMUX-} ]]; then printf '${f[m].tmux}' "$1"; else printf '${f[m].plain}' "$1"; fi`;
  const lines = ['__mokkan_osc() {', ...prelude];
  if (modes.length === 1) {
    lines.push(emit(modes[0]!, '  '));
  } else {
    lines.push(
      '  local m=9',
      '  case ${TERM_PROGRAM-} in kitty) m=99 ;; foot*) m=777 ;; esac',
      '  case ${TERM-} in xterm-kitty) m=99 ;; foot*) m=777 ;; esac',
      '  case $m in',
      ...modes.map((m) => `    ${m === '9' ? '*' : m})\n${emit(m, '      ')} ;;`),
      '  esac',
    );
  }
  lines.push('}');
  return lines;
}

/**
 * bash 3.2 (macOS) and later. Hooks into bash-preexec's `precmd_functions` when it is loaded, else appends to an array
 * PROMPT_COMMAND (bash >= 5.1; older bash runs only element 0, so there the string form is used) or to the string one after a newline, once even when sourced twice. The hook keeps
 * `$?` for the prompt. `__mokkan_tty` (default /dev/tty) is where the OSC escapes go; tests point it at a file.
 */
export const bash: NotifyShell = {
  name: 'bash',
  installStyle: 'rc-block',
  rcFile(env, platform) {
    const profile = path.join(home(env), '.bash_profile');
    return platform === 'darwin' && existsSync(profile) ? profile : path.join(home(env), '.bashrc');
  },
  initFile: (env) => initFileFor(env, 'bash'),
  rcLine: () =>
    '[ -r "${XDG_CONFIG_HOME:-$HOME/.config}/mokkan/notify/init.bash" ] && . "${XDG_CONFIG_HOME:-$HOME/.config}/mokkan/notify/init.bash"',
  snippet(opts) {
    checkOptions(opts);
    const osc = shOscFunction(opts);
    return [
      headerLine(opts),
      '[[ $- == *i* ]] || return 0',
      '__mokkan_dir=${XDG_CONFIG_HOME:-$HOME/.config}/mokkan/notify',
      '__mokkan_tty=${__mokkan_tty:-/dev/tty}',
      '__mokkan_shown=${__mokkan_shown-}',
      "__mokkan_nl=$'\\n'",
      ...osc,
      '__mokkan_show() {',
      '  [[ ${MOKKAN_NOTIFY-} == 0 ]] && return 0',
      '  local last= cur= line= now=${EPOCHSECONDS:-$(date +%s)}',
      // `|| :`: read returns 1 at end of file without a newline (always, for -d ''), which would end a shell that has
      // `set -e`, since the hook runs from PROMPT_COMMAND.
      '  [[ -r $__mokkan_dir/stamp ]] && { read -r last <"$__mokkan_dir/stamp" || :; }',
      '  case $last in \'\'|*[!0-9]*) last=0 ;; esac',
      '  (( ${#last} > 15 )) && last=0',
      `  if (( now - 10#$last >= ${opts.interval} )); then`,
      `    ( ${shQuote(opts.node)} ${shQuote(opts.cli)} notify poll </dev/null >/dev/null 2>&1 & ) 2>/dev/null`,
      '  fi',
      "  [[ -r $__mokkan_dir/shell.txt ]] && { IFS= read -r -d '' cur <\"$__mokkan_dir/shell.txt\" || :; }",
      '  cur=${cur%"$__mokkan_nl"}',
      '  [[ $cur == "$__mokkan_shown" ]] && return 0',
      '  __mokkan_shown=$cur',
      '  [[ -n $cur ]] || return 0',
      "  printf '\\033[35mmokkan:\\033[0m\\n'",
      "  printf '%s\\n' \"$cur\"",
      ...(osc.length === 0 ? [] : [
        '  if [[ -n ${SSH_CONNECTION-} && -r $__mokkan_dir/osc.txt ]]; then',
        '    { while IFS= read -r line || [[ -n $line ]]; do',
        '      [[ -n $line ]] && __mokkan_osc "$line"',
        '    done <"$__mokkan_dir/osc.txt" >"$__mokkan_tty"; } 2>/dev/null',
        '  fi',
      ]),
      '  return 0',
      '}',
      '__mokkan_prompt() { local s=$?; __mokkan_show; return $s; }',
      'if [[ -n ${bash_preexec_imported-}${__bp_imported-} ]] || declare -F __bp_install >/dev/null 2>&1; then',
      '  [[ " ${precmd_functions[*]-} " == *" __mokkan_prompt "* ]] || precmd_functions+=(__mokkan_prompt)',
      'elif (( BASH_VERSINFO[0] * 100 + BASH_VERSINFO[1] >= 501 )) && [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == "declare -a"* ]]; then',
      '  [[ " ${PROMPT_COMMAND[*]} " == *" __mokkan_prompt "* ]] || PROMPT_COMMAND+=(__mokkan_prompt)',
      'else',
      '  [[ ${PROMPT_COMMAND-} == *__mokkan_prompt* ]] || PROMPT_COMMAND=${PROMPT_COMMAND:+$PROMPT_COMMAND$__mokkan_nl}__mokkan_prompt',
      'fi',
      '',
    ].join('\n');
  },
};
