import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions.js";
import { listSessionEntriesCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SessionMutationTarget } from "./session-sharing-target-input.js";

export function resolveSessionGroupMutationTargetsByName(
  cfg: OpenClawConfig,
): Map<string, SessionMutationTarget[]> {
  const targetsByName = new Map<string, SessionMutationTarget[]>();
  for (const storeTarget of resolveAllAgentSessionStoreTargetsSync(cfg)) {
    for (const { sessionKey, entry } of listSessionEntriesCore({
      agentId: storeTarget.agentId,
      storePath: storeTarget.storePath,
    })) {
      const groupName = normalizeOptionalString(entry.category);
      if (!groupName) {
        continue;
      }
      const targets = targetsByName.get(groupName) ?? [];
      targets.push({ sessionKey, agentId: storeTarget.agentId });
      targetsByName.set(groupName, targets);
    }
  }
  return targetsByName;
}
