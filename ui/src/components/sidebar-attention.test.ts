/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type {
  CronJob,
  CronJobsListResult,
  ModelAuthStatusResult,
  UpdateAvailable,
} from "../api/types.ts";
import type { ApplicationContext, ApplicationGateway } from "../app/context.ts";
import type { ExecApprovalRequest } from "../app/exec-approval.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { createStorageMock as createTestStorageMock } from "../test-helpers/storage.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import {
  addDismissal,
  dismissalStoreKey,
  pruneDismissals,
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
  updateComplete: Promise<boolean>;
  cronJobs: CronJob[];
  modelAuthStatus: ModelAuthStatusResult | null;
  loadedAtMs: number;
  onSummaryChange?: (summary: { count: number; severity: "error" | "warning" | null }) => void;
};

function approval(id: string): ExecApprovalRequest {
  return {
    id,
    kind: "exec",
    request: { command: "echo ok" },
    createdAtMs: 1,
    expiresAtMs: 2,
  };
}

function approvalItems(queue: readonly ExecApprovalRequest[]) {
  return buildSidebarAttentionItems({
    cronJobs: [],
    modelAuthStatus: null,
    approvalQueue: queue,
    updateAvailable: null,
    updateSchedule: null,
    updateStatusBanner: null,
    now: 0,
  }).filter((item) => item.kind === "pendingApproval");
}

function cronItems(cronJobs: readonly CronJob[], now = 0) {
  return buildSidebarAttentionItems({
    cronJobs,
    modelAuthStatus: null,
    approvalQueue: [],
    updateAvailable: null,
    updateSchedule: null,
    updateStatusBanner: null,
    now,
  });
}

function itemFacts(item: ReturnType<typeof cronItems>[number] | undefined): string | undefined {
  return item?.action.kind === "askCustodian" ? item.action.alert.facts.join("\n") : undefined;
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
    approvalQueue: [],
    updateAvailable: null,
    updateSchedule: null,
    updateStatusBanner: null,
    now: 0,
  }).filter((item) => item.kind === "modelAuthExpired");
}

describe("cron attention details", () => {
  it("lists each failed job with its preferred error", () => {
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

    const failed = cronItems([primary, reason, unknown]).find((item) => item.kind === "cronFailed");

    expect(itemFacts(failed)).toBe(
      "Nightly backup: disk full\nreason-id: timeout\nunknown-id: Unknown error",
    );
  });

  it("caps failure errors at 200 characters with an ellipsis", () => {
    const job = cronJob("long-error");
    job.state = { lastRunStatus: "error", lastError: "x".repeat(201) };

    const detail = itemFacts(cronItems([job]).find((item) => item.kind === "cronFailed"));
    const errorText = detail?.slice("long-error: ".length);

    expect(errorText).toHaveLength(200);
    expect(errorText).toBe(`${"x".repeat(199)}…`);
  });

  it("lists overdue job names", () => {
    const named = cronJob("named-id");
    named.name = "Nightly backup";
    named.state = { lastRunStatus: "ok", nextRunAtMs: 1 };
    const unnamed = cronJob("unnamed-id");
    unnamed.name = "";
    unnamed.state = { lastRunStatus: "ok", nextRunAtMs: 2 };

    const overdue = cronItems([named, unnamed], 300_003).find(
      (item) => item.kind === "cronOverdue",
    );

    expect(itemFacts(overdue)).toBe("Nightly backup: 5m late\nunnamed-id: 5m late");
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

    expect(itemFacts(overdue)).toBe("stalled-id: 5m late");
  });

  it("presents failed and overdue jobs to the custodian with raw facts", () => {
    const failedJob = cronJob("failed");
    failedJob.state = { lastRunStatus: "error", lastError: "disk full" };
    const overdueJob = cronJob("overdue");
    overdueJob.state = { lastRunStatus: "ok", nextRunAtMs: 1 };

    const items = cronItems([failedJob, overdueJob], 300_002);

    for (const kind of ["cronFailed", "cronOverdue"] as const) {
      const action = items.find((item) => item.kind === kind)?.action;
      expect(action).toMatchObject({ kind: "askCustodian" });
      if (action?.kind !== "askCustodian") {
        throw new Error(`expected ${kind} custodian action`);
      }
      expect(action.alert.facts.length).toBeGreaterThan(0);
      expect(action.alert.question).toContain(kind === "cronFailed" ? "failed" : "not run");
      expect(action.alert.question).toContain(action.alert.facts[0]);
      expect(action.alert.action?.target).toEqual({ kind: "navigate", routeId: "cron" });
    }
  });

  it("hard-caps the model question for a large incident set", () => {
    const jobs = Array.from({ length: 100 }, (_, index) => {
      const job = cronJob(`failed-${index}`);
      job.name = `Automation ${index} ${"n".repeat(40)}`;
      job.state = { lastRunStatus: "error", lastError: "e".repeat(200) };
      return job;
    });
    const action = cronItems(jobs).find((item) => item.kind === "cronFailed")?.action;
    if (action?.kind !== "askCustodian") {
      throw new Error("expected failed cron custodian action");
    }

    expect(action.alert.question).toHaveLength(1_000);
    expect(action.alert.question.endsWith("…")).toBe(true);
  });
});

describe("pending approval attention", () => {
  it("builds a warning chip only while approvals are pending", () => {
    expect(approvalItems([])).toEqual([]);

    expect(approvalItems([approval("exec:b")])).toMatchObject([
      {
        kind: "pendingApproval",
        severity: "warning",
        icon: "shieldQuestion",
        action: { kind: "openApprovals" },
      },
    ]);
  });

  it("sorts queue ids into a signature that changes for a new approval", () => {
    const first = approvalItems([approval("exec:b"), approval("exec:a")])[0];
    const changed = approvalItems([approval("exec:b"), approval("exec:a"), approval("exec:c")])[0];

    if (!first || !changed) {
      throw new Error("expected pending approval attention items");
    }

    expect(first.signature).toBe("exec:a\nexec:b");
    expect(changed.signature).toBe("exec:a\nexec:b\nexec:c");
    expect(pruneDismissals({ pendingApproval: first.signature }, [changed])).toEqual({});
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
      approvalQueue: [],
      updateAvailable: null,
      updateSchedule: null,
      updateStatusBanner: null,
      now: 0,
    });

    expect(items.some((item) => item.kind === "modelAuthExpired")).toBe(true);
  });

  it("presents expired providers to the custodian with raw status", () => {
    const action = authItems("main")[0]?.action;
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

describe("update attention", () => {
  const update: UpdateAvailable = {
    channel: "dev",
    currentVersion: "2026.8.1",
    latestVersion: "2026.8.1",
    upstreamSha: "a".repeat(40),
    commitsBehind: 2,
    commits: [{ sha: "abcdef123", subject: "Improve alerts" }],
  };
  const schedule = {
    channel: "dev",
    autoEnabled: false,
    target: {
      kind: "git" as const,
      upstreamRef: "origin/main",
      upstreamSha: "a".repeat(40),
      commitsBehind: 2,
    },
  };
  const build = (overrides: Record<string, unknown> = {}) =>
    buildSidebarAttentionItems({
      cronJobs: [],
      modelAuthStatus: null,
      approvalQueue: [],
      updateAvailable: update,
      updateSchedule: schedule,
      updateStatusBanner: null,
      now: 0,
      ...overrides,
    }).filter((item) => item.kind === "updateAvailable");

  it("appears only for an available update outside loud card states", () => {
    expect(build()).toMatchObject([
      {
        severity: "warning",
        icon: "download",
        label: "2 commits behind",
        action: { kind: "askCustodian" },
      },
    ]);
    expect(
      build({ updateAvailable: { ...update, commitsBehind: 0 }, updateSchedule: null }),
    ).toEqual([]);
    expect(build({ updateSchedule: { ...schedule, campaign: { id: "campaign" } } })).toEqual([]);
    expect(build({ updateStatusBanner: { tone: "danger", text: "failed" } })).toEqual([]);
  });

  it("changes its signature with upstream sha and carries commit facts", () => {
    const first = build()[0];
    const changed = build({
      updateAvailable: { ...update, upstreamSha: "b".repeat(40) },
      updateSchedule: {
        ...schedule,
        target: { ...schedule.target, upstreamSha: "b".repeat(40) },
      },
    })[0];
    expect(first?.signature).not.toBe(changed?.signature);
    if (first?.action.kind !== "askCustodian") {
      throw new Error("expected update custodian action");
    }
    expect(first.action.alert.facts).toEqual(["abcdef1 Improve alerts"]);
    expect(first.action.alert.question).toContain("abcdef1 Improve alerts");
    expect(first.action.alert.action?.target).toEqual({ kind: "update" });
  });

  it("falls back to installed and available package versions", () => {
    const item = build({
      updateAvailable: {
        channel: "stable",
        currentVersion: "1.0.0",
        latestVersion: "2.0.0",
      },
      updateSchedule: null,
    })[0];
    if (item?.action.kind !== "askCustodian") {
      throw new Error("expected package update custodian action");
    }
    expect(item.action.alert.facts).toEqual(["Installed v1.0.0 · Available v2.0.0"]);
    expect(item.action.alert.question).toContain("Installed v1.0.0 · Available v2.0.0");
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
      JSON.stringify({ cronFailed: "current" }),
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

  it("clears a stale failure alert when the gateway reports an automation change", async () => {
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
    await waitForFast(() => expect(element.textContent).toContain("1 automation(s) failed"));

    eventListener?.({ type: "event", event: "cron", payload: {} });
    await waitForFast(() => expect(element.textContent).not.toContain("automation(s) failed"));
  });

  it("renders icon-only accessible alerts and reports summary changes", async () => {
    const request = vi.fn((method: string) => {
      if (method === "cron.list") {
        return Promise.resolve(cronListResponse([]));
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const gateway = {
      snapshot: {
        client: { request } as unknown as GatewayBrowserClient,
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
      subscribeEvents: () => () => undefined,
    } as unknown as ApplicationGateway;
    const overlayListeners = new Set<() => void>();
    const overlaySnapshot: {
      approvalQueue: ExecApprovalRequest[];
      updateAvailable: UpdateAvailable | null;
      updateSchedule: null;
      updateStatusBanner: null;
    } = {
      approvalQueue: [],
      updateAvailable: {
        channel: "stable",
        currentVersion: "1.0.0",
        latestVersion: "2.0.0",
      },
      updateSchedule: null,
      updateStatusBanner: null,
    };
    const overlays = {
      snapshot: overlaySnapshot,
      subscribe: (listener: () => void) => {
        overlayListeners.add(listener);
        return () => overlayListeners.delete(listener);
      },
    } as unknown as ApplicationContext["overlays"];
    const provider = createApplicationContextProvider({
      gateway,
      overlays,
      agentSelection: {
        state: { selectedId: null },
        subscribe: () => () => undefined,
      },
    } as unknown as ApplicationContext);
    vi.stubGlobal("localStorage", createTestStorageMock());
    const summary = vi.fn();
    const element = document.createElement("openclaw-sidebar-attention") as SidebarAttentionElement;
    element.onSummaryChange = summary;
    provider.append(element);
    document.body.append(provider);

    await waitForFast(() =>
      expect(element.querySelector<HTMLButtonElement>(".sidebar-attention__open")).not.toBeNull(),
    );
    const button = element.querySelector<HTMLButtonElement>(".sidebar-attention__open");
    expect(button?.getAttribute("aria-label")).toBe("v2.0.0");
    expect(element.querySelector(".sidebar-attention__label")).toBeNull();
    expect(summary).toHaveBeenLastCalledWith({ count: 1, severity: "warning" });

    overlaySnapshot.updateAvailable = null;
    for (const listener of overlayListeners) {
      listener();
    }
    await waitForFast(() => expect(summary).toHaveBeenLastCalledWith({ count: 0, severity: null }));
  });
});

describe("pruneDismissals", () => {
  const chip = (kind: SidebarAttentionKind, signature: string) => ({ kind, signature });

  it("keeps a dismissal while the same entity set is still affected", () => {
    const dismissals = { cronFailed: "alpha\nbeta" };
    expect(pruneDismissals(dismissals, [chip("cronFailed", "alpha\nbeta")])).toBe(dismissals);
  });

  it("drops a dismissal when the affected set changes so the chip resurfaces", () => {
    expect(
      pruneDismissals({ cronFailed: "alpha", modelAuthExpired: "openai" }, [
        chip("cronFailed", "alpha\nbeta"),
        chip("modelAuthExpired", "openai"),
      ]),
    ).toEqual({ modelAuthExpired: "openai" });
  });

  it("drops a dismissal once the underlying state clears", () => {
    expect(pruneDismissals({ cronFailed: "alpha" }, [])).toEqual({});
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
    localStorage.setItem(key, JSON.stringify({ cronFailed: "alpha" }));

    const next = addDismissal("ws://gateway.test", "modelAuthExpired", "openai");

    const expected = { cronFailed: "alpha", modelAuthExpired: "openai" };
    expect(next).toEqual(expected);
    expect(JSON.parse(localStorage.getItem(key) ?? "null")).toEqual(expected);
  });
});
