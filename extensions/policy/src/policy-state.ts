import { createHash } from "node:crypto";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import { coerceSecretRef } from "openclaw/plugin-sdk/secret-input";

export type PolicyAttestation = {
  readonly checkedAt: string;
  readonly policy?: {
    readonly path: string;
    readonly hash: string;
  };
  readonly workspace: {
    readonly scope: "policy";
    readonly hash: string;
  };
  readonly findingsHash?: string;
  readonly attestationHash?: string;
};

export type PolicyEvidence = {
  readonly channels: readonly PolicyChannelEvidence[];
  readonly tools?: readonly PolicyToolEvidence[];
  readonly mcpServers: readonly PolicyMcpServerEvidence[];
  readonly modelProviders: readonly PolicyModelProviderEvidence[];
  readonly modelRefs: readonly PolicyModelRefEvidence[];
  readonly network: readonly PolicyNetworkEvidence[];
  readonly gatewayExposure?: readonly PolicyGatewayExposureEvidence[];
  readonly secrets?: readonly PolicySecretEvidence[];
  readonly authProfiles?: readonly PolicyAuthProfileEvidence[];
};

export type PolicyChannelEvidence = {
  readonly id: string;
  readonly provider: string;
  readonly source: string;
  readonly enabled?: boolean;
};

export type PolicyMcpServerEvidence = {
  readonly id: string;
  readonly transport: "stdio" | "sse" | "streamable-http" | "unknown";
  readonly source: string;
  readonly command?: string;
  readonly url?: string;
};

export type PolicyToolEvidence = {
  readonly id: string;
  readonly source: string;
  readonly line: number;
  readonly risk?: string;
  readonly sensitivity?: string;
  readonly owner?: string;
  readonly capabilities?: readonly string[];
};

export type PolicyModelProviderEvidence = {
  readonly id: string;
  readonly source: string;
};

export type PolicyModelRefEvidence = {
  readonly ref: string;
  readonly provider: string;
  readonly model: string;
  readonly source: string;
};

export type PolicyNetworkEvidence = {
  readonly id: string;
  readonly source: string;
  readonly value: boolean;
};

export type PolicyGatewayExposureEvidence = {
  readonly id: string;
  readonly kind:
    | "auth"
    | "authRateLimit"
    | "bind"
    | "controlUi"
    | "httpEndpoint"
    | "httpUrlFetch"
    | "remote"
    | "tailscale";
  readonly source: string;
  readonly value?: boolean | string;
  readonly nonLoopback?: boolean;
  readonly explicit?: boolean;
  readonly endpoint?: string;
  readonly hasAllowlist?: boolean;
};

export type PolicySecretEvidence = {
  readonly id: string;
  readonly kind: "input" | "provider";
  readonly source: string;
  readonly provenance?: "secretRef";
  readonly refSource?: "env" | "file" | "exec";
  readonly refProvider?: string;
  readonly providerSource?: string;
  readonly insecure?: readonly string[];
};

export type PolicyAuthProfileEvidence = {
  readonly id: string;
  readonly source: string;
  readonly validMetadata: boolean;
  readonly provider?: string;
  readonly mode?: string;
};

type SecretRefEvidence = {
  readonly source: "env" | "file" | "exec";
  readonly provider: string;
  readonly id: string;
};
type SecretRefDefaults = NonNullable<Parameters<typeof coerceSecretRef>[1]>;

const RESERVED_CHANNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);
const NON_SLUG_CHARS = /[^a-z0-9-]+/g;
const COLLAPSE_HYPHENS = /-+/g;
const TRIM_HYPHENS = /^-+|-+$/g;

export function policyDocumentHash(policy: unknown): string {
  return sha256(stableJson(policy));
}

export function policyWorkspaceHash(evidence: PolicyEvidence): string {
  return sha256(stableJson(evidence));
}

export function policyFindingsHash(findings: readonly unknown[]): string {
  return sha256(stableJson(findings));
}

export function policyAttestationHash(input: {
  readonly ok: boolean;
  readonly policyHash?: string;
  readonly workspaceHash: string;
  readonly findingsHash: string;
}): string {
  return sha256(stableJson(input));
}

export function createPolicyAttestation(input: {
  readonly ok: boolean;
  readonly checkedAt: string;
  readonly policyPath: string;
  readonly policyHash?: string;
  readonly evidence: PolicyEvidence;
  readonly findings: readonly unknown[];
}): PolicyAttestation {
  const workspaceHash = policyWorkspaceHash(input.evidence);
  const findingsHash = policyFindingsHash(input.findings);
  return {
    checkedAt: input.checkedAt,
    ...(input.policyHash === undefined
      ? {}
      : {
          policy: {
            path: input.policyPath,
            hash: input.policyHash,
          },
        }),
    workspace: {
      scope: "policy",
      hash: workspaceHash,
    },
    findingsHash,
    attestationHash: policyAttestationHash({
      ok: input.ok,
      policyHash: input.policyHash,
      workspaceHash,
      findingsHash,
    }),
  };
}

export function collectPolicyEvidence(
  cfg: Record<string, unknown>,
  options?: {
    readonly toolsRaw?: undefined;
    readonly includeGatewayExposure?: boolean;
    readonly includeSecrets?: boolean;
    readonly includeAuthProfiles?: boolean;
  },
): PolicyEvidence;
export function collectPolicyEvidence(
  cfg: Record<string, unknown>,
  options: {
    readonly toolsRaw: string;
    readonly includeGatewayExposure?: boolean;
    readonly includeSecrets?: boolean;
    readonly includeAuthProfiles?: boolean;
  },
): Promise<PolicyEvidence>;
export function collectPolicyEvidence(
  cfg: Record<string, unknown>,
  options: {
    readonly toolsRaw?: string;
    readonly includeGatewayExposure?: boolean;
    readonly includeSecrets?: boolean;
    readonly includeAuthProfiles?: boolean;
  } = {},
): PolicyEvidence | Promise<PolicyEvidence> {
  const evidence = {
    channels: scanPolicyChannels(cfg),
    mcpServers: scanPolicyMcpServers(cfg),
    modelProviders: scanPolicyModelProviders(cfg),
    modelRefs: scanPolicyModelRefs(cfg),
    network: scanPolicyNetwork(cfg),
    ...(options.includeGatewayExposure === false
      ? {}
      : { gatewayExposure: scanPolicyGatewayExposure(cfg) }),
    ...(options.includeSecrets === false ? {} : { secrets: scanPolicySecrets(cfg) }),
    ...(options.includeAuthProfiles === false ? {} : { authProfiles: scanPolicyAuthProfiles(cfg) }),
  };
  if (options.toolsRaw === undefined) {
    return evidence;
  }
  return scanPolicyTools(options.toolsRaw).then((tools) => ({ ...evidence, tools }));
}

export function scanPolicyChannels(cfg: Record<string, unknown>): readonly PolicyChannelEvidence[] {
  return Object.entries(configuredChannels(cfg))
    .filter(([id]) => !RESERVED_CHANNEL_CONFIG_KEYS.has(id))
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([id, value]) => {
      const entry: {
        id: string;
        provider: string;
        source: string;
        enabled?: boolean;
      } = {
        id,
        provider: id,
        source: `oc://openclaw.config/channels/${id}`,
      };
      if (isRecord(value) && typeof value.enabled === "boolean") {
        entry.enabled = value.enabled;
      }
      return entry;
    });
}

export function scanPolicyMcpServers(
  cfg: Record<string, unknown>,
): readonly PolicyMcpServerEvidence[] {
  return Object.entries(configuredMcpServers(cfg))
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([id, value]) => {
      const entry: {
        id: string;
        transport: "stdio" | "sse" | "streamable-http" | "unknown";
        source: string;
        command?: string;
        url?: string;
      } = {
        id,
        transport: mcpServerTransport(value),
        source: `oc://openclaw.config/mcp/servers/${ocPathSegment(id)}`,
      };
      if (isRecord(value)) {
        if (typeof value.command === "string") {
          entry.command = value.command;
        }
        if (typeof value.url === "string") {
          entry.url = redactMcpUrlForEvidence(value.url);
        }
      }
      return entry;
    });
}

export function scanPolicyModelProviders(
  cfg: Record<string, unknown>,
): readonly PolicyModelProviderEvidence[] {
  return Object.keys(configuredModelProviders(cfg))
    .toSorted((a, b) => a.localeCompare(b))
    .map((id) => ({
      id: normalizeProviderId(id),
      source: `oc://openclaw.config/models/providers/${id}`,
    }));
}

export function scanPolicyModelRefs(
  cfg: Record<string, unknown>,
): readonly PolicyModelRefEvidence[] {
  const refs: PolicyModelRefEvidence[] = [];
  if (isRecord(cfg.agents)) {
    collectModelRefsFromRecord(refs, cfg.agents, "oc://openclaw.config/agents");
    collectModelRefsFromAgentAllowlist(refs, cfg.agents);
  }
  return refs.toSorted(
    (a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
  );
}

export function scanPolicyNetwork(cfg: Record<string, unknown>): readonly PolicyNetworkEvidence[] {
  return [
    networkBooleanEvidence(
      cfg,
      "browser-private-network",
      ["browser", "ssrfPolicy", "dangerouslyAllowPrivateNetwork"],
      "oc://openclaw.config/browser/ssrfPolicy/dangerouslyAllowPrivateNetwork",
    ),
    networkBooleanEvidence(
      cfg,
      "browser-private-network-legacy",
      ["browser", "ssrfPolicy", "allowPrivateNetwork"],
      "oc://openclaw.config/browser/ssrfPolicy/allowPrivateNetwork",
    ),
    networkBooleanEvidence(
      cfg,
      "web-fetch-private-network",
      ["tools", "web", "fetch", "ssrfPolicy", "dangerouslyAllowPrivateNetwork"],
      "oc://openclaw.config/tools/web/fetch/ssrfPolicy/dangerouslyAllowPrivateNetwork",
    ),
    networkBooleanEvidence(
      cfg,
      "web-fetch-private-network-legacy",
      ["tools", "web", "fetch", "ssrfPolicy", "allowPrivateNetwork"],
      "oc://openclaw.config/tools/web/fetch/ssrfPolicy/allowPrivateNetwork",
    ),
    networkBooleanEvidence(
      cfg,
      "web-fetch-rfc2544-benchmark-range",
      ["tools", "web", "fetch", "ssrfPolicy", "allowRfc2544BenchmarkRange"],
      "oc://openclaw.config/tools/web/fetch/ssrfPolicy/allowRfc2544BenchmarkRange",
    ),
    networkBooleanEvidence(
      cfg,
      "web-fetch-ipv6-unique-local-range",
      ["tools", "web", "fetch", "ssrfPolicy", "allowIpv6UniqueLocalRange"],
      "oc://openclaw.config/tools/web/fetch/ssrfPolicy/allowIpv6UniqueLocalRange",
    ),
  ].filter((entry): entry is PolicyNetworkEvidence => entry !== undefined);
}

export function scanPolicyGatewayExposure(
  cfg: Record<string, unknown>,
): readonly PolicyGatewayExposureEvidence[] {
  const gateway = isRecord(cfg.gateway) ? cfg.gateway : {};
  const entries: PolicyGatewayExposureEvidence[] = [];
  const bind = typeof gateway.bind === "string" ? gateway.bind : undefined;
  const customBindHost =
    typeof gateway.customBindHost === "string" ? gateway.customBindHost : undefined;
  const hasCustomBindHost = customBindHost !== undefined && customBindHost.trim() !== "";
  const tailscale = isRecord(gateway.tailscale) ? gateway.tailscale : {};
  const tailscaleForcesLoopback = tailscale.mode === "serve" || tailscale.mode === "funnel";
  entries.push({
    id: bind === undefined ? "gateway-bind-default" : "gateway-bind",
    kind: "bind",
    source: "oc://openclaw.config/gateway/bind",
    value: bind ?? (tailscaleForcesLoopback ? "loopback" : "runtime-default"),
    nonLoopback:
      bind === undefined
        ? !tailscaleForcesLoopback
        : bind === "custom"
          ? false
          : isGatewayNonLoopbackBind(bind),
    explicit: bind !== undefined,
  });
  if (bind === "custom" && hasCustomBindHost) {
    entries.push({
      id: "gateway-custom-bind-host",
      kind: "bind",
      source: "oc://openclaw.config/gateway/customBindHost",
      value: customBindHost,
      nonLoopback: isRuntimeNonLoopbackCustomBindHost(customBindHost),
    });
  }

  const auth = isRecord(gateway.auth) ? gateway.auth : {};
  entries.push({
    id: "gateway-auth-mode",
    kind: "auth",
    source: "oc://openclaw.config/gateway/auth/mode",
    value: typeof auth.mode === "string" ? auth.mode : "token",
    explicit: typeof auth.mode === "string",
  });
  entries.push({
    id: "gateway-auth-rate-limit",
    kind: "authRateLimit",
    source: "oc://openclaw.config/gateway/auth/rateLimit",
    value: isRecord(auth.rateLimit),
    explicit: isRecord(auth.rateLimit),
  });

  const controlUi = isRecord(gateway.controlUi) ? gateway.controlUi : {};
  pushGatewayBooleanEvidence(
    entries,
    "gateway-control-ui-enabled",
    "controlUi",
    controlUi.enabled,
    "oc://openclaw.config/gateway/controlUi/enabled",
  );
  pushGatewayBooleanEvidence(
    entries,
    "gateway-control-ui-insecure-auth",
    "controlUi",
    controlUi.allowInsecureAuth,
    "oc://openclaw.config/gateway/controlUi/allowInsecureAuth",
  );
  pushGatewayBooleanEvidence(
    entries,
    "gateway-control-ui-device-auth-disabled",
    "controlUi",
    controlUi.dangerouslyDisableDeviceAuth,
    "oc://openclaw.config/gateway/controlUi/dangerouslyDisableDeviceAuth",
  );
  pushGatewayBooleanEvidence(
    entries,
    "gateway-control-ui-host-origin-fallback",
    "controlUi",
    controlUi.dangerouslyAllowHostHeaderOriginFallback,
    "oc://openclaw.config/gateway/controlUi/dangerouslyAllowHostHeaderOriginFallback",
  );

  if (typeof tailscale.mode === "string") {
    entries.push({
      id: "gateway-tailscale-mode",
      kind: "tailscale",
      source: "oc://openclaw.config/gateway/tailscale/mode",
      value: tailscale.mode,
    });
  }
  if (tailscale.mode === "serve" && tailscale.preserveFunnel === true) {
    entries.push({
      id: "gateway-tailscale-preserve-funnel",
      kind: "tailscale",
      source: "oc://openclaw.config/gateway/tailscale/preserveFunnel",
      value: "funnel",
    });
  }

  const remote = isRecord(gateway.remote) ? gateway.remote : {};
  if (gateway.mode === "remote") {
    entries.push({
      id: "gateway-mode-remote",
      kind: "remote",
      source: "oc://openclaw.config/gateway/mode",
      value: "remote",
    });
    if (typeof remote.url === "string" && remote.url.trim() !== "") {
      entries.push({
        id: "gateway-remote-url",
        kind: "remote",
        source: "oc://openclaw.config/gateway/remote/url",
        value: true,
      });
    }
  }

  const http = isRecord(gateway.http) ? gateway.http : {};
  const endpoints = isRecord(http.endpoints) ? http.endpoints : {};
  pushGatewayHttpEndpointEvidence(entries, endpoints, "chatCompletions");
  pushGatewayHttpEndpointEvidence(entries, endpoints, "responses");
  return entries.toSorted((a, b) => a.source.localeCompare(b.source));
}

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

export function scanPolicyTools(raw: string): Promise<readonly PolicyToolEvidence[]> {
  return Promise.resolve(scanPolicyToolHeaders(raw));
}

function scanPolicyToolHeaders(raw: string): readonly PolicyToolEvidence[] {
  const section = markdownSectionLines(raw, "tools");
  if (section.length === 0) {
    return [];
  }
  const tools: PolicyToolEvidence[] = [];
  for (let index = 0; index < section.length; index += 1) {
    const line = section[index]?.text ?? "";
    const heading = /^###\s+([^\s#]+)(.*)$/.exec(line);
    const bullet = /^[-*+]\s+([^:\s][^:]*?)\s*:(.*)$/.exec(line);
    const match = heading ?? bullet;
    if (match === null || slugify(match[1]).length === 0) {
      continue;
    }
    const id = slugify(match[1]);
    const entry: {
      id: string;
      source: string;
      line: number;
      risk?: string;
      sensitivity?: string;
      owner?: string;
      capabilities?: readonly string[];
    } = {
      id,
      source: `oc://TOOLS.md/tools/${id}`,
      line: section[index]?.line ?? index + 1,
    };
    const metaLines = [match[2] ?? ""];
    for (let metaIndex = index + 1; metaIndex < section.length; metaIndex += 1) {
      const metaLine = section[metaIndex]?.text ?? "";
      if (/^###\s+\S+/.test(metaLine.trim()) || /^[-*+]\s+[^:\s][^:]*?\s*:/.test(metaLine)) {
        break;
      }
      metaLines.push(metaLine);
    }
    const meta = metaLines.join("\n");
    const risk = riskFromMeta(meta);
    const sensitivity = /\bsensitivity\s*:\s*([a-z0-9_-]+)\b/i.exec(meta)?.[1]?.toLowerCase();
    const owner = /\bowner\s*:\s*([^\s#]+)\b/i.exec(meta)?.[1];
    const capabilities = capabilityTokensFromMetaLines(metaLines);
    if (risk !== undefined) {
      entry.risk = risk;
    }
    if (sensitivity !== undefined) {
      entry.sensitivity = sensitivity;
    }
    if (owner !== undefined) {
      entry.owner = owner;
    }
    if (capabilities.length > 0) {
      entry.capabilities = capabilities;
    }
    tools.push(entry);
  }
  return tools;
}

function markdownSectionLines(
  raw: string,
  sectionSlug: string,
): readonly { readonly line: number; readonly text: string }[] {
  const lines = raw.split(/\r?\n/);
  let sectionDepth: number | undefined;
  const section: { line: number; text: string }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      const depth = heading[1]?.length ?? 0;
      const slug = slugify(heading[2] ?? "");
      if (sectionDepth !== undefined && depth <= sectionDepth) {
        break;
      }
      if (sectionDepth !== undefined) {
        section.push({ line: index + 1, text: line });
        continue;
      }
      if (sectionDepth === undefined && slug === sectionSlug) {
        sectionDepth = depth;
      }
      continue;
    }
    if (sectionDepth !== undefined) {
      section.push({ line: index + 1, text: line });
    }
  }
  return section;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(NON_SLUG_CHARS, "-")
    .replace(COLLAPSE_HYPHENS, "-")
    .replace(TRIM_HYPHENS, "");
}

function riskFromMeta(meta: string): string | undefined {
  const namedRisk = /\brisk\s*:\s*([a-z0-9_-]+)\b/i.exec(meta)?.[1];
  if (namedRisk !== undefined) {
    return namedRisk.toLowerCase();
  }
  const alias = /\bR([0-5])\b/.exec(meta)?.[1];
  switch (alias) {
    case "0":
    case "1":
      return "low";
    case "2":
    case "3":
      return "medium";
    case "4":
      return "high";
    case "5":
      return "critical";
    default:
      return undefined;
  }
}

function capabilityTokensFromMetaLines(lines: readonly string[]): readonly string[] {
  return lines.flatMap((line, index): string[] => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return [];
    }
    const tokens = trimmed.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? [];
    if (index === 0 || /\bcapabilities\s*:/i.test(trimmed)) {
      return tokens;
    }
    const withoutTokens = tokens.reduce((remaining, token) => {
      return remaining.replace(token, "");
    }, trimmed);
    return /^[\s,;:[\](){}#*_-]*$/.test(withoutTokens) ? tokens : [];
  });
}

function configuredChannels(cfg: Record<string, unknown>): Record<string, unknown> {
  return isRecord(cfg.channels) ? cfg.channels : {};
}

function configuredMcpServers(cfg: Record<string, unknown>): Record<string, unknown> {
  return isRecord(cfg.mcp) && isRecord(cfg.mcp.servers) ? cfg.mcp.servers : {};
}

function mcpServerTransport(value: unknown): PolicyMcpServerEvidence["transport"] {
  if (!isRecord(value)) {
    return "unknown";
  }
  if (typeof value.command === "string") {
    return "stdio";
  }
  if (value.transport === "sse" || value.transport === "streamable-http") {
    return value.transport;
  }
  if (typeof value.url === "string") {
    return "streamable-http";
  }
  return "unknown";
}

function redactMcpUrlForEvidence(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "[redacted-url]";
  }
}

function configuredModelProviders(cfg: Record<string, unknown>): Record<string, unknown> {
  return isRecord(cfg.models) && isRecord(cfg.models.providers) ? cfg.models.providers : {};
}

function networkBooleanEvidence(
  cfg: Record<string, unknown>,
  id: string,
  path: readonly string[],
  source: string,
): PolicyNetworkEvidence | undefined {
  const value = readBooleanPath(cfg, path);
  return value === undefined ? undefined : { id, source, value };
}

function pushGatewayBooleanEvidence(
  entries: PolicyGatewayExposureEvidence[],
  id: string,
  kind: PolicyGatewayExposureEvidence["kind"],
  value: unknown,
  source: string,
): void {
  if (typeof value !== "boolean") {
    return;
  }
  entries.push({ id, kind, source, value });
}

function pushGatewayHttpEndpointEvidence(
  entries: PolicyGatewayExposureEvidence[],
  endpoints: Record<string, unknown>,
  endpoint: "chatCompletions" | "responses",
): void {
  const config = endpoints[endpoint];
  if (!isRecord(config)) {
    return;
  }
  const source = `oc://openclaw.config/gateway/http/endpoints/${endpoint}`;
  const enabled = config.enabled === true;
  if (enabled) {
    entries.push({
      id: `gateway-http-${endpoint}`,
      kind: "httpEndpoint",
      source: `${source}/enabled`,
      value: true,
      endpoint,
    });
  }
  if (!enabled) {
    return;
  }
  if (endpoint === "chatCompletions") {
    pushGatewayHttpUrlFetchEvidence(entries, source, endpoint, ["images"], config.images);
    return;
  }
  pushGatewayHttpUrlFetchEvidence(entries, source, endpoint, ["files"], config.files);
  pushGatewayHttpUrlFetchEvidence(entries, source, endpoint, ["images"], config.images);
}

function pushGatewayHttpUrlFetchEvidence(
  entries: PolicyGatewayExposureEvidence[],
  endpointSource: string,
  endpoint: string,
  path: readonly string[],
  value: unknown,
): void {
  const allowUrl = isRecord(value) ? value.allowUrl : undefined;
  if (allowUrl === false || (allowUrl !== true && endpoint !== "responses")) {
    return;
  }
  const allowlist = isRecord(value) ? value.urlAllowlist : undefined;
  const hasEffectiveAllowlist =
    Array.isArray(allowlist) &&
    allowlist.some((entry) => isEffectiveGatewayUrlAllowlistEntry(entry));
  entries.push({
    id: `gateway-http-${endpoint}-${path.join("-")}-url-fetch`,
    kind: "httpUrlFetch",
    source: `${endpointSource}/${path.map(ocPathSegment).join("/")}/allowUrl`,
    value: true,
    endpoint,
    explicit: allowUrl === true,
    hasAllowlist: hasEffectiveAllowlist,
  });
}

function isEffectiveGatewayUrlAllowlistEntry(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "*" && normalized !== "*.";
}

function isGatewayNonLoopbackBind(value: string): boolean {
  return value === "auto" || value === "lan" || value === "custom" || value === "tailnet";
}

function isRuntimeNonLoopbackCustomBindHost(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return isCanonicalDottedDecimalIPv4(normalized) && !normalized.startsWith("127.");
}

function isCanonicalDottedDecimalIPv4(value: string): boolean {
  return /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(
    value,
  );
}

function readBooleanPath(value: unknown, path: readonly string[]): boolean | undefined {
  let current = value;
  for (const part of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  return typeof current === "boolean" ? current : undefined;
}

function collectModelRefsFromValue(
  refs: PolicyModelRefEvidence[],
  value: unknown,
  source: string,
): void {
  if (typeof value === "string") {
    pushModelRef(refs, value, source);
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (typeof value.primary === "string") {
    pushModelRef(refs, value.primary, `${source}/primary`);
  }
  if (Array.isArray(value.fallbacks)) {
    for (const [index, fallback] of value.fallbacks.entries()) {
      if (typeof fallback === "string") {
        pushModelRef(refs, fallback, `${source}/fallbacks/#${index}`);
      }
    }
  }
}

function collectModelRefsFromRecord(
  refs: PolicyModelRefEvidence[],
  value: Record<string, unknown>,
  source: string,
): void {
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${source}/${key}`;
    if (isModelSettingKey(key)) {
      collectModelRefsFromValue(refs, child, childPath);
      continue;
    }
    if (Array.isArray(child)) {
      for (const [index, item] of child.entries()) {
        if (isRecord(item)) {
          collectModelRefsFromRecord(refs, item, `${childPath}/#${index}`);
        }
      }
      continue;
    }
    if (isRecord(child)) {
      collectModelRefsFromRecord(refs, child, childPath);
    }
  }
}

function collectModelRefsFromAgentAllowlist(
  refs: PolicyModelRefEvidence[],
  agents: Record<string, unknown>,
): void {
  const defaults = agents.defaults;
  if (isRecord(defaults) && isRecord(defaults.models)) {
    collectModelRefsFromModelMap(
      refs,
      defaults.models,
      "oc://openclaw.config/agents/defaults/models",
    );
  }

  const list = agents.list;
  if (!Array.isArray(list)) {
    return;
  }
  for (const [index, agent] of list.entries()) {
    if (!isRecord(agent) || !isRecord(agent.models)) {
      continue;
    }
    collectModelRefsFromModelMap(
      refs,
      agent.models,
      `oc://openclaw.config/agents/list/#${index}/models`,
    );
  }
}

function collectModelRefsFromModelMap(
  refs: PolicyModelRefEvidence[],
  models: Record<string, unknown>,
  source: string,
): void {
  for (const ref of Object.keys(models)) {
    pushModelRef(refs, ref, `${source}/${ocPathSegment(ref)}`);
  }
}

function isModelSettingKey(key: string): boolean {
  return key === "model" || key.endsWith("Model");
}

function ocPathSegment(value: string): string {
  if (/^(?:[A-Za-z0-9_-]+|#\d+)$/.test(value)) {
    return value;
  }
  if (value.includes('"') || value.includes("\\")) {
    return value;
  }
  return `"${value}"`;
}

function pushModelRef(refs: PolicyModelRefEvidence[], ref: string, source: string): void {
  const parsed = parseModelRef(ref);
  if (parsed === undefined) {
    return;
  }
  refs.push({ ref, provider: parsed.provider, model: parsed.model, source });
}

function parseModelRef(
  ref: string,
): { readonly provider: string; readonly model: string } | undefined {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return undefined;
  }
  return {
    provider: normalizeProviderId(trimmed.slice(0, slash)),
    model: trimmed.slice(slash + 1),
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
