/**
 * The two shell wrappers `wsc --completion <shell>` prints.
 *
 * They are deliberately thin: hand the line up to the cursor to `wsc __complete`, read the
 * directive it answers with, and give the candidates to the shell. Every decision — what
 * to offer, how to escape it for bash — is made in JavaScript, where it is tested.
 *
 * Both silence stderr and swallow a failing `wsc`: a Tab press must never print anything.
 */

/** @typedef {import('./shells.js').CompletionShell} CompletionShell */

// `\${` below is a literal `${` in the emitted script: in a template literal it would
// otherwise start an interpolation.
export const ZSH_SCRIPT = `#compdef wsc
# Tab completion for wsc. Add this to ~/.zshrc:
#   source <(wsc --completion zsh)

# The one place that reads ZLE's BUFFER and CURSOR, kept apart so the tests can replace it.
_wsc_line() { REPLY=\${BUFFER[1,CURSOR]} }

_wsc() {
  local -a reply_lines
  _wsc_line
  reply_lines=("\${(@f)$(command wsc __complete zsh "$REPLY" 2>/dev/null)}")
  local directive=\${reply_lines[1]}
  shift reply_lines
  case $directive in
    values) (( \${#reply_lines} )) && compadd -- "\${reply_lines[@]}" ;;
    dirs) _files -/ ;;
  esac
  return 0
}

if ! (( $+functions[compdef] )); then
  autoload -Uz compinit && compinit
fi
compdef _wsc wsc
`;

export const BASH_SCRIPT = `# Tab completion for wsc. Add this to ~/.bashrc:
#   source <(wsc --completion bash)

_wsc() {
  local out directive line rest
  COMPREPLY=()
  out=$(command wsc __complete bash "\${COMP_LINE:0:COMP_POINT}" "$COMP_WORDBREAKS" 2>/dev/null) || return 0
  directive=\${out%%$'\\n'*}
  case $directive in
    values)
      [[ $out == *$'\\n'* ]] || return 0
      rest=\${out#*$'\\n'}
      while IFS= read -r line; do
        [[ -n $line ]] && COMPREPLY+=("$line")
      done <<< "$rest"
      ;;
    dirs)
      compopt -o filenames 2>/dev/null
      while IFS= read -r line; do
        COMPREPLY+=("$line")
      done < <(compgen -d -- "\${COMP_WORDS[COMP_CWORD]}")
      ;;
  esac
  return 0
}

complete -F _wsc wsc
`;

/**
 * @param {CompletionShell} shell
 * @returns {string}
 */
export function completionScript(shell) {
    return shell === 'zsh' ? ZSH_SCRIPT : BASH_SCRIPT;
}
