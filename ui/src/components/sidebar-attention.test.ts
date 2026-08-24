/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type {
  CronJob,
  CronJobsListResult,
  ModelAuthStatusResult,
  UpdateScheduleState,
} from "../api/types.ts";
import type { ApplicationContext, ApplicationGateway } from "../app/context.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { createStorageMock as createTestStorageMock } from "../test-helpers/storage.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import {
  addDismissal,
  dismissUpdateAttention,
  dismissalStoreKey,
  isUpdateAttentionDismissed,
  loadDismissals,
  pruneDismissals,
  resolveUpdateAttentionDismissal,
  type SidebarAttentionKind,
} from "./sidebar-attention-dismissals.ts";
import { buildSidebarAttentionItems } from "./sidebar-attention-items.ts";
import "./sidebar-attention.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function cronJob(id: string): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "test" },
    state: { lastRunStatus: "error" },
  };
}

function cronListResponse(jobs: CronJob[]): CronJobsListResult {
  return {
    jobs,
    snapshotRevision: "sidebar-attention-cron-fixture",
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  };
}

type SidebarAttentionElement = HTMLElement & {
  context: ApplicationContext;
  updateComplete: Promise<boolean>;
  cronJobs: CronJob[];
  hasUpdateSurface(): boolean;
  updateSurfaceVisible(): boolean;
  dismissUpdateSurface(): void;
  startUpdate(): void;
  modelAuthStatus: ModelAuthStatusResult | null;
  loadedAtMs: number;
};

function cronItems(cronJobs: readonly CronJob[], now = 0) {
  return buildSidebarAttentionItems({
    cronJobs,
    modelAuthStatus: null,
    now,
  });
}

function authItems(agentId: string) {
  return buildSidebarAttentionItems({
    cronJobs: [],
    modelAuthStatus: {
      ts: 1,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          status: "missing",
          profiles: [],
        },
      ],
    },
    modelAuthAgentId: agentId,
    now: 0,
  }).filter((item) => item.kind === "modelAuthExpired");
}

describe("automation attention", () => {
  it("lists each failed job as direct automation navigation", () => {
    const primary = cronJob("primary");
    primary.name = "Nightly backup";
    primary.state = { lastRunStatus: "error", lastError: "  disk full  " };
    const reason = cronJob("reason-id");
    reason.name = "";
    reason.state = {
      lastRunStatus: "error",
      lastError: "   ",
      lastErrorReason: "timeout",
    };
    const unknown = cronJob("unknown-id");

    const failed = cronItems([primary, reason, unknown]).filter(
      (item) => item.kind === "cronFailed",
    );

    expect(failed.map((item) => item.label)).toEqual(["Nightly backup", "reason-id", "unknown-id"]);
    expect(failed.every((item) => item.action.kind === "navigate")).toBe(true);
    expect(
      failed.every((item) => item.action.kind !== "navigate" || item.action.routeId === "cron"),
    ).toBe(true);
  });

  it("does not flag an actively running job as overdue", () => {
    // The gateway leaves nextRunAtMs past-due during execution; runningAtMs is
    // the recorded fact that a run is in flight (agentTurn runs may take up to
    // an hour, far beyond the 5-minute overdue grace).
    const running = cronJob("running-id");
    running.state = { lastRunStatus: "ok", nextRunAtMs: 1, runningAtMs: 2 };
    const stalled = cronJob("stalled-id");
    stalled.state = { lastRunStatus: "ok", nextRunAtMs: 2 };

    const overdue = cronItems([running, stalled], 300_003).find(
      (item) => item.kind === "cronOverdue",
    );

    expect(overdue?.label).toBe("stalled-id");
  });

  it("orders failed before overdue and newest first within each group", () => {
    const failedJob = cronJob("failed");
    failedJob.state = { lastRunStatus: "error", lastRunAtMs: 200 };
    const olderFailedJob = cronJob("older-failed");
    olderFailedJob.state = { lastRunStatus: "error", lastRunAtMs: 100 };
    const overdueJob = cronJob("overdue");
    overdueJob.state = { lastRunStatus: "ok", nextRunAtMs: 2 };
    const olderOverdueJob = cronJob("older-overdue");
    olderOverdueJob.state = { lastRunStatus: "ok", nextRunAtMs: 1 };

    const items = cronItems(
      [olderOverdueJob, olderFailedJob, overdueJob, failedJob],
      300_003,
    ).filter((item) => item.kind === "cronFailed" || item.kind === "cronOverdue");

    expect(items.map((item) => item.label)).toEqual([
      "failed",
      "older-failed",
      "overdue",
      "older-overdue",
    ]);
  });
});

describe("model auth attention", () => {
  it("keeps identical provider warnings distinct across agents", () => {
    expect(authItems("main")[0]?.signature).toBe("agent:main\nopenai");
    expect(authItems("writer")[0]?.signature).toBe("agent:writer\nopenai");
  });

  it("keeps a missing canonical route visible beside CLI OAuth", () => {
    const items = buildSidebarAttentionItems({
      cronJobs: [],
      modelAuthStatus: {
        ts: 1,
        providers: [
          {
            provider: "anthropic",
            displayName: "Claude",
            status: "missing",
            profiles: [],
          },
          {
            provider: "claude-cli",
            displayName: "Claude",
            status: "expiring",
            profiles: [{ profileId: "anthropic:claude-cli", type: "oauth", status: "expiring" }],
          },
        ],
      },
      modelAuthAgentId: "main",
      now: 0,
    });

    expect(items.some((item) => item.kind === "modelAuthExpired")).toBe(true);
  });

  it("presents expired providers to the custodian with raw status", () => {
    const item = authItems("main")[0];
    expect(item).toMatchObject({
      label: "OpenAI",
      inlineAction: { label: "Reconnect", routeId: "model-providers" },
    });
    const action = item?.action;
    expect(action).toMatchObject({ kind: "askCustodian" });
    if (action?.kind !== "askCustodian") {
      throw new Error("expected model auth custodian action");
    }
    expect(action.alert.facts).toEqual(["OpenAI: missing"]);
    expect(action.alert.question).toContain("OpenAI: missing");
    expect(action.alert.action?.target).toEqual({
      kind: "navigate",
      routeId: "model-providers",
    });
  });
});

describe("sidebar attention refresh ownership", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps the latest refresh when an older load on the same client finishes last", async () => {
    const firstCron = deferred<unknown>();
    const firstAuth = deferred<unknown>();
    const secondCron = deferred<unknown>();
    const secondAuth = deferred<unknown>();
    const responses = {
      "cron.list": [firstCron, secondCron, deferred<unknown>()],
      "models.authStatus": [firstAuth, secondAuth],
    };
    const request = vi.fn((method: keyof typeof responses, _params?: unknown) => {
      const response = responses[method].shift();
      if (!response) {
        throw new Error(`Unexpected request: ${method}`);
      }
      return response.promise;
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const snapshot = {
      client,
      phase: "connected",
      hello: null,
      assistantAgentId: "main",
      sessionKey: "agent:main:main",
      lastError: null,
      lastErrorCode: null,
    };
    const gateway = {
      snapshot,
      connection: {
        gatewayUrl: "ws://gateway.test",
        token: "",
        bootstrapToken: "",
        password: "",
      },
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    } as unknown as ApplicationGateway;
    const overlays = {
      snapshot: { approvalQueue: [] },
      subscribe: () => () => undefined,
    } as unknown as ApplicationContext["overlays"];
    const selectionState = { selectedId: "main" as string | null };
    const selectionListeners = new Set<() => void>();
    const agentSelection = {
      state: selectionState,
      subscribe: (listener: () => void) => {
        selectionListeners.add(listener);
        return () => selectionListeners.delete(listener);
      },
    } as unknown as ApplicationContext["agentSelection"];
    const storage = createTestStorageMock();
    vi.stubGlobal("localStorage", storage);
    localStorage.setItem(
      dismissalStoreKey(gateway.connection.gatewayUrl),
      JSON.stringify({ cronFailed: ["current"] }),
    );
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let now = 120_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const provider = createApplicationContextProvider({
      gateway,
      overlays,
      agentSelection,
    } as ApplicationContext);
    const element = document.createElement("openclaw-sidebar-attention") as SidebarAttentionElement;
    provider.append(element);
    document.body.append(provider);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls.find(([method]) => method === "models.authStatus")?.[1]).toEqual({
      agentId: "main",
    });

    selectionState.selectedId = "writer";
    for (const listener of selectionListeners) {
      listener();
    }
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(4));
    expect(request.mock.calls.filter(([method]) => method === "models.authStatus")[1]?.[1]).toEqual(
      { agentId: "writer" },
    );

    const currentAuth = { ts: 2, providers: [] } as ModelAuthStatusResult;
    now = 200_000;
    secondCron.resolve(cronListResponse([cronJob("current")]));
    secondAuth.resolve(currentAuth);
    await waitForFast(() => expect(element.loadedAtMs).toBe(200_000));
    expect(element.cronJobs.map((job) => job.id)).toEqual(["current"]);
    expect(element.modelAuthStatus).toBe(currentAuth);
    expect(localStorage.getItem(dismissalStoreKey(gateway.connection.gatewayUrl))).not.toBeNull();

    now = 300_000;
    firstCron.resolve(cronListResponse([cronJob("stale")]));
    firstAuth.resolve({ ts: 1, providers: [] });
    await Promise.all([firstCron.promise, firstAuth.promise]);
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });
    await element.updateComplete;

    expect(element.cronJobs.map((job) => job.id)).toEqual(["current"]);
    expect(element.modelAuthStatus).toBe(currentAuth);
    expect(element.loadedAtMs).toBe(200_000);
    expect(localStorage.getItem(dismissalStoreKey(gateway.connection.gatewayUrl))).not.toBeNull();

    selectionState.selectedId = null;
    for (const listener of selectionListeners) {
      listener();
    }
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(5));
    expect(request.mock.calls.filter(([method]) => method === "models.authStatus")).toHaveLength(2);
    expect(element.modelAuthStatus).toBeNull();
  });

  it("finishes an agent auth refresh when a cron event arrives mid-switch", async () => {
    const switchedCron = deferred<unknown>();
    const switchedAuth = deferred<unknown>();
    const writerAuth = { ts: 2, providers: [] } as ModelAuthStatusResult;
    const responses = {
      "cron.list": [
        Promise.resolve(cronListResponse([])),
        switchedCron.promise,
        Promise.resolve(cronListResponse([])),
      ],
      "models.authStatus": [
        Promise.resolve({ ts: 1, providers: [] }),
        switchedAuth.promise,
        Promise.resolve(writerAuth),
      ],
    };
    const request = vi.fn((method: keyof typeof responses) => {
      const response = responses[method].shift();
      if (!response) {
        throw new Error(`Unexpected request: ${method}`);
      }
      return response;
    });
    const client = { request } as unknown as GatewayBrowserClient;
    let eventListener: Parameters<ApplicationGateway["subscribeEvents"]>[0] | undefined;
    const gateway = {
      snapshot: {
        client,
        phase: "connected",
        hello: null,
        assistantAgentId: "main",
        sessionKey: "agent:main:main",
        lastError: null,
        lastErrorCode: null,
      },
      connection: {
        gatewayUrl: "ws://gateway.test",
        token: "",
        bootstrapToken: "",
        password: "",
      },
      subscribe: () => () => undefined,
      subscribeEvents: (listener: NonNullable<typeof eventListener>) => {
        eventListener = listener;
        return () => undefined;
      },
    } as unknown as ApplicationGateway;
    const selectionState = { selectedId: "main" as string | null };
    const selectionListeners = new Set<() => void>();
    const provider = createApplicationContextProvider({
      gateway,
      overlays: {
        snapshot: { approvalQueue: [] },
        subscribe: () => () => undefined,
      },
      agentSelection: {
        state: selectionState,
        subscribe: (listener: () => void) => {
          selectionListeners.add(listener);
          return () => selectionListeners.delete(listener);
        },
      },
    } as unknown as ApplicationContext);
    vi.stubGlobal("localStorage", createTestStorageMock());
    const element = document.createElement("openclaw-sidebar-attention") as SidebarAttentionElement;
    provider.append(element);
    document.body.append(provider);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));

    selectionState.selectedId = "writer";
    for (const listener of selectionListeners) {
      listener();
    }
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(4));
    eventListener?.({ type: "event", event: "cron", payload: {} });

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(6));
    await waitForFast(() => expect(element.modelAuthStatus).toBe(writerAuth));
    switchedCron.resolve(cronListResponse([]));
    switchedAuth.resolve({ ts: 3, providers: [] });
  });

  it("opens top-mounted attention downward and clears stale live automation alerts", async () => {
    const responses = {
      "cron.list": [cronListResponse([cronJob("failed")]), cronListResponse([])],
      "models.authStatus": [{ ts: 1, providers: [] }],
    };
    const request = vi.fn((method: keyof typeof responses) => {
      const response = responses[method].shift();
      if (!response) {
        throw new Error(`Unexpected request: ${method}`);
      }
      return Promise.resolve(response);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const snapshot = {
      client,
      phase: "connected",
      hello: null,
      assistantAgentId: "main",
      sessionKey: "agent:main:main",
      lastError: null,
      lastErrorCode: null,
    };
    let eventListener: Parameters<ApplicationGateway["subscribeEvents"]>[0] | undefined;
    const gateway = {
      snapshot,
      connection: {
        gatewayUrl: "ws://gateway.test",
        token: "",
        bootstrapToken: "",
        password: "",
      },
      subscribe: () => () => undefined,
      subscribeEvents: (listener: NonNullable<typeof eventListener>) => {
        eventListener = listener;
        return () => undefined;
      },
    } as unknown as ApplicationGateway;
    const overlays = {
      snapshot: { approvalQueue: [] },
      subscribe: () => () => undefined,
    } as unknown as ApplicationContext["overlays"];
    const agentSelection = {
      state: { selectedId: "main" },
      subscribe: () => () => undefined,
    } as unknown as ApplicationContext["agentSelection"];
    vi.stubGlobal("localStorage", createTestStorageMock());

    const provider = createApplicationContextProvider({
      gateway,
      overlays,
      agentSelection,
    } as ApplicationContext);
    const element = document.createElement("openclaw-sidebar-attention") as SidebarAttentionElement;
    provider.append(element);
    document.body.append(provider);
    await waitForFast(() =>
      expect(element.querySelector<HTMLButtonElement>(".sidebar-issues-button")).not.toBeNull(),
    );
    const trigger = element.querySelector<HTMLButtonElement>(".sidebar-issues-button")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 20,
      y: 10,
      left: 20,
      top: 10,
      right: 52,
      bottom: 42,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });
    trigger.click();
    await waitForFast(() =>
      expect(element.querySelector('[data-attention-kind="cronFailed"]')).not.toBeNull(),
    );
    const panel = element.querySelector<HTMLElement>(".sidebar-issues-panel")!;
    expect(panel.style.top).toBe("50px");
    expect(panel.style.bottom).toBe("");
    expect(panel.style.getPropertyValue("--sidebar-issues-panel-top")).toBe("50px");

    eventListener?.({ type: "event", event: "cron", payload: {} });
    await waitForFast(() =>
      expect(element.querySelector('[data-attention-kind="cronFailed"]')).toBeNull(),
    );
  });
});

describe("update attention", () => {
  it("hides an unhydrated campaign only while update status can be polled", () => {
    const overlaySnapshot = {
      updateAvailable: {
        currentVersion: "2026.8.1",
        latestVersion: "2026.8.1",
        channel: "dev",
        commitsBehind: 2,
      },
      updateSchedule: {
        channel: "dev",
        autoEnabled: true,
        campaign: {
          id: "campaign-1",
          state: "waiting-for-idle",
          announcedAtMs: 1_000,
          forceAtMs: 901_000,
          updatedAtMs: 1_000,
        },
      },
      updateCampaignStatusHydrated: false,
      updateRunning: false,
      updateStatusBanner: null,
    };
    const gatewaySnapshot = {
      client: {} as GatewayBrowserClient,
      phase: "connected" as const,
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["update.status"] },
      },
    };
    const element = document.createElement("openclaw-sidebar-attention") as SidebarAttentionElement;
    element.context = {
      gateway: { snapshot: gatewaySnapshot },
      overlays: { snapshot: overlaySnapshot },
    } as unknown as ApplicationContext;

    expect(element.hasUpdateSurface()).toBe(false);

    gatewaySnapshot.hello.auth.scopes = ["operator.read"];
    expect(element.hasUpdateSurface()).toBe(true);

    gatewaySnapshot.hello.auth.scopes = ["operator.admin"];
    overlaySnapshot.updateCampaignStatusHydrated = true;
    expect(element.hasUpdateSurface()).toBe(true);
  });

  it("keeps restart reconciliation visible after update metadata clears", () => {
    const element = document.createElement("openclaw-sidebar-attention") as SidebarAttentionElement;
    element.context = {
      gateway: { snapshot: { phase: "connected" } },
      overlays: {
        snapshot: {
          updateAvailable: null,
          updateSchedule: null,
          updateRunning: false,
          updateReconciliationPending: true,
          updateStatusBanner: null,
        },
      },
    } as unknown as ApplicationContext;

    expect(element.hasUpdateSurface()).toBe(true);
  });

  it("dismisses one target for one Gateway boot and resurfaces on either change", () => {
    vi.stubGlobal("localStorage", createTestStorageMock());
    const overlaySnapshot = {
      updateAvailable: {
        currentVersion: "2026.8.1",
        latestVersion: "2026.8.2",
        channel: "latest",
      },
      updateSchedule: {
        channel: "stable",
        autoEnabled: false,
        target: { kind: "package" as const, version: "2026.8.2" },
      },
      updateCampaignStatusHydrated: true,
      updateReconciliationPending: false,
      updateRunning: false,
      updateStatusBanner: null,
    };
    const gatewaySnapshot = {
      client: {} as GatewayBrowserClient,
      phase: "connected" as const,
      hello: {
        server: { bootId: "boot-a" },
        auth: { role: "operator", scopes: ["operator.admin", "operator.read"] },
        features: { methods: ["update.run"] },
      },
    };
    const element = document.createElement("openclaw-sidebar-attention") as SidebarAttentionElement;
    element.context = {
      gateway: {
        connection: { gatewayUrl: "ws://gateway.test" },
        snapshot: gatewaySnapshot,
      },
      overlays: { snapshot: overlaySnapshot },
    } as unknown as ApplicationContext;
    (element as unknown as { dismissedScope: string }).dismissedScope = "ws://gateway.test";

    expect(element.updateSurfaceVisible()).toBe(true);
    element.dismissUpdateSurface();
    expect(element.updateSurfaceVisible()).toBe(false);
    expect(loadDismissals("ws://gateway.test").updateAvailable).toEqual({
      version: "2026.8.2",
      gatewayBootId: "boot-a",
    });

    overlaySnapshot.updateSchedule.target.version = "2026.8.3";
    expect(element.updateSurfaceVisible()).toBe(true);
    overlaySnapshot.updateSchedule.target.version = "2026.8.2";
    gatewaySnapshot.hello.server.bootId = "boot-b";
    expect(element.updateSurfaceVisible()).toBe(true);
  });

  it("forces a dismissed update back for warning and failure outcomes", () => {
    vi.stubGlobal("localStorage", createTestStorageMock());
    const element = document.createElement("openclaw-sidebar-attention") as SidebarAttentionElement;
    const overlaySnapshot = {
      updateAvailable: {
        currentVersion: "2026.8.1",
        latestVersion: "2026.8.2",
        channel: "latest",
      },
      updateSchedule: null as UpdateScheduleState | null,
      updateCampaignStatusHydrated: true,
      updateReconciliationPending: false,
      updateRunning: false,
      updateStatusBanner: null as null | { tone: "warn" | "danger"; text: string },
    };
    element.context = {
      gateway: {
        connection: { gatewayUrl: "ws://gateway.test" },
        snapshot: {
          client: {} as GatewayBrowserClient,
          phase: "connected",
          hello: {
            server: { bootId: "boot-a" },
            auth: { role: "operator", scopes: ["operator.admin", "operator.read"] },
            features: { methods: ["update.run"] },
          },
        },
      },
      overlays: { snapshot: overlaySnapshot },
    } as unknown as ApplicationContext;
    (element as unknown as { dismissedScope: string }).dismissedScope = "ws://gateway.test";
    element.dismissUpdateSurface();
    expect(element.updateSurfaceVisible()).toBe(false);

    overlaySnapshot.updateStatusBanner = { tone: "warn", text: "Update blocked" };
    expect(element.updateSurfaceVisible()).toBe(true);
    overlaySnapshot.updateStatusBanner = { tone: "danger", text: "Update failed" };
    expect(element.updateSurfaceVisible()).toBe(true);

    overlaySnapshot.updateStatusBanner = null;
    overlaySnapshot.updateRunning = true;
    expect(element.updateSurfaceVisible()).toBe(true);
    overlaySnapshot.updateRunning = false;
    overlaySnapshot.updateReconciliationPending = true;
    expect(element.updateSurfaceVisible()).toBe(true);
    overlaySnapshot.updateReconciliationPending = false;
    overlaySnapshot.updateSchedule = {
      channel: "stable",
      autoEnabled: true,
      target: { kind: "package", version: "2026.8.2" },
      campaign: {
        id: "campaign-applying",
        state: "applying",
        announcedAtMs: 1,
        forceAtMs: 2,
        updatedAtMs: 2,
      },
    };
    expect(element.updateSurfaceVisible()).toBe(true);
  });

  it("does not start an update when a failure has no actionable target", () => {
    const runUpdate = vi.fn();
    const element = document.createElement("openclaw-sidebar-attention") as SidebarAttentionElement;
    element.context = {
      gateway: {
        snapshot: {
          phase: "connected",
          hello: {
            auth: { role: "operator", scopes: ["operator.admin"] },
            features: { methods: ["update.run"] },
          },
        },
      },
      overlays: {
        runUpdate,
        snapshot: {
          updateAvailable: null,
          updateSchedule: null,
          updateRunning: false,
          updateStatusBanner: { tone: "danger", text: "Update failed" },
        },
      },
    } as unknown as ApplicationContext;

    element.startUpdate();

    expect(runUpdate).not.toHaveBeenCalled();
  });
});

describe("pruneDismissals", () => {
  const chip = (kind: SidebarAttentionKind, signature: string) => ({
    kind,
    signature,
  });

  it("keeps a dismissal while the same entity set is still affected", () => {
    const dismissals = { cronFailed: ["alpha", "beta"] };
    expect(
      pruneDismissals(dismissals, [chip("cronFailed", "alpha"), chip("cronFailed", "beta")]),
    ).toBe(dismissals);
  });

  it("drops a dismissal when the affected set changes so the chip resurfaces", () => {
    expect(
      pruneDismissals({ cronFailed: ["alpha"], modelAuthExpired: ["openai"] }, [
        chip("cronFailed", "beta"),
        chip("modelAuthExpired", "openai"),
      ]),
    ).toEqual({ modelAuthExpired: ["openai"] });
  });
});

describe("addDismissal", () => {
  function createStorageMock(): Storage {
    const map = new Map<string, string>();
    return {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (key: string) => map.get(key) ?? null,
      key: (index: number) => [...map.keys()][index] ?? null,
      removeItem: (key: string) => void map.delete(key),
      setItem: (key: string, value: string) => void map.set(key, value),
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("merges with the persisted map so another tab's dismissal survives", () => {
    vi.stubGlobal("localStorage", createStorageMock());
    const key = dismissalStoreKey("ws://gateway.test");
    // Another tab dismissed a cron chip after this tab last loaded.
    localStorage.setItem(key, JSON.stringify({ cronFailed: ["alpha"] }));

    const next = addDismissal("ws://gateway.test", "cronFailed", "beta");

    const expected = { cronFailed: ["alpha", "beta"] };
    expect(next).toEqual(expected);
    expect(JSON.parse(localStorage.getItem(key) ?? "null")).toEqual(expected);
  });

  it("preserves released single-signature dismissals during upgrade", () => {
    vi.stubGlobal("localStorage", createStorageMock());
    const gatewayUrl = "ws://gateway.test";
    localStorage.setItem(
      dismissalStoreKey(gatewayUrl),
      JSON.stringify({ cronFailed: "legacy-signature" }),
    );

    expect(loadDismissals(gatewayUrl)).toEqual({ cronFailed: ["legacy-signature"] });
  });
});

describe("update dismissal fact", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the canonical package target and persists the literal boot binding", () => {
    vi.stubGlobal("localStorage", createTestStorageMock());
    const dismissal = resolveUpdateAttentionDismissal({
      gatewayBootId: "boot-a",
      updateAvailable: {
        currentVersion: "2026.8.1",
        latestVersion: "2026.8.2",
        channel: "latest",
      },
      updateSchedule: {
        channel: "stable",
        autoEnabled: false,
        target: { kind: "package", version: "2026.8.3" },
      },
    });
    expect(dismissal).toEqual({ version: "2026.8.3", gatewayBootId: "boot-a" });
    const stored = dismissUpdateAttention("ws://gateway.test", dismissal!);
    expect(isUpdateAttentionDismissed(stored, dismissal)).toBe(true);
    expect(
      JSON.parse(localStorage.getItem(dismissalStoreKey("ws://gateway.test")) ?? "null"),
    ).toEqual({ updateAvailable: { version: "2026.8.3", gatewayBootId: "boot-a" } });
  });

  it("uses the git target SHA instead of an unchanged package version", () => {
    expect(
      resolveUpdateAttentionDismissal({
        gatewayBootId: "boot-a",
        updateAvailable: {
          currentVersion: "2026.8.1",
          latestVersion: "2026.8.1",
          channel: "dev",
        },
        updateSchedule: {
          channel: "dev",
          autoEnabled: true,
          target: {
            kind: "git",
            upstreamRef: "origin/main",
            upstreamSha: "abcdef1234567890",
            commitsBehind: 2,
          },
        },
      }),
    ).toEqual({ version: "abcdef1234567890", gatewayBootId: "boot-a" });
  });
});
