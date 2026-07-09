import type { GatewaySessionRow } from "../../api/types.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import type { SessionCapability } from "./index.ts";
import { parseAgentSessionKey } from "./session-key.ts";

const SESSION_CUSTOM_GROUPS_STORAGE_KEY = "openclaw:sessions:custom-groups";

export function loadStoredSessionCustomGroups(): string[] {
  try {
    const raw = getSafeLocalStorage()?.getItem(SESSION_CUSTOM_GROUPS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return [
      ...new Set(
        parsed.flatMap((name) => {
          const normalized = typeof name === "string" ? name.trim() : "";
          return normalized ? [normalized] : [];
        }),
      ),
    ];
  } catch {
    return [];
  }
}

export function saveStoredSessionCustomGroups(groups: readonly string[]) {
  try {
    const normalized = [...new Set(groups.map((name) => name.trim()).filter(Boolean))];
    getSafeLocalStorage()?.setItem(SESSION_CUSTOM_GROUPS_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Assigned groups still persist server-side via the session category field.
  }
}

/** Move one custom group before another while preserving every other group. */
export function reorderSessionCustomGroups(
  groups: readonly string[],
  source: string,
  target: string,
  position: "before" | "after" = "before",
): string[] {
  const ordered = [...new Set(groups.map((name) => name.trim()).filter(Boolean))];
  const sourceIndex = ordered.indexOf(source);
  const targetIndex = ordered.indexOf(target);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
    return ordered;
  }
  const [moved] = ordered.splice(sourceIndex, 1);
  const targetInsertionIndex = ordered.indexOf(target) + (position === "after" ? 1 : 0);
  ordered.splice(targetInsertionIndex, 0, moved);
  return ordered;
}

type SessionGroupClient = Pick<SessionCapability, "list" | "patch">;

// The gateway caps sessions.list at a 100-row default when no limit is sent
// (SESSIONS_LIST_DEFAULT_LIMIT), so enumeration must page via nextOffset or a
// silent cap strands members in the old group. The page cap only bounds runaway
// servers; 50 x 200 rows is far past any realistic session store.
const GROUP_MEMBER_PAGE_LIMIT = 200;
const GROUP_MEMBER_PAGE_CAP = 50;

async function collectSessionGroupWindow(
  sessions: SessionGroupClient,
  group: string,
  showArchived: boolean,
  members: Map<string, GatewaySessionRow>,
): Promise<void> {
  let offset = 0;
  for (let page = 0; page < GROUP_MEMBER_PAGE_CAP; page += 1) {
    const result = await sessions.list({
      activeMinutes: 0,
      limit: GROUP_MEMBER_PAGE_LIMIT,
      ...(offset > 0 ? { offset } : {}),
      ...(showArchived ? { showArchived: true } : {}),
    });
    for (const row of result?.sessions ?? []) {
      if (row.category?.trim() === group && !members.has(row.key)) {
        members.set(row.key, row);
      }
    }
    const nextOffset = result?.hasMore ? result.nextOffset : null;
    if (typeof nextOffset !== "number" || nextOffset <= offset) {
      return;
    }
    offset = nextOffset;
  }
}

/**
 * Enumerate every session assigned to the group. The shared sidebar/page lists
 * are windowed (recent, active-only, per-agent), so group mutations must not
 * derive membership from them: `sessions.list` filters archived rows either-or,
 * hence the two paged queries.
 */
async function listSessionGroupMembers(
  sessions: SessionGroupClient,
  group: string,
): Promise<GatewaySessionRow[]> {
  const members = new Map<string, GatewaySessionRow>();
  await Promise.all([
    collectSessionGroupWindow(sessions, group, false, members),
    collectSessionGroupWindow(sessions, group, true, members),
  ]);
  return [...members.values()];
}

function patchSessionGroupMembers(
  sessions: SessionGroupClient,
  members: readonly GatewaySessionRow[],
  category: string | null,
): Promise<unknown> {
  // allSettled: one failed patch must not abandon the rest of the group; the
  // capability already publishes patch errors to its shared state.
  return Promise.allSettled(
    members.map((row) =>
      sessions.patch(row.key, { category }, { agentId: parseAgentSessionKey(row.key)?.agentId }),
    ),
  );
}

/** Rename a group everywhere: the stored group list plus every member session. */
export async function renameSessionGroup(
  sessions: SessionGroupClient,
  from: string,
  to: string,
): Promise<void> {
  const stored = loadStoredSessionCustomGroups();
  saveStoredSessionCustomGroups([
    ...new Set(
      stored.includes(from) ? stored.map((name) => (name === from ? to : name)) : [...stored, to],
    ),
  ]);
  const members = await listSessionGroupMembers(sessions, from);
  await patchSessionGroupMembers(sessions, members, to);
}

/** Delete a group: member sessions are kept and move back to Ungrouped. */
export async function dissolveSessionGroup(
  sessions: SessionGroupClient,
  group: string,
): Promise<void> {
  saveStoredSessionCustomGroups(loadStoredSessionCustomGroups().filter((name) => name !== group));
  const members = await listSessionGroupMembers(sessions, group);
  await patchSessionGroupMembers(sessions, members, null);
}
