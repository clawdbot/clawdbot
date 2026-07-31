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

type GroupMutationSessions = Pick<SessionCapability, "groupsPut" | "state">;

export async function rememberSessionCustomGroup(options: {
  name: string;
  knownCategories: readonly string[];
  sessions: GroupMutationSessions | undefined;
  isCurrent: () => boolean;
  onError: (message: string) => void;
}): Promise<void> {
  if (!options.sessions || options.knownCategories.includes(options.name)) {
    return;
  }
  try {
    await options.sessions.groupsPut([...(options.sessions.state.groups ?? []), options.name]);
  } catch (error) {
    if (options.isCurrent()) {
      options.onError(String(error));
    }
  }
}
