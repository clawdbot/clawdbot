import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { mutateConfigFileWithRetry } from "../config/config.js";
import { resolveIsConfigReadOnly, resolveIsNixMode } from "../config/paths.js";
import type { ModelSelectionScope } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { setAgentEffectiveModelPrimary, type AgentModelPrimaryWriteTarget } from "./agent-scope.js";

const log = createSubsystemLogger("agents/sticky-model-selection");
let warnedImmutableConfig = false;

export type StickyModelSelectionDispatchOutcome = "requested" | "skipped-immutable";
export type StickyModelSelectionTarget = ModelSelectionScope;
export type StickyModelSelectionPolicy = {
  scope: ModelSelectionScope;
  target: StickyModelSelectionTarget;
};

/** Resolve preference only; callers must separately authorize config writes. */
export function resolveStickyModelSelectionScope(params: {
  cfg: OpenClawConfig;
  scope?: ModelSelectionScope;
}): ModelSelectionScope {
  return params.scope ?? params.cfg.agents?.defaults?.modelSelectionScope ?? "session";
}

/** Resolve the exact layer a selection may update before presenting or applying it. */
export function resolveStickyModelSelectionPolicy(params: {
  canPersistConfig: boolean;
  cfg: OpenClawConfig;
  scope?: ModelSelectionScope;
}): StickyModelSelectionPolicy {
  const scope = resolveStickyModelSelectionScope(params);
  return { scope, target: params.canPersistConfig ? scope : "session" };
}

/** Persists a validated model selection at its explicitly requested config layer. */
async function persistStickyModelSelection(params: {
  agentId: string;
  model: string;
  target: AgentModelPrimaryWriteTarget | "effective";
}): Promise<AgentModelPrimaryWriteTarget> {
  const model = normalizeOptionalString(params.model);
  if (!model) {
    throw new Error("Sticky model selection must be non-empty.");
  }
  const agentId = normalizeAgentId(params.agentId);
  const committed = await mutateConfigFileWithRetry<AgentModelPrimaryWriteTarget>({
    afterWrite: { mode: "auto" },
    mutate: (draft) =>
      setAgentEffectiveModelPrimary(
        draft,
        agentId,
        model,
        params.target === "effective" ? {} : { target: params.target },
      ),
  });
  if (!committed.result) {
    throw new Error("Sticky model config mutation did not return its write target.");
  }
  log.info(
    `persisted sticky model selection agentId=${agentId} model=${model} target=${committed.result}`,
  );
  return committed.result;
}

/** Starts a best-effort sticky write without delaying or failing the session mutation. */
export function persistStickyModelSelectionBestEffort(params: {
  agentId: string;
  model: string;
  target: AgentModelPrimaryWriteTarget | "effective";
}): StickyModelSelectionDispatchOutcome {
  if (resolveIsConfigReadOnly()) {
    // A gateway with immutable config can switch models but can never persist this preference.
    // Warn once per process so repeated switches do not flood the operator log.
    if (!warnedImmutableConfig) {
      warnedImmutableConfig = true;
      const reason = resolveIsNixMode()
        ? "config is immutable in OPENCLAW_NIX_MODE"
        : "config is externally managed and immutable";
      log.warn(
        `skipped sticky model persistence agentId=${params.agentId} model=${params.model} reason=${reason}`,
      );
    }
    return "skipped-immutable";
  }
  void persistStickyModelSelection(params).catch((error: unknown) => {
    log.warn(
      `failed sticky model persistence agentId=${params.agentId} model=${params.model} reason=${formatErrorMessage(error)}`,
    );
  });
  return "requested";
}
