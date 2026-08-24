import { CLAW_REMOVE_PLAN_SCHEMA_VERSION } from "../claws/lifecycle-state.js";
// Consent gating for the experimental Claws commands.
import { readClawPlanConsent } from "../claws/plan-consent-cache.js";
import { CLAW_ADD_PLAN_SCHEMA_VERSION, CLAW_OUTPUT_STABILITY } from "../claws/types.js";
import { writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import type { ClawsAddOptions, ClawsRemoveOptions } from "./claws-cli.js";

export function failNonDryRun(opts: ClawsAddOptions, runtime: RuntimeEnv): boolean {
  if (opts.dryRun) {
    return false;
  }
  const consented = opts.yes && (opts.planIntegrity || opts.consentLatest);
  if (consented) {
    return false;
  }
  const code = opts.yes ? "plan_integrity_required" : "consent_required";
  const message = opts.yes
    ? "Claw add consent must include --plan-integrity or --consent-latest."
    : "Claw add requires explicit consent; pass --dry-run to preview or --yes with --plan-integrity to create the new agent and workspace.";
  if (opts.json) {
    writeRuntimeJson(runtime, {
      schemaVersion: CLAW_ADD_PLAN_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      ok: false,
      error: { code, message },
    });
  } else {
    runtime.error(message);
  }
  runtime.exit(1);
  return true;
}

export function requireRemoveConsent(opts: ClawsRemoveOptions, runtime: RuntimeEnv): boolean {
  if (opts.dryRun || (opts.yes && (opts.planIntegrity || opts.consentLatest))) {
    return false;
  }
  const code = opts.yes ? "plan_integrity_required" : "consent_required";
  const message = opts.yes
    ? "Claw remove consent must include --plan-integrity or --consent-latest."
    : "Claw remove requires explicit consent; pass --dry-run to preview or --yes with --plan-integrity to remove owned state.";
  if (opts.json) {
    writeRuntimeJson(runtime, {
      schemaVersion: CLAW_REMOVE_PLAN_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      ok: false,
      error: { code, message },
    });
  } else {
    runtime.error(message);
  }
  runtime.exit(1);
  return true;
}

/**
 * Resolves consent from the plan cached by a previous --dry-run. Reading the
 * cache here, before applying, is what keeps --consent-latest from
 * degenerating into self-consent: only a plan the operator reviewed (via a
 * dry-run that stored it) can satisfy the flag.
 */
export function resolveLatestPlanConsent(
  agentId: string | undefined,
  kind: "add" | "remove",
): string {
  if (!agentId) {
    throw new Error(`No cached dry-run plan for ${kind}; run ${kind} --dry-run first.`);
  }
  const cached = readClawPlanConsent(agentId, {});
  if (cached && cached.planKind === kind) {
    return cached.planIntegrity;
  }
  throw new Error(`No cached dry-run plan for ${kind}; run ${kind} --dry-run first.`);
}
