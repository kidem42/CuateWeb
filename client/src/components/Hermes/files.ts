import {
  hermesDisplayRows,
  hermesMessagePaths,
  hermesSplitAttachments,
  hermesText,
} from 'librechat-data-provider';
import type { HermesMessage } from 'librechat-data-provider';

export type SessionFile = { path: string; source: 'assistant' | 'user' };

/** Native MEDIA deliveries are file references, regardless of extension or preview support. */
function mediaPaths(text: string): string[] {
  const paths: string[] = [];
  const pattern =
    /(?:^|\s)MEDIA:[ \t]*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|`([^`\r\n]+)`|((?:\/(?!\/)|~\/)[^\s<>"`]+))/g;
  for (const match of text.matchAll(pattern)) {
    paths.push(match[1] ?? match[2] ?? match[3] ?? match[4]);
  }
  return paths;
}

/** Files handed over in this session, newest first; never infer a host working directory. */
export function sessionFiles(history: HermesMessage[]): SessionFile[] {
  const rows = hermesDisplayRows(history);
  const found = new Set<string>();
  const result: SessionFile[] = [];
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    if (row.role !== 'assistant' && row.role !== 'user') continue;
    const source = row.role;
    const paths =
      source === 'user'
        ? hermesSplitAttachments(hermesText(row)).paths
        : [
            ...hermesMessagePaths({ ...row, tool_calls: undefined }),
            ...mediaPaths(hermesText(row)),
          ];
    for (const raw of paths) {
      const path = raw.startsWith('sandbox:/') ? raw.slice(8) : raw;
      if (!/^(?:\/(?!\/)|~\/).+[^/]$/.test(path) || /[\r\n\0]/.test(path)) continue;
      const key = source + ':' + path;
      if (found.has(key)) continue;
      found.add(key);
      result.push({ path, source });
    }
  }
  return result;
}

export function fileParent(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}
