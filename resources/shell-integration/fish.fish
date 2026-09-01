# SAFS session-only shell integration for Fish.

function __safs_escape_value
  string join '' -- $argv | string replace --all '\\' '\\\\' | string replace --all ';' '\\x3b'
end

function __safs_escape_sequence
  builtin printf '\e]633;%s\a' (string join ';' -- $argv)
end

function __safs_preexec --on-event fish_preexec
  __safs_escape_sequence E (__safs_escape_value "$argv")
  __safs_escape_sequence C
  set --global __safs_command_ran 1
end

function __safs_postexec --on-event fish_postexec
  __safs_escape_sequence D $status
end

if functions --query fish_prompt
  functions --copy fish_prompt __safs_user_fish_prompt
else
  function __safs_user_fish_prompt
    echo -n (whoami)@(prompt_hostname)' ' (prompt_pwd) '> '
  end
end

function fish_prompt
  if not string match --quiet --regex '[[:cntrl:]]' -- "$PWD"
    __safs_escape_sequence P Cwd=(__safs_escape_value "$PWD")
  end
  __safs_escape_sequence A
  __safs_user_fish_prompt
  __safs_escape_sequence B
  set --erase __safs_command_ran
end

__safs_escape_sequence P HasRichCommandDetection=True
