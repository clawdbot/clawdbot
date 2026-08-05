import { resolveStorePath } from "../../config/sessions.js";
import { loadSessionEntry as getSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";

/** Linearizes a host-scoped grant against reset/delete of its expected incarnation. */
export async function runWithScopedSessionAccess<T>(params: {
  cfg: OpenClawConfig;
  expectedSessionId?: string;
  targetSessionKey: string;
  run: () => Promise<T>;
}): Promise<T> {
  const expectedSessionId = params.expectedSessionId?.trim();
  if (!expectedSessionId) {
    return await params.run();
  }
  const agentId = resolveAgentIdFromSessionKey(params.targetSessionKey);
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  const assertExpectedIncarnation = () => {
    const current = getSessionEntry({ storePath, sessionKey: params.targetSessionKey });
    if (current?.sessionId !== expectedSessionId || current.archivedAt !== undefined) {
      throw new Error(`Session "${params.targetSessionKey}" changed after access was granted.`);
    }
  };
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [params.targetSessionKey, expectedSessionId],
    assertAllowed: assertExpectedIncarnation,
    revalidateAllowed: assertExpectedIncarnation,
  });
  try {
    return await admission.run(params.run);
  } finally {
    admission.release();
  }
}
