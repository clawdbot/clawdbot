import { roleScopesAllow } from "../../../../src/shared/operator-scope-compat.ts";
import type {
  ChannelsPairingApproveResult,
  ChannelsPairingListResult,
  ChannelsStatusSnapshot,
} from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../gateway-errors.ts";

type ChannelGatewayClient = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
};

type ChannelLogoutResult = {
  cleared: boolean;
};

type ChannelGatewaySnapshot = {
  client: ChannelGatewayClient | null;
  connected: boolean;
  hello?: {
    auth?: { role?: string; scopes?: readonly string[] } | null;
  } | null;
};

type ChannelGateway = {
  readonly snapshot: ChannelGatewaySnapshot;
  subscribe: (listener: (snapshot: ChannelGatewaySnapshot) => void) => () => void;
};

type ChannelsState = {
  client: ChannelGatewayClient | null;
  connected: boolean;
  channelsLoading: boolean;
  channelsLoadingProbe?: boolean | null;
  channelsRefreshSeq?: number;
  channelsSnapshot: ChannelsStatusSnapshot | null;
  channelsError: string | null;
  channelsLastSuccess: number | null;
  pairingLoading: boolean;
  pairingRefreshSeq: number;
  pairingSnapshot: ChannelsPairingListResult | null;
  pairingError: string | null;
  pairingLastSuccess: number | null;
  pairingBusyRequestId: string | null;
  whatsappLoginMessage: string | null;
  whatsappLoginQrDataUrl: string | null;
  whatsappLoginConnected: boolean | null;
  whatsappBusy: boolean;
};

type LoadChannelsOptions = {
  softTimeoutMs?: number;
};

export type ChannelCapability = {
  readonly state: ChannelsState;
  refresh: (probe?: boolean, options?: LoadChannelsOptions) => Promise<void>;
  refreshPairing: () => Promise<void>;
  approvePairing: (params: {
    channel: string;
    accountId: string;
    requestId: string;
    notify: boolean;
    bootstrapCommandOwner: boolean;
  }) => Promise<ChannelsPairingApproveResult | null>;
  dismissPairing: (params: {
    channel: string;
    accountId: string;
    requestId: string;
  }) => Promise<boolean>;
  startWhatsApp: (force: boolean, accountId?: string) => Promise<void>;
  waitWhatsApp: (accountId?: string) => Promise<void>;
  logoutWhatsApp: (accountId?: string) => Promise<void>;
  subscribe: (listener: (state: ChannelsState) => void) => () => void;
  dispose: () => void;
};

export function resolveChannelPairingAuthSignature(
  snapshot: Partial<ChannelGatewaySnapshot>,
): string {
  const auth = snapshot.hello?.auth;
  return JSON.stringify({
    role: auth?.role ?? null,
    scopes: auth?.scopes ? [...auth.scopes].toSorted() : null,
  });
}

function channelSnapshotAllowsScope(
  snapshot: Partial<ChannelGatewaySnapshot>,
  scope: string,
): boolean {
  const auth = snapshot.hello?.auth;
  if (!auth?.scopes) {
    return true;
  }
  return roleScopesAllow({
    role: auth.role ?? "operator",
    requestedScopes: [scope],
    allowedScopes: auth.scopes,
  });
}

function createInitialChannelsState(snapshot: Partial<ChannelGatewaySnapshot> = {}): ChannelsState {
  return {
    client: snapshot.client ?? null,
    connected: snapshot.connected ?? false,
    channelsLoading: false,
    channelsLoadingProbe: null,
    channelsRefreshSeq: 0,
    channelsSnapshot: null,
    channelsError: null,
    channelsLastSuccess: null,
    pairingLoading: false,
    pairingRefreshSeq: 0,
    pairingSnapshot: null,
    pairingError: null,
    pairingLastSuccess: null,
    pairingBusyRequestId: null,
    whatsappLoginMessage: null,
    whatsappLoginQrDataUrl: null,
    whatsappLoginConnected: null,
    whatsappBusy: false,
  };
}

function delay(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => {
    setTimeout(() => resolve("timeout"), ms);
  });
}

function isCurrentChannelRefresh(
  state: ChannelsState,
  client: ChannelGatewayClient,
  refreshSeq: number,
): boolean {
  return state.client === client && state.channelsRefreshSeq === refreshSeq;
}

async function loadChannels(
  state: ChannelsState,
  probe: boolean,
  options: LoadChannelsOptions = {},
) {
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  if (state.channelsLoading && (!state.channelsLoadingProbe || probe)) {
    return;
  }
  const refreshSeq = (state.channelsRefreshSeq ?? 0) + 1;
  state.channelsRefreshSeq = refreshSeq;
  state.channelsLoading = true;
  state.channelsLoadingProbe = probe;
  state.channelsError = null;
  const refresh = (async () => {
    try {
      const res = await client.request<ChannelsStatusSnapshot | null>("channels.status", {
        probe,
        timeoutMs: 8000,
      });
      if (!isCurrentChannelRefresh(state, client, refreshSeq)) {
        return;
      }
      state.channelsSnapshot = res;
      state.channelsLastSuccess = Date.now();
    } catch (err) {
      if (!isCurrentChannelRefresh(state, client, refreshSeq)) {
        return;
      }
      if (isMissingOperatorReadScopeError(err)) {
        state.channelsSnapshot = null;
        state.channelsError = formatMissingOperatorReadScopeMessage("channel status");
      } else {
        state.channelsError = String(err);
      }
    } finally {
      if (isCurrentChannelRefresh(state, client, refreshSeq)) {
        state.channelsLoading = false;
        state.channelsLoadingProbe = null;
      }
    }
  })();

  const softTimeoutMs = options.softTimeoutMs;
  if (typeof softTimeoutMs === "number" && softTimeoutMs > 0) {
    const outcome = await Promise.race([refresh.then(() => "done" as const), delay(softTimeoutMs)]);
    if (outcome === "timeout") {
      return;
    }
    return;
  }
  await refresh;
}

function isCurrentPairingRefresh(
  state: ChannelsState,
  client: ChannelGatewayClient,
  refreshSeq: number,
): boolean {
  return state.connected && state.client === client && state.pairingRefreshSeq === refreshSeq;
}

function invalidatePairingRefresh(state: ChannelsState): void {
  // A mutation must supersede any list that started before it; otherwise that
  // stale list can put the resolved request back until the next poll.
  state.pairingRefreshSeq += 1;
  state.pairingLoading = false;
}

async function loadChannelPairing(
  state: ChannelsState,
  options: { duringMutation?: boolean } = {},
): Promise<void> {
  const client = state.client;
  if (
    !client ||
    !state.connected ||
    state.pairingLoading ||
    (state.pairingBusyRequestId && !options.duringMutation)
  ) {
    return;
  }
  const refreshSeq = state.pairingRefreshSeq + 1;
  state.pairingRefreshSeq = refreshSeq;
  state.pairingLoading = true;
  state.pairingError = null;
  try {
    const snapshot = await client.request<ChannelsPairingListResult>("channels.pairing.list", {});
    if (!isCurrentPairingRefresh(state, client, refreshSeq)) {
      return;
    }
    state.pairingSnapshot = snapshot;
    state.pairingLastSuccess = Date.now();
  } catch (error) {
    if (isCurrentPairingRefresh(state, client, refreshSeq)) {
      state.pairingError = String(error);
    }
  } finally {
    if (isCurrentPairingRefresh(state, client, refreshSeq)) {
      state.pairingLoading = false;
    }
  }
}

type PairingMutation = {
  client: ChannelGatewayClient;
  pairingEpoch: number;
  requestId: string;
};

function isCurrentPairingMutation(state: ChannelsState, mutation: PairingMutation): boolean {
  return (
    state.connected &&
    state.client === mutation.client &&
    getChannelsLifecycle(state).pairingEpoch === mutation.pairingEpoch &&
    state.pairingBusyRequestId === mutation.requestId
  );
}

function removePairingRequestFromSnapshot(state: ChannelsState, requestId: string): void {
  const snapshot = state.pairingSnapshot;
  if (!snapshot || !snapshot.requests.some((request) => request.requestId === requestId)) {
    return;
  }
  state.pairingSnapshot = {
    ...snapshot,
    requests: snapshot.requests.filter((request) => request.requestId !== requestId),
  };
}

async function approveChannelPairing(
  state: ChannelsState,
  params: {
    channel: string;
    accountId: string;
    requestId: string;
    notify: boolean;
    bootstrapCommandOwner: boolean;
  },
): Promise<ChannelsPairingApproveResult | null> {
  const client = state.client;
  if (!client || !state.connected || state.pairingBusyRequestId) {
    return null;
  }
  const mutation: PairingMutation = {
    client,
    pairingEpoch: getChannelsLifecycle(state).pairingEpoch,
    requestId: params.requestId,
  };
  invalidatePairingRefresh(state);
  state.pairingBusyRequestId = params.requestId;
  state.pairingError = null;
  try {
    const result = await client.request<ChannelsPairingApproveResult>(
      "channels.pairing.approve",
      params,
    );
    if (!isCurrentPairingMutation(state, mutation)) {
      return null;
    }
    removePairingRequestFromSnapshot(state, params.requestId);
    invalidatePairingRefresh(state);
    await loadChannelPairing(state, { duringMutation: true });
    return isCurrentPairingMutation(state, mutation) ? result : null;
  } catch (error) {
    if (isCurrentPairingMutation(state, mutation)) {
      state.pairingError = String(error);
    }
    return null;
  } finally {
    if (isCurrentPairingMutation(state, mutation)) {
      state.pairingBusyRequestId = null;
    }
  }
}

async function dismissChannelPairing(
  state: ChannelsState,
  params: { channel: string; accountId: string; requestId: string },
): Promise<boolean> {
  const client = state.client;
  if (!client || !state.connected || state.pairingBusyRequestId) {
    return false;
  }
  const mutation: PairingMutation = {
    client,
    pairingEpoch: getChannelsLifecycle(state).pairingEpoch,
    requestId: params.requestId,
  };
  invalidatePairingRefresh(state);
  state.pairingBusyRequestId = params.requestId;
  state.pairingError = null;
  try {
    await client.request("channels.pairing.dismiss", params);
    if (!isCurrentPairingMutation(state, mutation)) {
      return false;
    }
    removePairingRequestFromSnapshot(state, params.requestId);
    invalidatePairingRefresh(state);
    await loadChannelPairing(state, { duringMutation: true });
    return isCurrentPairingMutation(state, mutation);
  } catch (error) {
    if (isCurrentPairingMutation(state, mutation)) {
      state.pairingError = String(error);
    }
    return false;
  } finally {
    if (isCurrentPairingMutation(state, mutation)) {
      state.pairingBusyRequestId = null;
    }
  }
}

type WhatsAppOperation = {
  client: ChannelGatewayClient;
  whatsappEpoch: number;
  operationSeq: number;
};

type ChannelsLifecycle = {
  whatsappEpoch: number;
  pairingEpoch: number;
  whatsappOperationSeq: number;
};

const channelsLifecycles = new WeakMap<ChannelsState, ChannelsLifecycle>();

function getChannelsLifecycle(state: ChannelsState): ChannelsLifecycle {
  const existing = channelsLifecycles.get(state);
  if (existing) {
    return existing;
  }
  const created = { whatsappEpoch: 0, pairingEpoch: 0, whatsappOperationSeq: 0 };
  channelsLifecycles.set(state, created);
  return created;
}

function beginWhatsAppOperation(state: ChannelsState): WhatsAppOperation | null {
  const client = state.client;
  if (!client || !state.connected || state.whatsappBusy) {
    return null;
  }
  const lifecycle = getChannelsLifecycle(state);
  const operationSeq = lifecycle.whatsappOperationSeq + 1;
  lifecycle.whatsappOperationSeq = operationSeq;
  state.whatsappBusy = true;
  return { client, whatsappEpoch: lifecycle.whatsappEpoch, operationSeq };
}

function isCurrentWhatsAppOperation(state: ChannelsState, operation: WhatsAppOperation): boolean {
  const lifecycle = getChannelsLifecycle(state);
  return (
    state.connected &&
    state.client === operation.client &&
    lifecycle.whatsappEpoch === operation.whatsappEpoch &&
    lifecycle.whatsappOperationSeq === operation.operationSeq
  );
}

async function startWhatsAppLogin(
  state: ChannelsState,
  force: boolean,
  accountId?: string,
): Promise<boolean> {
  const operation = beginWhatsAppOperation(state);
  if (!operation) {
    return false;
  }
  try {
    const res = await operation.client.request<{
      message?: string;
      qrDataUrl?: string;
      connected?: boolean;
    }>("web.login.start", {
      force,
      timeoutMs: 30000,
      ...(accountId ? { accountId } : {}),
    });
    if (!isCurrentWhatsAppOperation(state, operation)) {
      return false;
    }
    state.whatsappLoginMessage = res.message ?? null;
    state.whatsappLoginQrDataUrl = res.qrDataUrl ?? null;
    state.whatsappLoginConnected = typeof res.connected === "boolean" ? res.connected : null;
  } catch (err) {
    if (!isCurrentWhatsAppOperation(state, operation)) {
      return false;
    }
    state.whatsappLoginMessage = String(err);
    state.whatsappLoginQrDataUrl = null;
    state.whatsappLoginConnected = null;
  } finally {
    if (isCurrentWhatsAppOperation(state, operation)) {
      state.whatsappBusy = false;
    }
  }
  return true;
}

async function waitWhatsAppLogin(state: ChannelsState, accountId?: string): Promise<boolean> {
  const operation = beginWhatsAppOperation(state);
  if (!operation) {
    return false;
  }
  const currentQrDataUrl = state.whatsappLoginQrDataUrl ?? undefined;
  try {
    const res = await operation.client.request<{
      message?: string;
      connected?: boolean;
      qrDataUrl?: string;
    }>("web.login.wait", {
      timeoutMs: 120000,
      currentQrDataUrl,
      ...(accountId ? { accountId } : {}),
    });
    if (!isCurrentWhatsAppOperation(state, operation)) {
      return false;
    }
    state.whatsappLoginMessage = res.message ?? null;
    state.whatsappLoginConnected = res.connected ?? null;
    if (res.qrDataUrl) {
      state.whatsappLoginQrDataUrl = res.qrDataUrl;
    } else if (res.connected) {
      state.whatsappLoginQrDataUrl = null;
    }
  } catch (err) {
    if (!isCurrentWhatsAppOperation(state, operation)) {
      return false;
    }
    state.whatsappLoginMessage = String(err);
    state.whatsappLoginConnected = null;
  } finally {
    if (isCurrentWhatsAppOperation(state, operation)) {
      state.whatsappBusy = false;
    }
  }
  return true;
}

async function logoutWhatsApp(state: ChannelsState, accountId?: string): Promise<boolean> {
  const operation = beginWhatsAppOperation(state);
  if (!operation) {
    return false;
  }
  try {
    const result = await operation.client.request<ChannelLogoutResult>("channels.logout", {
      channel: "whatsapp",
      ...(accountId ? { accountId } : {}),
    });
    if (!isCurrentWhatsAppOperation(state, operation)) {
      return false;
    }
    if (result.cleared) {
      state.whatsappLoginMessage = t("channels.whatsapp.loggedOut");
      state.whatsappLoginQrDataUrl = null;
      state.whatsappLoginConnected = null;
    } else {
      state.whatsappLoginMessage = t("channels.whatsapp.logoutNotCleared");
    }
  } catch (err) {
    if (!isCurrentWhatsAppOperation(state, operation)) {
      return false;
    }
    state.whatsappLoginMessage = String(err);
  } finally {
    if (isCurrentWhatsAppOperation(state, operation)) {
      state.whatsappBusy = false;
    }
  }
  return true;
}

export function resolveChannelConfigValue(
  configForm: Record<string, unknown> | null | undefined,
  channelId: string,
): Record<string, unknown> | null {
  if (!configForm) {
    return null;
  }
  const channels = (configForm.channels ?? {}) as Record<string, unknown>;
  const fromChannels = channels[channelId];
  if (fromChannels && typeof fromChannels === "object") {
    return fromChannels as Record<string, unknown>;
  }
  const fallback = configForm[channelId];
  if (fallback && typeof fallback === "object") {
    return fallback as Record<string, unknown>;
  }
  return null;
}

export function formatChannelExtraValue(raw: unknown): string {
  if (raw == null) {
    return t("common.na");
  }
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    return String(raw);
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return t("common.na");
  }
}

export function resolveChannelExtras(params: {
  configForm: Record<string, unknown> | null | undefined;
  channelId: string;
  fields: readonly string[];
}): Array<{ label: string; value: string }> {
  const value = resolveChannelConfigValue(params.configForm, params.channelId);
  if (!value) {
    return [];
  }
  return params.fields.flatMap((field) => {
    if (!(field in value)) {
      return [];
    }
    return [{ label: field, value: formatChannelExtraValue(value[field]) }];
  });
}

export function createChannelCapability(gateway: ChannelGateway): ChannelCapability {
  const state = createInitialChannelsState(gateway.snapshot);
  const listeners = new Set<(state: ChannelsState) => void>();
  let currentChannelReadAccess = channelSnapshotAllowsScope(gateway.snapshot, "operator.read");
  let currentPairingAuthSignature = resolveChannelPairingAuthSignature(gateway.snapshot);
  let currentWhatsAppAdminAccess = channelSnapshotAllowsScope(gateway.snapshot, "operator.admin");
  let disposed = false;

  const publish = () => {
    if (disposed) {
      return;
    }
    for (const listener of listeners) {
      listener(state);
    }
  };
  const run = async (task: () => Promise<void>): Promise<void> => {
    if (disposed) {
      return;
    }
    const result = task();
    publish();
    try {
      await result;
    } finally {
      publish();
    }
  };
  const stopGateway = gateway.subscribe((snapshot) => {
    const clientChanged = state.client !== snapshot.client;
    const connectionChanged = state.connected !== snapshot.connected;
    const nextChannelReadAccess = channelSnapshotAllowsScope(snapshot, "operator.read");
    const channelReadAccessChanged = currentChannelReadAccess !== nextChannelReadAccess;
    currentChannelReadAccess = nextChannelReadAccess;
    const nextPairingAuthSignature = resolveChannelPairingAuthSignature(snapshot);
    const pairingAuthChanged = currentPairingAuthSignature !== nextPairingAuthSignature;
    currentPairingAuthSignature = nextPairingAuthSignature;
    const nextWhatsAppAdminAccess = channelSnapshotAllowsScope(snapshot, "operator.admin");
    const whatsappAdminAccessChanged = currentWhatsAppAdminAccess !== nextWhatsAppAdminAccess;
    currentWhatsAppAdminAccess = nextWhatsAppAdminAccess;
    state.client = snapshot.client;
    state.connected = snapshot.connected;
    const lifecycle = getChannelsLifecycle(state);
    if (clientChanged || connectionChanged || channelReadAccessChanged) {
      state.channelsLoading = false;
      state.channelsLoadingProbe = null;
      state.channelsRefreshSeq = (state.channelsRefreshSeq ?? 0) + 1;
      if (!nextChannelReadAccess) {
        state.channelsSnapshot = null;
        state.channelsError = null;
        state.channelsLastSuccess = null;
      }
    }
    if (clientChanged || connectionChanged || whatsappAdminAccessChanged) {
      lifecycle.whatsappEpoch += 1;
      lifecycle.whatsappOperationSeq += 1;
      state.whatsappBusy = false;
      if (!nextWhatsAppAdminAccess) {
        state.whatsappLoginMessage = null;
        state.whatsappLoginQrDataUrl = null;
        state.whatsappLoginConnected = null;
      }
    }
    if (clientChanged || connectionChanged || pairingAuthChanged) {
      // Pairing authorization has its own epoch so scope changes cannot cancel
      // unrelated channel login/logout operations on the same connection.
      lifecycle.pairingEpoch += 1;
      state.pairingSnapshot = null;
      state.pairingError = null;
      state.pairingLastSuccess = null;
      state.pairingLoading = false;
      state.pairingBusyRequestId = null;
      state.pairingRefreshSeq += 1;
    }
    publish();
  });

  return {
    get state() {
      return state;
    },
    refresh: (probe, options) => run(() => loadChannels(state, probe ?? false, options)),
    refreshPairing: () => run(() => loadChannelPairing(state)),
    approvePairing: async (params) => {
      let result: ChannelsPairingApproveResult | null = null;
      await run(async () => {
        result = await approveChannelPairing(state, params);
      });
      return result;
    },
    dismissPairing: async (params) => {
      let dismissed = false;
      await run(async () => {
        dismissed = await dismissChannelPairing(state, params);
      });
      return dismissed;
    },
    startWhatsApp: (force, accountId) =>
      run(async () => {
        if (await startWhatsAppLogin(state, force, accountId)) {
          await loadChannels(state, true);
        }
      }),
    waitWhatsApp: (accountId) =>
      run(async () => {
        if (await waitWhatsAppLogin(state, accountId)) {
          await loadChannels(state, true);
        }
      }),
    logoutWhatsApp: (accountId) =>
      run(async () => {
        if (await logoutWhatsApp(state, accountId)) {
          await loadChannels(state, true);
        }
      }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      const lifecycle = getChannelsLifecycle(state);
      lifecycle.whatsappEpoch += 1;
      lifecycle.pairingEpoch += 1;
      lifecycle.whatsappOperationSeq += 1;
      state.pairingRefreshSeq += 1;
      state.pairingBusyRequestId = null;
      state.whatsappBusy = false;
      stopGateway();
      listeners.clear();
    },
  };
}
