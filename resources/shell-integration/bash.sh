# SAFS session-only shell integration for Bash.
# Loaded with --init-file; it emulates login startup before installing hooks.

if [[ -r /etc/profile ]]; then
  . /etc/profile
fi
if [[ -r ~/.bash_profile ]]; then
  . ~/.bash_profile
elif [[ -r ~/.bash_login ]]; then
  . ~/.bash_login
elif [[ -r ~/.profile ]]; then
  . ~/.profile
fi

__safs_escape_value() {
  local LC_ALL=C value="$1" index byte code token output=''
  for ((index = 0; index < ${#value}; index++)); do
    byte="${value:index:1}"
    printf -v code '%d' "'$byte"
    if ((code < 32 || code == 127)); then
      printf -v token '\\x%02x' "$code"
    elif [[ $byte == '\' ]]; then
      token='\\'
    elif [[ $byte == ';' ]]; then
      token='\x3b'
    else
      token="$byte"
    fi
    output+="$token"
  done
  builtin printf '%s' "$output"
}

__safs_report_cwd() {
  local status=${1-$?}
  builtin printf '\e]633;P;Cwd=%s\a' "$(__safs_escape_value "$PWD")"
  return "$status"
}

__safs_prompt_command='(__safs_status=$?; if builtin declare -F __safs_report_cwd >/dev/null; then __safs_report_cwd "$__safs_status"; else exit "$__safs_status"; fi)'
if [[ $(builtin declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a '* ]]; then
  PROMPT_COMMAND+=("$__safs_prompt_command")
elif [[ -n ${PROMPT_COMMAND:-} ]]; then
  PROMPT_COMMAND="${PROMPT_COMMAND}"$'\n'"$__safs_prompt_command"
else
  PROMPT_COMMAND="$__safs_prompt_command"
fi
unset __safs_prompt_command
