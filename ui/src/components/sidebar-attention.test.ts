/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { CronJob, CronJobsListResult, ModelAuthStatusResult } from "../api/types.ts";
import type { ApplicationContext, ApplicationGateway } from "../app/context.ts";
import type { ExecApprovalRequest } from "../app/exec-approval.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import "./sidebar-attention.ts";
import { buildSidebarIssuesSnapshot } from "./sidebar-attention-items.ts";
import type { SidebarIssuesChangeDetail } from "./sidebar-attention.ts";

const SIDEBAR_ISSUES_CHANGE_EVENT = "sidebar-issues-change";

const NOW = 1_000_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function cronJob(
  id: string,
  state: CronJob["state"] = { lastRunStatus: "ok", nextRunAtMs: NOW + 60_000 },
): CronJob {
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
    state,
  };
}

function cronListResponse(
  jobs: CronJob[],
  options: {
    total?: number;
    offset?: number;
    hasMore?: boolean;
    nextOffset?: number | null;
    snapshotRevision?: string;
  } = {},
): CronJobsListResult {
  return {
    jobs,
    snapshotRevision: options.snapshotRevision ?? "sidebar-issues-fixture",
    total: options.total ?? (options.hasMore ? jobs.length + 1 : jobs.length),
    offset: options.offset ?? 0,
    limit: 50,
    hasMore: options.hasMore ?? false,
    nextOffset: options.nextOffset ?? null,
  };
}

function authStatus(providers: ModelAuthStatusResult["providers"] = []): ModelAuthStatusResult {
  return { ts: NOW, providers };
}

function approval(id: string): ExecApprovalRequest {
  return {
    id,
    kind: "exec",
    request: { command: "echo ok" },
    createdAtMs: NOW,
    expiresAtMs: NOW + 60_000,
  };
}

function snapshot(params: {
  cronJobs?: CronJob[];
  modelAuthStatus?: ModelAuthStatusResult | null;
  approvalQueue?: ExecApprovalRequest[];
}) {
  return buildSidebarIssuesSnapshot({
    cronJobs: params.cronJobs ?? [],
    modelAuthStatus: params.modelAuthStatus ?? null,
    approvalQueue: params.approvalQueue ?? [],
    now: NOW,
  });
}

type SidebarAttentionElement = HTMLElement & {
  updateComplete: Promise<boolean>;
  activeRouteId?: string;
  cronJobs: CronJob[];
  modelAuthStatus: ModelAuthStatusResult | null;
};

function mountSidebarAttention(options: {
  cronResponses: Array<CronJobsListResult | Promise<CronJobsListResult>>;
  authResponses?: Array<ModelAuthStatusResult | Promise<ModelAuthStatusResult>>;
  approvalQueue?: ExecApprovalRequest[];
}) {
  const cronResponses = [...options.cronResponses];
  const authResponses = [...(options.authResponses ?? [authStatus()])];
  const request = vi.fn(
    (method: string, _params?: unknown, _options?: { signal?: AbortSignal }) => {
      const response = method === "cron.list" ? cronResponses.shift() : authResponses.shift();
      if (!response) {
        throw new Error(`Unexpected request: ${method}`);
      }
      return Promise.resolve(response);
    },
  );
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
  const provider = createApplicationContextProvider({
    gateway,
    overlays: {
      snapshot: { approvalQueue: options.approvalQueue ?? [] },
      subscribe: () => () => undefined,
    },
    agentSelection: {
      state: { selectedId: "main" },
      subscribe: () => () => undefined,
    },
  } as unknown as ApplicationContext);
  const element = document.createElement("openclaw-sidebar-attention") as SidebarAttentionElement;
  provider.append(element);
  document.body.append(provider);
  return {
    element,
    request,
    emitCron: () => eventListener?.({ type: "event", event: "cron", payload: {} }),
  };
}

describe("sidebar issue derivation", () => {
  it("keeps the healthy state quiet", () => {
    expect(snapshot({ cronJobs: [cronJob("healthy")] })).toEqual({
      conditions: [],
      automationAttention: { count: 0, severity: null },
    });
  });

  it("uses the producer-recorded failure alert fact for repeated failures", () => {
    const beforeAlert = cronJob("before-alert", {
      lastRunStatus: "error",
      consecutiveErrors: 10,
    });
    const alerted = cronJob("alerted", {
      lastRunStatus: "error",
      consecutiveErrors: 2,
      lastFailureAlertAtMs: NOW - 1_000,
    });

    const result = snapshot({ cronJobs: [beforeAlert, alerted] });

    expect(result.conditions).toMatchObject([
      {
        id: "automation.failing-repeatedly.alerted",
        entityLabel: "alerted",
        stateLabel: "failing repeatedly",
      },
    ]);
    expect(result.automationAttention).toEqual({ count: 2, severity: "danger" });
  });

  it("counts one failed run in Automations without inventing an issue row", () => {
    const result = snapshot({
      cronJobs: [cronJob("failed-once", { lastRunStatus: "error", consecutiveErrors: 1 })],
    });

    expect(result.conditions).toEqual([]);
    expect(result.automationAttention).toEqual({ count: 1, severity: "danger" });
  });

  it("keeps repeated and overdue rows while counting the automation once", () => {
    const result = snapshot({
      cronJobs: [
        cronJob("stuck", {
          lastRunStatus: "error",
          consecutiveErrors: 2,
          lastFailureAlertAtMs: NOW - 2_000,
          nextRunAtMs: NOW - 300_001,
        }),
      ],
    });

    expect(result.conditions.map((condition) => condition.id)).toEqual([
      "automation.failing-repeatedly.stuck",
      "automation.overdue.stuck",
    ]);
    expect(result.automationAttention).toEqual({ count: 1, severity: "danger" });
  });

  it("does not flag an actively running automation as overdue", () => {
    const result = snapshot({
      cronJobs: [
        cronJob("running", {
          lastRunStatus: "ok",
          nextRunAtMs: NOW - 300_001,
          runningAtMs: NOW - 60_000,
        }),
        cronJob("stalled", { lastRunStatus: "ok", nextRunAtMs: NOW - 300_001 }),
      ],
    });

    expect(result.conditions.map((condition) => condition.id)).toEqual([
      "automation.overdue.stalled",
    ]);
    expect(result.automationAttention).toEqual({ count: 1, severity: "warning" });
  });

  it("renders each blocking provider from the canonical auth response", () => {
    const result = snapshot({
      modelAuthStatus: authStatus([
        {
          provider: "google",
          displayName: "Gemini",
          status: "expired",
          profiles: [{ profileId: "google:default", type: "oauth", status: "expired" }],
        },
        { provider: "openai", displayName: "OpenAI", status: "missing", profiles: [] },
      ]),
    });

    expect(result.conditions).toMatchObject([
      {
        id: "auth.expired.google",
        entityLabel: "Gemini",
        action: { kind: "navigate", routeId: "model-setup" },
      },
      {
        id: "auth.expired.openai",
        entityLabel: "OpenAI",
        action: { kind: "navigate", routeId: "model-setup" },
      },
    ]);
  });

  it("keeps active approvals as one actionable condition", () => {
    const result = snapshot({ approvalQueue: [approval("a"), approval("b")] });

    expect(result.conditions).toMatchObject([
      {
        id: "approval.pending",
        entityLabel: "Approvals",
        stateLabel: "2 pending",
        action: { kind: "openApprovals" },
      },
    ]);
  });
});

describe("sidebar issues lifecycle", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("drains cron pages before publishing Bell and Automations counts", async () => {
    const repeated = (id: string) =>
      cronJob(id, {
        lastRunStatus: "error",
        consecutiveErrors: 2,
        lastFailureAlertAtMs: NOW,
      });
    const { element, request } = mountSidebarAttention({
      cronResponses: [
        cronListResponse([repeated("first")], { total: 2, hasMore: true, nextOffset: 1 }),
        cronListResponse([repeated("second")], { total: 2, offset: 1 }),
      ],
    });
    let detail: SidebarIssuesChangeDetail | undefined;
    element.addEventListener(SIDEBAR_ISSUES_CHANGE_EVENT, (event) => {
      detail = (event as CustomEvent<SidebarIssuesChangeDetail>).detail;
    });

    await waitForFast(() =>
      expect(element.querySelector(".sidebar-issues-button")?.getAttribute("aria-label")).toBe(
        "2 issues, 0 blocking",
      ),
    );

    expect(element.cronJobs.map((job) => job.id)).toEqual(["first", "second"]);
    expect(detail?.automationAttention).toEqual({ count: 2, severity: "danger" });
    expect(request.mock.calls.filter(([method]) => method === "cron.list")).toHaveLength(2);
  });

  it("stops a superseded paginated load before requesting another page", async () => {
    const staleSecondPage = deferred<CronJobsListResult>();
    const repeated = (id: string) =>
      cronJob(id, {
        lastRunStatus: "error",
        consecutiveErrors: 2,
        lastFailureAlertAtMs: NOW,
      });
    const { element, emitCron, request } = mountSidebarAttention({
      cronResponses: [
        cronListResponse([repeated("stale-first")], {
          total: 3,
          hasMore: true,
          nextOffset: 1,
        }),
        staleSecondPage.promise,
        cronListResponse([repeated("current")]),
      ],
    });

    await waitForFast(() =>
      expect(request.mock.calls.filter(([method]) => method === "cron.list")).toHaveLength(2),
    );
    const staleSignal = request.mock.calls[1]?.[2]?.signal;
    expect(staleSignal?.aborted).toBe(false);
    emitCron();
    expect(staleSignal?.aborted).toBe(true);
    await waitForFast(() =>
      expect(request.mock.calls.filter(([method]) => method === "cron.list")).toHaveLength(3),
    );
    staleSecondPage.resolve(
      cronListResponse([repeated("stale-second")], {
        total: 3,
        offset: 1,
        hasMore: true,
        nextOffset: 2,
      }),
    );

    await waitForFast(() => expect(element.cronJobs.map((job) => job.id)).toEqual(["current"]));
    expect(request.mock.calls.filter(([method]) => method === "cron.list")).toHaveLength(3);
  });

  it("bounds snapshot recovery during revision churn", async () => {
    const repeated = (id: string) =>
      cronJob(id, {
        lastRunStatus: "error",
        consecutiveErrors: 2,
        lastFailureAlertAtMs: NOW,
      });
    const page = (id: string, snapshotRevision: string, offset: number) =>
      cronListResponse([repeated(id)], {
        snapshotRevision,
        total: 2,
        offset,
        hasMore: offset === 0,
        nextOffset: offset === 0 ? 1 : null,
      });
    const { element, request } = mountSidebarAttention({
      cronResponses: [
        page("a-first", "revision-a", 0),
        page("b-second", "revision-b", 1),
        page("b-first", "revision-b", 0),
        page("c-second", "revision-c", 1),
        page("c-first", "revision-c", 0),
      ],
    });

    await waitForFast(() =>
      expect(request.mock.calls.filter(([method]) => method === "cron.list")).toHaveLength(5),
    );
    expect(element.cronJobs).toEqual([]);
    expect(element.querySelector(".sidebar-issues-button")).toBeNull();
  });

  it("uses the same conditions for the Bell count and rendered rows", async () => {
    const { element } = mountSidebarAttention({
      cronResponses: [
        cronListResponse([
          cronJob("repeated", {
            lastRunStatus: "error",
            consecutiveErrors: 2,
            lastFailureAlertAtMs: NOW,
          }),
          cronJob("overdue", { lastRunStatus: "ok", nextRunAtMs: NOW - 300_001 }),
        ]),
      ],
      authResponses: [
        authStatus([
          {
            provider: "google",
            displayName: "Gemini",
            status: "expired",
            profiles: [{ profileId: "google:default", type: "oauth", status: "expired" }],
          },
        ]),
      ],
    });

    await waitForFast(() => expect(element.querySelector(".sidebar-issues-button")).not.toBeNull());
    (element.querySelector(".sidebar-issues-button") as HTMLButtonElement).click();
    await element.updateComplete;

    expect(element.querySelector(".sidebar-issues-button")?.getAttribute("aria-label")).toBe(
      "3 issues, 1 blocking",
    );
    expect(element.querySelectorAll(".sidebar-issues-panel__row")).toHaveLength(3);
    expect(element.textContent).not.toContain("Recent");
    expect(element.textContent).not.toContain("Clear");
    expect(element.querySelector("[data-sidebar-issue-id] [aria-label*='Dismiss']")).toBeNull();
  });

  it("closes a resolved panel and removes the Bell after a cron event", async () => {
    const repeated = cronJob("repeated", {
      lastRunStatus: "error",
      consecutiveErrors: 2,
      lastFailureAlertAtMs: NOW,
    });
    const { element, emitCron } = mountSidebarAttention({
      cronResponses: [cronListResponse([repeated]), cronListResponse([])],
    });

    await waitForFast(() => expect(element.querySelector(".sidebar-issues-button")).not.toBeNull());
    (element.querySelector(".sidebar-issues-button") as HTMLButtonElement).click();
    await element.updateComplete;
    expect(element.querySelector(".sidebar-issues-panel")).not.toBeNull();

    emitCron();
    await waitForFast(() => expect(element.querySelector(".sidebar-issues-button")).toBeNull());
    expect(element.querySelector(".sidebar-issues-panel")).toBeNull();
  });

  it("closes on route changes and Escape restores focus to the Bell", async () => {
    const repeated = cronJob("repeated", {
      lastRunStatus: "error",
      consecutiveErrors: 2,
      lastFailureAlertAtMs: NOW,
    });
    const { element } = mountSidebarAttention({
      cronResponses: [cronListResponse([repeated])],
    });
    element.activeRouteId = "home";
    await element.updateComplete;

    await waitForFast(() => expect(element.querySelector(".sidebar-issues-button")).not.toBeNull());
    const bell = element.querySelector(".sidebar-issues-button") as HTMLButtonElement;
    bell.click();
    await element.updateComplete;
    element
      .querySelector(".sidebar-issues-panel")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await element.updateComplete;
    expect(document.activeElement).toBe(bell);

    bell.click();
    await element.updateComplete;
    element.activeRouteId = "cron";
    await element.updateComplete;
    expect(element.querySelector(".sidebar-issues-panel")).toBeNull();
  });

  it("ignores a stale selected-agent auth response", async () => {
    const firstAuth = deferred<ModelAuthStatusResult>();
    const secondAuth = deferred<ModelAuthStatusResult>();
    const thirdAuth = deferred<ModelAuthStatusResult>();
    const authResponses = [firstAuth.promise, secondAuth.promise, thirdAuth.promise];
    const request = vi.fn((method: string, _params?: { agentId?: string }) => {
      if (method === "cron.list") {
        return Promise.resolve(cronListResponse([]));
      }
      const response = authResponses.shift();
      if (!response) {
        throw new Error(`Unexpected request: ${method}`);
      }
      return response;
    });
    const client = { request } as unknown as GatewayBrowserClient;
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
      connection: { gatewayUrl: "ws://gateway.test", token: "", bootstrapToken: "", password: "" },
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    } as unknown as ApplicationGateway;
    const state = { selectedId: "main" as string | null };
    const listeners = new Set<() => void>();
    const provider = createApplicationContextProvider({
      gateway,
      overlays: { snapshot: { approvalQueue: [] }, subscribe: () => () => undefined },
      agentSelection: {
        state,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    } as unknown as ApplicationContext);
    const element = document.createElement("openclaw-sidebar-attention") as SidebarAttentionElement;
    provider.append(element);
    document.body.append(provider);
    await waitForFast(() =>
      expect(
        request.mock.calls.some(
          ([method, params]) => method === "models.authStatus" && params?.agentId === "main",
        ),
      ).toBe(true),
    );

    state.selectedId = "writer";
    for (const listener of listeners) {
      listener();
    }
    await waitForFast(() =>
      expect(
        request.mock.calls.some(
          ([method, params]) => method === "models.authStatus" && params?.agentId === "writer",
        ),
      ).toBe(true),
    );
    const writerStatus = authStatus([
      {
        provider: "google",
        displayName: "Gemini",
        status: "expired",
        profiles: [{ profileId: "google:default", type: "oauth", status: "expired" }],
      },
    ]);
    secondAuth.resolve(writerStatus);
    await waitForFast(() => expect(element.modelAuthStatus).toBe(writerStatus));
    await waitForFast(() => expect(element.querySelector(".sidebar-issues-button")).not.toBeNull());

    state.selectedId = "main";
    for (const listener of listeners) {
      listener();
    }
    await waitForFast(() =>
      expect(
        request.mock.calls.filter(
          ([method, params]) => method === "models.authStatus" && params?.agentId === "main",
        ),
      ).toHaveLength(2),
    );
    await element.updateComplete;
    expect(element.querySelector(".sidebar-issues-button")).toBeNull();

    firstAuth.resolve(
      authStatus([
        {
          provider: "google",
          displayName: "Gemini",
          status: "expired",
          profiles: [{ profileId: "google:default", type: "oauth", status: "expired" }],
        },
      ]),
    );
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });

    expect(element.modelAuthStatus).toBe(writerStatus);
    expect(element.querySelector(".sidebar-issues-button")).toBeNull();
    const mainStatus = authStatus([]);
    thirdAuth.resolve(mainStatus);
    await waitForFast(() => expect(element.modelAuthStatus).toBe(mainStatus));
  });
});
