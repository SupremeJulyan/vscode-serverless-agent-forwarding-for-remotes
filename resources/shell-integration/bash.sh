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
  local status=$?
  builtin printf '\e]633;P;Cwd=%s\a' "$(__safs_escape_value "$PWD")"
  return "$status"
}

if [[ $(builtin declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a '* ]]; then
  PROMPT_COMMAND+=(__safs_report_cwd)
elif [[ -n ${PROMPT_COMMAND:-} ]]; then
  PROMPT_COMMAND="${PROMPT_COMMAND}"$'\n''__safs_report_cwd'
else
  PROMPT_COMMAND=__safs_report_cwd
fi

