import path from 'node:path';
import { shOscFunction } from './bash.js';
import { checkOptions, headerLine, home, initFileFor, shQuote, type NotifyShell } from './types.js';

/**
 * zsh, as in the spec. Each function starts with `emulate -L zsh`, so user options (sh_glob, ksh_arrays, nounset …)
 * cannot change how `<->` or the comparisons behave. `__mokkan_tty` (default /dev/tty) is where the OSC escapes go.
 */
export const zsh: NotifyShell = {
  name: 'zsh',
  installStyle: 'rc-block',
  rcFile: (env) => path.join(env.ZDOTDIR && env.ZDOTDIR !== '' ? env.ZDOTDIR : home(env), '.zshrc'),
  initFile: (env) => initFileFor(env, 'zsh'),
  rcLine: () =>
    '[ -r "${XDG_CONFIG_HOME:-$HOME/.config}/mokkan/notify/init.zsh" ] && . "${XDG_CONFIG_HOME:-$HOME/.config}/mokkan/notify/init.zsh"',
  snippet(opts) {
    checkOptions(opts);
    const osc = shOscFunction(opts, ['  emulate -L zsh']);
    return [
      headerLine(opts),
      '[[ -o interactive ]] || return 0',
      'zmodload zsh/datetime 2>/dev/null',
      'typeset -g __mokkan_dir=${XDG_CONFIG_HOME:-$HOME/.config}/mokkan/notify',
      'typeset -g __mokkan_tty=${__mokkan_tty:-/dev/tty}',
      'typeset -g __mokkan_shown=${__mokkan_shown-}',
      ...osc,
      '__mokkan_precmd() {',
      '  emulate -L zsh',
      '  [[ ${MOKKAN_NOTIFY-} == 0 ]] && return 0',
      '  local last= cur= line= now=${EPOCHSECONDS:-$(date +%s)}',
      '  [[ -r $__mokkan_dir/stamp ]] && last=$(<$__mokkan_dir/stamp)',
      '  [[ $last == <-> && ${#last} -le 15 ]] || last=0',
      `  (( now - 10#$last >= ${opts.interval} )) && { { ${shQuote(opts.node)} ${shQuote(opts.cli)} notify poll; } </dev/null >/dev/null 2>&1 &! }`,
      '  [[ -r $__mokkan_dir/shell.txt ]] && cur=$(<$__mokkan_dir/shell.txt)',
      '  [[ $cur == "$__mokkan_shown" ]] && return 0',
      '  __mokkan_shown=$cur',
      '  [[ -n $cur ]] || return 0',
      "  print -P '%F{magenta}mokkan:%f'; print -r -- \"$cur\"",
      ...(osc.length === 0 ? [] : [
        '  if [[ -n ${SSH_CONNECTION-} && -r $__mokkan_dir/osc.txt ]]; then',
        '    { while IFS= read -r line || [[ -n $line ]]; do',
        '      [[ -n $line ]] && __mokkan_osc "$line"',
        '    done <$__mokkan_dir/osc.txt >$__mokkan_tty; } 2>/dev/null',
        '  fi',
      ]),
      '  return 0',
      '}',
      'autoload -Uz add-zsh-hook; add-zsh-hook precmd __mokkan_precmd',
      '',
    ].join('\n');
  },
};
