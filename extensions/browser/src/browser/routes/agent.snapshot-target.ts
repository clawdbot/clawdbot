/** Resolve the correct targetId after a navigation that may trigger a renderer swap. */
export async function resolveTargetIdAfterNavigate(opts: {
  oldTargetId: string;
  navigatedUrl: string;
  listTabs: () => Promise<Array<{ targetId: string; url: string }>>;
  retryDelayMs?: number;
}): Promise<string> {
  let currentTargetId = opts.oldTargetId;
  try {
    const pickReplacement = (
      tabs: Array<{ targetId: string; url: string }>,
      options?: { allowSingleTabFallback?: boolean },
    ): { targetId: string; shouldRetry: boolean } => {
      if (tabs.some((tab) => tab.targetId === opts.oldTargetId)) {
        return { targetId: opts.oldTargetId, shouldRetry: false };
      }
      const byUrl = tabs.filter((tab) => tab.url === opts.navigatedUrl);
      if (byUrl.length === 1) {
        return { targetId: byUrl[0]?.targetId ?? opts.oldTargetId, shouldRetry: false };
      }
      const uniqueReplacement = byUrl.filter((tab) => tab.targetId !== opts.oldTargetId);
      if (uniqueReplacement.length === 1) {
        return {
          targetId: uniqueReplacement[0]?.targetId ?? opts.oldTargetId,
          shouldRetry: false,
        };
      }
      if (options?.allowSingleTabFallback && tabs.length === 1) {
        return { targetId: tabs[0]?.targetId ?? opts.oldTargetId, shouldRetry: false };
      }
      return { targetId: opts.oldTargetId, shouldRetry: true };
    };

    const first = pickReplacement(await opts.listTabs());
    currentTargetId = first.targetId;
    if (first.shouldRetry) {
      await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 800));
      currentTargetId = pickReplacement(await opts.listTabs(), {
        allowSingleTabFallback: true,
      }).targetId;
    }
  } catch {
    // Best-effort: fall back to pre-navigation targetId.
  }
  return currentTargetId;
}
