import type { ChannelsStatusSnapshot } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../gateway-errors.ts";

type ChannelGatewayClient = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
};

type ChannelGatewaySnapshot = {
  client: ChannelGatewayClient | null;
  connected: boolean;
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
  startWhatsApp: (force: boolean, accountId?: string) => Promise<void>;
  waitWhatsApp: (accountId?: string) => Promise<void>;
  logoutWhatsApp: () => Promise<void>;
  subscribe: (listener: (state: ChannelsState) => void) => () => void;
  dispose: () => void;
};

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

type WhatsAppOperation = {
  client: ChannelGatewayClient;
  gatewayEpoch: number;
  operationSeq: number;
};

type ChannelsLifecycle = {
  gatewayEpoch: number;
  whatsappOperationSeq: number;
};

const channelsLifecycles = new WeakMap<ChannelsState, ChannelsLifecycle>();

function getChannelsLifecycle(state: ChannelsState): ChannelsLifecycle {
  const existing = channelsLifecycles.get(state);
  if (existing) {
    return existing;
  }
  const created = { gatewayEpoch: 0, whatsappOperationSeq: 0 };
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
  return { client, gatewayEpoch: lifecycle.gatewayEpoch, operationSeq };
}

function isCurrentWhatsAppOperation(state: ChannelsState, operation: WhatsAppOperation): boolean {
  const lifecycle = getChannelsLifecycle(state);
  return (
    state.connected &&
    state.client === operation.client &&
    lifecycle.gatewayEpoch === operation.gatewayEpoch &&
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

async function logoutWhatsApp(state: ChannelsState): Promise<boolean> {
  const operation = beginWhatsAppOperation(state);
  if (!operation) {
    return false;
  }
  try {
    await operation.client.request("channels.logout", { channel: "whatsapp" });
    if (!isCurrentWhatsAppOperation(state, operation)) {
      return false;
    }
    state.whatsappLoginMessage = "Logged out.";
    state.whatsappLoginQrDataUrl = null;
    state.whatsappLoginConnected = null;
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
    state.client = snapshot.client;
    state.connected = snapshot.connected;
    if (clientChanged || connectionChanged) {
      // Every transport epoch invalidates both channel loads and login work.
      // A reconnect may reuse the same client object, so identity alone is insufficient.
      const lifecycle = getChannelsLifecycle(state);
      lifecycle.gatewayEpoch += 1;
      lifecycle.whatsappOperationSeq += 1;
      state.channelsLoading = false;
      state.channelsLoadingProbe = null;
      state.whatsappBusy = false;
      state.channelsRefreshSeq = (state.channelsRefreshSeq ?? 0) + 1;
    }
    publish();
  });

  return {
    get state() {
      return state;
    },
    refresh: (probe, options) => run(() => loadChannels(state, probe ?? false, options)),
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
    logoutWhatsApp: () =>
      run(async () => {
        if (await logoutWhatsApp(state)) {
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
      lifecycle.gatewayEpoch += 1;
      lifecycle.whatsappOperationSeq += 1;
      state.whatsappBusy = false;
      stopGateway();
      listeners.clear();
    },
  };
}
