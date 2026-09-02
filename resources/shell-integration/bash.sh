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

__safs_prompt_start() { builtin printf '\e]633;A\a'; }
__safs_prompt_end() { builtin printf '\e]633;B\a'; }

__safs_first_prompt=''
__safs_in_command=1
__safs_current_command=''
__safs_command_status=0

# PROMPT_COMMAND may run arbitrary user hooks before SAFS. Capture the command
# status first and return it unchanged so the existing first hook still sees
# the real `$?` value.
__safs_prompt_capture() {
  local status=$?
  __safs_command_status=$status
  return "$status"
}

# Run last in PROMPT_COMMAND. This must execute in the current shell: using a
# `( ... )` subshell loses __safs_in_command/__safs_first_prompt and prevents
# the next DEBUG/preexec hook from reporting E/C/D command boundaries.
__safs_prompt_finish() {
  local status=$__safs_command_status
  if builtin declare -F __safs_report_cwd >/dev/null; then
    if (( ${__safs_rich_command_detection:-0} )) && [[ -n ${__safs_current_command:-} ]]; then
      builtin printf '\e]633;D;%s\a' "$status"
    fi
    __safs_report_cwd "$status"
    __safs_first_prompt=1
    __safs_current_command=''
    __safs_in_command=0
  fi
  return "$status"
}

__safs_preexec() {
  local status=$?
  if [[ $__safs_in_command == 0 ]]; then
    __safs_in_command=1
    if [[ -n ${1:-} ]]; then
      __safs_current_command=$1
    else
      __safs_current_command=$(builtin history 1)
      __safs_current_command=${__safs_current_command#*[0-9]  }
    fi
    builtin printf '\e]633;E;%s\a' "$(__safs_escape_value "$__safs_current_command")"
    builtin printf '\e]633;C\a'
  fi
  return "$status"
}

__safs_debug_trap=$(builtin trap -p DEBUG)
__safs_rich_command_detection=0
if [[ $- == *i* && -z ${BLE_VERSION:-} && -n ${bash_preexec_imported:-} ]]; then
  preexec_functions+=(__safs_preexec)
  __safs_rich_command_detection=1
elif [[ $- == *i* && -z $__safs_debug_trap ]]; then
  builtin trap '__safs_preexec' DEBUG
  __safs_rich_command_detection=1
fi

if [[ $(builtin declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a '* ]]; then
  PROMPT_COMMAND=(__safs_prompt_capture "${PROMPT_COMMAND[@]}" __safs_prompt_finish)
elif [[ -n ${PROMPT_COMMAND:-} ]]; then
  PROMPT_COMMAND="__safs_prompt_capture"$'\n'"${PROMPT_COMMAND}"$'\n'"__safs_prompt_finish"
else
  PROMPT_COMMAND=$'__safs_prompt_capture\n__safs_prompt_finish'
fi

PS1="\[$(__safs_prompt_start)\]${PS1}\[$(__safs_prompt_end)\]"
if (( __safs_rich_command_detection )); then
  builtin printf '\e]633;P;HasRichCommandDetection=True\a'
fi
