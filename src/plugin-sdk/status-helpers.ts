import type { ChannelStatusAdapter } from "../channels/plugins/types.adapters.js";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.core.js";
import type { ChannelStatusIssue } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
export type { ChannelAccountSnapshot } from "../channels/plugins/types.core.js";
export type { ChannelStatusIssue } from "../channels/plugins/types.public.js";
export { isRecord } from "../channels/plugins/status-issues/shared.js";
export {
  appendMatchMetadata,
  asString,
  collectIssuesForEnabledAccounts,
  formatMatchMetadata,
  resolveEnabledConfiguredAccountId,
} from "../channels/plugins/status-issues/shared.js";

type RuntimeLifecycleSnapshot = {
  running?: boolean | null;
  connected?: boolean | null;
  restartPending?: boolean | null;
  reconnectAttempts?: number | null;
  lastConnectedAt?: number | null;
  lastDisconnect?:
    | string
    | {
        at: number;
        status?: number;
        error?: string;
        loggedOut?: boolean;
      }
    | null;
  lastEventAt?: number | null;
  lastTransportActivityAt?: number | null;
  healthState?: string | null;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
};

type StatusSnapshotExtra = Record<string, unknown>;

type ComputedAccountStatusBase = {
  accountId: string;
  name?: string;
  enabled?: boolean;
  configured?: boolean;
};

type ComputedAccountStatusAdapterParams<ResolvedAccount, Probe, Audit> = {
  account: ResolvedAccount;
  cfg: OpenClawConfig;
  runtime?: ChannelAccountSnapshot;
  probe?: Probe;
  audit?: Audit;
};

type ComputedAccountStatusSnapshot<TExtra extends StatusSnapshotExtra = StatusSnapshotExtra> =
  ComputedAccountStatusBase & { extra?: TExtra };

type ConfigIssueAccount = {
  accountId?: string | null;
  configured?: boolean | null;
} & Record<string, unknown>;

function buildComputedAccountStatusAdapterBase<ResolvedAccount, Probe, Audit>(
  options: Omit<ChannelStatusAdapter<ResolvedAccount, Probe, Audit>, "buildAccountSnapshot">,
): Omit<ChannelStatusAdapter<ResolvedAccount, Probe, Audit>, "buildAccountSnapshot"> {
  return {
    defaultRuntime: options.defaultRuntime,
    buildChannelSummary: options.buildChannelSummary,
    probeAccount: options.probeAccount,
    formatCapabilitiesProbe: options.formatCapabilitiesProbe,
    auditAccount: options.auditAccount,
    buildCapabilitiesDiagnostics: options.buildCapabilitiesDiagnostics,
    logSelfId: options.logSelfId,
    resolveAccountState: options.resolveAccountState,
    collectStatusIssues: options.collectStatusIssues,
  };
}

/** Create the baseline runtime snapshot shape used by channel/account status stores. */
export function createDefaultChannelRuntimeState<T extends Record<string, unknown>>(
  accountId: string,
  extra?: T,
): {
  accountId: string;
  running: false;
  lastStartAt: null;
  lastStopAt: null;
  lastError: null;
} & T {
  return {
    accountId,
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
    ...(extra ?? ({} as T)),
  };
}

/** Normalize a channel-level status summary so missing lifecycle fields become explicit nulls. */
export function buildBaseChannelStatusSummary<TExtra extends StatusSnapshotExtra>(
  snapshot: {
    configured?: boolean | null;
    running?: boolean | null;
    lastStartAt?: number | null;
    lastStopAt?: number | null;
    lastError?: string | null;
  },
  extra?: TExtra,
) {
  return {
    configured: snapshot.configured ?? false,
    ...(extra ?? ({} as TExtra)),
    running: snapshot.running ?? false,
    lastStartAt: snapshot.lastStartAt ?? null,
    lastStopAt: snapshot.lastStopAt ?? null,
    lastError: snapshot.lastError ?? null,
  };
}

/** Extend the base summary with probe fields while preserving stable null defaults. */
export function buildProbeChannelStatusSummary<TExtra extends Record<string, unknown>>(
  snapshot: {
    configured?: boolean | null;
    running?: boolean | null;
    lastStartAt?: number | null;
    lastStopAt?: number | null;
    lastError?: string | null;
    probe?: unknown;
    lastProbeAt?: number | null;
  },
  extra?: TExtra,
) {
  return {
    ...buildBaseChannelStatusSummary(snapshot, extra),
    probe: snapshot.probe,
    lastProbeAt: snapshot.lastProbeAt ?? null,
  };
}

/** Build webhook channel summaries with a stable default mode. */
export function buildWebhookChannelStatusSummary<TExtra extends StatusSnapshotExtra>(
  snapshot: {
    configured?: boolean | null;
    mode?: string | null;
    running?: boolean | null;
    lastStartAt?: number | null;
    lastStopAt?: number | null;
    lastError?: string | null;
  },
  extra?: TExtra,
) {
  return buildBaseChannelStatusSummary(snapshot, {
    mode: snapshot.mode ?? "webhook",
    ...(extra ?? ({} as TExtra)),
  });
}

/** Build the standard per-account status payload from config metadata plus runtime state. */
export function buildBaseAccountStatusSnapshot<TExtra extends StatusSnapshotExtra>(
  params: {
    account: {
      accountId: string;
      name?: string;
      enabled?: boolean;
      configured?: boolean;
    };
    runtime?: RuntimeLifecycleSnapshot | null;
    probe?: unknown;
  },
  extra?: TExtra,
) {
  const { account, runtime, probe } = params;
  return {
    accountId: account.accountId,
    name: account.name,
    enabled: account.enabled,
    configured: account.configured,
    ...buildRuntimeAccountStatusSnapshot({ runtime, probe }),
    lastInboundAt: runtime?.lastInboundAt ?? null,
    lastOutboundAt: runtime?.lastOutboundAt ?? null,
    ...(extra ?? ({} as TExtra)),
  };
}

/** Convenience wrapper when the caller already has flattened account fields instead of an account object. */
export function buildComputedAccountStatusSnapshot<TExtra extends StatusSnapshotExtra>(
  params: {
    accountId: string;
    name?: string;
    enabled?: boolean;
    configured?: boolean;
    runtime?: RuntimeLifecycleSnapshot | null;
    probe?: unknown;
  },
  extra?: TExtra,
) {
  const { accountId, name, enabled, configured, runtime, probe } = params;
  return buildBaseAccountStatusSnapshot(
    {
      account: {
        accountId,
        name,
        enabled,
        configured,
      },
      runtime,
      probe,
    },
    extra,
  );
}

/** Build a full status adapter when only configured/extras vary per account. */
export function createComputedAccountStatusAdapter<
  ResolvedAccount,
  Probe = unknown,
  Audit = unknown,
  TExtra extends StatusSnapshotExtra = StatusSnapshotExtra,
>(
  options: Omit<ChannelStatusAdapter<ResolvedAccount, Probe, Audit>, "buildAccountSnapshot"> & {
    resolveAccountSnapshot: (
      params: ComputedAccountStatusAdapterParams<ResolvedAccount, Probe, Audit>,
    ) => ComputedAccountStatusSnapshot<TExtra>;
  },
): ChannelStatusAdapter<ResolvedAccount, Probe, Audit> {
  return {
    ...buildComputedAccountStatusAdapterBase(options),
    buildAccountSnapshot: (params) => {
      const typedParams = params as ComputedAccountStatusAdapterParams<
        ResolvedAccount,
        Probe,
        Audit
      >;
      const { extra, ...snapshot } = options.resolveAccountSnapshot(typedParams);
      return buildComputedAccountStatusSnapshot(
        {
          ...snapshot,
          runtime: typedParams.runtime,
          probe: typedParams.probe,
        },
        extra,
      );
    },
  };
}

/** Async variant for channels that compute configured state or snapshot extras from I/O. */
export function createAsyncComputedAccountStatusAdapter<
  ResolvedAccount,
  Probe = unknown,
  Audit = unknown,
  TExtra extends StatusSnapshotExtra = StatusSnapshotExtra,
>(
  options: Omit<ChannelStatusAdapter<ResolvedAccount, Probe, Audit>, "buildAccountSnapshot"> & {
    resolveAccountSnapshot: (
      params: ComputedAccountStatusAdapterParams<ResolvedAccount, Probe, Audit>,
    ) => Promise<ComputedAccountStatusSnapshot<TExtra>>;
  },
): ChannelStatusAdapter<ResolvedAccount, Probe, Audit> {
  return {
    ...buildComputedAccountStatusAdapterBase(options),
    buildAccountSnapshot: async (params) => {
      const typedParams = params as ComputedAccountStatusAdapterParams<
        ResolvedAccount,
        Probe,
        Audit
      >;
      const { extra, ...snapshot } = await options.resolveAccountSnapshot(typedParams);
      return buildComputedAccountStatusSnapshot(
        {
          ...snapshot,
          runtime: typedParams.runtime,
          probe: typedParams.probe,
        },
        extra,
      );
    },
  };
}

/** Normalize runtime-only account state into the shared status snapshot fields. */
export function buildRuntimeAccountStatusSnapshot<TExtra extends StatusSnapshotExtra>(
  params: {
    runtime?: RuntimeLifecycleSnapshot | null;
    probe?: unknown;
  },
  extra?: TExtra,
) {
  const { runtime, probe } = params;
  return {
    running: runtime?.running ?? false,
    lastStartAt: runtime?.lastStartAt ?? null,
    lastStopAt: runtime?.lastStopAt ?? null,
    lastError: runtime?.lastError ?? null,
    probe,
    ...(typeof runtime?.connected === "boolean" ? { connected: runtime.connected } : {}),
    ...(typeof runtime?.restartPending === "boolean"
      ? { restartPending: runtime.restartPending }
      : {}),
    ...(typeof runtime?.reconnectAttempts === "number"
      ? { reconnectAttempts: runtime.reconnectAttempts }
      : {}),
    ...(typeof runtime?.lastConnectedAt === "number"
      ? { lastConnectedAt: runtime.lastConnectedAt }
      : {}),
    ...(runtime?.lastDisconnect ? { lastDisconnect: runtime.lastDisconnect } : {}),
    ...(typeof runtime?.lastEventAt === "number" ? { lastEventAt: runtime.lastEventAt } : {}),
    ...(typeof runtime?.lastTransportActivityAt === "number"
      ? { lastTransportActivityAt: runtime.lastTransportActivityAt }
      : {}),
    ...(typeof runtime?.healthState === "string" ? { healthState: runtime.healthState } : {}),
    ...(extra ?? ({} as TExtra)),
  };
}

/** Build token-based channel status summaries with optional mode reporting. */
export function buildTokenChannelStatusSummary(
  snapshot: {
    configured?: boolean | null;
    tokenSource?: string | null;
    running?: boolean | null;
    mode?: string | null;
    lastStartAt?: number | null;
    lastStopAt?: number | null;
    lastError?: string | null;
    probe?: unknown;
    lastProbeAt?: number | null;
  },
  opts?: { includeMode?: boolean },
) {
  const base = {
    ...buildBaseChannelStatusSummary(snapshot),
    tokenSource: snapshot.tokenSource ?? "none",
    probe: snapshot.probe,
    lastProbeAt: snapshot.lastProbeAt ?? null,
  };
  if (opts?.includeMode === false) {
    return base;
  }
  return {
    ...base,
    mode: snapshot.mode ?? null,
  };
}

/** Build a config-issue collector from snapshot-safe source metadata only. */
export function createDependentCredentialStatusIssueCollector(options: {
  channel: string;
  dependencySourceKey: string;
  missingPrimaryMessage: string;
  missingDependentMessage: string;
  isDependencyConfigured?: ((value: unknown) => boolean) | undefined;
}) {
  const isDependencyConfigured =
    options.isDependencyConfigured ??
    ((value: unknown) => {
      const normalized = typeof value === "string" ? normalizeOptionalString(value) : undefined;
      return Boolean(normalized && normalized !== "none");
    });

  return (accounts: ConfigIssueAccount[]): ChannelStatusIssue[] =>
    accounts.flatMap((account) => {
      if (account.configured !== false) {
        return [];
      }
      return [
        {
          channel: options.channel,
          accountId: account.accountId ?? "",
          kind: "config",
          message: isDependencyConfigured(account[options.dependencySourceKey])
            ? options.missingDependentMessage
            : options.missingPrimaryMessage,
        },
      ];
    });
}

/** Convert account runtime errors into the generic channel status issue format. */
export function collectStatusIssuesFromLastError(
  channel: string,
  accounts: Array<{ accountId: string; lastError?: unknown }>,
): ChannelStatusIssue[] {
  return accounts.flatMap((account) => {
    const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
    if (!lastError) {
      return [];
    }
    return [
      {
        channel,
        accountId: account.accountId,
        kind: "runtime",
        message: `Channel error: ${lastError}`,
      },
    ];
  });
}
