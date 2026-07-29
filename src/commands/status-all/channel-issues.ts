// Groups channel-scoped status issues for status report table rendering.
// Kept tiny so both text and report builders share identical issue ordering.

/** Groups issue-like rows by channel id while preserving the original issue order per channel. */
export function groupChannelIssuesByChannel<T extends { channel: string }>(
  issues: readonly T[],
): Map<string, T[]> {
  const byChannel = new Map<string, T[]>();
  for (const issue of issues) {
    const key = issue.channel;
    const list = byChannel.get(key);
    if (list) {
      list.push(issue);
    } else {
      byChannel.set(key, [issue]);
    }
  }
  return byChannel;
}
