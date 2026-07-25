// Policy automatic repairs apply only deterministic narrowing config changes.
import type {
  HealthFinding,
  HealthRepairContext,
  HealthRepairResult,
  OpenClawConfig,
} from "openclaw/plugin-sdk/health";
import { CHECK_IDS, type POLICY_CHECK_IDS } from "./check-ids.js";
import { POLICY_FIX_METADATA_BY_CHECK_ID } from "./fix-metadata.js";

type PolicyCheckId = (typeof POLICY_CHECK_IDS)[number];
type ConfigRecord = Record<string, unknown>;
type RepairPatch = {
  readonly config: OpenClawConfig;
  readonly changes: readonly string[];
  readonly warnings?: readonly string[];
};

const AUTOMATIC_REPAIR_CHECK_IDS = new Set<PolicyCheckId>([
  CHECK_IDS.policyAgentsToolNotDenied,
  CHECK_IDS.policyToolsElevatedEnabled,
  CHECK_IDS.policyToolsRequiredDenyMissing,
  CHECK_IDS.policyGatewayControlUiInsecure,
  CHECK_IDS.policyGatewayHttpEndpointEnabled,
  CHECK_IDS.policyGatewayRemoteEnabled,
  CHECK_IDS.policyIngressOpenGroupsDenied,
  CHECK_IDS.policyIngressGroupMentionRequired,
  CHECK_IDS.policyDataHandlingRedactionDisabled,
  CHECK_IDS.policyDataHandlingTelemetryContentCapture,
]);

export function repairPolicyAutomaticNarrower(
  ctx: HealthRepairContext,
  findings: readonly HealthFinding[],
  checkId: PolicyCheckId,
): Promise<HealthRepairResult> {
  if (!workspaceRepairsEnabled(ctx)) {
    return Promise.resolve(workspaceRepairsDisabledResult());
  }
  if (!AUTOMATIC_REPAIR_CHECK_IDS.has(checkId)) {
    return Promise.resolve({
      status: "skipped",
      reason: "policy finding is not an automatic narrowing repair",
      changes: [],
    });
  }
  if (
    findings.length === 0 ||
    findings.some(
      (finding) =>
        finding.checkId !== checkId ||
        POLICY_FIX_METADATA_BY_CHECK_ID.get(finding.checkId)?.fixClass !== "automatic",
    )
  ) {
    return Promise.resolve({
      status: "skipped",
      reason: "policy finding is not classified as automatic",
      changes: [],
    });
  }

  const patch = applyAutomaticPatch(ctx.cfg, findings, checkId);
  if (patch.changes.length === 0) {
    return Promise.resolve({
      status: "skipped",
      reason: "policy automatic repair had no config changes to apply",
      changes: [],
      ...(patch.warnings !== undefined ? { warnings: patch.warnings } : {}),
    });
  }
  return Promise.resolve({
    status: "repaired",
    config: patch.config,
    changes: patch.changes,
    ...(patch.warnings !== undefined ? { warnings: patch.warnings } : {}),
  });
}

function applyAutomaticPatch(
  cfg: OpenClawConfig,
  findings: readonly HealthFinding[],
  checkId: PolicyCheckId,
): RepairPatch {
  switch (checkId) {
    case CHECK_IDS.policyAgentsToolNotDenied:
      return mergeRequiredDenyTools(cfg, findings);
    case CHECK_IDS.policyToolsElevatedEnabled:
      if (hasScopedPolicyRequirement(findings)) {
        return skippedUnsafeScopedRepair(
          cfg,
          "Skipped scoped tools repair. Scoped elevated-tools policy findings are detect-only because automatic repair cannot safely choose between shared and agent-local config targets.",
        );
      }
      return disableElevatedTools(cfg, findings);
    case CHECK_IDS.policyToolsRequiredDenyMissing:
      return mergeRequiredDenyTools(cfg, findings);
    case CHECK_IDS.policyGatewayControlUiInsecure:
      return disableInsecureControlUi(cfg, findings);
    case CHECK_IDS.policyGatewayHttpEndpointEnabled:
      return setFindingConfigValues(cfg, findings, "enabled", false);
    case CHECK_IDS.policyGatewayRemoteEnabled:
      return disableRemoteGatewayMode(cfg, findings);
    case CHECK_IDS.policyIngressOpenGroupsDenied:
      return setFindingConfigValues(cfg, findings, "groupPolicy", "allowlist");
    case CHECK_IDS.policyIngressGroupMentionRequired:
      return setFindingConfigValues(cfg, findings, "requireMention", true);
    case CHECK_IDS.policyDataHandlingRedactionDisabled:
      if (hasScopedPolicyRequirement(findings)) {
        return skippedUnsafeScopedRepair(
          cfg,
          "Skipped scoped data-handling repair. The finding reports shared logging config, so changing it would affect more than the scoped policy target.",
        );
      }
      return enableSensitiveLoggingRedaction(cfg);
    case CHECK_IDS.policyDataHandlingTelemetryContentCapture:
      if (hasScopedPolicyRequirement(findings)) {
        return skippedUnsafeScopedRepair(
          cfg,
          "Skipped scoped data-handling repair. The finding reports shared telemetry config, so changing it would affect more than the scoped policy target.",
        );
      }
      return disableTelemetryContentCapture(cfg);
    default:
      return { config: cfg, changes: [] };
  }
}

function mergeRequiredDenyTools(
  cfg: OpenClawConfig,
  findings: readonly HealthFinding[],
): RepairPatch {
  const next = cloneConfig(cfg);
  const changes: string[] = [];
  const warnings: string[] = [];
  for (const finding of findings) {
    const tool = missingRequiredTool(finding);
    if (tool === undefined || finding.ocPath === undefined) {
      continue;
    }
    if (
      hasScopedPolicyRequirement([finding]) &&
      finding.ocPath === "oc://openclaw.config/tools/deny"
    ) {
      warnings.push(
        `Skipped scoped deny repair for ${tool}. The finding reports inherited root tools.deny, so changing it would affect more than the scoped policy target.`,
      );
      continue;
    }
    if (mergeStringArrayAtOcPath(next, finding.ocPath, tool)) {
      changes.push(`Added ${tool} to ${configPathLabel(finding.ocPath)} for policy conformance.`);
    }
  }
  return changes.length > 0
    ? { config: next as OpenClawConfig, changes: uniqueStrings(changes), warnings }
    : { config: cfg, changes, warnings: uniqueStrings(warnings) };
}

function disableElevatedTools(
  cfg: OpenClawConfig,
  findings: readonly HealthFinding[],
): RepairPatch {
  if (
    !findings.some((finding) => finding.ocPath === "oc://openclaw.config/tools/elevated/enabled")
  ) {
    return { config: cfg, changes: [] };
  }
  const next = cloneConfig(cfg);
  const tools = ensureRecord(next, "tools");
  const elevated = ensureRecord(tools, "elevated");
  if (elevated.enabled === false) {
    return { config: cfg, changes: [] };
  }
  elevated.enabled = false;
  return {
    config: next as OpenClawConfig,
    changes: ["Set tools.elevated.enabled=false for policy conformance."],
  };
}

function disableInsecureControlUi(
  cfg: OpenClawConfig,
  findings: readonly HealthFinding[],
): RepairPatch {
  const next = cloneConfig(cfg);
  const gateway = ensureRecord(next, "gateway");
  const controlUi = ensureRecord(gateway, "controlUi");
  const changes: string[] = [];
  const fields = [
    ["allowInsecureAuth", "oc://openclaw.config/gateway/controlUi/allowInsecureAuth"],
    [
      "dangerouslyDisableDeviceAuth",
      "oc://openclaw.config/gateway/controlUi/dangerouslyDisableDeviceAuth",
    ],
    [
      "dangerouslyAllowHostHeaderOriginFallback",
      "oc://openclaw.config/gateway/controlUi/dangerouslyAllowHostHeaderOriginFallback",
    ],
  ] as const;
  const findingPaths = new Set(findings.map((finding) => finding.ocPath));
  for (const [field, ocPath] of fields) {
    if (findingPaths.has(ocPath) && controlUi[field] !== false) {
      controlUi[field] = false;
      changes.push(`Set gateway.controlUi.${field}=false for policy conformance.`);
    }
  }
  return changes.length > 0
    ? { config: next as OpenClawConfig, changes }
    : { config: cfg, changes };
}

function disableRemoteGatewayMode(
  cfg: OpenClawConfig,
  findings: readonly HealthFinding[],
): RepairPatch {
  if (!findings.some((finding) => finding.ocPath === "oc://openclaw.config/gateway/mode")) {
    return { config: cfg, changes: [] };
  }
  const next = cloneConfig(cfg);
  const gateway = ensureRecord(next, "gateway");
  const changes: string[] = [];
  if (gateway.mode === "remote") {
    gateway.mode = "local";
    changes.push("Set gateway.mode=local for policy conformance.");
  }
  return changes.length > 0
    ? { config: next as OpenClawConfig, changes }
    : { config: cfg, changes };
}

function enableSensitiveLoggingRedaction(cfg: OpenClawConfig): RepairPatch {
  const next = cloneConfig(cfg);
  const logging = ensureRecord(next, "logging");
  if (logging.redactSensitive !== "off") {
    return { config: cfg, changes: [] };
  }
  logging.redactSensitive = "tools";
  return {
    config: next as OpenClawConfig,
    changes: ["Set logging.redactSensitive=tools for policy conformance."],
  };
}

function disableTelemetryContentCapture(cfg: OpenClawConfig): RepairPatch {
  const next = cloneConfig(cfg);
  const diagnostics = ensureRecord(next, "diagnostics");
  const otel = ensureRecord(diagnostics, "otel");
  if (otel.captureContent === false) {
    return { config: cfg, changes: [] };
  }
  otel.captureContent = false;
  return {
    config: next as OpenClawConfig,
    changes: ["Set diagnostics.otel.captureContent=false for policy conformance."],
  };
}

function setFindingConfigValues(
  cfg: OpenClawConfig,
  findings: readonly HealthFinding[],
  fieldName: string,
  value: unknown,
): RepairPatch {
  const next = cloneConfig(cfg);
  const changes: string[] = [];
  const warnings: string[] = [];
  for (const finding of findings) {
    if (isScopedInheritedChannelDefaultFinding(finding)) {
      warnings.push(
        `Skipped scoped channel ingress repair for ${configPathLabel(finding.ocPath ?? "")}. The finding reports inherited channels.defaults config, so changing it would affect more than the scoped channel target.`,
      );
      continue;
    }
    if (
      finding.ocPath === undefined ||
      configPathSegments(finding.ocPath).at(-1) !== fieldName ||
      !setValueAtOcPath(next, finding.ocPath, value)
    ) {
      continue;
    }
    changes.push(`Set ${configPathLabel(finding.ocPath)}=${String(value)} for policy conformance.`);
  }
  return changes.length > 0
    ? { config: next as OpenClawConfig, changes: uniqueStrings(changes), warnings }
    : { config: cfg, changes, warnings: uniqueStrings(warnings) };
}

function cloneConfig(cfg: OpenClawConfig): ConfigRecord {
  return structuredClone(cfg) as ConfigRecord;
}

function mergeStringArrayAtOcPath(cfg: ConfigRecord, ocPath: string, entry: string): boolean {
  const segments = configPathSegments(ocPath);
  if (segments.length === 0 || segments.at(-1) !== "deny") {
    return false;
  }
  let current: unknown = cfg;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (segment === undefined) {
      return false;
    }
    if (segment.startsWith("#")) {
      const arrayIndex = Number.parseInt(segment.slice(1), 10);
      if (!Array.isArray(current) || !Number.isInteger(arrayIndex) || arrayIndex < 0) {
        return false;
      }
      current = current[arrayIndex];
      continue;
    }
    if (!isRecord(current)) {
      return false;
    }
    const nextSegment = segments[index + 1];
    const existing = current[segment];
    if (existing === undefined) {
      current[segment] = nextSegment?.startsWith("#") ? [] : {};
    }
    current = current[segment];
  }
  if (!isRecord(current)) {
    return false;
  }
  const existing = current.deny;
  if (existing !== undefined && !Array.isArray(existing)) {
    return false;
  }
  const deny = existing ?? [];
  if (deny.some((value) => typeof value === "string" && value === entry)) {
    return false;
  }
  current.deny = [...deny, entry];
  return true;
}

function configPathSegments(ocPath: string): readonly string[] {
  const prefix = "oc://openclaw.config/";
  if (!ocPath.startsWith(prefix)) {
    return [];
  }
  return splitConfigPath(ocPath.slice(prefix.length));
}

function splitConfigPath(path: string): readonly string[] {
  const segments: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  for (const char of path) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (quoted && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && char === "/") {
      if (current !== "") {
        segments.push(current);
      }
      current = "";
      continue;
    }
    current += char;
  }
  if (current !== "") {
    segments.push(current);
  }
  return quoted ? [] : segments;
}

function configPathLabel(ocPath: string): string {
  let label = "";
  for (const segment of configPathSegments(ocPath)) {
    if (segment.startsWith("#")) {
      label += `[${segment.slice(1)}]`;
    } else {
      label += label === "" ? segment : `.${segment}`;
    }
  }
  return label;
}

function missingRequiredTool(finding: HealthFinding): string | undefined {
  return finding.message.match(/required tool '([^']+)'/)?.[1]?.trim();
}

function setValueAtOcPath(cfg: ConfigRecord, ocPath: string, value: unknown): boolean {
  const segments = configPathSegments(ocPath);
  if (segments.length === 0) {
    return false;
  }
  let current: unknown = cfg;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (segment === undefined || segment.startsWith("#")) {
      return false;
    }
    if (!isRecord(current)) {
      return false;
    }
    const existing = current[segment];
    if (existing !== undefined && !isRecord(existing)) {
      return false;
    }
    if (existing === undefined) {
      current[segment] = {};
    }
    current = current[segment];
  }
  if (!isRecord(current)) {
    return false;
  }
  const last = segments.at(-1);
  if (last === undefined || last.startsWith("#") || current[last] === value) {
    return false;
  }
  current[last] = value;
  return true;
}

function workspaceRepairsEnabled(ctx: HealthRepairContext): boolean {
  const plugins = isRecord(ctx.cfg.plugins) ? ctx.cfg.plugins : {};
  const entries = isRecord(plugins.entries) ? plugins.entries : {};
  const policy = isRecord(entries.policy) ? entries.policy : {};
  const config = isRecord(policy.config) ? policy.config : {};
  return config.workspaceRepairs === true;
}

function workspaceRepairsDisabledResult(): HealthRepairResult {
  const warning =
    "Skipped policy config repair. Enable plugins.entries.policy.config.workspaceRepairs to let doctor --fix edit workspace policy config.";
  return {
    status: "skipped",
    reason: "workspace repairs are disabled",
    changes: [],
    warnings: [warning],
  };
}

function hasScopedPolicyRequirement(findings: readonly HealthFinding[]): boolean {
  return findings.some((finding) => finding.requirement?.includes("/scopes/") === true);
}

function skippedUnsafeScopedRepair(cfg: OpenClawConfig, warning: string): RepairPatch {
  return { config: cfg, changes: [], warnings: [warning] };
}

function isScopedInheritedChannelDefaultFinding(finding: HealthFinding): boolean {
  return (
    hasScopedPolicyRequirement([finding]) &&
    finding.ocPath?.startsWith("oc://openclaw.config/channels/defaults/") === true
  );
}

function ensureRecord(parent: ConfigRecord, key: string): ConfigRecord {
  const current = parent[key];
  if (isRecord(current)) {
    const copy = { ...current };
    parent[key] = copy;
    return copy;
  }
  const next: ConfigRecord = {};
  parent[key] = next;
  return next;
}

function isRecord(value: unknown): value is ConfigRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
