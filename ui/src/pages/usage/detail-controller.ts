import type { ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  beginPanelRefresh,
  completePanelRefresh,
  createPanelRefreshStatus,
  failPanelRefresh,
} from "../../components/panel-refresh-status.ts";
import { isGatewayAvailable } from "../../lib/gateway-availability.ts";
import {
  requestSessionUsageContextWeight,
  requestSessionUsageLogs,
  requestSessionUsageTimeSeries,
  type SessionUsageQuery,
} from "../../lib/sessions/usage.ts";
import type { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { failUsageDetailRefresh } from "./detail-refresh.ts";
import { createUsageRequest } from "./request.ts";
import type { SessionLogEntry, UsageSessionEntry } from "./types.ts";

function createUsageDetailRequest<T>(
  host: ReactiveControllerHost,
  gateway: GatewayPageController,
  request: (client: GatewayBrowserClient, key: string, signal: AbortSignal) => Promise<T>,
  canLoad?: (key: string) => boolean,
) {
  let value: { sessionKey: string; data: T } | null = null;
  let status = createPanelRefreshStatus();
  let pending: Promise<void> | null = null;
  let generation = 0;
  const task = createUsageRequest(host, {
    task: async ([client, sessionKey]: readonly [GatewayBrowserClient, string], { signal }) => ({
      sessionKey,
      data: await request(client, sessionKey, signal),
    }),
    onComplete: (result) => {
      pending = null;
      value = result;
      status = completePanelRefresh();
    },
    onError: (error) => {
      pending = null;
      const failure = failUsageDetailRefresh(status, error, gateway.snapshot);
      if (failure.clearData) {
        value = null;
      }
      status = failure.status;
    },
  });

  const cancel = () => {
    if (pending && gateway.snapshot && !isGatewayAvailable(gateway.snapshot)) {
      status = failPanelRefresh(status, undefined, gateway.snapshot);
    }
    pending = null;
    generation += 1;
    task.cancel();
  };
  return {
    get data() {
      return value?.data ?? null;
    },
    get status() {
      return status;
    },
    get loading() {
      return pending !== null;
    },
    async recover(sessionKey: string, loadInitial = false): Promise<void> {
      const current = generation;
      await pending;
      if (
        current === generation &&
        gateway.snapshot &&
        isGatewayAvailable(gateway.snapshot) &&
        (status.awaitingGateway || status.error !== null || (loadInitial && !status.hasLoaded))
      ) {
        void this.load(sessionKey);
      }
    },
    load(sessionKey: string): Promise<void> {
      const client = gateway.client;
      if (!client || !gateway.connected) {
        return Promise.resolve();
      }
      const enabled = Boolean(sessionKey) && canLoad?.(sessionKey) !== false;
      if (value?.sessionKey !== sessionKey || !enabled) {
        value = null;
        status = createPanelRefreshStatus();
      }
      if (!enabled) {
        cancel();
        return Promise.resolve();
      }
      status = beginPanelRefresh(status);
      generation += 1;
      return (pending = task.run([client, sessionKey]));
    },
    cancel,
    clear() {
      value = null;
      status = createPanelRefreshStatus();
      cancel();
    },
  };
}

export class UsageDetailsController {
  readonly timeSeries;
  readonly sessionLogs;
  readonly contextWeight;

  constructor(
    host: ReactiveControllerHost,
    gateway: GatewayPageController,
    query: () => SessionUsageQuery,
    sessions: () => UsageSessionEntry[],
  ) {
    this.timeSeries = createUsageDetailRequest(host, gateway, requestSessionUsageTimeSeries);
    this.sessionLogs = createUsageDetailRequest(host, gateway, async (client, key) => {
      const payload = await requestSessionUsageLogs(client, key);
      // SAFETY: sessions.usage.logs returns entries normalized by the Gateway's loadSessionLogs.
      return Array.isArray(payload.logs) ? (payload.logs as SessionLogEntry[]) : null;
    });
    this.contextWeight = createUsageDetailRequest(
      host,
      gateway,
      (client, key, signal) => {
        const params = query();
        const agentId =
          sessions().find((session) => session.key === key)?.agentId ?? params.agentId;
        return requestSessionUsageContextWeight(client, { ...params, agentId }, key, signal);
      },
      (key) => sessions().some((session) => session.key === key && session.hasContextWeight),
    );
  }

  load(sessionKey: string): void {
    void this.timeSeries.load(sessionKey);
    void this.sessionLogs.load(sessionKey);
    void this.contextWeight.load(sessionKey);
  }

  cancel(): void {
    this.timeSeries.cancel();
    this.sessionLogs.cancel();
    this.contextWeight.cancel();
  }

  clear(): void {
    this.timeSeries.clear();
    this.sessionLogs.clear();
    this.contextWeight.clear();
  }
}
