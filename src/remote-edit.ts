import { createHash } from 'node:crypto';

export interface RemoteTextEdit {
  oldText: string;
  newText: string;
}

export const maxRemoteEditFileBytes = 1024 * 1024;
export const maxRemoteEdits = 100;

export function textSha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function applyRemoteTextEdits(
  content: string, edits: RemoteTextEdit[]
): { content: string; replacements: number } {
  if (edits.length === 0) throw new Error('remote_edit 至少需要一项 edit');
  if (edits.length > maxRemoteEdits) {
    throw new Error(`remote_edit 一次最多接受 ${maxRemoteEdits} 项 edit`);
  }
  let updated = content;
  for (const [index, edit] of edits.entries()) {
    if (!edit.oldText) throw new Error(`remote_edit edits[${index}].oldText 不能为空`);
    const first = updated.indexOf(edit.oldText);
    if (first < 0) throw new Error(`remote_edit edits[${index}] 未找到精确匹配`);
    if (updated.indexOf(edit.oldText, first + 1) >= 0) {
      throw new Error(`remote_edit edits[${index}] 匹配到多处，请提供更多上下文使其唯一`);
    }
    updated = updated.slice(0, first) + edit.newText
      + updated.slice(first + edit.oldText.length);
  }
  return { content: updated, replacements: edits.length };
}
