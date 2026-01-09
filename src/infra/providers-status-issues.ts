import { listProviderPlugins } from "../providers/plugins/index.js";
import type {
  ProviderAccountSnapshot,
  ProviderStatusIssue,
} from "../providers/plugins/types.js";

export function collectProvidersStatusIssues(
  payload: Record<string, unknown>,
): ProviderStatusIssue[] {
  const issues: ProviderStatusIssue[] = [];
  for (const plugin of listProviderPlugins()) {
    const collect = plugin.status?.collectStatusIssues;
    if (!collect) continue;

    const key = `${plugin.id}Accounts`;
    const raw = payload[key];
    if (!Array.isArray(raw)) continue;

    issues.push(...collect(raw as ProviderAccountSnapshot[]));
  }
  return issues;
}

