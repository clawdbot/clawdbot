import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
// Signal compatibility migration moves shipped flat transport config into account ownership.
import type { ChannelDoctorConfigMutation } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { SignalTransportConfig } from "./account-types.js";
import {
  allocateSignalManagedNativePort,
  assignSignalManagedNativePort,
  DEFAULT_SIGNAL_MANAGED_NATIVE_PORT,
  isSignalManagedNativeConnectionUrlForBind,
  isValidSignalManagedNativePort,
  resolveLocalSignalTransportPort,
} from "./transport-policy.js";
import { buildSignalTransportHttpUrl, normalizeSignalTransportUrl } from "./transport-url.js";

const LEGACY_TRANSPORT_FIELDS = [
  "configPath",
  "httpUrl",
  "httpHost",
  "httpPort",
  "cliPath",
  "autoStart",
  "startupTimeoutMs",
  "receiveMode",
  "ignoreStories",
] as const;

const PENDING_LEGACY_TRANSPORT_WARNING =
  "- channels.signal: legacy auto transport is ambiguous while its endpoint is unavailable; bring the endpoint online and rerun openclaw doctor --fix, or replace the retired fields with an explicit account-owned transport in openclaw.json.";
const PENDING_LEGACY_INVALID_URL_WARNING =
  "- channels.signal: legacy httpUrl is invalid; keep the current config, correct httpUrl, then run openclaw doctor --fix.";
const PENDING_LEGACY_INVALID_HOST_WARNING =
  "- channels.signal: legacy httpHost is invalid; keep the current config, correct httpHost, then run openclaw doctor --fix.";
const PENDING_LEGACY_INVALID_PORT_WARNING =
  "- channels.signal: legacy httpPort must be an integer between 1 and 65535; correct httpPort, then run openclaw doctor --fix.";
const PENDING_LEGACY_CONTAINER_ACCOUNT_WARNING =
  "- channels.signal: legacy container transport requires an account number; add channels.signal.account (or the relevant channels.signal.accounts.*.account) and rerun openclaw doctor --fix.";

type DetectTransport = (params: {
  url: string;
  account?: string;
}) => Promise<SignalTransportConfig>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSignalTransportConfig(value: unknown): value is SignalTransportConfig {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === "managed-native") {
    if (value.httpPort !== undefined && !isValidSignalManagedNativePort(value.httpPort)) {
      return false;
    }
    if (value.url === undefined) {
      return true;
    }
    if (typeof value.url !== "string") {
      return false;
    }
    try {
      normalizeSignalTransportUrl(value.url);
      return true;
    } catch {
      return false;
    }
  }
  if (
    (value.kind !== "external-native" && value.kind !== "container") ||
    typeof value.url !== "string"
  ) {
    return false;
  }
  try {
    normalizeSignalTransportUrl(value.url);
    return true;
  } catch {
    return false;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function inherited(entry: Record<string, unknown>, parent: Record<string, unknown>, key: string) {
  return Object.hasOwn(entry, key) ? entry[key] : parent[key];
}

function legacyBaseUrl(entry: Record<string, unknown>, parent: Record<string, unknown>): string {
  const url = optionalString(inherited(entry, parent, "httpUrl"));
  if (url) {
    return normalizeSignalTransportUrl(url);
  }
  const host = optionalString(inherited(entry, parent, "httpHost")) ?? "127.0.0.1";
  const rawPort = inherited(entry, parent, "httpPort");
  const port = typeof rawPort === "number" ? rawPort : 8080;
  return buildSignalTransportHttpUrl(host, port);
}

function hasLegacyFields(entry: Record<string, unknown>): boolean {
  return LEGACY_TRANSPORT_FIELDS.some((field) => Object.hasOwn(entry, field));
}

function wasLegacySignalAccountConfigured(
  entry: Record<string, unknown>,
  parent: Record<string, unknown>,
): boolean {
  return Boolean(
    optionalString(inherited(entry, parent, "account")) ||
    optionalString(inherited(entry, parent, "configPath")) ||
    optionalString(inherited(entry, parent, "httpUrl")) ||
    optionalString(inherited(entry, parent, "httpHost")) ||
    optionalString(inherited(entry, parent, "cliPath")) ||
    typeof inherited(entry, parent, "httpPort") === "number" ||
    typeof inherited(entry, parent, "autoStart") === "boolean",
  );
}

function hasInvalidLegacyHttpUrl(
  entries: Record<string, unknown>[],
  parent: Record<string, unknown>,
): boolean {
  return entries.some((entry) => {
    const httpUrl = optionalString(inherited(entry, parent, "httpUrl"));
    if (!httpUrl) {
      return false;
    }
    try {
      normalizeSignalTransportUrl(httpUrl);
      return false;
    } catch {
      return true;
    }
  });
}

function findInvalidLegacyDerivedEndpoint(
  entries: Record<string, unknown>[],
  parent: Record<string, unknown>,
): "host" | "port" | undefined {
  for (const entry of entries) {
    if (optionalString(inherited(entry, parent, "httpUrl"))) {
      continue;
    }
    const rawPort = inherited(entry, parent, "httpPort");
    if (rawPort !== undefined && !isValidSignalManagedNativePort(rawPort)) {
      return "port";
    }
    const host = optionalString(inherited(entry, parent, "httpHost")) ?? "127.0.0.1";
    try {
      buildSignalTransportHttpUrl(host, typeof rawPort === "number" ? rawPort : 8080);
    } catch {
      return "host";
    }
  }
  return undefined;
}

function hasInvalidManagedTransportPort(
  transports: Array<SignalTransportConfig | undefined>,
): boolean {
  return transports.some(
    (transport) =>
      transport?.kind === "managed-native" &&
      transport.httpPort !== undefined &&
      !isValidSignalManagedNativePort(transport.httpPort),
  );
}

function requiresDetection(
  entry: Record<string, unknown>,
  parent: Record<string, unknown>,
  apiMode: unknown,
): boolean {
  if (apiMode !== undefined && apiMode !== "auto") {
    return false;
  }
  return (
    Boolean(optionalString(inherited(entry, parent, "httpUrl"))) ||
    !resolveLegacyAutoStart(entry, parent)
  );
}

function resolveLegacyAutoStart(
  entry: Record<string, unknown>,
  parent: Record<string, unknown>,
): boolean {
  const autoStart = inherited(entry, parent, "autoStart");
  if (typeof autoStart === "boolean") {
    return autoStart;
  }
  return !optionalString(inherited(entry, parent, "httpUrl"));
}

function resolveManagedConnectionUrl(
  entry: Record<string, unknown>,
  parent: Record<string, unknown>,
): string | undefined {
  const httpUrl = optionalString(inherited(entry, parent, "httpUrl"));
  if (!httpUrl) {
    return undefined;
  }
  const normalizedUrl = normalizeSignalTransportUrl(httpUrl);
  const endpoint = new URL(normalizedUrl);
  const bindHost = (optionalString(inherited(entry, parent, "httpHost")) ?? "127.0.0.1")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  const rawBindPort = inherited(entry, parent, "httpPort");
  const bindPort = typeof rawBindPort === "number" ? rawBindPort : 8080;
  const endpointHost = endpoint.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const endpointPort = endpoint.port
    ? Number.parseInt(endpoint.port, 10)
    : endpoint.protocol === "https:"
      ? 443
      : 80;
  const matchesBindEndpoint =
    endpoint.protocol === "http:" && endpointHost === bindHost && endpointPort === bindPort;
  return matchesBindEndpoint ? undefined : normalizedUrl;
}

function buildManagedNativeTransport(
  entry: Record<string, unknown>,
  parent: Record<string, unknown>,
): SignalTransportConfig {
  const value = (key: string) => inherited(entry, parent, key);
  const configPath = optionalString(value("configPath"));
  const cliPath = optionalString(value("cliPath"));
  const url = resolveManagedConnectionUrl(entry, parent);
  const httpHost = optionalString(value("httpHost"));
  const httpPort = value("httpPort");
  const startupTimeoutMs = value("startupTimeoutMs");
  const receiveMode = value("receiveMode");
  const ignoreStories = value("ignoreStories");
  return {
    kind: "managed-native",
    ...(configPath ? { configPath } : {}),
    ...(cliPath ? { cliPath } : {}),
    ...(url ? { url } : {}),
    ...(httpHost ? { httpHost } : {}),
    ...(typeof httpPort === "number" ? { httpPort } : {}),
    ...(typeof startupTimeoutMs === "number" ? { startupTimeoutMs } : {}),
    ...(receiveMode === "on-start" || receiveMode === "manual" ? { receiveMode } : {}),
    ...(typeof ignoreStories === "boolean" ? { ignoreStories } : {}),
  };
}

function resolveLegacyTransportWithoutDetection(params: {
  entry: Record<string, unknown>;
  parent: Record<string, unknown>;
  apiMode: unknown;
}): SignalTransportConfig | undefined {
  if (isSignalTransportConfig(params.entry.transport)) {
    return params.entry.transport;
  }
  const baseUrl = legacyBaseUrl(params.entry, params.parent);
  const autoStart = inherited(params.entry, params.parent, "autoStart");
  if (params.apiMode === "container") {
    return { kind: "container", url: baseUrl };
  }
  if (params.apiMode === "native") {
    return resolveLegacyAutoStart(params.entry, params.parent)
      ? buildManagedNativeTransport(params.entry, params.parent)
      : { kind: "external-native", url: baseUrl };
  }
  if (requiresDetection(params.entry, params.parent, params.apiMode)) {
    return undefined;
  }
  if (autoStart === false) {
    return { kind: "external-native", url: baseUrl };
  }
  return buildManagedNativeTransport(params.entry, params.parent);
}

async function resolveLegacyTransport(params: {
  entry: Record<string, unknown>;
  parent: Record<string, unknown>;
  apiMode: unknown;
  detect?: DetectTransport;
}): Promise<SignalTransportConfig | undefined> {
  const resolved = resolveLegacyTransportWithoutDetection(params);
  if (resolved) {
    return resolved;
  }
  const account = optionalString(inherited(params.entry, params.parent, "account"));
  try {
    const detected = await params.detect?.({
      url: legacyBaseUrl(params.entry, params.parent),
      ...(account ? { account } : {}),
    });
    if (
      detected?.kind === "external-native" &&
      resolveLegacyAutoStart(params.entry, params.parent)
    ) {
      return buildManagedNativeTransport(params.entry, params.parent);
    }
    return detected;
  } catch {
    if (resolveLegacyAutoStart(params.entry, params.parent)) {
      // A gateway-owned daemon is normally offline while update has the service stopped.
      // Preserve that explicit ownership instead of blocking migration on a live probe.
      return buildManagedNativeTransport(params.entry, params.parent);
    }
    // Shipped auto mode could select either protocol at the same URL. Do not guess while the
    // endpoint is down; the warning points to an explicit account-owned config replacement.
    return undefined;
  }
}

function clearLegacyTransportFields(entry: Record<string, unknown>): void {
  for (const field of LEGACY_TRANSPORT_FIELDS) {
    delete entry[field];
  }
}

function hasRootSignalAccount(entries: Record<string, unknown>[]): boolean {
  const root = entries[0];
  return (
    entries.length === 1 ||
    Boolean(optionalString(root?.account)) ||
    isSignalTransportConfig(root?.transport)
  );
}

function signalAccountIds(entries: Record<string, unknown>[]): string[] {
  const accounts = isRecord(entries[0]?.accounts) ? entries[0].accounts : {};
  return Object.entries(accounts)
    .filter(([, entry]) => isRecord(entry))
    .map(([accountId]) => accountId);
}

function isDefaultSignalAccountId(accountId: string | undefined): boolean {
  return Boolean(accountId?.trim()) && normalizeAccountId(accountId) === DEFAULT_ACCOUNT_ID;
}

function resolveSignalAccountKey(
  accounts: Record<string, unknown>,
  accountId: string,
): string | undefined {
  const normalizedAccountId = normalizeAccountId(accountId);
  return Object.keys(accounts).find(
    (key) => Boolean(key.trim()) && normalizeAccountId(key) === normalizedAccountId,
  );
}

function nestedDefaultOwnsEffectiveTransport(entries: Record<string, unknown>[]): boolean {
  const accounts = isRecord(entries[0]?.accounts) ? entries[0].accounts : {};
  const nestedDefaultKey = resolveSignalAccountKey(accounts, DEFAULT_ACCOUNT_ID);
  const nestedDefault = nestedDefaultKey ? accounts[nestedDefaultKey] : undefined;
  return (
    isRecord(nestedDefault) &&
    (isSignalTransportConfig(nestedDefault.transport) || hasLegacyFields(nestedDefault))
  );
}

function isDiscardedTransportEntry(entries: Record<string, unknown>[], index: number): boolean {
  if (index === 0) {
    // Shipped account merging let accounts.default override root transport fields. Materialize
    // that effective merged entry once; probing the shadowed root can block an otherwise valid
    // migration when its retired endpoint is offline.
    return !hasRootSignalAccount(entries) || nestedDefaultOwnsEffectiveTransport(entries);
  }
  // A canonical root transport owns the default account; a nested default's
  // retired endpoint fields are cleanup-only and must not block migration.
  return (
    isDefaultSignalAccountId(signalAccountIds(entries)[index - 1]) &&
    isSignalTransportConfig(entries[0]?.transport)
  );
}

function shouldMaterializeTransport(entries: Record<string, unknown>[], index: number): boolean {
  if (isDiscardedTransportEntry(entries, index)) {
    return false;
  }
  const entry = entries[index];
  const parent = entries[0];
  return Boolean(
    entry &&
    parent &&
    (isSignalTransportConfig(entry.transport) || wasLegacySignalAccountConfigured(entry, parent)),
  );
}

export function clearLegacySignalTransportFieldsForAccount(params: {
  cfg: OpenClawConfig;
  accountId: string;
}): OpenClawConfig {
  const next = structuredClone(params.cfg);
  const signal = next.channels?.signal as unknown;
  if (!isRecord(signal)) {
    return next;
  }
  if (isDefaultSignalAccountId(params.accountId)) {
    clearLegacyTransportFields(signal);
    delete signal.apiMode;
    const accounts = isRecord(signal.accounts) ? signal.accounts : undefined;
    const nestedDefaultKey = accounts
      ? resolveSignalAccountKey(accounts, DEFAULT_ACCOUNT_ID)
      : undefined;
    const nestedDefault = nestedDefaultKey ? accounts?.[nestedDefaultKey] : undefined;
    if (isRecord(nestedDefault)) {
      // Setup writes the implicit default transport at the channel root.
      // Remove a nested copy so it cannot shadow the canonical write.
      clearLegacyTransportFields(nestedDefault);
      delete nestedDefault.transport;
    }
    return next;
  }
  const accounts = isRecord(signal.accounts) ? signal.accounts : undefined;
  const accountKey = accounts ? resolveSignalAccountKey(accounts, params.accountId) : undefined;
  const account = accountKey ? accounts?.[accountKey] : undefined;
  if (isRecord(account)) {
    clearLegacyTransportFields(account);
  }
  return next;
}

function allocateMigratedManagedPorts(params: {
  entries: Record<string, unknown>[];
  transports: Array<SignalTransportConfig | undefined>;
}): Array<SignalTransportConfig | undefined> {
  const reservedPorts = new Set<number>();
  const rootIsAccount = hasRootSignalAccount(params.entries);
  const accountIds = signalAccountIds(params.entries);
  const nestedDefaultOffset = accountIds.findIndex((accountId) =>
    isDefaultSignalAccountId(accountId),
  );
  const canonicalDefaultIndex = isSignalTransportConfig(params.entries[0]?.transport)
    ? 0
    : nestedDefaultOffset >= 0
      ? nestedDefaultOffset + 1
      : rootIsAccount
        ? 0
        : undefined;
  for (const [index, transport] of params.transports.entries()) {
    if (!transport || (index === 0 && canonicalDefaultIndex !== 0)) {
      continue;
    }
    if (transport.kind !== "managed-native") {
      const localPort = resolveLocalSignalTransportPort(transport.url);
      if (localPort !== undefined) {
        reservedPorts.add(localPort);
      }
      continue;
    }
    if (transport.url && !isSignalManagedNativeConnectionUrlForBind(transport)) {
      const localConnectionPort = resolveLocalSignalTransportPort(transport.url);
      if (localConnectionPort !== undefined) {
        reservedPorts.add(localConnectionPort);
      }
    }
    if (index === canonicalDefaultIndex || isRecord(params.entries[index]?.transport)) {
      reservedPorts.add(transport.httpPort ?? DEFAULT_SIGNAL_MANAGED_NATIVE_PORT);
    }
  }
  return params.transports.map((transport, index) => {
    if (!transport || (index === 0 && canonicalDefaultIndex !== 0)) {
      return transport;
    }
    if (transport.kind !== "managed-native") {
      return transport;
    }
    const existingCanonical = isRecord(params.entries[index]?.transport);
    if (existingCanonical || index === canonicalDefaultIndex) {
      return transport;
    }
    const rawPreferredPort = params.entries[index]?.httpPort;
    const preferredPort =
      typeof rawPreferredPort === "number" ? rawPreferredPort : transport.httpPort;
    const httpPort = allocateSignalManagedNativePort({
      reservedPorts,
      ...(typeof preferredPort === "number" ? { preferredPort } : {}),
    });
    reservedPorts.add(httpPort);
    return assignSignalManagedNativePort(transport, httpPort);
  });
}

function applyMigratedSignalTransports(params: {
  cfg: OpenClawConfig;
  entries: Record<string, unknown>[];
  transports: Array<SignalTransportConfig | undefined>;
}): OpenClawConfig | undefined {
  const next = structuredClone(params.cfg);
  const nextSignal = next.channels?.signal as unknown;
  if (!isRecord(nextSignal)) {
    return undefined;
  }
  const accountIds = signalAccountIds(params.entries);
  const nextAccounts = isRecord(nextSignal.accounts) ? nextSignal.accounts : {};
  const nextEntries = [nextSignal, ...Object.values(nextAccounts).filter(isRecord)];
  const rootIsAccount = hasRootSignalAccount(params.entries);
  const canonicalRootTransport = isSignalTransportConfig(params.entries[0]?.transport)
    ? params.entries[0].transport
    : undefined;
  for (const [index, entry] of nextEntries.entries()) {
    const accountId = index === 0 ? undefined : accountIds[index - 1];
    if (isDefaultSignalAccountId(accountId)) {
      const defaultTransport = canonicalRootTransport ?? params.transports[index];
      if (defaultTransport) {
        nextSignal.transport = defaultTransport;
      } else {
        delete nextSignal.transport;
      }
      delete entry.transport;
    } else if (index === 0 && !rootIsAccount) {
      delete entry.transport;
    } else if (params.transports[index]) {
      entry.transport = params.transports[index];
    } else {
      delete entry.transport;
    }
    clearLegacyTransportFields(entry);
  }
  delete nextSignal.apiMode;
  return next;
}

function hasContainerTransportWithoutEffectiveAccount(cfg: OpenClawConfig): boolean {
  const signal = cfg.channels?.signal as unknown;
  if (!isRecord(signal)) {
    return false;
  }
  const accounts = isRecord(signal.accounts) ? signal.accounts : {};
  const rootTransport = isSignalTransportConfig(signal.transport) ? signal.transport : undefined;
  const defaultKey = resolveSignalAccountKey(accounts, DEFAULT_ACCOUNT_ID);
  const defaultEntry = defaultKey ? accounts[defaultKey] : undefined;
  const defaultAccount =
    isRecord(defaultEntry) && defaultEntry.account !== undefined
      ? optionalString(defaultEntry.account)
      : optionalString(signal.account);
  const channelEnabled = signal.enabled !== false;
  const defaultEnabled = !isRecord(defaultEntry) || defaultEntry.enabled !== false;
  if (rootTransport?.kind === "container" && channelEnabled && defaultEnabled && !defaultAccount) {
    return true;
  }
  for (const [accountId, entry] of Object.entries(accounts)) {
    if (!isRecord(entry)) {
      continue;
    }
    if (!channelEnabled || entry.enabled === false) {
      continue;
    }
    const isDefaultAccount = isDefaultSignalAccountId(accountId);
    const transport =
      isDefaultAccount && rootTransport
        ? rootTransport
        : isSignalTransportConfig(entry.transport)
          ? entry.transport
          : undefined;
    if (transport?.kind !== "container" || (isDefaultAccount && rootTransport)) {
      continue;
    }
    const account =
      entry.account === undefined ? optionalString(signal.account) : optionalString(entry.account);
    if (!account) {
      return true;
    }
  }
  return false;
}

export async function migrateLegacySignalTransportConfig(params: {
  cfg: OpenClawConfig;
  detect?: DetectTransport;
}): Promise<ChannelDoctorConfigMutation> {
  const signal = params.cfg.channels?.signal as unknown;
  if (!isRecord(signal)) {
    return { config: params.cfg, changes: [] };
  }
  const accounts = isRecord(signal.accounts) ? signal.accounts : {};
  const hasLegacy =
    Object.hasOwn(signal, "apiMode") ||
    hasLegacyFields(signal) ||
    Object.values(accounts).some((entry) => isRecord(entry) && hasLegacyFields(entry));
  if (!hasLegacy) {
    return { config: params.cfg, changes: [] };
  }
  const apiMode = signal.apiMode;
  const entries = [signal, ...Object.values(accounts).filter(isRecord)];
  const migrationEntries = entries.filter((_, index) => shouldMaterializeTransport(entries, index));
  const legacyResolutionEntries = migrationEntries.filter(
    (entry) => !isSignalTransportConfig(entry.transport),
  );
  const invalidDerivedEndpoint = findInvalidLegacyDerivedEndpoint(legacyResolutionEntries, signal);
  if (invalidDerivedEndpoint) {
    return {
      config: params.cfg,
      changes: [],
      warnings: [
        invalidDerivedEndpoint === "port"
          ? PENDING_LEGACY_INVALID_PORT_WARNING
          : PENDING_LEGACY_INVALID_HOST_WARNING,
      ],
    };
  }
  if (hasInvalidLegacyHttpUrl(legacyResolutionEntries, signal)) {
    return {
      config: params.cfg,
      changes: [],
      warnings: [PENDING_LEGACY_INVALID_URL_WARNING],
    };
  }
  if (
    !params.detect &&
    legacyResolutionEntries.some((entry) => requiresDetection(entry, signal, apiMode))
  ) {
    return {
      config: params.cfg,
      changes: [],
      warnings: [PENDING_LEGACY_TRANSPORT_WARNING],
    };
  }
  const resolvedTransports = await Promise.all(
    entries.map(async (entry, index) =>
      !shouldMaterializeTransport(entries, index)
        ? undefined
        : await resolveLegacyTransport({ entry, parent: signal, apiMode, detect: params.detect }),
    ),
  );
  if (hasInvalidManagedTransportPort(resolvedTransports)) {
    return {
      config: params.cfg,
      changes: [],
      warnings: [PENDING_LEGACY_INVALID_PORT_WARNING],
    };
  }
  const transports = allocateMigratedManagedPorts({
    entries,
    transports: resolvedTransports,
  });
  if (
    transports.some((transport, index) => shouldMaterializeTransport(entries, index) && !transport)
  ) {
    return {
      config: params.cfg,
      changes: [],
      warnings: [PENDING_LEGACY_TRANSPORT_WARNING],
    };
  }
  const next = applyMigratedSignalTransports({ cfg: params.cfg, entries, transports });
  if (!next) {
    return { config: params.cfg, changes: [] };
  }
  if (hasContainerTransportWithoutEffectiveAccount(next)) {
    return {
      config: params.cfg,
      changes: [],
      warnings: [PENDING_LEGACY_CONTAINER_ACCOUNT_WARNING],
    };
  }
  return {
    config: next,
    changes: [
      "Migrated channels.signal transport settings to concrete account-owned transport objects.",
    ],
  };
}

export function migrateLegacySignalTransportConfigSync(
  cfg: OpenClawConfig,
): ChannelDoctorConfigMutation {
  const signal = cfg.channels?.signal as unknown;
  if (!isRecord(signal)) {
    return { config: cfg, changes: [] };
  }
  const accounts = isRecord(signal.accounts) ? signal.accounts : {};
  const hasLegacy =
    Object.hasOwn(signal, "apiMode") ||
    hasLegacyFields(signal) ||
    Object.values(accounts).some((entry) => isRecord(entry) && hasLegacyFields(entry));
  if (!hasLegacy) {
    return { config: cfg, changes: [] };
  }
  const entries = [signal, ...Object.values(accounts).filter(isRecord)];
  const migrationEntries = entries.filter((_, index) => shouldMaterializeTransport(entries, index));
  const legacyResolutionEntries = migrationEntries.filter(
    (entry) => !isSignalTransportConfig(entry.transport),
  );
  const invalidDerivedEndpoint = findInvalidLegacyDerivedEndpoint(legacyResolutionEntries, signal);
  if (invalidDerivedEndpoint) {
    return {
      config: cfg,
      changes: [],
      warnings: [
        invalidDerivedEndpoint === "port"
          ? PENDING_LEGACY_INVALID_PORT_WARNING
          : PENDING_LEGACY_INVALID_HOST_WARNING,
      ],
    };
  }
  if (hasInvalidLegacyHttpUrl(legacyResolutionEntries, signal)) {
    return {
      config: cfg,
      changes: [],
      warnings: [PENDING_LEGACY_INVALID_URL_WARNING],
    };
  }
  const resolvedTransports = entries.map((entry, index) => {
    if (!shouldMaterializeTransport(entries, index)) {
      return undefined;
    }
    return resolveLegacyTransportWithoutDetection({
      entry,
      parent: signal,
      apiMode: signal.apiMode,
    });
  });
  if (hasInvalidManagedTransportPort(resolvedTransports)) {
    return {
      config: cfg,
      changes: [],
      warnings: [PENDING_LEGACY_INVALID_PORT_WARNING],
    };
  }
  const transports = allocateMigratedManagedPorts({
    entries,
    transports: resolvedTransports,
  });
  if (
    transports.some((transport, index) => shouldMaterializeTransport(entries, index) && !transport)
  ) {
    return { config: cfg, changes: [], warnings: [PENDING_LEGACY_TRANSPORT_WARNING] };
  }
  const next = applyMigratedSignalTransports({ cfg, entries, transports });
  if (!next) {
    return { config: cfg, changes: [] };
  }
  if (hasContainerTransportWithoutEffectiveAccount(next)) {
    return {
      config: cfg,
      changes: [],
      warnings: [PENDING_LEGACY_CONTAINER_ACCOUNT_WARNING],
    };
  }
  return {
    config: next,
    changes: [
      "Migrated channels.signal transport settings to concrete account-owned transport objects.",
    ],
  };
}
