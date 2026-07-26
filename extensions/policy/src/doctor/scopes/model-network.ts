// Policy doctor checks and findings for MCP, model provider, and network policy.
import type { HealthCheck, HealthFinding } from "openclaw/plugin-sdk/health";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import type { PolicyEvidence } from "../../policy-state.js";
import { CHECK_IDS } from "../check-ids.js";
import type { PolicyDoctorCheckDeps } from "../types.js";
import { readPolicyBoolean, readStringList } from "../utils.js";

export function createPolicyModelNetworkChecks(
  deps: PolicyDoctorCheckDeps,
): readonly HealthCheck[] {
  const { evaluatePolicy, findingsForCheck } = deps;

  const policyMcpDeniedServerCheck: HealthCheck = {
    id: CHECK_IDS.policyDeniedMcpServer,
    kind: "plugin",
    description: "Configured MCP servers do not match policy deny rules.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyDeniedMcpServer);
    },
  };
  const policyMcpUnapprovedServerCheck: HealthCheck = {
    id: CHECK_IDS.policyUnapprovedMcpServer,
    kind: "plugin",
    description: "Configured MCP servers do not match policy allow rules.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyUnapprovedMcpServer);
    },
  };
  const policyModelsDeniedProviderCheck: HealthCheck = {
    id: CHECK_IDS.policyDeniedModelProvider,
    kind: "plugin",
    description: "Configured model providers do not match policy deny rules.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyDeniedModelProvider);
    },
  };
  const policyModelsUnapprovedProviderCheck: HealthCheck = {
    id: CHECK_IDS.policyUnapprovedModelProvider,
    kind: "plugin",
    description: "Configured model providers do not match policy allow rules.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyUnapprovedModelProvider);
    },
  };
  const policyNetworkPrivateAccessCheck: HealthCheck = {
    id: CHECK_IDS.policyPrivateNetworkAccess,
    kind: "plugin",
    description: "Network SSRF policy settings match private-network requirements.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyPrivateNetworkAccess);
    },
  };

  return [
    policyMcpDeniedServerCheck,
    policyMcpUnapprovedServerCheck,
    policyModelsDeniedProviderCheck,
    policyModelsUnapprovedProviderCheck,
    policyNetworkPrivateAccessCheck,
  ];
}

export function mcpServerFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const denied = new Set(readStringList(policy, ["mcp", "servers", "deny"], { lowercase: false }));
  const allowed = readStringList(policy, ["mcp", "servers", "allow"], { lowercase: false });
  const allowedSet = new Set(allowed);
  const findings: HealthFinding[] = [];

  for (const server of evidence.mcpServers) {
    if (denied.has(server.id)) {
      findings.push({
        checkId: CHECK_IDS.policyDeniedMcpServer,
        severity: "error",
        message: `MCP server '${server.id}' is denied by policy.`,
        source: "policy",
        path: "openclaw config",
        ocPath: server.source,
        target: server.source,
        requirement: `oc://${policyDocName}/mcp/servers/deny`,
        fixHint: "Remove this configured MCP server or update the policy after review.",
      });
      continue;
    }
    if (allowedSet.size > 0 && !allowedSet.has(server.id)) {
      findings.push({
        checkId: CHECK_IDS.policyUnapprovedMcpServer,
        severity: "error",
        message: `MCP server '${server.id}' is not in the policy allowlist.`,
        source: "policy",
        path: "openclaw config",
        ocPath: server.source,
        target: server.source,
        requirement: `oc://${policyDocName}/mcp/servers/allow`,
        fixHint: "Use an approved MCP server or update the policy after review.",
      });
    }
  }

  return findings;
}

export function modelProviderFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const denied = new Set(readModelProviderPolicyList(policy, ["models", "providers", "deny"]));
  const allowed = readModelProviderPolicyList(policy, ["models", "providers", "allow"]);
  const allowedSet = new Set(allowed);
  const findings: HealthFinding[] = [];

  for (const provider of evidence.modelProviders) {
    findings.push(...modelProviderConformanceFindings(provider, denied, allowedSet, policyDocName));
  }
  for (const modelRef of evidence.modelRefs) {
    findings.push(...modelRefConformanceFindings(modelRef, denied, allowedSet, policyDocName));
  }

  return findings;
}

function readModelProviderPolicyList(policy: unknown, path: readonly string[]): readonly string[] {
  return readStringList(policy, path).map((provider) => normalizeProviderId(provider));
}

function modelProviderConformanceFindings(
  provider: PolicyEvidence["modelProviders"][number],
  denied: ReadonlySet<string>,
  allowed: ReadonlySet<string>,
  policyDocName: string,
): readonly HealthFinding[] {
  const findings: HealthFinding[] = [];
  if (denied.has(provider.id)) {
    findings.push({
      checkId: CHECK_IDS.policyDeniedModelProvider,
      severity: "error",
      message: `Model provider '${provider.id}' is denied by policy.`,
      source: "policy",
      path: "openclaw config",
      ocPath: provider.source,
      target: provider.source,
      requirement: `oc://${policyDocName}/models/providers/deny`,
      fixHint: "Remove this configured provider or update the policy after review.",
    });
  }
  if (!denied.has(provider.id) && allowed.size > 0 && !allowed.has(provider.id)) {
    findings.push({
      checkId: CHECK_IDS.policyUnapprovedModelProvider,
      severity: "error",
      message: `Model provider '${provider.id}' is not in the policy allowlist.`,
      source: "policy",
      path: "openclaw config",
      ocPath: provider.source,
      target: provider.source,
      requirement: `oc://${policyDocName}/models/providers/allow`,
      fixHint: "Use an approved model provider or update the policy after review.",
    });
  }
  return findings;
}

function modelRefConformanceFindings(
  modelRef: PolicyEvidence["modelRefs"][number],
  denied: ReadonlySet<string>,
  allowed: ReadonlySet<string>,
  policyDocName: string,
): readonly HealthFinding[] {
  const findings: HealthFinding[] = [];
  if (denied.has(modelRef.provider)) {
    findings.push({
      checkId: CHECK_IDS.policyDeniedModelProvider,
      severity: "error",
      message: `Model ref '${modelRef.ref}' uses denied provider '${modelRef.provider}'.`,
      source: "policy",
      path: "openclaw config",
      ocPath: modelRef.source,
      target: modelRef.source,
      requirement: `oc://${policyDocName}/models/providers/deny`,
      fixHint: "Select an approved model provider or update the policy after review.",
    });
  }
  if (!denied.has(modelRef.provider) && allowed.size > 0 && !allowed.has(modelRef.provider)) {
    findings.push({
      checkId: CHECK_IDS.policyUnapprovedModelProvider,
      severity: "error",
      message: `Model ref '${modelRef.ref}' uses unapproved provider '${modelRef.provider}'.`,
      source: "policy",
      path: "openclaw config",
      ocPath: modelRef.source,
      target: modelRef.source,
      requirement: `oc://${policyDocName}/models/providers/allow`,
      fixHint: "Select an approved model provider or update the policy after review.",
    });
  }
  return findings;
}

export function networkFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const allowPrivateNetwork = readPolicyBoolean(policy, ["network", "privateNetwork", "allow"]);
  if (allowPrivateNetwork !== false) {
    return [];
  }
  return evidence.network
    .filter((setting) => setting.value)
    .map((setting): HealthFinding => {
      return {
        checkId: CHECK_IDS.policyPrivateNetworkAccess,
        severity: "error",
        message: `Network setting '${setting.id}' allows private-network access.`,
        source: "policy",
        path: "openclaw config",
        ocPath: setting.source,
        target: setting.source,
        requirement: `oc://${policyDocName}/network/privateNetwork/allow`,
        fixHint: "Disable this private-network access setting or update policy after review.",
      };
    });
}
