# SAFS temporary ZDOTDIR profile wrapper.

if [[ -o login && -r $SAFS_USER_ZDOTDIR/.zprofile ]]; then
  SAFS_INTEGRATION_ZDOTDIR=$ZDOTDIR
  ZDOTDIR=$SAFS_USER_ZDOTDIR
  . $SAFS_USER_ZDOTDIR/.zprofile
  SAFS_USER_ZDOTDIR=$ZDOTDIR
  ZDOTDIR=$SAFS_INTEGRATION_ZDOTDIR
fi

if [[ $options[norcs] = on ]]; then
  ZDOTDIR=$SAFS_USER_ZDOTDIR
  __safs_cleanup_integration_startup
  add-zsh-hook -d zshexit __safs_cleanup_integration_startup
  unfunction __safs_cleanup_integration_startup
  unset SAFS_INTEGRATION_DIR SAFS_INTEGRATION_ZDOTDIR SAFS_USER_ZDOTDIR
fi
