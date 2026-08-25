/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { CronJob, CronJobsListResult, ModelAuthStatusResult } from "../api/types.ts";
import type { ApplicationContext, ApplicationGateway } from "../app/context.ts";
import type { ScopeUpgradeState } from "../app/device-scope-upgrade-availability.ts";
import {
  createApplicationContextProvider,
  hiddenScopeUpgradeCapability,
} from "../test-helpers/application-context.ts";
import { createStorageMock as createTestStorageMock } from "../test-helpers/storage.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import {
  dismissSidebarAttention,
  dismissalStoreKey,
  isSidebarAttentionDismissed,
  loadDismissals,
  reconcileSidebarAttentionDismissals,
  resolveUpdateAttentionDismissal,
} from "./sidebar-attention-dismissals.ts";
import {
  buildScopeUpgradeInboxEntry,
  buildSidebarInboxEntries,
  buildUpdateInboxEntry,
  sidebarInboxTabCounts,
  type SidebarAttentionKind,
} from "./sidebar-attention-entries.ts";
import { buildSidebarAttentionEntries } from "./sidebar-attention-items.ts";
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
  startUpdate(): void;
  modelAuthStatus: ModelAuthStatusResult | null;
  loadedAtMs: number;
};

function cronItems(cronJobs: readonly CronJob[], now = 0) {
  return buildSidebarAttentionEntries({
    cronJobs,
    modelAuthStatus: null,
    now,
  });
}

function authItems(agentId: string) {
  return buildSidebarAttentionEntries({
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
    const items = buildSidebarAttentionEntries({
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

    expect(items.some((entry) => entry.kind === "modelAuthExpired")).toBe(true);
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
      scopeUpgrade: hiddenScopeUpgradeCapability,
    } as unknown as ApplicationContext);
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
      scopeUpgrade: hiddenScopeUpgradeCapability,
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
      scopeUpgrade: hiddenScopeUpgradeCapability,
    } as unknown as ApplicationContext);
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

  it.each([
    { name: "stable admin update", canDismiss: true, forced: false, dismissible: true },
    { name: "read-only update", canDismiss: false, forced: false, dismissible: false },
    { name: "forced update", canDismiss: true, forced: true, dismissible: false },
  ])("projects $name with explicit dismissal policy", ({ canDismiss, forced, dismissible }) => {
    const dismissal = resolveUpdateAttentionDismissal({
      gatewayBootId: "boot-a",
      updateAvailable: {
        currentVersion: "2026.8.1",
        latestVersion: "2026.8.2",
        channel: "latest",
      },
    });

    const entry = buildUpdateInboxEntry({
      canDismiss,
      dismissal,
      forced,
      severity: "warning",
      visible: true,
    });

    expect(Boolean(entry?.dismissal)).toBe(dismissible);
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

describe("reconcileSidebarAttentionDismissals", () => {
  const chip = (kind: SidebarAttentionKind, signature: string) => ({
    kind,
    signature,
  });
  const gatewayUrl = "ws://gateway.test";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const reconcile = (
    dismissals: Record<string, string[]>,
    active: Array<{ kind: SidebarAttentionKind; signature: string }>,
  ) => {
    vi.stubGlobal("localStorage", createTestStorageMock());
    localStorage.setItem(dismissalStoreKey(gatewayUrl), JSON.stringify(dismissals));
    return reconcileSidebarAttentionDismissals({
      active,
      gatewayUrl,
    });
  };

  it("keeps a dismissal while the same entity set is still affected", () => {
    const dismissals = { cronFailed: ["alpha", "beta"] };
    expect(
      reconcile(dismissals, [chip("cronFailed", "alpha"), chip("cronFailed", "beta")]),
    ).toEqual(dismissals);
  });

  it("drops a dismissal when the affected set changes so the chip resurfaces", () => {
    expect(
      reconcile({ cronFailed: ["alpha"], modelAuthExpired: ["openai"] }, [
        chip("cronFailed", "beta"),
        chip("modelAuthExpired", "openai"),
      ]),
    ).toEqual({ modelAuthExpired: ["openai"] });
  });
});

describe("scope upgrade dismissal fact", () => {
  const cases: Array<{
    dismissible: boolean;
    state: ScopeUpgradeState;
  }> = [
    { state: { phase: "hidden" }, dismissible: false },
    { state: { phase: "guidance" }, dismissible: true },
    { state: { phase: "available" }, dismissible: true },
    { state: { phase: "requesting" }, dismissible: false },
    { state: { phase: "pending", requestId: "request-1" }, dismissible: false },
    {
      state: { phase: "rejected", requestId: "request-1", expired: false },
      dismissible: false,
    },
    { state: { phase: "error", message: "request failed" }, dismissible: false },
  ];

  it.each(cases)(
    "projects $state.phase with explicit dismissal policy",
    ({ state, dismissible }) => {
      const entry = buildScopeUpgradeInboxEntry({
        scopes: ["operator.write", "operator.read"],
        state,
      });

      expect(Boolean(entry?.dismissal)).toBe(dismissible);
    },
  );

  it("resurfaces when manual guidance becomes an actionable upgrade", () => {
    const scopes = ["operator.write", "operator.read"];
    const guidance = buildScopeUpgradeInboxEntry({ scopes, state: { phase: "guidance" } });
    const available = buildScopeUpgradeInboxEntry({ scopes, state: { phase: "available" } });

    expect(guidance?.dismissal).not.toEqual(available?.dismissal);
  });
});

describe("sidebar Inbox projection", () => {
  it("derives every tab count and dismiss control from one entry list", () => {
    const attention = buildSidebarAttentionEntries({
      cronJobs: [cronJob("failed-job")],
      modelAuthStatus: null,
      now: 0,
    });
    const scopeUpgrade = buildScopeUpgradeInboxEntry({
      scopes: ["operator.read"],
      state: { phase: "available" },
    });
    const update = buildUpdateInboxEntry({
      canDismiss: true,
      dismissal: { kind: "updateAvailable", signature: '["2026.8.3","boot-a"]' },
      forced: true,
      severity: "warning",
      visible: true,
    });
    const entries = buildSidebarInboxEntries({
      approvals: [
        {
          id: "approval-1",
          kind: "exec",
          request: { command: "pwd" },
          createdAtMs: 1,
          expiresAtMs: 60_000,
        },
      ],
      attention,
      scopeUpgrade,
      update,
    });

    expect(sidebarInboxTabCounts(entries)).toEqual({
      all: 4,
      approvals: 1,
      automations: 1,
      system: 2,
    });
    expect(entries.filter((entry) => entry.dismissal).map((entry) => entry.type)).toEqual([
      "scopeUpgrade",
      "attention",
    ]);
  });
});

describe("dismissSidebarAttention", () => {
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

    const next = dismissSidebarAttention("ws://gateway.test", {
      kind: "cronFailed",
      signature: "beta",
    });

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
    expect(dismissal).toEqual({
      kind: "updateAvailable",
      signature: '["2026.8.3","boot-a"]',
    });
    const stored = dismissSidebarAttention("ws://gateway.test", dismissal!);
    expect(isSidebarAttentionDismissed(stored, dismissal!)).toBe(true);
    expect(
      JSON.parse(localStorage.getItem(dismissalStoreKey("ws://gateway.test")) ?? "null"),
    ).toEqual({ updateAvailable: ['["2026.8.3","boot-a"]'] });
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
    ).toEqual({
      kind: "updateAvailable",
      signature: '["abcdef1234567890","boot-a"]',
    });
  });
});
