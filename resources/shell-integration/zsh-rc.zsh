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
  local status=$?
  builtin printf '\e]633;P;Cwd=%s\a' "$(__safs_escape_value "$PWD")"
  return "$status"
}

add-zsh-hook precmd __safs_report_cwd

ZDOTDIR=$SAFS_USER_ZDOTDIR
__safs_cleanup_integration_startup
add-zsh-hook -d zshexit __safs_cleanup_integration_startup
unfunction __safs_cleanup_integration_startup
unset SAFS_INTEGRATION_DIR SAFS_INTEGRATION_ZDOTDIR SAFS_USER_ZDOTDIR
