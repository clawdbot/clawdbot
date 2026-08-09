type NoticeSource = { notices?: readonly string[] } | undefined;

export function mergeNotices(sources: NoticeSource[]): string[] {
  return [...new Set(sources.flatMap((source) => (source?.notices ? [...source.notices] : [])))];
}
