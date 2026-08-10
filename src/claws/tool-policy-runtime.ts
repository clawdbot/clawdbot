import { listAgentEntries } from "../agents/agent-scope.js";
import { registerRuntimeConfigSnapshotPreparer } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { readExistingClawInstallSchemaVersionsSync } from "./provenance-runtime-read.js";
import { CLAW_INSTALL_RECORD_SCHEMA_VERSION } from "./provenance-schema-version.js";

const frozenToolAllowPolicies = new WeakSet<object>();
type PreparedClawToolPolicy =
  | { kind: "current" }
  | { kind: "legacy" }
  | { kind: "state-error"; error: unknown };
const preparedClawToolPolicies = new WeakMap<object, PreparedClawToolPolicy>();

export function markFrozenClawToolAllowPolicy(policy: object | undefined): void {
  if (policy) {
    frozenToolAllowPolicies.add(policy);
  }
}

export function isFrozenClawToolAllowPolicy(policy: object | undefined): boolean {
  return policy ? frozenToolAllowPolicies.has(policy) : false;
}

export function prepareClawToolPolicyConsent(
  config: OpenClawConfig,
  options: OpenClawStateDatabaseOptions & {
    readSchemaVersions?: typeof readExistingClawInstallSchemaVersionsSync;
  } = {},
): void {
  const candidates = listAgentEntries(config).flatMap((agent) => {
    const tools = agent.tools;
    return tools && (tools.profile || tools.allow?.length) ? [{ agentId: agent.id, tools }] : [];
  });
  if (candidates.length === 0) {
    return;
  }
  let schemaVersions;
  try {
    schemaVersions = (options.readSchemaVersions ?? readExistingClawInstallSchemaVersionsSync)(
      options,
    );
  } catch (error) {
    for (const candidate of candidates) {
      preparedClawToolPolicies.set(candidate.tools, { kind: "state-error", error });
    }
    return;
  }
  for (const candidate of candidates) {
    const schemaVersion = schemaVersions.get(candidate.agentId);
    if (!schemaVersion) {
      preparedClawToolPolicies.delete(candidate.tools);
      continue;
    }
    preparedClawToolPolicies.set(candidate.tools, {
      kind: schemaVersion === CLAW_INSTALL_RECORD_SCHEMA_VERSION ? "current" : "legacy",
    });
  }
}

registerRuntimeConfigSnapshotPreparer((config) => prepareClawToolPolicyConsent(config));

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
  agentTools?: object;
  agentId?: string;
  hasAgentAllowlist: boolean;
  ownsProfile: boolean;
  profile?: string;
}): { frozen: boolean } {
  if (!params.agentId || (!params.ownsProfile && !params.hasAgentAllowlist)) {
    return { frozen: false };
  }
  const prepared = params.agentTools ? preparedClawToolPolicies.get(params.agentTools) : undefined;
  if (!prepared) {
    return { frozen: false };
  }
  if (prepared.kind === "state-error") {
    throw new ClawToolProfileConsentStateError(params.agentId, prepared.error);
  }
  if (
    prepared.kind === "legacy" ||
    (params.ownsProfile && (params.profile !== "full" || !params.hasAgentAllowlist))
  ) {
    throw new ClawToolProfileConsentError(params.agentId);
  }
  return { frozen: params.hasAgentAllowlist };
}
