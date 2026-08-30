# SAFS temporary ZDOTDIR entry point. Sources the user's original .zshenv.

autoload -Uz add-zsh-hook
__safs_cleanup_integration_startup() {
  command rm -f -- "$SAFS_INTEGRATION_DIR/.zshenv" \
    "$SAFS_INTEGRATION_DIR/.zprofile" "$SAFS_INTEGRATION_DIR/.zshrc"
  command rmdir -- "$SAFS_INTEGRATION_DIR" 2>/dev/null
}
add-zsh-hook zshexit __safs_cleanup_integration_startup

if [[ -r $SAFS_USER_ZDOTDIR/.zshenv ]]; then
  SAFS_INTEGRATION_ZDOTDIR=$ZDOTDIR
  ZDOTDIR=$SAFS_USER_ZDOTDIR
  . $SAFS_USER_ZDOTDIR/.zshenv
  SAFS_USER_ZDOTDIR=$ZDOTDIR
  ZDOTDIR=$SAFS_INTEGRATION_ZDOTDIR
fi

# If the user's environment disables rc loading, restore it and clean up now.
if [[ $options[norcs] = on ]]; then
  ZDOTDIR=$SAFS_USER_ZDOTDIR
  __safs_cleanup_integration_startup
  add-zsh-hook -d zshexit __safs_cleanup_integration_startup
  unfunction __safs_cleanup_integration_startup
  unset SAFS_INTEGRATION_DIR SAFS_INTEGRATION_ZDOTDIR SAFS_USER_ZDOTDIR
fi
