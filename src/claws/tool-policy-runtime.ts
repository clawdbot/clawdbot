import { readExistingClawInstallRecordSync } from "./provenance-runtime-read.js";
import { CLAW_INSTALL_RECORD_SCHEMA_VERSION } from "./provenance-schema-version.js";

const frozenToolAllowPolicies = new WeakSet<object>();

export function markFrozenClawToolAllowPolicy(policy: object | undefined): void {
  if (policy) {
    frozenToolAllowPolicies.add(policy);
  }
}

export function isFrozenClawToolAllowPolicy(policy: object | undefined): boolean {
  return policy ? frozenToolAllowPolicies.has(policy) : false;
}

class ClawToolProfileConsentError extends Error {
  constructor(agentId: string) {
    super(
      `Claw-managed agent ${JSON.stringify(agentId)} uses a legacy dynamic tool policy. ` +
        `Run \`openclaw claws update ${agentId}\` and approve the refreshed tool authority before running it.`,
    );
    this.name = "ClawToolProfileConsentError";
  }
}

class ClawToolProfileConsentStateError extends Error {
  constructor(agentId: string, cause: unknown) {
    super(
      `Cannot verify the installed tool authority for Claw-managed agent ${JSON.stringify(agentId)}. ` +
        "Repair the OpenClaw state database before running it.",
      { cause },
    );
    this.name = "ClawToolProfileConsentStateError";
  }
}

export function resolveClawToolPolicyConsent(params: {
  agentId?: string;
  hasAgentAllowlist: boolean;
  ownsProfile: boolean;
  profile?: string;
}): { frozen: boolean } {
  if (!params.agentId || (!params.ownsProfile && !params.hasAgentAllowlist)) {
    return { frozen: false };
  }
  let record;
  try {
    record = readExistingClawInstallRecordSync(params.agentId);
  } catch (error) {
    // This synchronous security gate cannot use the asynchronous snapshot
    // recovery path. Never interpret an unreadable ownership record as absent.
    throw new ClawToolProfileConsentStateError(params.agentId, error);
  }
  if (!record) {
    return { frozen: false };
  }
  if (
    record.schemaVersion !== CLAW_INSTALL_RECORD_SCHEMA_VERSION ||
    (params.ownsProfile && (params.profile !== "full" || !params.hasAgentAllowlist))
  ) {
    throw new ClawToolProfileConsentError(params.agentId);
  }
  return { frozen: params.hasAgentAllowlist };
}
