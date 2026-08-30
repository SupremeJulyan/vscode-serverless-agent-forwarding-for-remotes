import * as path from 'node:path';
import { shellQuote } from './shell-quote';

const cwdOscPrefix = '\x1b]633;P;Cwd=';
const maxReportedCwdLength = 4096;

/**
 * Build a login command that adds transient cwd reporting to interactive Bash.
 * The hook lives only in the child shell environment and never edits remote
 * startup files. Existing PROMPT_COMMAND content runs before the SAFS report.
 */
export function ssh2InteractiveLoginCommand(remoteCwd?: string): string {
  const cd = remoteCwd ? `cd -- ${shellQuote(remoteCwd)} && ` : '';
  const report = `printf '\\033]633;P;Cwd=%s\\007' "$PWD"`;
  return `${cd}if [ "\${SHELL##*/}" = bash ]; then `
    + `__safs_cwd_hook=${shellQuote(report)}; `
    + `if [ -n "\${PROMPT_COMMAND:-}" ]; then `
    + `PROMPT_COMMAND="\${PROMPT_COMMAND};\${__safs_cwd_hook}"; `
    + `else PROMPT_COMMAND="\${__safs_cwd_hook}"; fi; export PROMPT_COMMAND; fi; `
    + `exec "\${SHELL:-/bin/sh}" -l`;
}

/** Parse OSC 633 cwd reports even when an SSH data frame splits the sequence. */
export class RemoteCwdOscTracker {
  private pending = '';

  push(data: string): string[] {
    this.pending += data;
    const paths: string[] = [];
    while (this.pending) {
      const start = this.pending.indexOf(cwdOscPrefix);
      if (start < 0) {
        this.pending = this.prefixTail(this.pending);
        break;
      }
      if (start > 0) this.pending = this.pending.slice(start);
      const payloadStart = cwdOscPrefix.length;
      const bell = this.pending.indexOf('\x07', payloadStart);
      const stringTerminator = this.pending.indexOf('\x1b\\', payloadStart);
      const end = bell < 0
        ? stringTerminator
        : stringTerminator < 0 ? bell : Math.min(bell, stringTerminator);
      if (end < 0) {
        if (this.pending.length > cwdOscPrefix.length + maxReportedCwdLength + 2) {
          this.pending = this.pending.slice(1);
          continue;
        }
        break;
      }
      const reported = this.pending.slice(payloadStart, end);
      const terminatorLength = end === stringTerminator ? 2 : 1;
      this.pending = this.pending.slice(end + terminatorLength);
      if (reported.length <= maxReportedCwdLength
        && path.posix.isAbsolute(reported)
        && !/[\0-\x1f\x7f]/u.test(reported)) {
        paths.push(path.posix.normalize(reported));
      }
    }
    return paths;
  }

  private prefixTail(value: string): string {
    const max = Math.min(value.length, cwdOscPrefix.length - 1);
    for (let length = max; length > 0; length--) {
      if (value.endsWith(cwdOscPrefix.slice(0, length))) return value.slice(-length);
    }
    return '';
  }
}

export function ssh2RemoteCommand(remoteCwd: string, command: string): string {
  return `cd -- ${shellQuote(remoteCwd)} && exec "\${SHELL:-/bin/sh}" -lc ${shellQuote(command)}`;
}
