import { resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  listProfilesForProvider,
  loadAuthProfileStoreForRuntime,
} from "../../agents/auth-profiles.js";
import {
  getRuntimeConfig,
  getRuntimeConfigSourceSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  parseStrictFiniteNumber,
  parseStrictPositiveInteger,
} from "../../infra/parse-finite-number.js";
import { writeRuntimeJson, defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { resolveCommandConfigWithSecrets } from "../command-config-resolution.js";
import { parseTimeoutMsWithFallback } from "../parse-timeout.js";
import type { CapabilityEnvelope, CapabilityTransport } from "./metadata.js";

export function resolveTransport(opts: {
  local?: boolean;
  gateway?: boolean;
  supported: Array<CapabilityTransport>;
  defaultTransport: CapabilityTransport;
}): CapabilityTransport {
  if (opts.local && opts.gateway) {
    throw new Error("Pass only one of --local or --gateway.");
  }
  if (opts.local) {
    if (!opts.supported.includes("local")) {
      throw new Error("This command does not support --local.");
    }
    return "local";
  }
  if (opts.gateway) {
    if (!opts.supported.includes("gateway")) {
      throw new Error("This command does not support --gateway.");
    }
    return "gateway";
  }
  return opts.defaultTransport;
}

export function emitJsonOrText(
  runtime: RuntimeEnv,
  json: boolean | undefined,
  value: unknown,
  textFormatter: (value: unknown) => string,
) {
  if (json) {
    writeRuntimeJson(runtime, value);
    return;
  }
  runtime.log(textFormatter(value));
}

export function formatEnvelopeForText(value: unknown): string {
  const envelope = value as CapabilityEnvelope;
  if (!envelope.ok) {
    return `${envelope.capability} failed: ${envelope.error ?? "unknown error"}`;
  }
  const lines = [
    `${envelope.capability} via ${envelope.transport}`,
    ...(envelope.provider ? [`provider: ${envelope.provider}`] : []),
    ...(envelope.model ? [`model: ${envelope.model}`] : []),
    ...(envelope.ignoredOverrides && envelope.ignoredOverrides.length > 0
      ? [`ignoredOverrides: ${JSON.stringify(envelope.ignoredOverrides)}`]
      : []),
    `outputs: ${String(envelope.outputs.length)}`,
  ];
  for (const output of envelope.outputs) {
    const pathValue = typeof output.path === "string" ? output.path : undefined;
    const textValue = typeof output.text === "string" ? output.text : undefined;
    if (pathValue) {
      lines.push(pathValue);
    } else if (textValue) {
      lines.push(textValue);
    } else {
      lines.push(JSON.stringify(output));
    }
  }
  return lines.join("\n");
}

export function providerSummaryText(value: unknown): string {
  const providers = value as Array<Record<string, unknown>>;
  return providers.map((entry) => JSON.stringify(entry)).join("\n");
}

function hasOwnKeys(value: unknown): boolean {
  return Boolean(
    value && typeof value === "object" && Object.keys(value as Record<string, unknown>).length > 0,
  );
}

export function resolveSelectedProviderFromModelRef(
  modelRef: string | undefined,
): string | undefined {
  return resolveModelRefOverride(modelRef).provider;
}

function getAuthProfileIdsForProvider(cfg: OpenClawConfig, providerId: string): string[] {
  const agentDir = resolveAgentDir(cfg, resolveDefaultAgentId(cfg));
  const store = loadAuthProfileStoreForRuntime(agentDir);
  return listProfilesForProvider(store, providerId);
}

export function providerHasGenericConfig(params: {
  cfg: OpenClawConfig;
  providerId: string;
  envVars?: string[];
}): boolean {
  const modelsProviders = (params.cfg.models?.providers ?? {}) as Record<string, unknown>;
  const pluginEntries = (params.cfg.plugins?.entries ?? {}) as Record<string, { config?: unknown }>;
  const ttsProviders = (params.cfg.messages?.tts?.providers ?? {}) as Record<string, unknown>;
  const envConfigured = (params.envVars ?? []).some((envVar) =>
    Boolean(process.env[envVar]?.trim()),
  );
  return (
    getAuthProfileIdsForProvider(params.cfg, params.providerId).length > 0 ||
    hasOwnKeys(modelsProviders[params.providerId]) ||
    hasOwnKeys(pluginEntries[params.providerId]?.config) ||
    hasOwnKeys(ttsProviders[params.providerId]) ||
    envConfigured
  );
}

export function resolveModelRefOverride(raw: string | undefined): {
  provider?: string;
  model?: string;
} {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return {};
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return { model: trimmed };
  }
  return {
    provider: trimmed.slice(0, slash),
    model: trimmed.slice(slash + 1),
  };
}

export function requireProviderModelOverride(
  raw: string | undefined,
): { provider: string; model: string } | undefined {
  const resolved = resolveModelRefOverride(raw);
  if (!raw?.trim()) {
    return undefined;
  }
  if (!resolved.provider || !resolved.model) {
    throw new Error("Model overrides must use the form <provider/model>.");
  }
  return {
    provider: resolved.provider,
    model: resolved.model,
  };
}

export function parseOptionalFiniteNumber(
  raw: string | number | undefined,
  label: string,
): number | undefined {
  if (raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    return undefined;
  }
  const value = parseStrictFiniteNumber(raw);
  if (value === undefined) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

export function parseOptionalPositiveInteger(raw: unknown, label: string): number | undefined {
  if (raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    return undefined;
  }
  const value = parseStrictPositiveInteger(raw);
  if (value === undefined) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

export function parseOptionalTimeoutMs(raw: string | number | undefined): number | undefined {
  if (raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    return undefined;
  }
  return parseTimeoutMsWithFallback(raw, 0, { invalidType: "error" });
}

export async function resolveLocalCapabilityRuntimeConfig(params: {
  commandName: string;
  targetIds: Set<string>;
  allowedPaths?: Set<string>;
  forcedActivePaths?: Set<string>;
  optionalActivePaths?: Set<string>;
  config?: OpenClawConfig;
}): Promise<OpenClawConfig> {
  const cfg = params.config ?? getRuntimeConfig();
  const { effectiveConfig } = await resolveCommandConfigWithSecrets({
    config: cfg,
    commandName: params.commandName,
    targetIds: params.targetIds,
    ...(params.allowedPaths ? { allowedPaths: params.allowedPaths } : {}),
    ...(params.forcedActivePaths ? { forcedActivePaths: params.forcedActivePaths } : {}),
    ...(params.optionalActivePaths ? { optionalActivePaths: params.optionalActivePaths } : {}),
    runtime: defaultRuntime,
    autoEnable: true,
  });
  pinRuntimeConfigSnapshot(effectiveConfig);
  return effectiveConfig;
}

export function pinRuntimeConfigSnapshot(config: OpenClawConfig): void {
  const sourceConfig = getRuntimeConfigSourceSnapshot();
  if (sourceConfig) {
    setRuntimeConfigSnapshot(config, sourceConfig);
  } else {
    setRuntimeConfigSnapshot(config);
  }
}
