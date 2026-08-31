// Signal setup owns transport discovery and canonical account writes.
import { normalizeAccountId, resolveAccountEntry } from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  DEFAULT_ACCOUNT_ID,
  patchChannelConfigForAccount,
} from "openclaw/plugin-sdk/setup-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SignalTransportConfig } from "./account-types.js";
import {
  listSignalAccountIds,
  resolveSignalAccount,
  resolveSignalAccountConfig,
  resolveSignalTransport,
} from "./accounts.js";
import { clearLegacySignalTransportFieldsForAccount } from "./config-compat.js";
import type {
  SignalContainerTransportProbe,
  SignalNativeTransportProbe,
  SignalTransportProbeResult,
} from "./transport-detection.js";
import {
  allocateSignalManagedNativePort,
  assignSignalManagedNativePort,
  DEFAULT_SIGNAL_MANAGED_NATIVE_HOST,
  isSignalManagedNativeConnectionUrlForBind,
  resolveLocalSignalTransportPort,
} from "./transport-policy.js";
import { normalizeSignalTransportHost, normalizeSignalTransportUrl } from "./transport-url.js";

export { detectSignalTransport, type SignalTransportProbeResult } from "./transport-detection.js";

export type SignalManagedNativeTransport = Extract<
  SignalTransportConfig,
  { kind: "managed-native" }
>;

function managedTransportOptions(
  transport: SignalManagedNativeTransport,
): Omit<SignalManagedNativeTransport, "kind"> {
  const { kind: _kind, ...options } = transport;
  return options;
}

function normalizeTransport(transport: SignalTransportConfig): SignalTransportConfig {
  if (transport.kind === "managed-native") {
    return {
      ...transport,
      ...(transport.url ? { url: normalizeSignalTransportUrl(transport.url) } : {}),
      ...(transport.httpHost ? { httpHost: normalizeSignalTransportHost(transport.httpHost) } : {}),
    };
  }
  return { ...transport, url: normalizeSignalTransportUrl(transport.url) };
}

function assertSignalContainerTransportHasAccount(params: {
  cfg: OpenClawConfig;
  accountId: string;
  transport: SignalTransportConfig;
}): void {
  if (params.transport.kind !== "container" || params.cfg.channels?.signal?.enabled === false) {
    return;
  }
  const account = resolveSignalAccountConfig(params.cfg, normalizeAccountId(params.accountId));
  if (account.enabled === false || normalizeOptionalString(account.account)) {
    return;
  }
  throw new Error("Signal container transport requires an account number for an enabled account.");
}

function assertSignalLocalEndpointDoesNotConflictWithManagedSibling(params: {
  cfg: OpenClawConfig;
  accountId: string;
  transport: SignalTransportConfig;
}): void {
  if (params.transport.kind === "managed-native") {
    return;
  }
  const localPort = resolveLocalSignalTransportPort(params.transport.url);
  if (localPort === undefined) {
    return;
  }
  const targetAccountId = normalizeAccountId(params.accountId);
  for (const accountId of listSignalAccountIds(params.cfg)) {
    if (normalizeAccountId(accountId) === targetAccountId) {
      continue;
    }
    const accountEntry = resolveAccountEntry(params.cfg.channels?.signal?.accounts, accountId);
    if (accountEntry?.enabled === false) {
      continue;
    }
    const siblingAccount = resolveSignalAccount({
      cfg: params.cfg,
      accountId,
    });
    // Empty configs expose an implicit default placeholder with managed defaults. Until that
    // account is configured, its synthetic endpoint does not reserve a port.
    if (!siblingAccount.configured) {
      continue;
    }
    const siblingTransport = siblingAccount.transport;
    if (siblingTransport?.kind !== "managed-native" || siblingTransport.httpPort !== localPort) {
      continue;
    }
    throw new Error(
      `Signal ${params.transport.kind} account "${targetAccountId}" uses local port ${localPort}, which conflicts with managed native account "${accountId}". Choose a distinct transport URL.`,
    );
  }
}

export function resolveConfiguredSignalTransport(
  cfg: OpenClawConfig,
  accountId: string,
): SignalTransportConfig | undefined {
  const signal = cfg.channels?.signal;
  const normalizedAccountId = normalizeAccountId(accountId);
  return normalizedAccountId === DEFAULT_ACCOUNT_ID
    ? (signal?.transport ?? resolveAccountEntry(signal?.accounts, normalizedAccountId)?.transport)
    : resolveAccountEntry(signal?.accounts, normalizedAccountId)?.transport;
}

function alignManagedConnectionUrlAfterBindChange(params: {
  existing: SignalManagedNativeTransport | undefined;
  prepared: SignalManagedNativeTransport;
  httpPort: number;
  hasUrlOverride: boolean;
}): SignalManagedNativeTransport {
  if (
    params.hasUrlOverride ||
    !params.existing?.url ||
    !isSignalManagedNativeConnectionUrlForBind(params.existing)
  ) {
    return assignSignalManagedNativePort(params.prepared, params.httpPort);
  }

  const connectionUrl = new URL(params.existing.url);
  connectionUrl.port = String(params.httpPort);
  const alignedPortUrl = normalizeSignalTransportUrl(connectionUrl.toString());
  const next = { ...params.prepared, url: alignedPortUrl, httpPort: params.httpPort };
  if (isSignalManagedNativeConnectionUrlForBind(next)) {
    return next;
  }

  const bindHost = params.prepared.httpHost ?? DEFAULT_SIGNAL_MANAGED_NATIVE_HOST;
  const connectionHost =
    bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost === "::" ? "::1" : bindHost;
  connectionUrl.hostname = connectionHost.includes(":") ? `[${connectionHost}]` : connectionHost;
  return {
    ...next,
    url: normalizeSignalTransportUrl(connectionUrl.toString()),
  };
}

export function prepareSignalManagedNativeTransport(params: {
  cfg: OpenClawConfig;
  accountId: string;
  overrides?: Omit<SignalManagedNativeTransport, "kind">;
}): SignalManagedNativeTransport {
  const existing = resolveConfiguredSignalTransport(params.cfg, params.accountId);
  const existingManaged = existing?.kind === "managed-native" ? existing : undefined;
  const preferredPort = params.overrides?.httpPort ?? existingManaged?.httpPort;
  const prepared: SignalManagedNativeTransport = {
    kind: "managed-native",
    ...existingManaged,
    ...params.overrides,
    httpHost:
      params.overrides?.httpHost ?? existingManaged?.httpHost ?? DEFAULT_SIGNAL_MANAGED_NATIVE_HOST,
  };
  const portsByAccountId = new Map<string, Set<number>>();
  const implicitManagedAccountIds: string[] = [];
  // Resolve the full current allocation before excluding the selected owner. Otherwise an
  // implicit sibling can claim the target's port and make an unrelated edit swap both daemons.
  for (const accountId of listSignalAccountIds(params.cfg)) {
    const normalizedAccountId = normalizeAccountId(accountId);
    const accountConfig = resolveSignalAccountConfig(params.cfg, accountId);
    if (!normalizeOptionalString(accountConfig.account) && !accountConfig.transport) {
      continue;
    }
    const accountPorts = portsByAccountId.get(normalizedAccountId) ?? new Set<number>();
    portsByAccountId.set(normalizedAccountId, accountPorts);
    const transport = accountConfig.transport;
    if (transport?.kind === "managed-native") {
      if (transport.httpPort !== undefined) {
        accountPorts.add(transport.httpPort);
      } else {
        implicitManagedAccountIds.push(normalizedAccountId);
      }
      if (transport.url && !isSignalManagedNativeConnectionUrlForBind(transport)) {
        const localConnectionPort = resolveLocalSignalTransportPort(transport.url);
        if (localConnectionPort !== undefined) {
          accountPorts.add(localConnectionPort);
        }
      }
      continue;
    }
    if (transport?.kind === "external-native" || transport?.kind === "container") {
      const localPort = resolveLocalSignalTransportPort(transport.url);
      if (localPort !== undefined) {
        accountPorts.add(localPort);
      }
      continue;
    }
    implicitManagedAccountIds.push(normalizedAccountId);
  }
  const currentReservedPorts = new Set<number>();
  for (const accountPorts of portsByAccountId.values()) {
    for (const httpPort of accountPorts) {
      currentReservedPorts.add(httpPort);
    }
  }
  for (const accountId of implicitManagedAccountIds) {
    const accountPorts = portsByAccountId.get(accountId);
    if (!accountPorts) {
      continue;
    }
    const httpPort = allocateSignalManagedNativePort({ reservedPorts: currentReservedPorts });
    currentReservedPorts.add(httpPort);
    accountPorts.add(httpPort);
  }
  const targetAccountId = normalizeAccountId(params.accountId);
  const reservedPorts = new Set<number>();
  for (const [accountId, accountPorts] of portsByAccountId) {
    if (accountId === targetAccountId) {
      continue;
    }
    for (const httpPort of accountPorts) {
      reservedPorts.add(httpPort);
    }
  }

  const hasIndependentPreparedConnectionUrl =
    prepared.url &&
    (params.overrides?.url !== undefined
      ? !isSignalManagedNativeConnectionUrlForBind(prepared)
      : Boolean(
          existingManaged?.url && !isSignalManagedNativeConnectionUrlForBind(existingManaged),
        ));
  if (hasIndependentPreparedConnectionUrl && prepared.url) {
    const localConnectionPort = resolveLocalSignalTransportPort(prepared.url);
    if (localConnectionPort !== undefined) {
      reservedPorts.add(localConnectionPort);
    }
  }

  if (params.overrides?.httpPort !== undefined && reservedPorts.has(params.overrides.httpPort)) {
    throw new Error(
      `Signal managed native port ${params.overrides.httpPort} is already reserved by another account or local transport endpoint.`,
    );
  }
  const httpPort = allocateSignalManagedNativePort({ reservedPorts, preferredPort });
  // A managed connection URL that points at the daemon's bind is one endpoint.
  // Keep its connection endpoint aligned when setup changes or reallocates the bind.
  return alignManagedConnectionUrlAfterBindChange({
    existing: existingManaged,
    prepared,
    httpPort,
    hasUrlOverride: params.overrides?.url !== undefined,
  });
}

export async function probeSignalTransport(params: {
  cfg: OpenClawConfig;
  accountId: string;
  transport: SignalTransportConfig;
  account?: string;
  timeoutMs?: number;
  probeNative?: SignalNativeTransportProbe;
  probeContainer?: SignalContainerTransportProbe;
}): Promise<SignalTransportProbeResult> {
  const timeoutMs = params.timeoutMs ?? 10_000;
  const transport =
    params.transport.kind === "managed-native"
      ? prepareSignalManagedNativeTransport({
          cfg: params.cfg,
          accountId: params.accountId,
          overrides: managedTransportOptions(params.transport),
        })
      : params.transport;
  const resolved = resolveSignalTransport(transport);
  if (resolved.kind === "container") {
    const probeContainer =
      params.probeContainer ?? (await import("./transport-probes.runtime.js")).containerCheck;
    return probeContainer(resolved.baseUrl, timeoutMs, params.account);
  }
  const probeNative =
    params.probeNative ?? (await import("./transport-probes.runtime.js")).nativeCheck;
  return probeNative(resolved.baseUrl, timeoutMs);
}

export function writeSignalAccountTransport(params: {
  cfg: OpenClawConfig;
  accountId: string;
  transport: SignalTransportConfig;
}): OpenClawConfig {
  const transport = normalizeTransport(params.transport);
  assertSignalContainerTransportHasAccount({
    cfg: params.cfg,
    accountId: params.accountId,
    transport,
  });
  assertSignalLocalEndpointDoesNotConflictWithManagedSibling({
    cfg: params.cfg,
    accountId: params.accountId,
    transport,
  });
  const next = patchChannelConfigForAccount({
    cfg: params.cfg,
    channel: "signal",
    accountId: params.accountId,
    patch: { transport },
  });
  const canonical = clearLegacySignalTransportFieldsForAccount({
    cfg: next,
    accountId: params.accountId,
  });
  if (transport.kind === "managed-native") {
    // Direct setup consumers can bypass prepareSignalManagedNativeTransport. Resolve the
    // candidate before returning so a sibling endpoint collision is never persisted.
    resolveSignalAccount({ cfg: canonical, accountId: params.accountId });
  }
  return canonical;
}
