// Policy plugin data, secret, and auth evidence.
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { coerceSecretRef } from "openclaw/plugin-sdk/secret-input";
import {
  isRecord,
  asBoolean as readBoolean,
  normalizeOptionalString as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { ocPathSegment } from "./policy-state-helpers.js";
import type {
  PolicyAuthProfileEvidence,
  PolicyDataHandlingEvidence,
  PolicySecretEvidence,
  SecretRefDefaults,
  SecretRefEvidence,
} from "./policy-state-types.js";

export function scanPolicySecrets(cfg: Record<string, unknown>): readonly PolicySecretEvidence[] {
  return [...scanPolicySecretProviders(cfg), ...scanPolicySecretInputs(cfg)].toSorted((a, b) =>
    a.source.localeCompare(b.source),
  );
}

export function scanPolicyAuthProfiles(
  cfg: Record<string, unknown>,
): readonly PolicyAuthProfileEvidence[] {
  const auth = isRecord(cfg.auth) ? cfg.auth : {};
  const profiles = isRecord(auth.profiles) ? auth.profiles : {};
  return Object.entries(profiles)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([id, value]) => {
      const entry: {
        id: string;
        source: string;
        validMetadata: boolean;
        provider?: string;
        mode?: string;
      } = {
        id,
        source: `oc://openclaw.config/auth/profiles/${ocPathSegment(id)}`,
        validMetadata: isValidAuthProfileMetadata(value),
      };
      if (isRecord(value)) {
        if (typeof value.provider === "string") {
          entry.provider = value.provider;
        }
        if (typeof value.mode === "string") {
          entry.mode = value.mode;
        }
      }
      return entry;
    });
}

export function scanPolicyDataHandling(
  cfg: Record<string, unknown>,
): readonly PolicyDataHandlingEvidence[] {
  const entries: PolicyDataHandlingEvidence[] = [];
  const logging = isRecord(cfg.logging) ? cfg.logging : {};
  entries.push({
    id: "logging-redaction",
    kind: "sensitiveLoggingRedaction",
    source: "oc://openclaw.config/logging/redactSensitive",
    scope: "global",
    value: logging.redactSensitive !== "off",
    explicit: logging.redactSensitive !== undefined,
  });

  const diagnostics = isRecord(cfg.diagnostics) ? cfg.diagnostics : {};
  const otel = isRecord(diagnostics.otel) ? diagnostics.otel : {};
  const otelEnabled = diagnostics.enabled !== false && otel.enabled === true;
  const tracesEnabled = otelEnabled && otel.traces !== false;
  const logsEnabled = otelEnabled && otel.logs === true;
  const captureContent =
    otelEnabled &&
    telemetryContentCaptureEnabled(otel.captureContent, {
      tracesEnabled,
      logsEnabled,
    });
  entries.push({
    id: "diagnostics-otel-content-capture",
    kind: "telemetryContentCapture",
    source: "oc://openclaw.config/diagnostics/otel/captureContent",
    scope: "global",
    value: captureContent,
    explicit: otel.captureContent !== undefined,
  });

  const session = isRecord(cfg.session) ? cfg.session : {};
  const maintenance = isRecord(session.maintenance) ? session.maintenance : {};
  const retentionMode = typeof maintenance.mode === "string" ? maintenance.mode : "enforce";
  entries.push({
    id: "session-maintenance-mode",
    kind: "sessionRetentionMode",
    source: "oc://openclaw.config/session/maintenance/mode",
    scope: "global",
    value: retentionMode,
    explicit: maintenance.mode !== undefined,
  });

  pushMemorySessionTranscriptIndexing(entries, cfg);
  return entries.toSorted((a, b) => a.source.localeCompare(b.source));
}

function telemetryContentCaptureEnabled(
  value: unknown,
  signals: { readonly tracesEnabled: boolean; readonly logsEnabled: boolean },
): boolean {
  if (value === true) {
    return signals.tracesEnabled || signals.logsEnabled;
  }
  if (!isRecord(value)) {
    return false;
  }
  if (!signals.tracesEnabled) {
    return false;
  }
  if (value.enabled !== true) {
    return false;
  }
  return (
    value.inputMessages === true ||
    value.outputMessages === true ||
    value.toolInputs === true ||
    value.toolOutputs === true ||
    value.systemPrompt === true ||
    value.toolDefinitions === true
  );
}

function pushMemorySessionTranscriptIndexing(
  entries: PolicyDataHandlingEvidence[],
  cfg: Record<string, unknown>,
): void {
  const memory = isRecord(cfg.memory) ? cfg.memory : {};
  const qmd = isRecord(memory.qmd) ? memory.qmd : {};
  const qmdSessions = isRecord(qmd.sessions) ? qmd.sessions : {};
  if (qmdSessions.enabled !== undefined) {
    entries.push({
      id: "memory-qmd-session-transcripts",
      kind: "memorySessionTranscriptIndexing",
      source: "oc://openclaw.config/memory/qmd/sessions/enabled",
      scope: "global",
      value: memory.backend === "qmd" && readBoolean(qmdSessions.enabled) === true,
      explicit: true,
    });
  }

  const agents = isRecord(cfg.agents) ? cfg.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  const defaultsMemorySearch = isRecord(defaults.memorySearch) ? defaults.memorySearch : {};
  const defaultSessionMemory = memorySearchSessionTranscriptIndexing(defaultsMemorySearch);
  if (defaultSessionMemory !== undefined) {
    entries.push({
      id: "agents-defaults-memory-session-transcripts",
      kind: "memorySessionTranscriptIndexing",
      source: "oc://openclaw.config/agents/defaults/memorySearch/experimental/sessionMemory",
      scope: "global",
      value: defaultSessionMemory,
      explicit: true,
    });
  }

  if (!Array.isArray(agents.list)) {
    return;
  }
  agents.list.forEach((rawAgent, index) => {
    if (!isRecord(rawAgent)) {
      return;
    }
    const agentId =
      readString(rawAgent.id) ??
      readString(rawAgent.name) ??
      readString(rawAgent.slug) ??
      `agent-${index}`;
    const memorySearch = isRecord(rawAgent.memorySearch) ? rawAgent.memorySearch : undefined;
    const agentSessionMemory =
      memorySearch === undefined
        ? defaultSessionMemory
        : memorySearchSessionTranscriptIndexing(memorySearch, defaultsMemorySearch);
    if (agentSessionMemory === undefined) {
      return;
    }
    const explicit = memorySearchSessionTranscriptIndexingHasLocalConfig(memorySearch);
    entries.push({
      id: `${agentId}-memory-session-transcripts`,
      kind: "memorySessionTranscriptIndexing",
      source: explicit
        ? `oc://openclaw.config/agents/list/#${index}/memorySearch/experimental/sessionMemory`
        : "oc://openclaw.config/agents/defaults/memorySearch/experimental/sessionMemory",
      scope: "agent",
      agentId: normalizeAgentId(agentId),
      value: agentSessionMemory,
      explicit,
    });
  });
}

function memorySearchSessionTranscriptIndexing(
  memorySearch: unknown,
  inheritedMemorySearch?: unknown,
): boolean | undefined {
  if (!isRecord(memorySearch)) {
    return undefined;
  }
  const experimental = isRecord(memorySearch.experimental) ? memorySearch.experimental : {};
  const inherited = isRecord(inheritedMemorySearch) ? inheritedMemorySearch : {};
  const inheritedExperimental = isRecord(inherited.experimental) ? inherited.experimental : {};
  const enabled = readBoolean(memorySearch.enabled) ?? readBoolean(inherited.enabled) ?? true;
  const sessionMemory =
    readBoolean(experimental.sessionMemory) ?? readBoolean(inheritedExperimental.sessionMemory);
  const sourcesIncludeSessions =
    memorySearchSourcesIncludeSessions(memorySearch) ??
    memorySearchSourcesIncludeSessions(inherited) ??
    false;
  if (
    sessionMemory === undefined &&
    memorySearchSourcesIncludeSessions(memorySearch) === undefined &&
    readBoolean(memorySearch.enabled) === undefined
  ) {
    return undefined;
  }
  if (!enabled) {
    return false;
  }
  return sessionMemory === true && sourcesIncludeSessions;
}

function memorySearchSessionTranscriptIndexingHasLocalConfig(memorySearch: unknown): boolean {
  if (!isRecord(memorySearch)) {
    return false;
  }
  const experimental = isRecord(memorySearch.experimental) ? memorySearch.experimental : {};
  return (
    readBoolean(memorySearch.enabled) !== undefined ||
    readBoolean(experimental.sessionMemory) !== undefined ||
    memorySearchSourcesIncludeSessions(memorySearch) !== undefined
  );
}

function memorySearchSourcesIncludeSessions(memorySearch: unknown): boolean | undefined {
  if (!isRecord(memorySearch) || memorySearch.sources === undefined) {
    return undefined;
  }
  if (!Array.isArray(memorySearch.sources)) {
    return false;
  }
  return memorySearch.sources.includes("sessions");
}

function scanPolicySecretProviders(cfg: Record<string, unknown>): readonly PolicySecretEvidence[] {
  const secrets = isRecord(cfg.secrets) ? cfg.secrets : {};
  const providers = isRecord(secrets.providers) ? secrets.providers : {};
  return Object.entries(providers).map(([id, value]) => {
    const insecure = secretProviderInsecureFlags(value);
    const entry: {
      id: string;
      kind: "provider";
      source: string;
      providerSource?: string;
      insecure?: readonly string[];
    } = {
      id,
      kind: "provider",
      source: `oc://openclaw.config/secrets/providers/${ocPathSegment(id)}`,
    };
    if (isRecord(value) && typeof value.source === "string") {
      entry.providerSource = value.source;
    }
    if (insecure.length > 0) {
      entry.insecure = insecure;
    }
    return entry;
  });
}

function scanPolicySecretInputs(cfg: Record<string, unknown>): readonly PolicySecretEvidence[] {
  const entries: PolicySecretEvidence[] = [];
  const secrets = isRecord(cfg.secrets) ? cfg.secrets : {};
  collectSecretInputs(entries, cfg, [], secretRefDefaults(secrets.defaults));
  return entries;
}

function collectSecretInputs(
  entries: PolicySecretEvidence[],
  value: unknown,
  path: readonly string[],
  defaults: SecretRefDefaults | undefined,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectSecretInputs(entries, item, [...path, `#${index}`], defaults),
    );
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    const source = configPathSource(childPath);
    const secretInputPath = isSecretInputPath(childPath);
    const ref = secretInputPath ? secretRefEvidence(child, defaults) : undefined;
    if (ref !== undefined) {
      entries.push({
        id: source,
        kind: "input",
        source,
        provenance: "secretRef",
        refSource: ref.source,
        refProvider: ref.provider,
      });
      continue;
    }
    collectSecretInputs(entries, child, childPath, defaults);
  }
}

function configPathSource(path: readonly string[]): string {
  return `oc://openclaw.config/${path.map(ocPathSegment).join("/")}`;
}

function isSecretInputPath(path: readonly string[]): boolean {
  const key = path.at(-1);
  if (key === undefined) {
    return false;
  }
  if (
    matchesConfigPath(path, ["plugins", "entries", "acpx", "config", "mcpServers", "*", "env", "*"])
  ) {
    return true;
  }
  if (isRawEnvMapValuePath(path)) {
    return false;
  }
  if (isSecretInputKey(key)) {
    return true;
  }
  return (
    matchesConfigPath(path, ["models", "providers", "*", "headers", "*"]) ||
    isConfiguredProviderRequestSecretPath(path, ["models", "providers", "*"]) ||
    isMediaConfiguredProviderRequestSecretPath(path) ||
    matchesConfigPath(path, ["agents", "defaults", "memorySearch", "remote", "headers", "*"]) ||
    matchesConfigPath(path, ["diagnostics", "otel", "headers", "*"])
  );
}

function isRawEnvMapValuePath(path: readonly string[]): boolean {
  return path.length >= 2 && path.at(-2) === "env";
}

function isMediaConfiguredProviderRequestSecretPath(path: readonly string[]): boolean {
  return (
    isConfiguredProviderRequestSecretPath(path, ["tools", "media", "models", "#"]) ||
    isConfiguredProviderRequestSecretPath(path, ["tools", "media", "audio"]) ||
    isConfiguredProviderRequestSecretPath(path, ["tools", "media", "audio", "models", "#"]) ||
    isConfiguredProviderRequestSecretPath(path, ["tools", "media", "image"]) ||
    isConfiguredProviderRequestSecretPath(path, ["tools", "media", "image", "models", "#"]) ||
    isConfiguredProviderRequestSecretPath(path, ["tools", "media", "video"]) ||
    isConfiguredProviderRequestSecretPath(path, ["tools", "media", "video", "models", "#"])
  );
}

function isConfiguredProviderRequestSecretPath(
  path: readonly string[],
  prefix: readonly string[],
): boolean {
  if (path.length < prefix.length + 3) {
    return false;
  }
  if (!matchesConfigPathPrefix(path, prefix)) {
    return false;
  }
  const requestIndex = prefix.length;
  if (path[requestIndex] !== "request") {
    return false;
  }
  const suffix = path.slice(requestIndex + 1);
  if (suffix.length === 2 && suffix[0] === "headers") {
    return true;
  }
  if (suffix.length === 2 && suffix[0] === "auth" && isConfiguredProviderAuthSecretKey(suffix[1])) {
    return true;
  }
  if (suffix.length === 2 && suffix[0] === "tls" && isConfiguredProviderTlsSecretKey(suffix[1])) {
    return true;
  }
  return (
    suffix.length === 3 &&
    suffix[0] === "proxy" &&
    suffix[1] === "tls" &&
    isConfiguredProviderTlsSecretKey(suffix[2])
  );
}

function matchesConfigPathPrefix(path: readonly string[], prefix: readonly string[]): boolean {
  if (path.length < prefix.length) {
    return false;
  }
  return prefix.every((segment, index) => {
    const value = path[index];
    if (segment === "*") {
      return value !== undefined && value !== "";
    }
    if (segment === "#") {
      return value?.startsWith("#") ?? false;
    }
    return value === segment;
  });
}

function matchesConfigPath(path: readonly string[], pattern: readonly string[]): boolean {
  return path.length === pattern.length && matchesConfigPathPrefix(path, pattern);
}

function isConfiguredProviderTlsSecretKey(key: string | undefined): boolean {
  return key === "ca" || key === "cert" || key === "key" || key === "passphrase";
}

function isConfiguredProviderAuthSecretKey(key: string | undefined): boolean {
  return key === "token" || key === "value";
}

function isSecretInputKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized === "apikey" ||
    normalized === "keyref" ||
    normalized === "token" ||
    normalized === "tokenref" ||
    normalized === "password" ||
    normalized === "secret" ||
    normalized === "encryptkey" ||
    normalized === "webhooksecret" ||
    normalized === "serviceaccount" ||
    normalized === "serviceaccountref" ||
    normalized === "privatekey" ||
    normalized === "certificate" ||
    normalized === "certificatedata" ||
    normalized === "identitydata" ||
    normalized === "knownhosts" ||
    normalized === "knownhostsdata" ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("password")
  );
}

function secretRefDefaults(value: unknown): SecretRefDefaults | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const defaults: SecretRefDefaults = {};
  if (typeof value.env === "string") {
    defaults.env = value.env;
  }
  if (typeof value.file === "string") {
    defaults.file = value.file;
  }
  if (typeof value.exec === "string") {
    defaults.exec = value.exec;
  }
  return defaults;
}

function secretRefEvidence(
  value: unknown,
  defaults: SecretRefDefaults | undefined,
): SecretRefEvidence | undefined {
  const ref = coerceSecretRef(value, defaults);
  return ref === null ? undefined : { source: ref.source, provider: ref.provider, id: ref.id };
}

function secretProviderInsecureFlags(value: unknown): readonly string[] {
  if (!isRecord(value)) {
    return [];
  }
  return [
    ...(value.allowInsecurePath === true ? ["allowInsecurePath"] : []),
    ...(value.allowSymlinkCommand === true ? ["allowSymlinkCommand"] : []),
  ];
}

function isValidAuthProfileMetadata(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.provider === "string" &&
    value.provider.trim() !== "" &&
    isAuthProfileMode(value.mode)
  );
}

function isAuthProfileMode(value: unknown): boolean {
  return value === "api_key" || value === "aws-sdk" || value === "oauth" || value === "token";
}
