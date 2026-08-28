import { initialState, Task, TaskStatus } from "@lit/task";
import type { ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  beginPanelRefresh,
  completePanelRefresh,
  createPanelRefreshStatus,
} from "../../components/panel-refresh-status.ts";
import {
  requestSessionUsageContextWeight,
  requestSessionUsageLogs,
  requestSessionUsageTimeSeries,
} from "../../lib/sessions/index.ts";
import type { SessionUsageQuery } from "../../lib/sessions/usage.ts";
import type { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { failUsageDetailRefresh } from "./detail-refresh.ts";
import type { SessionLogEntry, UsageSessionEntry } from "./types.ts";

function createUsageDetailRequest<T>(
  host: ReactiveControllerHost,
  gateway: GatewayPageController,
  request: (client: GatewayBrowserClient, key: string, signal: AbortSignal) => Promise<T>,
  canLoad?: (key: string) => boolean,
) {
  let value: { sessionKey: string; data: T } | null = null;
  let status = createPanelRefreshStatus();
  const task = new Task(host, {
    autoRun: false,
    args: (): readonly [GatewayBrowserClient | null, string] => [null, ""],
    task: async ([client, sessionKey], { signal }) =>
      client && sessionKey
        ? { sessionKey, data: await request(client, sessionKey, signal) }
        : initialState,
    onComplete: (result) => {
      value = result;
      status = completePanelRefresh();
    },
    onError: (error) => {
      const failure = failUsageDetailRefresh(status, error);
      if (failure.clearData) {
        value = null;
      }
      status = failure.status;
    },
  });

  const cancel = () => {
    // A null-client run fences late completions while retaining the last displayed detail.
    void task.run([null, ""]);
  };
  return {
    get data() {
      return value?.data ?? null;
    },
    get status() {
      return status;
    },
    get loading() {
      return task.status === TaskStatus.PENDING;
    },
    load(sessionKey: string): Promise<void> {
      const client = gateway.client;
      if (!client || !gateway.connected) {
        return Promise.resolve();
      }
      const enabled = canLoad?.(sessionKey) !== false;
      if (value?.sessionKey !== sessionKey || !enabled) {
        value = null;
        status = createPanelRefreshStatus();
      }
      if (!enabled) {
        cancel();
        return Promise.resolve();
      }
      status = beginPanelRefresh(status);
      return task.run([client, sessionKey]);
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
