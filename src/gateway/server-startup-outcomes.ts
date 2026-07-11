// Fixed-vocabulary Gateway startup outcomes keep normal boot logs useful
// without exposing configuration values, paths, or startup errors.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasConfiguredInternalHooks } from "../hooks/configured.js";
import { isTruthyEnvValue } from "../infra/env.js";

export const GATEWAY_STARTUP_SUBSYSTEMS = [
  "internal-hooks",
  "internal-startup-hook",
  "gateway-start-hooks",
  "memory-qmd",
  "gmail-watcher",
  "gmail-model",
] as const;

export type GatewayStartupSubsystem = (typeof GATEWAY_STARTUP_SUBSYSTEMS)[number];

export type GatewayStartupSkippedReason =
  | "not-configured"
  | "no-handlers-loaded"
  | "disabled-by-environment"
  | "hooks-disabled"
  | "no-gmail-account"
  | "startup-disabled";

export type GatewayStartupOutcome =
  | { subsystem: GatewayStartupSubsystem; status: "loaded" | "scheduled" }
  | { subsystem: GatewayStartupSubsystem; status: "failed"; reason: "see earlier log" }
  | {
      subsystem: GatewayStartupSubsystem;
      status: "skipped";
      reason: GatewayStartupSkippedReason;
    };

type GatewayStartupOutcomePlan = {
  internalHooks: "configured" | "not-configured" | "hooks-disabled";
  gatewayStartHooks: boolean;
  memoryQmd: "scheduled" | "not-configured" | "startup-disabled";
  gmailWatcher: "scheduled" | "disabled-by-environment" | "hooks-disabled" | "no-gmail-account";
  gmailModel: "scheduled" | "not-configured";
};

export type GatewayStartupOutcomeRecorder = {
  record: (outcome: GatewayStartupOutcome) => void;
  snapshot: () => GatewayStartupOutcome[];
};

export type GatewayStartupOutcomeRecorderParams = {
  cfg: OpenClawConfig;
  gatewayStartHooks: boolean;
  memoryStartupMode: "off" | "immediate" | "idle";
  env?: NodeJS.ProcessEnv;
};

function skipped(
  subsystem: GatewayStartupSubsystem,
  reason: GatewayStartupSkippedReason,
): GatewayStartupOutcome {
  return { subsystem, status: "skipped", reason };
}

function resolveOutcomePlan(
  params: GatewayStartupOutcomeRecorderParams,
): GatewayStartupOutcomePlan {
  const internalHooks: GatewayStartupOutcomePlan["internalHooks"] =
    params.cfg.hooks?.internal?.enabled === false
      ? "hooks-disabled"
      : hasConfiguredInternalHooks(params.cfg)
        ? "configured"
        : "not-configured";
  const memoryQmd: GatewayStartupOutcomePlan["memoryQmd"] =
    params.cfg.memory?.backend !== "qmd"
      ? "not-configured"
      : params.memoryStartupMode === "off"
        ? "startup-disabled"
        : "scheduled";
  const gmailWatcher: GatewayStartupOutcomePlan["gmailWatcher"] = !params.cfg.hooks?.enabled
    ? "hooks-disabled"
    : !params.cfg.hooks.gmail?.account
      ? "no-gmail-account"
      : isTruthyEnvValue((params.env ?? process.env).OPENCLAW_SKIP_GMAIL_WATCHER)
        ? "disabled-by-environment"
        : "scheduled";

  return {
    internalHooks,
    gatewayStartHooks: params.gatewayStartHooks,
    memoryQmd,
    gmailWatcher,
    gmailModel: params.cfg.hooks?.gmail?.model ? "scheduled" : "not-configured",
  };
}

/** Create the complete initial outcome set; awaited startup work may replace entries later. */
export function createGatewayStartupOutcomeRecorder(
  params: GatewayStartupOutcomeRecorderParams,
): GatewayStartupOutcomeRecorder {
  const plan = resolveOutcomePlan(params);
  const internalHooks =
    plan.internalHooks === "configured"
      ? skipped("internal-hooks", "no-handlers-loaded")
      : skipped("internal-hooks", plan.internalHooks);
  const internalStartupHook =
    plan.internalHooks === "hooks-disabled"
      ? skipped("internal-startup-hook", "hooks-disabled")
      : skipped("internal-startup-hook", "no-handlers-loaded");
  const outcomes = new Map<GatewayStartupSubsystem, GatewayStartupOutcome>([
    ["internal-hooks", internalHooks],
    ["internal-startup-hook", internalStartupHook],
    [
      "gateway-start-hooks",
      plan.gatewayStartHooks
        ? { subsystem: "gateway-start-hooks", status: "scheduled" }
        : skipped("gateway-start-hooks", "no-handlers-loaded"),
    ],
    [
      "memory-qmd",
      plan.memoryQmd === "scheduled"
        ? { subsystem: "memory-qmd", status: "scheduled" }
        : skipped("memory-qmd", plan.memoryQmd),
    ],
    [
      "gmail-watcher",
      plan.gmailWatcher === "scheduled"
        ? { subsystem: "gmail-watcher", status: "scheduled" }
        : skipped("gmail-watcher", plan.gmailWatcher),
    ],
    [
      "gmail-model",
      plan.gmailModel === "scheduled"
        ? { subsystem: "gmail-model", status: "scheduled" }
        : skipped("gmail-model", "not-configured"),
    ],
  ]);

  return {
    record: (outcome) => {
      outcomes.set(outcome.subsystem, outcome);
    },
    snapshot: () =>
      GATEWAY_STARTUP_SUBSYSTEMS.flatMap((subsystem) => {
        const outcome = outcomes.get(subsystem);
        return outcome ? [outcome] : [];
      }),
  };
}

/** Format outcomes in canonical order regardless of collection order. */
export function formatGatewayStartupOutcomes(outcomes: readonly GatewayStartupOutcome[]): string {
  const bySubsystem = new Map(outcomes.map((outcome) => [outcome.subsystem, outcome]));
  const entries = GATEWAY_STARTUP_SUBSYSTEMS.flatMap((subsystem) => {
    const outcome = bySubsystem.get(subsystem);
    if (!outcome) {
      return [];
    }
    const detail = "reason" in outcome ? ` (${outcome.reason})` : "";
    return `${outcome.subsystem}=${outcome.status}${detail}`;
  });
  return `gateway startup outcomes: ${entries.join("; ")}`;
}
