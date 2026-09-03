/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { CronJob, CronJobsListResult, ModelAuthStatusResult } from "../api/types.ts";
import type { ApplicationContext, ApplicationGateway } from "../app/context.ts";
import type { ScopeUpgradeState } from "../app/device-scope-upgrade-availability.ts";
import { client as mockClient, createGatewayHarness } from "../app/overlays-access.test-support.ts";
import { createApplicationOverlays } from "../app/overlays.ts";
import {
  createSidebarAttentionStore,
  type SidebarAttentionStore,
} from "../app/sidebar-attention-store.ts";
import {
  createApplicationContextProvider,
  hiddenScopeUpgradeCapability,
} from "../test-helpers/application-context.ts";
import { createStorageMock as createTestStorageMock } from "../test-helpers/storage.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { CUSTODIAN_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";
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
import { SidebarAttentionStoreController } from "./sidebar-attention-store.ts";
import { resolveSidebarUpdateAttention } from "./sidebar-attention-update.ts";
import "./sidebar-attention.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
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
  dismissPanel: () => boolean;
};

function authStatus(ts: number, status: "missing" | "ok" = "missing"): ModelAuthStatusResult {
  return {
    ts,
    providers: [
      {
        provider: "openai",
        displayName: "OpenAI",
        status,
        profiles: [],
      },
    ],
  };
}

function authItems(agentId: string) {
  return buildSidebarAttentionEntries({
    cronJobs: [],
    cronSchedulerEnabled: true,
    modelAuthStatus: authStatus(1),
    modelAuthAgentId: agentId,
    now: 0,
  }).filter((item) => item.kind === "modelAuthExpired");
}

describe("model auth attention", () => {
  it("keeps identical provider warnings distinct across agents", () => {
    expect(authItems("main")[0]?.signature).toBe("agent:main\nopenai");
    expect(authItems("writer")[0]?.signature).toBe("agent:writer\nopenai");
  });

  it("keeps a missing canonical route visible beside CLI OAuth", () => {
    const items = buildSidebarAttentionEntries({
      cronJobs: [],
      cronSchedulerEnabled: true,
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
  const stores = new Set<SidebarAttentionStore>();
  afterEach(() => {
    for (const store of stores) {
      store.dispose();
    }
    stores.clear();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mountAttention(
    overrides: Partial<Pick<ApplicationContext, "agentSelection" | "gateway" | "overlays">> = {},
  ) {
    const sources = {
      gateway: {
        snapshot: { phase: "connected", client: null, hello: null },
        connection: { gatewayUrl: "" },
        subscribe: () => () => undefined,
        subscribeEvents: () => () => undefined,
      },
      overlays: {
        snapshot: { approvalQueue: [] },
        subscribe: () => () => undefined,
      },
      agentSelection: {
        state: { selectedId: null, scopeId: null },
        subscribe: () => () => undefined,
      },
      scopeUpgrade: hiddenScopeUpgradeCapability,
      ...overrides,
      agents: {
        state: { agentsList: null },
        subscribe: () => () => undefined,
      },
    } as unknown as Parameters<typeof createSidebarAttentionStore>[0];
    const store = createSidebarAttentionStore(sources);
    store.activate(SidebarAttentionStoreController);
    stores.add(store);
    const provider = createApplicationContextProvider({
      ...sources,
      sidebarAttention: store,
    } as unknown as ApplicationContext);
    const element = document.createElement("openclaw-sidebar-attention") as SidebarAttentionElement;
    provider.append(element);
    document.body.append(provider);

    await waitForFast(() =>
      expect(element.querySelector<HTMLButtonElement>(".sidebar-issues-button")).not.toBeNull(),
    );
    const trigger = element.querySelector<HTMLButtonElement>(".sidebar-issues-button")!;
    return { element, provider, store, trigger };
  }

  it("keeps the plain attention panel inside its top-layer menu surface", async () => {
    const { element, trigger } = await mountAttention();
    trigger.click();

    await import("./sidebar-attention-panel.runtime.ts");
    await element.updateComplete;
    const panel = element.querySelector(".sidebar-issues-panel");
    expect(panel).not.toBeNull();
    expect(panel?.closest("openclaw-menu-surface")).not.toBeNull();
    panel!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await element.updateComplete;
    expect(element.querySelector(".sidebar-issues-panel")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps a reconnected attention panel closed until a new open", async () => {
    const { element, provider, trigger } = await mountAttention();
    trigger.click();
    await waitForFast(() => expect(element.querySelector(".sidebar-issues-panel")).not.toBeNull());

    element.remove();
    provider.append(element);
    await element.updateComplete;

    expect(element.querySelector(".sidebar-issues-panel")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    trigger.click();
    await waitForFast(() => expect(element.querySelector(".sidebar-issues-panel")).not.toBeNull());
  });

  it("keeps loaded health attention across a view-only remount", async () => {
    const request = vi.fn((method: string) => {
      if (method === "cron.list") {
        return Promise.resolve(cronListResponse([cronJob("failed")]));
      }
      if (method === "cron.status") {
        return Promise.resolve({ enabled: true, triggersEnabled: true, jobs: 1 });
      }
      if (method === "models.authStatus") {
        return Promise.resolve(authStatus(1));
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const harness = createGatewayHarness(mockClient(request));
    const { element, provider } = await mountAttention({
      gateway: harness.gateway,
      agentSelection: {
        state: { selectedId: "main", scopeId: null },
        subscribe: () => () => undefined,
      } as unknown as ApplicationContext["agentSelection"],
    });
    await waitForFast(() =>
      expect(element.querySelector(".sidebar-issues-button__count")?.textContent).toBe("2"),
    );

    element.remove();
    provider.append(element);

    expect(element.querySelector(".sidebar-issues-button__count")?.textContent).toBe("2");
  });

  it("keeps overdue jobs out of the Inbox while the scheduler is disabled", async () => {
    const overdue = cronJob("overdue-id");
    overdue.state = { lastRunStatus: "ok", nextRunAtMs: 1 };
    vi.spyOn(Date, "now").mockReturnValue(300_002);
    const request = vi.fn((method: string) => {
      if (method === "cron.list") {
        return Promise.resolve(cronListResponse([overdue]));
      }
      if (method === "cron.status") {
        return Promise.resolve({ enabled: false, triggersEnabled: true, jobs: 1 });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const harness = createGatewayHarness(mockClient(request));

    const { element } = await mountAttention({ gateway: harness.gateway });

    await waitForFast(() => expect(request).toHaveBeenCalledWith("cron.status", {}));
    expect(element.querySelector(".sidebar-issues-button__count")).toBeNull();
  });

  it("does not let an obsolete open render steal focus from a later interaction", async () => {
    const { element, trigger } = await mountAttention();
    const rendered = deferred<boolean>();
    const updateComplete = vi
      .spyOn(element, "updateComplete", "get")
      .mockReturnValueOnce(rendered.promise);
    trigger.click();
    await waitForFast(() => expect(element.querySelector(".sidebar-issues-panel")).not.toBeNull());
    expect(updateComplete).toHaveBeenCalledOnce();
    updateComplete.mockRestore();

    element.dismissPanel();
    await element.updateComplete;
    trigger.click();
    await waitForFast(() =>
      expect(document.activeElement).toBe(element.querySelector(".sidebar-issues-panel__list")),
    );
    const nextControl = document.body.appendChild(document.createElement("button"));
    nextControl.focus();
    rendered.resolve(true);
    await rendered.promise;

    expect(document.activeElement).toBe(nextControl);
  });

  it("does not restore an obsolete close's focus after another open and close", async () => {
    const { element, trigger } = await mountAttention();
    trigger.click();
    await waitForFast(() => expect(element.querySelector(".sidebar-issues-panel")).not.toBeNull());
    const rendered = deferred<boolean>();
    const updateComplete = vi
      .spyOn(element, "updateComplete", "get")
      .mockReturnValueOnce(rendered.promise);
    element
      .querySelector(".sidebar-issues-panel")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(updateComplete).toHaveBeenCalledOnce();
    updateComplete.mockRestore();
    await element.updateComplete;
    trigger.click();
    await waitForFast(() =>
      expect(document.activeElement).toBe(element.querySelector(".sidebar-issues-panel__list")),
    );
    element.dismissPanel();
    await element.updateComplete;
    const nextControl = document.body.appendChild(document.createElement("button"));
    nextControl.focus();
    rendered.resolve(true);
    await rendered.promise;

    expect(document.activeElement).toBe(nextControl);
  });

  it.each([
    { name: "same panel", reopen: false },
    { name: "reopened panel", reopen: true },
  ])("restores approval focus only within the initiating panel ($name)", async ({ reopen }) => {
    const resolution = deferred<unknown>();
    const request = vi.fn((method: string) => {
      if (method === "exec.approval.resolve") {
        return resolution.promise;
      }
      if (method === "cron.list") {
        return Promise.resolve(cronListResponse([]));
      }
      if (method === "cron.status") {
        return Promise.resolve({ enabled: true, triggersEnabled: true, jobs: 0 });
      }
      if (
        method === "exec.approval.list" ||
        method === "plugin.approval.list" ||
        method === "openclaw.approval.list"
      ) {
        return Promise.resolve([]);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const harness = createGatewayHarness(mockClient(request));
    const overlays = createApplicationOverlays(harness.gateway);
    const decideApproval = vi.spyOn(overlays, "decideApproval");
    try {
      const { element, trigger } = await mountAttention({ gateway: harness.gateway, overlays });
      harness.emitApproval("remaining", 1);
      harness.emitApproval("selected", 2);
      trigger.click();
      const decisionSelector =
        '[data-approval-id="selected"] .sidebar-approval-row__action--allow-once';
      await waitForFast(() => expect(element.querySelector(decisionSelector)).not.toBeNull());
      element.querySelector<HTMLButtonElement>(decisionSelector)!.click();
      expect(decideApproval).toHaveBeenCalledExactlyOnceWith("allow-once", "selected");
      expect(request).toHaveBeenCalledWith("exec.approval.resolve", {
        id: "selected",
        decision: "allow-once",
      });
      if (reopen) {
        element.dismissPanel();
        await element.updateComplete;
        trigger.click();
        await waitForFast(() =>
          expect(document.activeElement).toBe(element.querySelector(".sidebar-issues-panel__list")),
        );
      }
      const tab = element.querySelector<HTMLElement>("#sidebar-issues-tab-all")!;
      if (reopen) {
        tab.focus();
      }
      resolution.resolve({ ok: true });
      await decideApproval.mock.results[0]!.value;
      await element.updateComplete;

      expect(overlays.snapshot.approvalQueue.map((approval) => approval.id)).toEqual(["remaining"]);
      expect(document.activeElement).toBe(
        reopen
          ? tab
          : element.querySelector('[data-approval-id="remaining"] [data-issue-row-focus]'),
      );
    } finally {
      resolution.resolve({ ok: true });
      overlays.dispose();
    }
  });

  it.each(["success", "failure"] as const)(
    "keeps writer auth ownership after a stale Main %s settles",
    async (outcome) => {
      const staleCron = deferred<unknown>();
      const staleAuth = deferred<ModelAuthStatusResult>();
      const switchedAuth = deferred<ModelAuthStatusResult>();
      const responses = {
        "cron.list": [
          Promise.resolve(cronListResponse([cronJob("current")])),
          staleCron.promise,
          Promise.resolve(cronListResponse([cronJob("current")])),
          Promise.resolve(cronListResponse([cronJob("current")])),
        ],
        "cron.status": [
          Promise.resolve({ enabled: true, triggersEnabled: true, jobs: 1 }),
          Promise.resolve({ enabled: true, triggersEnabled: true, jobs: 1 }),
          Promise.resolve({ enabled: true, triggersEnabled: true, jobs: 1 }),
          Promise.resolve({ enabled: true, triggersEnabled: true, jobs: 1 }),
        ],
        "models.authStatus": [
          Promise.resolve(authStatus(1)),
          staleAuth.promise,
          switchedAuth.promise,
          Promise.resolve(authStatus(2)),
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
          hello: {
            auth: { role: "operator", scopes: ["operator.admin", "operator.read"] },
            features: { methods: ["update.run"] },
          },
        },
        connection: { gatewayUrl: "ws://gateway.test" },
        subscribe: () => () => undefined,
        subscribeEvents: (listener: NonNullable<typeof eventListener>) => {
          eventListener = listener;
          return () => undefined;
        },
      } as unknown as ApplicationGateway;
      const overlays = {
        snapshot: {
          approvalQueue: [{ id: "approval-1", request: { command: "echo proof" } }],
          approvalBusy: false,
          approvalCanGrant: true,
          approvalErrors: new Map(),
          updateAvailable: {
            currentVersion: "2026.8.1",
            latestVersion: "2026.8.2",
            channel: "latest",
          },
        },
        subscribe: () => () => undefined,
      } as unknown as ApplicationContext["overlays"];
      const selectionState = {
        selectedId: "main" as string | null,
        scopeId: null as string | null,
      };
      const selectionListeners = new Set<() => void>();
      const agentSelection = {
        state: selectionState,
        subscribe: (listener: () => void) => {
          selectionListeners.add(listener);
          return () => selectionListeners.delete(listener);
        },
      } as unknown as ApplicationContext["agentSelection"];
      vi.stubGlobal("localStorage", createTestStorageMock());
      localStorage.setItem(
        dismissalStoreKey(gateway.connection.gatewayUrl),
        JSON.stringify({
          cronFailed: ["dismissed-cron"],
          modelAuthExpired: ["agent:writer\nold-provider"],
        }),
      );
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      let now = 120_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);

      const { element, store, trigger } = await mountAttention({
        agentSelection,
        gateway,
        overlays,
      });
      await waitForFast(() =>
        expect(
          store.entries.some(
            (entry) => entry.type === "attention" && entry.kind === "modelAuthExpired",
          ),
        ).toBe(true),
      );
      trigger.click();
      await waitForFast(() =>
        expect(element.querySelector('[data-attention-kind="modelAuthExpired"]')).not.toBeNull(),
      );

      now = 200_000;
      document.dispatchEvent(new Event("visibilitychange"));
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(6));

      selectionState.selectedId = "writer";
      for (const listener of selectionListeners) {
        listener();
      }

      await element.updateComplete;
      expect(element.querySelector('[data-attention-kind="modelAuthExpired"]')).toBeNull();
      expect(element.querySelector('[data-attention-kind="cronFailed"]')).not.toBeNull();
      expect(element.querySelector('[data-attention-kind="updateAvailable"]')).not.toBeNull();
      expect(element.querySelector('[data-approval-id="approval-1"]')).not.toBeNull();

      await waitForFast(() => expect(request).toHaveBeenCalledTimes(9));
      eventListener?.({ type: "event", event: "cron", payload: {} });
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(12));
      await waitForFast(() =>
        expect(
          element
            .querySelector('[data-attention-kind="modelAuthExpired"]')
            ?.textContent?.replace(/\s+/g, " "),
        ).toContain("writer"),
      );
      const storedDismissals = localStorage.getItem(
        dismissalStoreKey(gateway.connection.gatewayUrl),
      );

      now = 300_000;
      staleCron.resolve(cronListResponse([cronJob("stale")]));
      if (outcome === "success") {
        staleAuth.resolve(authStatus(3, "ok"));
      } else {
        staleAuth.reject(new Error("stale Main auth"));
      }
      switchedAuth.resolve(authStatus(4, "ok"));
      await Promise.allSettled([staleCron.promise, staleAuth.promise, switchedAuth.promise]);
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, 0);
      });
      await element.updateComplete;

      expect(
        element
          .querySelector('[data-attention-kind="modelAuthExpired"]')
          ?.textContent?.replace(/\s+/g, " "),
      ).toContain("writer");
      expect(localStorage.getItem(dismissalStoreKey(gateway.connection.gatewayUrl))).toBe(
        storedDismissals,
      );
      expect(element.querySelector('[data-attention-kind="cronFailed"]')).not.toBeNull();
      expect(element.querySelector('[data-attention-kind="updateAvailable"]')).not.toBeNull();
      expect(element.querySelector('[data-approval-id="approval-1"]')).not.toBeNull();
    },
  );

  it("opens top-mounted attention downward and clears stale live automation alerts", async () => {
    const responses = {
      "cron.list": [cronListResponse([cronJob("failed")]), cronListResponse([])],
      "cron.status": [
        { enabled: true, triggersEnabled: true, jobs: 1 },
        { enabled: true, triggersEnabled: true, jobs: 0 },
      ],
      "models.authStatus": [authStatus(1)],
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
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["openclaw.chat"] },
      },
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
      state: { selectedId: "main", scopeId: "main" },
      subscribe: () => () => undefined,
    } as unknown as ApplicationContext["agentSelection"];
    vi.stubGlobal("localStorage", createTestStorageMock());

    const context = {
      gateway,
      overlays,
      agentSelection,
      scopeUpgrade: hiddenScopeUpgradeCapability,
      agents: {
        state: { agentsList: null },
        subscribe: () => () => undefined,
      },
    } as unknown as ApplicationContext;
    const store = createSidebarAttentionStore({
      gateway,
      agentSelection,
      agents: context.agents,
      overlays,
      scopeUpgrade: context.scopeUpgrade,
    });
    store.activate(SidebarAttentionStoreController);
    stores.add(store);
    const provider = createApplicationContextProvider({ ...context, sidebarAttention: store });
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
    expect(
      Array.from(
        panel.querySelectorAll("header button"),
        (button) => button.getAttribute("aria-label") ?? button.textContent,
      ).some((label) => label?.includes("Ask OpenClaw")),
    ).toBe(false);

    const { custodianAlertStore } = await import("../pages/custodian/custodian-alert-store.ts");
    const dispatch = vi.spyOn(window, "dispatchEvent");
    try {
      const alertAction = panel.querySelector<HTMLButtonElement>(
        '[data-attention-kind="modelAuthExpired"] .sidebar-issues-panel__action:not(.sidebar-issues-panel__action--primary)',
      )!;
      expect(alertAction.textContent?.trim()).toBe("Ask OpenClaw");
      alertAction.click();
      await waitForFast(() =>
        expect(dispatch).toHaveBeenCalledWith(
          expect.objectContaining({ type: CUSTODIAN_PANEL_TOGGLE_EVENT, detail: { open: true } }),
        ),
      );
      expect(custodianAlertStore.alert?.id).toBe("modelAuthExpired:agent:main\nopenai");
      expect(element.querySelector(".sidebar-issues-panel")).toBeNull();
    } finally {
      custodianAlertStore.dismiss();
    }
    trigger.click();
    await waitForFast(() => expect(element.querySelector(".sidebar-issues-panel")).not.toBeNull());

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

    expect(resolveSidebarUpdateAttention(element.context).present).toBe(false);

    gatewaySnapshot.hello.auth.scopes = ["operator.read"];
    expect(resolveSidebarUpdateAttention(element.context).present).toBe(true);

    gatewaySnapshot.hello.auth.scopes = ["operator.admin"];
    overlaySnapshot.updateCampaignStatusHydrated = true;
    expect(resolveSidebarUpdateAttention(element.context).present).toBe(true);
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

    expect(resolveSidebarUpdateAttention(element.context).present).toBe(true);
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
      requiresAction: true,
      severity: "warning",
      visible: true,
    });

    expect(Boolean(entry?.dismissal)).toBe(dismissible);
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
    scope?: { cronInventoryComplete: boolean; modelAuthAgentId: string | null },
  ) => {
    vi.stubGlobal("localStorage", createTestStorageMock());
    localStorage.setItem(dismissalStoreKey(gatewayUrl), JSON.stringify(dismissals));
    return reconcileSidebarAttentionDismissals({
      active,
      gatewayUrl,
      ...(scope ? { scope } : {}),
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

  it("preserves dismissals outside a selected agent's partial inventory", () => {
    expect(
      reconcile(
        {
          cronFailed: ["main-job", "writer-job"],
          modelAuthExpired: ["agent:main\nopenai", "agent:writer\nopenai"],
        },
        [chip("cronFailed", "main-job"), chip("modelAuthExpired", "agent:main\nopenai")],
        { cronInventoryComplete: false, modelAuthAgentId: "main" },
      ),
    ).toEqual({
      cronFailed: ["main-job", "writer-job"],
      modelAuthExpired: ["agent:main\nopenai", "agent:writer\nopenai"],
    });
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
    { state: { phase: "error", message: "request failed", retryable: false }, dismissible: false },
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
      cronSchedulerEnabled: true,
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
      requiresAction: true,
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

  it("keeps informational updates visible without adding them to attention counts", () => {
    const update = buildUpdateInboxEntry({
      canDismiss: false,
      dismissal: { kind: "updateAvailable", signature: '["2026.8.3","boot-a"]' },
      forced: false,
      requiresAction: false,
      severity: "warning",
      visible: true,
    });
    const entries = buildSidebarInboxEntries({
      approvals: [],
      attention: [],
      scopeUpgrade: null,
      update,
    });

    expect(entries).toHaveLength(1);
    expect(sidebarInboxTabCounts(entries)).toEqual({
      all: 0,
      approvals: 0,
      automations: 0,
      system: 0,
    });
  });
});

describe("dismissSidebarAttention", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("merges with the persisted map so another tab's dismissal survives", () => {
    vi.stubGlobal("localStorage", createTestStorageMock());
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
    vi.stubGlobal("localStorage", createTestStorageMock());
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
