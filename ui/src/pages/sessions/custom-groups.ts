import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";

export function sessionCategoryNames(
  result: SessionsListResult | null,
  customGroups: readonly string[],
): string[] {
  const fromRows = (result?.sessions ?? [])
    .map((row: GatewaySessionRow) => row.category?.trim())
    .filter((name): name is string => Boolean(name));
  return [...new Set([...customGroups, ...fromRows.toSorted((a, b) => a.localeCompare(b))])];
}

type GroupMutationSessions = Pick<SessionCapability, "groupsAdd" | "state">;

type SessionGroupWriteResult = "completed" | "failed" | "stale";

export async function rememberSessionCustomGroup(options: {
  name: string;
  knownCategories: readonly string[];
  sessions: GroupMutationSessions | undefined;
  isCurrent: () => boolean;
  onError: (message: string) => void;
}): Promise<SessionGroupWriteResult> {
  if (!options.sessions || options.knownCategories.includes(options.name)) {
    return "completed";
  }
  try {
    const written = await options.sessions.groupsAdd(options.name);
    // A replaced connection owns neither this catalog entry nor anything a
    // caller would key off it, so the write is reported as stale, not done. The
    // catalog owns the authoritative signal; the caller's scope adds its own, so
    // either one retiring means there is no confirmed entry to assign against.
    return written === "completed" && options.isCurrent() ? "completed" : "stale";
  } catch (error) {
    if (!options.isCurrent()) {
      return "stale";
    }
    options.onError(String(error));
    return "failed";
  }
}
