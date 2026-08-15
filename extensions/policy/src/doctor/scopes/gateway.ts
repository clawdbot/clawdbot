// Policy doctor checks and findings for gateway exposure policy.
import { isRecord } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import type { HealthCheck, HealthFinding } from "openclaw/plugin-sdk/health";
import type { PolicyEvidence } from "../../policy-state.js";
import { repairPolicyAutomaticNarrower } from "../automatic-repairs.js";
import { createPolicyScopedChecks } from "../check-factory.js";
import { CHECK_IDS } from "../check-ids.js";
import { previewPolicyReviewRequiredRepair } from "../review-required-repairs.js";
import type { PolicyDoctorCheckDeps } from "../types.js";
import { readPolicyBoolean, readStringList } from "../utils.js";

export function createPolicyGatewayChecks(deps: PolicyDoctorCheckDeps): readonly HealthCheck[] {
  return createPolicyScopedChecks(deps, [
    [
      CHECK_IDS.policyGatewayNonLoopbackBind,
      "Gateway bind posture matches policy exposure requirements.",
      (ctx, findings) =>
        previewPolicyReviewRequiredRepair(ctx, findings, CHECK_IDS.policyGatewayNonLoopbackBind),
    ],
    [
      CHECK_IDS.policyGatewayAuthDisabled,
      "Gateway authentication remains enabled when required by policy.",
    ],
    [
      CHECK_IDS.policyGatewayRateLimitMissing,
      "Gateway authentication rate-limit posture is explicit when required by policy.",
    ],
    [
      CHECK_IDS.policyGatewayControlUiInsecure,
      "Gateway Control UI insecure exposure toggles remain disabled by policy.",
      (ctx, findings) =>
        repairPolicyAutomaticNarrower(ctx, findings, CHECK_IDS.policyGatewayControlUiInsecure),
    ],
    [CHECK_IDS.policyGatewayTailscaleFunnel, "Gateway Tailscale Funnel exposure matches policy."],
    [
      CHECK_IDS.policyGatewayRemoteEnabled,
      "Remote gateway mode matches policy.",
      (ctx, findings) =>
        repairPolicyAutomaticNarrower(ctx, findings, CHECK_IDS.policyGatewayRemoteEnabled),
    ],
    [
      CHECK_IDS.policyGatewayHttpEndpointEnabled,
      "Gateway HTTP API endpoints match policy.",
      (ctx, findings) =>
        repairPolicyAutomaticNarrower(ctx, findings, CHECK_IDS.policyGatewayHttpEndpointEnabled),
    ],
    [
      CHECK_IDS.policyGatewayHttpUrlFetchUnrestricted,
      "Gateway HTTP URL-fetch inputs have allowlists when required by policy.",
    ],
    [
      CHECK_IDS.policyGatewayNodeCommandDenied,
      "Gateway node command allowlists match policy.",
      (ctx, findings) =>
        previewPolicyReviewRequiredRepair(ctx, findings, CHECK_IDS.policyGatewayNodeCommandDenied),
    ],
  ]);
}

export function gatewayExposureFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  return [
    ...gatewayNonLoopbackBindFindings(policy, policyDocName, evidence),
    ...gatewayAuthFindings(policy, policyDocName, evidence),
    ...gatewayControlUiFindings(policy, policyDocName, evidence),
    ...gatewayTailscaleFindings(policy, policyDocName, evidence),
    ...gatewayRemoteFindings(policy, policyDocName, evidence),
    ...gatewayHttpEndpointFindings(policy, policyDocName, evidence),
    ...gatewayHttpUrlFetchFindings(policy, policyDocName, evidence),
    ...gatewayNodeCommandFindings(policy, policyDocName, evidence),
  ];
}

function gatewayNonLoopbackBindFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  if (readPolicyBoolean(policy, ["gateway", "exposure", "allowNonLoopbackBind"]) !== false) {
    return [];
  }
  return (evidence.gatewayExposure ?? [])
    .filter((entry) => entry.kind === "bind" && entry.nonLoopback === true)
    .map((entry): HealthFinding => {
      return {
        checkId: CHECK_IDS.policyGatewayNonLoopbackBind,
        severity: "error",
        message:
          entry.explicit === false
            ? "Gateway bind is omitted while the runtime default can permit non-loopback exposure."
            : `Gateway bind setting '${entry.id}' permits non-loopback exposure.`,
        source: "policy",
        path: "openclaw config",
        ocPath: entry.source,
        target: entry.source,
        requirement: `oc://${policyDocName}/gateway/exposure/allowNonLoopbackBind`,
        fixHint: "Use gateway.bind=loopback or update policy after review.",
      };
    });
}

function gatewayAuthFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const findings: HealthFinding[] = [];
  if (readPolicyBoolean(policy, ["gateway", "auth", "requireAuth"]) === true) {
    findings.push(
      ...(evidence.gatewayExposure ?? [])
        .filter((entry) => entry.kind === "auth" && entry.value === "none")
        .map((entry): HealthFinding => {
          return {
            checkId: CHECK_IDS.policyGatewayAuthDisabled,
            severity: "error",
            message: "Gateway authentication is disabled.",
            source: "policy",
            path: "openclaw config",
            ocPath: entry.source,
            target: entry.source,
            requirement: `oc://${policyDocName}/gateway/auth/requireAuth`,
            fixHint: "Set gateway.auth.mode to token, password, or trusted-proxy.",
          };
        }),
    );
  }
  if (readPolicyBoolean(policy, ["gateway", "auth", "requireExplicitRateLimit"]) === true) {
    findings.push(
      ...(evidence.gatewayExposure ?? [])
        .filter((entry) => entry.kind === "authRateLimit" && entry.explicit !== true)
        .map((entry): HealthFinding => {
          return {
            checkId: CHECK_IDS.policyGatewayRateLimitMissing,
            severity: "error",
            message: "Gateway authentication rate-limit posture is not explicit.",
            source: "policy",
            path: "openclaw config",
            ocPath: entry.source,
            target: entry.source,
            requirement: `oc://${policyDocName}/gateway/auth/requireExplicitRateLimit`,
            fixHint: "Configure gateway.auth.rateLimit or update policy after review.",
          };
        }),
    );
  }
  return findings;
}

function gatewayControlUiFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  if (readPolicyBoolean(policy, ["gateway", "controlUi", "allowInsecure"]) !== false) {
    return [];
  }
  return (evidence.gatewayExposure ?? [])
    .filter(
      (entry) =>
        entry.kind === "controlUi" &&
        entry.value === true &&
        (entry.id === "gateway-control-ui-insecure-auth" ||
          entry.id === "gateway-control-ui-device-auth-disabled" ||
          entry.id === "gateway-control-ui-host-origin-fallback"),
    )
    .map((entry): HealthFinding => {
      return {
        checkId: CHECK_IDS.policyGatewayControlUiInsecure,
        severity: "error",
        message: `Gateway Control UI insecure toggle '${entry.id}' is enabled.`,
        source: "policy",
        path: "openclaw config",
        ocPath: entry.source,
        target: entry.source,
        requirement: `oc://${policyDocName}/gateway/controlUi/allowInsecure`,
        fixHint: "Disable the insecure Control UI toggle or update policy after review.",
      };
    });
}

function gatewayTailscaleFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  if (readPolicyBoolean(policy, ["gateway", "exposure", "allowTailscaleFunnel"]) !== false) {
    return [];
  }
  return (evidence.gatewayExposure ?? [])
    .filter((entry) => entry.kind === "tailscale" && entry.value === "funnel")
    .map((entry): HealthFinding => {
      return {
        checkId: CHECK_IDS.policyGatewayTailscaleFunnel,
        severity: "error",
        message: "Gateway Tailscale Funnel exposure is enabled.",
        source: "policy",
        path: "openclaw config",
        ocPath: entry.source,
        target: entry.source,
        requirement: `oc://${policyDocName}/gateway/exposure/allowTailscaleFunnel`,
        fixHint: "Use tailscale serve/off or update policy after review.",
      };
    });
}

function gatewayRemoteFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  if (readPolicyBoolean(policy, ["gateway", "remote", "allow"]) !== false) {
    return [];
  }
  return (evidence.gatewayExposure ?? [])
    .filter((entry) => entry.kind === "remote")
    .map((entry): HealthFinding => {
      return {
        checkId: CHECK_IDS.policyGatewayRemoteEnabled,
        severity: "error",
        message: `Gateway remote posture '${entry.id}' is enabled.`,
        source: "policy",
        path: "openclaw config",
        ocPath: entry.source,
        target: entry.source,
        requirement: `oc://${policyDocName}/gateway/remote/allow`,
        fixHint: "Disable remote gateway mode/config or update policy after review.",
      };
    });
}

function gatewayHttpEndpointFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const denied = new Set(
    readStringList(policy, ["gateway", "http", "denyEndpoints"]).map((endpoint) =>
      endpoint.toLowerCase(),
    ),
  );
  if (denied.size === 0) {
    return [];
  }
  return (evidence.gatewayExposure ?? [])
    .filter(
      (entry) =>
        entry.kind === "httpEndpoint" &&
        entry.endpoint !== undefined &&
        denied.has(entry.endpoint.toLowerCase()),
    )
    .map((entry): HealthFinding => {
      return {
        checkId: CHECK_IDS.policyGatewayHttpEndpointEnabled,
        severity: "error",
        message: `Gateway HTTP endpoint '${entry.endpoint ?? entry.id}' is denied by policy.`,
        source: "policy",
        path: "openclaw config",
        ocPath: entry.source,
        target: entry.source,
        requirement: `oc://${policyDocName}/gateway/http/denyEndpoints`,
        fixHint: "Disable the HTTP endpoint or update policy after review.",
      };
    });
}

function gatewayHttpUrlFetchFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  if (readPolicyBoolean(policy, ["gateway", "http", "requireUrlAllowlists"]) !== true) {
    return [];
  }
  return (evidence.gatewayExposure ?? [])
    .filter((entry) => entry.kind === "httpUrlFetch" && entry.hasAllowlist !== true)
    .map((entry): HealthFinding => {
      return {
        checkId: CHECK_IDS.policyGatewayHttpUrlFetchUnrestricted,
        severity: "error",
        message: `Gateway HTTP URL-fetch input '${entry.id}' has no URL allowlist.`,
        source: "policy",
        path: "openclaw config",
        ocPath: entry.source,
        target: entry.source,
        requirement: `oc://${policyDocName}/gateway/http/requireUrlAllowlists`,
        fixHint: "Add a urlAllowlist for this URL-fetch input or update policy after review.",
      };
    });
}

function gatewayNodeCommandFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  if (!hasValidOptionalStringList(policy, ["gateway", "nodes", "denyCommands"])) {
    return [];
  }
  const policyDenied = readStringList(policy, ["gateway", "nodes", "denyCommands"], {
    lowercase: false,
  });
  if (policyDenied.length === 0) {
    return [];
  }
  const configDenied = new Set(
    (evidence.gatewayExposure ?? [])
      .filter((entry) => entry.kind === "nodeDenyCommand" && entry.command !== undefined)
      .map((entry) => entry.command),
  );
  return policyDenied
    .filter((command) => !configDenied.has(command))
    .map((command): HealthFinding => {
      return {
        checkId: CHECK_IDS.policyGatewayNodeCommandDenied,
        severity: "error",
        message: `Gateway node command '${command}' is denied by policy but not denied by OpenClaw config.`,
        source: "policy",
        path: "openclaw config",
        ocPath: "oc://openclaw.config/gateway/nodes/commands/deny",
        target: "oc://openclaw.config/gateway/nodes/commands/deny",
        requirement: `oc://${policyDocName}/gateway/nodes/denyCommands`,
        fixHint: `Add '${command}' to gateway.nodes.commands.deny or update policy after review.`,
      };
    });
}

function hasValidOptionalStringList(policy: unknown, path: readonly string[]): boolean {
  let current: unknown = policy;
  for (const part of path) {
    if (!isRecord(current)) {
      return true;
    }
    current = current[part];
  }
  return (
    current === undefined ||
    (Array.isArray(current) &&
      current.every((entry) => typeof entry === "string" && entry.trim() !== ""))
  );
}
