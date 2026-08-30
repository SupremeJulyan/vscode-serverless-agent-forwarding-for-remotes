# SAFS session-only shell integration for Fish.

function __safs_escape_value
  string join '' -- $argv | string replace --all '\\' '\\\\' | string replace --all ';' '\\x3b'
end

function __safs_report_cwd --on-event fish_prompt
  set --local previous_status $status
  if not string match --quiet --regex '[[:cntrl:]]' -- "$PWD"
    builtin printf '\e]633;P;Cwd=%s\a' (__safs_escape_value "$PWD")
  end
  return $previous_status
end

