import { listProviderPlugins } from "../providers/plugins/index.js";
import type {
  ProviderAccountSnapshot,
  ProviderStatusIssue,
} from "../providers/plugins/types.js";

export function collectProvidersStatusIssues(
  payload: Record<string, unknown>,
): ProviderStatusIssue[] {
  const issues: ProviderStatusIssue[] = [];
  const accountsByProvider = payload.providerAccounts as
    | Record<string, unknown>
    | undefined;
  for (const plugin of listProviderPlugins()) {
    const collect = plugin.status?.collectStatusIssues;
    if (!collect) continue;
    const raw = accountsByProvider?.[plugin.id];
    if (!Array.isArray(raw)) continue;

    issues.push(...collect(raw as ProviderAccountSnapshot[]));
  }
  return issues;
}
