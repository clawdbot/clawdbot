// Signal plugin module implements accounts behavior.
import {
  createAccountListHelpers,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  resolveAccountEntry,
  resolveMergedAccountConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import type { ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SignalAccountConfig, SignalTransportConfig } from "./account-types.js";
import {
  allocateSignalManagedNativePort,
  assignSignalManagedNativePort,
  DEFAULT_SIGNAL_MANAGED_NATIVE_PORT,
  isSignalManagedNativeConnectionUrlForBind,
  resolveLocalSignalTransportPort,
} from "./transport-policy.js";
import { buildSignalTransportHttpUrl } from "./transport-url.js";

export type ResolvedSignalTransport =
  | {
      kind: "managed-native";
      baseUrl: string;
      cliPath: string;
      configPath?: string;
      httpHost: string;
      httpPort: number;
      startupTimeoutMs: number;
      receiveMode?: "on-start" | "manual";
      ignoreStories?: boolean;
    }
  | {
      kind: "external-native" | "container";
      baseUrl: string;
    };

export type ResolvedSignalAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  baseUrl: string;
  transport: ResolvedSignalTransport;
  configured: boolean;
  config: SignalAccountConfig;
};

const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("signal", {
  normalizeAccountId,
  implicitDefaultAccount: {
    channelKeys: ["account", "transport"],
  },
});
export const listSignalAccountIds = listAccountIds;
export const resolveDefaultSignalAccountId = resolveDefaultAccountId;

export function resolveSignalAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): SignalAccountConfig {
  const channelConfig = cfg.channels?.signal;
  const {
    transport: _transport,
    accounts: _accounts,
    defaultAccount: _defaultAccount,
    ...shared
  } = channelConfig ?? {};
  const merged = resolveMergedAccountConfig<SignalAccountConfig>({
    channelConfig: (accountId === DEFAULT_ACCOUNT_ID ? channelConfig : shared) as
      | SignalAccountConfig
      | undefined,
    accounts: cfg.channels?.signal?.accounts as
      | Record<string, Partial<SignalAccountConfig>>
      | undefined,
    accountId,
    nestedObjectKeys: ["aliases"],
  });
  if (accountId === DEFAULT_ACCOUNT_ID && channelConfig?.transport) {
    // Setup and doctor store the default account transport at the channel root.
    // A stale nested default copy must not redirect runtime to another daemon.
    return { ...merged, transport: channelConfig.transport };
  }
  return merged;
}

function isSignalAccountConfigured(config: SignalAccountConfig): boolean {
  return Boolean(normalizeOptionalString(config.account) || config.transport);
}

function isSignalAccountEnabled(cfg: OpenClawConfig, config: SignalAccountConfig): boolean {
  return cfg.channels?.signal?.enabled !== false && config.enabled !== false;
}

function resolveSignalManagedNativePort(params: {
  cfg: OpenClawConfig;
  accountId: string;
  accountConfig: SignalAccountConfig;
  transport: SignalTransportConfig | undefined;
}): number {
  if (!isSignalAccountEnabled(params.cfg, params.accountConfig)) {
    return params.transport?.kind === "managed-native" && params.transport.httpPort !== undefined
      ? params.transport.httpPort
      : DEFAULT_SIGNAL_MANAGED_NATIVE_PORT;
  }
  if (params.transport?.kind === "managed-native" && params.transport.httpPort !== undefined) {
    const explicitPort = params.transport.httpPort;
    if (
      params.transport.url &&
      !isSignalManagedNativeConnectionUrlForBind(params.transport) &&
      resolveLocalSignalTransportPort(params.transport.url) === explicitPort
    ) {
      throw new Error(
        `Signal managed native account "${params.accountId}" binds port ${explicitPort}, which conflicts with its local transport endpoint. Assign a distinct transport.httpPort.`,
      );
    }
    for (const accountId of listSignalAccountIds(params.cfg)) {
      if (normalizeAccountId(accountId) === params.accountId) {
        continue;
      }
      const accountConfig = resolveSignalAccountConfig(params.cfg, accountId);
      if (
        !isSignalAccountConfigured(accountConfig) ||
        !isSignalAccountEnabled(params.cfg, accountConfig)
      ) {
        continue;
      }
      const transport = accountConfig.transport;
      if (transport?.kind === "managed-native" && transport.httpPort === explicitPort) {
        throw new Error(
          `Signal managed native accounts "${params.accountId}" and "${accountId}" both bind port ${explicitPort}. Assign each account a distinct transport.httpPort.`,
        );
      }
      const independentLocalUrl =
        transport?.kind === "external-native" ||
        transport?.kind === "container" ||
        (transport?.kind === "managed-native" &&
          Boolean(transport.url) &&
          !isSignalManagedNativeConnectionUrlForBind(transport))
          ? transport.url
          : undefined;
      if (
        independentLocalUrl &&
        resolveLocalSignalTransportPort(independentLocalUrl) === explicitPort
      ) {
        throw new Error(
          `Signal managed native account "${params.accountId}" binds port ${explicitPort}, which conflicts with account "${accountId}" local transport endpoint. Assign a distinct transport.httpPort.`,
        );
      }
    }
    return explicitPort;
  }

  const reservedPorts = new Set<number>();
  const implicitManagedAccountIds: string[] = [];
  // Reserve concrete local endpoints first, then assign implicit ports in account order.
  // Independent account resolution must produce the same collision-free daemon binds.
  for (const accountId of listSignalAccountIds(params.cfg)) {
    const accountConfig = resolveSignalAccountConfig(params.cfg, accountId);
    if (
      !isSignalAccountConfigured(accountConfig) ||
      !isSignalAccountEnabled(params.cfg, accountConfig)
    ) {
      continue;
    }
    const transport = accountConfig.transport;
    if (transport?.kind === "external-native" || transport?.kind === "container") {
      const localPort = resolveLocalSignalTransportPort(transport.url);
      if (localPort !== undefined) {
        reservedPorts.add(localPort);
      }
      continue;
    }
    if (transport?.kind === "managed-native") {
      if (transport.httpPort !== undefined) {
        reservedPorts.add(transport.httpPort);
      } else {
        implicitManagedAccountIds.push(accountId);
      }
      if (transport.url && !isSignalManagedNativeConnectionUrlForBind(transport)) {
        const localConnectionPort = resolveLocalSignalTransportPort(transport.url);
        if (localConnectionPort !== undefined) {
          reservedPorts.add(localConnectionPort);
        }
      }
      continue;
    }
    implicitManagedAccountIds.push(accountId);
  }

  for (const accountId of implicitManagedAccountIds) {
    const port = allocateSignalManagedNativePort({ reservedPorts });
    reservedPorts.add(port);
    if (normalizeAccountId(accountId) === params.accountId) {
      return port;
    }
  }
  return DEFAULT_SIGNAL_MANAGED_NATIVE_PORT;
}

export function resolveSignalTransport(
  transport: SignalTransportConfig | undefined,
  managedNativePort = DEFAULT_SIGNAL_MANAGED_NATIVE_PORT,
): ResolvedSignalTransport {
  if (transport?.kind === "external-native" || transport?.kind === "container") {
    return {
      kind: transport.kind,
      baseUrl: transport.url.trim(),
    };
  }

  const managedTransport =
    transport?.kind === "managed-native"
      ? assignSignalManagedNativePort(transport, transport.httpPort ?? managedNativePort)
      : transport;
  const httpHost = normalizeOptionalString(managedTransport?.httpHost) ?? "127.0.0.1";
  const httpPort = managedTransport?.httpPort ?? managedNativePort;
  const configPath = normalizeOptionalString(managedTransport?.configPath);
  const connectionUrl = normalizeOptionalString(managedTransport?.url);
  return {
    kind: "managed-native",
    baseUrl: connectionUrl ?? buildSignalTransportHttpUrl(httpHost, httpPort),
    cliPath: normalizeOptionalString(managedTransport?.cliPath) ?? "signal-cli",
    ...(configPath ? { configPath } : {}),
    httpHost,
    httpPort,
    startupTimeoutMs: managedTransport?.startupTimeoutMs ?? 30_000,
    ...(managedTransport?.receiveMode ? { receiveMode: managedTransport.receiveMode } : {}),
    ...(typeof managedTransport?.ignoreStories === "boolean"
      ? { ignoreStories: managedTransport.ignoreStories }
      : {}),
  };
}

export function resolveSignalAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedSignalAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultSignalAccountId(params.cfg),
  );
  const baseEnabled = params.cfg.channels?.signal?.enabled !== false;
  const merged = resolveSignalAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const transport = resolveSignalTransport(
    merged.transport,
    resolveSignalManagedNativePort({
      cfg: params.cfg,
      accountId,
      accountConfig: merged,
      transport: merged.transport,
    }),
  );
  const baseUrl = transport.baseUrl;
  const configured = isSignalAccountConfigured(merged);
  return {
    accountId,
    enabled,
    name: normalizeOptionalString(merged.name),
    baseUrl,
    transport,
    configured,
    config: merged,
  };
}

export function listEnabledSignalAccounts(cfg: OpenClawConfig): ResolvedSignalAccount[] {
  return listSignalAccountIds(cfg)
    .map((accountId) => resolveSignalAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}

function normalizeSignalReplyToMode(value: unknown): ReplyToMode | undefined {
  return value === "off" || value === "first" || value === "all" || value === "batched"
    ? value
    : undefined;
}

export function resolveSignalReplyToMode(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  chatType?: string | null;
}): ReplyToMode {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultSignalAccountId(params.cfg),
  );
  const signalConfig = params.cfg.channels?.signal;
  const accountConfig = resolveAccountEntry(
    signalConfig?.accounts as Record<string, SignalAccountConfig> | undefined,
    accountId,
  );
  const chatType =
    params.chatType === "direct" || params.chatType === "group" ? params.chatType : undefined;
  if (chatType) {
    const accountScoped = normalizeSignalReplyToMode(
      accountConfig?.replyToModeByChatType?.[chatType],
    );
    if (accountScoped) {
      return accountScoped;
    }
    const accountDefault = normalizeSignalReplyToMode(accountConfig?.replyToMode);
    if (accountDefault) {
      return accountDefault;
    }
    const channelScoped = normalizeSignalReplyToMode(
      signalConfig?.replyToModeByChatType?.[chatType],
    );
    if (channelScoped) {
      return channelScoped;
    }
  }
  return (
    normalizeSignalReplyToMode(accountConfig?.replyToMode) ??
    normalizeSignalReplyToMode(signalConfig?.replyToMode) ??
    "all"
  );
}
