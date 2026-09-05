/** Tracks managed service environment keys across reinstall and repair flows. */
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { normalizeEnvVarKey } from "../infra/host-env-security.js";
import { detectRespawnSupervisor } from "../infra/supervisor-markers.js";
import type { GatewayServiceEnvironmentValueSource } from "./service-types.js";

const MANAGED_SERVICE_ENV_KEYS_VAR = "OPENCLAW_SERVICE_MANAGED_ENV_KEYS";

// Tracks which service environment keys OpenClaw owns across reinstall/start flows.
type ServiceEnvCommand = {
  environment?: Record<string, string | undefined>;
  environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource | undefined>;
} | null;

export function normalizeServiceEnvKey(key: string): string | null {
  return normalizeEnvVarKey(key, { portable: true })?.toUpperCase() ?? null;
}

export function normalizeServiceEnvKeys(keys: Iterable<string>): Set<string> {
  return new Set(
    [...keys].flatMap((key) => {
      const normalized = normalizeServiceEnvKey(key);
      return normalized ? [normalized] : [];
    }),
  );
}

export function hasInlineEnvironmentSource(
  source: GatewayServiceEnvironmentValueSource | undefined,
): boolean {
  return source === undefined || source === "inline" || source === "inline-and-file";
}

export function isEnvironmentFileOnlySource(
  source: GatewayServiceEnvironmentValueSource | undefined,
): boolean {
  return source === "file";
}

export function hasEnvironmentFileSource(
  source: GatewayServiceEnvironmentValueSource | undefined,
): boolean {
  return source === "file" || source === "inline-and-file";
}

function parseManagedServiceEnvKeys(value: string | undefined): Set<string> {
  return normalizeServiceEnvKeys(value?.split(",") ?? []);
}

export function formatManagedServiceEnvKeys(
  managedEnvironment: Record<string, string | undefined>,
  options?: { omitKeys?: Iterable<string> },
): string | undefined {
  const omitKeys = normalizeServiceEnvKeys(options?.omitKeys ?? []);
  const keys = Object.keys(managedEnvironment)
    .map(normalizeServiceEnvKey)
    .filter((key): key is string => Boolean(key && !omitKeys.has(key)))
    .toSorted();
  return keys.length > 0 ? keys.join(",") : undefined;
}

export function readManagedServiceEnvKeysFromEnvironment(
  environment: Record<string, string | undefined> | undefined,
): Set<string> {
  if (!environment) {
    return new Set();
  }
  for (const [rawKey, rawValue] of Object.entries(environment)) {
    if (normalizeServiceEnvKey(rawKey) === MANAGED_SERVICE_ENV_KEYS_VAR) {
      return parseManagedServiceEnvKeys(rawValue);
    }
  }
  return new Set();
}

export function readManagedSystemdServiceEnvKeysFromEnvironment(
  environment: Record<string, string | undefined> | undefined,
  platform: NodeJS.Platform = process.platform,
): Set<string> {
  // Only systemd snapshots state dotenv values into its inherited service environment.
  // Other supervisors retain their existing reinstall-based precedence contract.
  return environment && detectRespawnSupervisor(environment, platform) === "systemd"
    ? readManagedServiceEnvKeysFromEnvironment(environment)
    : new Set();
}

export function clearMissingManagedServiceEnvKeys(params: {
  environment: Record<string, string | undefined>;
  managedKeys: Iterable<string>;
  presentKeys: Iterable<string>;
  preserveKeys?: Iterable<string>;
}): void {
  const presentKeys = new Set(
    [...params.presentKeys, ...(params.preserveKeys ?? [])].flatMap((key) => {
      const normalized = normalizeServiceEnvKey(key);
      return normalized ? [normalized] : [];
    }),
  );
  const missingKeys = [...params.managedKeys].filter((key) => {
    const normalized = normalizeServiceEnvKey(key);
    return normalized !== null && !presentKeys.has(normalized);
  });
  deleteManagedServiceEnvKeys(params.environment, missingKeys);
}

function deleteManagedServiceEnvKeys(
  environment: Record<string, string | undefined>,
  keys: Iterable<string>,
): void {
  const normalizedKeys = normalizeServiceEnvKeys(keys);
  if (normalizedKeys.size === 0) {
    return;
  }
  // Delete by normalized key so casing changes between installs do not leave
  // stale service-owned values behind.
  for (const rawKey of Object.keys(environment)) {
    const key = normalizeServiceEnvKey(rawKey);
    if (key && normalizedKeys.has(key)) {
      delete environment[rawKey];
    }
  }
}

export function writeManagedServiceEnvKeysToEnvironment(
  environment: Record<string, string | undefined>,
  value: string | undefined,
): void {
  if (!value) {
    return;
  }
  deleteManagedServiceEnvKeys(environment, parseManagedServiceEnvKeys(value));
  environment[MANAGED_SERVICE_ENV_KEYS_VAR] = value;
}

export function readEnvironmentValueSource(
  environmentValueSources:
    | Record<string, GatewayServiceEnvironmentValueSource | undefined>
    | undefined,
  key: string,
): GatewayServiceEnvironmentValueSource | undefined {
  const normalizedKey = normalizeServiceEnvKey(key);
  if (!normalizedKey) {
    return undefined;
  }
  for (const [rawKey, source] of Object.entries(environmentValueSources ?? {})) {
    if (normalizeServiceEnvKey(rawKey) === normalizedKey) {
      return source;
    }
  }
  return undefined;
}

export function collectInlineManagedServiceEnvKeys(
  command: ServiceEnvCommand,
  expectedManagedKeys?: Iterable<string>,
): string[] {
  if (!command?.environment) {
    return [];
  }
  const managedKeys = parseManagedServiceEnvKeys(command.environment[MANAGED_SERVICE_ENV_KEYS_VAR]);
  for (const key of normalizeServiceEnvKeys(expectedManagedKeys ?? [])) {
    managedKeys.add(key);
  }
  return collectInlineServiceEnvKeys(command, managedKeys);
}

export function collectInlineServiceEnvKeys(
  command: ServiceEnvCommand,
  expectedKeys: Iterable<string>,
): string[] {
  if (!command?.environment) {
    return [];
  }
  const normalizedKeys = normalizeServiceEnvKeys(expectedKeys);
  if (normalizedKeys.size === 0) {
    return [];
  }
  const inlineKeys: string[] = [];
  for (const [rawKey, value] of Object.entries(command.environment)) {
    if (typeof value !== "string" || !value.trim()) {
      continue;
    }
    const normalized = normalizeServiceEnvKey(rawKey);
    if (!normalized || !normalizedKeys.has(normalized)) {
      continue;
    }
    if (normalized === MANAGED_SERVICE_ENV_KEYS_VAR) {
      continue;
    }
    if (
      !hasInlineEnvironmentSource(
        readEnvironmentValueSource(command.environmentValueSources, normalized),
      )
    ) {
      continue;
    }
    // Only inline/file-overlap sources can be repaired from the service command
    // itself; file-only values must stay owned by the generated env file.
    inlineKeys.push(normalized);
  }
  return sortUniqueStrings(inlineKeys);
}
