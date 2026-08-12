// Session checkout diff for operator clients, filtered against the exact
// working-tree state captured when the logical session started.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateSessionsDiffParams,
  type SessionsDiffParams,
  type SessionsDiffResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { applySessionDiffBaseline, loadCheckoutDiff } from "../../sessions/session-diff.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export { parseNameStatusZ, parseNumstatZ, splitPatchByFile } from "../../sessions/session-diff.js";

export async function loadSessionDiff(params: SessionsDiffParams): Promise<SessionsDiffResult> {
  const empty = (
    unavailableReason?: NonNullable<SessionsDiffResult["unavailableReason"]>,
  ): SessionsDiffResult => ({
    sessionKey: params.sessionKey,
    files: [],
    additions: 0,
    deletions: 0,
    ...(unavailableReason ? { unavailableReason } : {}),
  });
  const { cfg, entry, storePath, canonicalKey } = loadGatewaySessionEntryReadOnly(
    params.sessionKey,
    {
      agentId: params.agentId,
    },
  );
  // Same session scoping as sessions.files.*: an unknown session must not fall
  // back to some agent workspace and surface another checkout's diff.
  if (!entry?.sessionId || !storePath) {
    return empty("unknown_session");
  }
  const agentId = normalizeAgentId(
    parseAgentSessionKey(canonicalKey)?.agentId ??
      params.agentId ??
      parseAgentSessionKey(params.sessionKey)?.agentId ??
      resolveDefaultAgentId(cfg),
  );
  // spawnedCwd first, matching pushed Control UI session PR state: the diff must
  // describe the same checkout whose branch the PR chips report.
  const cwd =
    normalizeOptionalString(entry.spawnedCwd) ??
    normalizeOptionalString(entry.spawnedWorkspaceDir) ??
    normalizeOptionalString(resolveAgentWorkspaceDir(cfg, agentId));
  if (!cwd) {
    return empty("unknown_session");
  }
  if (params.scope === "commit") {
    if (!params.commit) {
      throw new TypeError("commit scope requires a commit");
    }
    return await loadCheckoutDiff({
      commit: params.commit,
      cwd,
      scope: "commit",
      sessionKey: params.sessionKey,
    });
  }
  return await applySessionDiffBaseline({
    baseline: entry.sessionDiffBaseline,
    diff: await loadCheckoutDiff({
      cwd,
      scope: params.scope ?? "all",
      sessionKey: params.sessionKey,
    }),
    sessionId: entry.sessionId,
  });
}

export const sessionsDiffHandlers: GatewayRequestHandlers = {
  "sessions.diff": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsDiffParams, "sessions.diff", respond)) {
      return;
    }
    const scope = params.scope ?? "all";
    if ((scope === "commit") !== (params.commit !== undefined)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid sessions.diff params: commit must be set if and only if scope is commit",
        ),
      );
      return;
    }
    respond(true, await loadSessionDiff(params));
  },
};
