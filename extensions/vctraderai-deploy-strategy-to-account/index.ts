import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: deploy_strategy_to_account (PROPOSE).
//
// PROPOSE_ONLY at confirm tier T3 per propfirm_manager ADR 0078
// (core/openclaw/allowlist.py, cluster G - "deployment / assignment, highest
// risk"). DEC-56 granted the agent the ability to PROPOSE a deployment; it did
// not grant autonomous deployment, and this plugin must never imply otherwise.
//
// This tool STAGES a card and stops. It POSTs the same chokepoint every other
// propose tool uses, `POST /api/v1/openclaw/stage`, with
// `{ tool_name, workspace_id, params, summary }`. The BFF re-gates the BODY
// tool against the closed-world allowlist, refuses anything that is not
// PROPOSE_ONLY, and requires the target_action_kind to be registered in the
// confirm-tier map. The real side effect happens later, in
// web_api/agent_alpha/staged_apply.py, which calls `governed_deploy` only after
// the human confirm/step-up chokepoint.
//
// This is deliberately NOT modelled on the Lane C EXECUTE tools
// (agent-place-order and friends). Those run against an autonomous-unlock
// window; nothing here is autonomous.
//
// PARAM NAMING IS LOAD-BEARING: the apply adapter
// (_build_deploy_strategy_to_account_kwargs) reads `version_id`, NOT
// `strategy_version_id`. A card staged under the wrong key applies with a null
// version.

export const DEPLOY_STRATEGY_TO_ACCOUNT_TOOL_NAME = "deploy_strategy_to_account";
const STAGE_PATH = "/api/v1/openclaw/stage";

/** The three modes the engine callable accepts; anything else is refused. */
const DEPLOYMENT_MODES = ["paper", "confirm", "live"] as const;
export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

export type DeployStrategyToAccountParams = {
  strategy_id: string;
  version_id: string;
  account_id: string;
  deployment_mode?: DeploymentMode;
  risk_cap_override_pct?: number;
  idempotency_key?: string;
};

export type DeployStrategyToAccountDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /** Per-turn BFF thread id, forwarded as `X-OpenClaw-Thread`. */
  threadId?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai deploy_strategy_to_account: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

function requireNonEmpty(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new Error(`deploy_strategy_to_account requires ${field}`);
  }
  return text;
}

function buildSummary(params: {
  strategy_id: string;
  version_id: string;
  account_id: string;
  deployment_mode: DeploymentMode;
}): string {
  return `Deploy strategy ${params.strategy_id} version ${params.version_id} to account ${params.account_id} (${params.deployment_mode})`;
}

/**
 * Stage a deployment proposal for human review. Never deploys.
 *
 * Validation here is a refusal, not a correction: a bad mode or a missing id is
 * reported to the model rather than silently defaulted (DEC-30), so the agent
 * can fix its own call instead of staging a card that means something else.
 */
export async function runDeployStrategyToAccount(
  params: DeployStrategyToAccountParams,
  deps: DeployStrategyToAccountDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const strategyId = requireNonEmpty(params.strategy_id, "strategy_id");
  const versionId = requireNonEmpty(params.version_id, "version_id");
  const accountId = requireNonEmpty(params.account_id, "account_id");

  const requestedMode = params.deployment_mode ?? "paper";
  if (!DEPLOYMENT_MODES.includes(requestedMode)) {
    throw new Error(
      `deploy_strategy_to_account: deployment_mode must be one of ${DEPLOYMENT_MODES.join(", ")}`,
    );
  }

  if (params.risk_cap_override_pct !== undefined) {
    const cap = params.risk_cap_override_pct;
    if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0 || cap > 100) {
      throw new Error(
        "deploy_strategy_to_account: risk_cap_override_pct must be a percentage above 0 and at most 100",
      );
    }
  }

  const stagedParams: Record<string, unknown> = {
    strategy_id: strategyId,
    version_id: versionId,
    account_id: accountId,
    deployment_mode: requestedMode,
    ...(params.risk_cap_override_pct === undefined
      ? {}
      : { risk_cap_override_pct: params.risk_cap_override_pct }),
    ...(params.idempotency_key ? { idempotency_key: params.idempotency_key } : {}),
  };

  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const staged = await bffFetch(STAGE_PATH, {
    method: "POST",
    body: {
      tool_name: DEPLOY_STRATEGY_TO_ACCOUNT_TOOL_NAME,
      workspace_id: requireWorkspaceId(),
      params: stagedParams,
      summary: buildSummary({
        strategy_id: strategyId,
        version_id: versionId,
        account_id: accountId,
        deployment_mode: requestedMode,
      }),
    },
    signal,
  });

  return {
    staged,
    requires_apply: true,
    confirm_tier: "T3",
    message:
      "Staged a deployment proposal for review. Nothing is deployed until the human reviews and Applies it, which requires a step-up confirmation.",
  };
}

export default defineToolPlugin({
  id: "vctraderai-deploy-strategy-to-account",
  name: "VC Trader AI Deploy Strategy To Account (Propose)",
  description:
    "Stages a strategy-version-to-account deployment proposal for human review and step-up; never deploys directly.",
  tools: (tool) => [
    tool({
      name: DEPLOY_STRATEGY_TO_ACCOUNT_TOOL_NAME,
      label: "Deploy Strategy To Account",
      description:
        "Propose deploying one live strategy version directly to one account through the governed deployment flow. Required: strategy_id, version_id, and account_id. Optional: deployment_mode (paper, confirm, or live), risk_cap_override_pct, and idempotency_key. This STAGES a card for human review and step-up - it does NOT deploy, and you cannot deploy without the human. On Apply the BFF runs smoke/compatibility checks, records strategy_deployed, persists strategy_registry.strategy_deployments, and ensures the account node is running. PROPOSE_ONLY at confirm tier T3 per ADR 0078. Call list_live_accounts_for_deployment and list_current_deployments first so you propose against a real account and do not duplicate a deployment that already exists. Pass the strategy VERSION id as version_id (not strategy_version_id); deployment_mode defaults to paper, so name it explicitly when the human asked for confirm or live.",
      parameters: Type.Object(
        {
          strategy_id: Type.String({
            minLength: 1,
            description: "Registered strategy id to deploy.",
          }),
          version_id: Type.String({
            minLength: 1,
            description:
              "The strategy VERSION id to deploy. This key is named version_id, not strategy_version_id.",
          }),
          account_id: Type.String({
            minLength: 1,
            description: "Target account id. Source it from list_live_accounts_for_deployment.",
          }),
          deployment_mode: Type.Optional(
            Type.Union([Type.Literal("paper"), Type.Literal("confirm"), Type.Literal("live")], {
              description:
                "paper (default), confirm, or live. Only propose live when the human has asked for live money.",
            }),
          ),
          risk_cap_override_pct: Type.Optional(
            Type.Number({
              exclusiveMinimum: 0,
              maximum: 100,
              description:
                "Optional per-deployment risk cap override, as a percentage. Omit to inherit the account's configured risk.",
            }),
          ),
          idempotency_key: Type.Optional(
            Type.String({
              description: "Optional idempotency key; the BFF derives one when omitted.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runDeployStrategyToAccount(
          params as DeployStrategyToAccountParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
