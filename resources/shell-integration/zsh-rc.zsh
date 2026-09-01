# SAFS session-only shell integration for Zsh. The temporary startup files are
# removed after the user's .zshrc has loaded; hooks remain in process memory.

if [[ -r $SAFS_USER_ZDOTDIR/.zshrc ]]; then
  SAFS_INTEGRATION_ZDOTDIR=$ZDOTDIR
  ZDOTDIR=$SAFS_USER_ZDOTDIR
  . $SAFS_USER_ZDOTDIR/.zshrc
  SAFS_USER_ZDOTDIR=$ZDOTDIR
  ZDOTDIR=$SAFS_INTEGRATION_ZDOTDIR
fi

autoload -Uz add-zsh-hook

__safs_escape_value() {
  emulate -L zsh
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
  builtin print -rn -- "$output"
}

__safs_report_cwd() {
  local status=${1-$?}
  builtin printf '\e]633;P;Cwd=%s\a' "$(__safs_escape_value "$PWD")"
  return "$status"
}

__safs_prompt_start() { builtin printf '\e]633;A\a'; }
__safs_prompt_end() { builtin printf '\e]633;B\a'; }

__safs_current_command=''
__safs_prior_prompt=''

__safs_precmd() {
  local status=$?
  if [[ -n $__safs_current_command ]]; then
    builtin printf '\e]633;D;%s\a' "$status"
  fi
  __safs_report_cwd "$status"
  __safs_current_command=''
  __safs_prior_prompt=$PS1
  PS1="%{$(__safs_prompt_start)%}${PS1}%{$(__safs_prompt_end)%}"
  return "$status"
}

__safs_preexec() {
  PS1=$__safs_prior_prompt
  __safs_current_command=$1
  builtin printf '\e]633;E;%s\a' "$(__safs_escape_value "$1")"
  builtin printf '\e]633;C\a'
}

add-zsh-hook precmd __safs_precmd
add-zsh-hook preexec __safs_preexec
builtin printf '\e]633;P;HasRichCommandDetection=True\a'

ZDOTDIR=$SAFS_USER_ZDOTDIR
__safs_cleanup_integration_startup
add-zsh-hook -d zshexit __safs_cleanup_integration_startup
unfunction __safs_cleanup_integration_startup
unset SAFS_INTEGRATION_DIR SAFS_INTEGRATION_ZDOTDIR SAFS_USER_ZDOTDIR
