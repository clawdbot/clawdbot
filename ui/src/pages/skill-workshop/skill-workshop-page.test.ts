import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { SkillWorkshopProposal } from "../../lib/skill-workshop/index.ts";
import { createSkillWorkshopState, skillWorkshopRouteData } from "./proposals.ts";
import type { SkillWorkshopRouteData, SkillWorkshopState } from "./proposals.ts";
import "./skill-workshop-page.ts";

type SkillWorkshopPageTestElement = HTMLElement & {
  context: ApplicationContext;
  data?: SkillWorkshopRouteData;
  state?: SkillWorkshopState;
  handleRevisionRequest: (
    instructions: string,
    proposal: SkillWorkshopProposal,
    proposalAgentId: string,
  ) => Promise<void>;
  updateComplete: Promise<boolean>;
  requestUpdate: () => void;
};

function waitForSkillWorkshop(assertion: () => void) {
  return vi.waitFor(assertion, { interval: 1 });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function callsFor(request: ReturnType<typeof vi.fn>, method: string) {
  return request.mock.calls.filter(([calledMethod]) => calledMethod === method);
}

function createRuntimeConfigStub(options?: {
  sourceConfig?: Record<string, unknown>;
  patch?: ReturnType<typeof vi.fn>;
}) {
  return {
    state: {
      configSnapshot: options?.sourceConfig
        ? { hash: "hash-1", sourceConfig: options.sourceConfig }
        : null,
      configLoading: false,
      lastError: null as string | null,
    },
    ensureLoaded: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    patch: options?.patch ?? vi.fn(async () => true),
    subscribe: () => () => undefined,
  };
}

function createContext(
  request: ReturnType<typeof vi.fn>,
  options?: {
    gatewaySubscribe?: (listener: (snapshot: ApplicationGatewaySnapshot) => void) => () => void;
    sessions?: ApplicationContext["sessions"];
    runtimeConfig?: ReturnType<typeof createRuntimeConfigStub>;
  },
): ApplicationContext {
  const client = { request } as unknown as GatewayBrowserClient;
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    connected: true,
    offlineStable: false,
    reconnecting: false,
    hello: null,
    assistantAgentId: "research",
    sessionKey: "global",
    lastError: null,
    lastErrorCode: null,
  };
  const subscribe = () => () => undefined;
  return {
    gateway: {
      snapshot,
      subscribe: options?.gatewaySubscribe ?? subscribe,
    },
    config: {
      current: { assistantIdentity: { name: "OpenClaw" } },
      subscribe,
    },
    agentSelection: {
      state: { selectedId: "research" },
      subscribe,
    },
    agentIdentity: {
      get: () => ({ agentId: "research", name: "Research" }),
      subscribe,
    },
    sessions: options?.sessions ?? { state: { result: null, loading: false } },
    skillWorkshopRevision: { prepare: vi.fn() },
    runtimeConfig: options?.runtimeConfig ?? createRuntimeConfigStub(),
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("SkillWorkshopPage lifecycle", () => {
  it("renders revisions in the shared modal and handles modal cancellation", async () => {
    const proposal = {
      key: "proposal-modal",
      slug: "proposal-modal",
      name: "Modal proposal",
      oneLine: "Shared modal coverage",
      body: "## Workflow\n- test",
      status: "pending",
      version: 1,
      createdAt: 0,
      recencyGroup: "today",
      ageLabel: "now",
      supportFiles: [],
      isNew: false,
    } satisfies SkillWorkshopProposal;
    const loadedState = createSkillWorkshopState();
    loadedState.skillWorkshopLoaded = true;
    loadedState.skillWorkshopProposals = [proposal];
    loadedState.skillWorkshopSelectedKey = proposal.key;
    loadedState.skillWorkshopRevisionKey = proposal.key;
    loadedState.skillWorkshopRevisionDraft = "Make it clearer";
    const page = document.createElement(
      "openclaw-skill-workshop-page",
    ) as SkillWorkshopPageTestElement;
    page.data = skillWorkshopRouteData(loadedState);
    page.context = createContext(vi.fn(async () => ({})));
    document.body.append(page);
    await page.updateComplete;

    const modal = page.querySelector("openclaw-modal-dialog");
    expect(modal).not.toBeNull();
    expect(page.querySelector(".sw-revision-backdrop")).toBeNull();
    expect(page.querySelector(".sw-revision-dialog__input")).toBeInstanceOf(HTMLTextAreaElement);

    modal?.dispatchEvent(new CustomEvent("modal-cancel", { bubbles: true, composed: true }));
    await page.updateComplete;
    expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("renders truncated Today previews without dangling surrogates", async () => {
    const previewText = `${"a".repeat(118)}😀trailing`;
    const proposal = {
      key: "proposal-utf16-preview",
      slug: "proposal-utf16-preview",
      name: "UTF-16 preview",
      oneLine: "Preview boundary coverage",
      body: `## Workflow\n- ${previewText}`,
      status: "pending",
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      recencyGroup: "today",
      ageLabel: "now",
      supportFiles: [],
      isNew: false,
      origin: {
        agentId: "research",
        sessionKey: "agent:research:proposal-utf16-preview",
      },
    } satisfies SkillWorkshopProposal;
    const loadedState = createSkillWorkshopState();
    loadedState.skillWorkshopAgentId = "research";
    loadedState.skillWorkshopLoaded = true;
    loadedState.skillWorkshopProposals = [proposal];
    loadedState.skillWorkshopSelectedKey = proposal.key;
    const page = document.createElement(
      "openclaw-skill-workshop-page",
    ) as SkillWorkshopPageTestElement;
    page.data = skillWorkshopRouteData(loadedState);
    page.context = createContext(vi.fn(async () => ({})));
    document.body.append(page);
    await page.updateComplete;

    expect(page.querySelector(".sw-today__does li")?.textContent).toBe(`${"a".repeat(118)}…`);
  });

  it("forces a fresh proposal load when the gateway source changes", async () => {
    const firstRequest = vi.fn(async () => ({}));
    const secondRequest = vi.fn(async () => ({
      schema: "openclaw.skill-workshop.proposals-manifest.v1",
      updatedAt: "2026-07-08T00:00:00.000Z",
      proposals: [],
    }));
    const loadedState = createSkillWorkshopState();
    loadedState.skillWorkshopAgentId = "research";
    loadedState.skillWorkshopLoaded = true;
    const page = document.createElement(
      "openclaw-skill-workshop-page",
    ) as SkillWorkshopPageTestElement;
    page.data = skillWorkshopRouteData(loadedState);
    page.context = createContext(firstRequest);
    document.body.append(page);
    await page.updateComplete;
    page.requestUpdate();
    await page.updateComplete;
    expect(firstRequest).not.toHaveBeenCalled();

    page.context = createContext(secondRequest);
    page.requestUpdate();
    await page.updateComplete;

    await waitForSkillWorkshop(() =>
      expect(secondRequest).toHaveBeenCalledWith("skills.proposals.list", {
        agentId: "research",
      }),
    );
  });

  it("does not issue duplicate list requests while a load is in flight", async () => {
    const manifest = deferred<unknown>();
    const request = vi.fn(() => manifest.promise);
    const page = document.createElement(
      "openclaw-skill-workshop-page",
    ) as SkillWorkshopPageTestElement;
    page.context = createContext(request);
    document.body.append(page);
    await page.updateComplete;

    // Extra update cycles during the pending load used to re-enter
    // loadProposals, whose early-return finally scheduled the next update and
    // spun the page at 100% CPU until the request settled.
    page.requestUpdate();
    await page.updateComplete;
    page.requestUpdate();
    await page.updateComplete;
    expect(callsFor(request, "skills.proposals.list")).toHaveLength(1);

    manifest.resolve({
      schema: "openclaw.skill-workshop.proposals-manifest.v1",
      updatedAt: "2026-07-08T00:00:00.000Z",
      proposals: [],
    });
    await waitForSkillWorkshop(() => expect(page.state?.skillWorkshopLoaded).toBe(true));
    expect(callsFor(request, "skills.proposals.list")).toHaveLength(1);
  });

  it("stops auto-retrying after a failed proposal load", async () => {
    const request = vi.fn(async () => {
      throw new Error("gateway offline");
    });
    const page = document.createElement(
      "openclaw-skill-workshop-page",
    ) as SkillWorkshopPageTestElement;
    page.context = createContext(request);
    document.body.append(page);
    await page.updateComplete;
    await waitForSkillWorkshop(() =>
      expect(page.state?.skillWorkshopError).toContain("gateway offline"),
    );

    page.requestUpdate();
    await page.updateComplete;
    page.requestUpdate();
    await page.updateComplete;
    expect(callsFor(request, "skills.proposals.list")).toHaveLength(1);
  });

  it("detaches an in-flight proposal load on a same-client disconnect", async () => {
    const manifest = deferred<unknown>();
    const request = vi.fn(() => manifest.promise);
    let gatewayListener: ((snapshot: ApplicationGatewaySnapshot) => void) | undefined;
    const context = createContext(request, {
      gatewaySubscribe: (listener) => {
        gatewayListener = listener;
        return () => undefined;
      },
    });
    const page = document.createElement(
      "openclaw-skill-workshop-page",
    ) as SkillWorkshopPageTestElement;
    page.context = context;
    document.body.append(page);
    await page.updateComplete;
    page.requestUpdate();
    await page.updateComplete;
    await waitForSkillWorkshop(() =>
      expect(callsFor(request, "skills.proposals.list")).toHaveLength(1),
    );
    const loadingState = page.state;

    gatewayListener?.({ ...context.gateway.snapshot, connected: false });
    expect(page.state).not.toBe(loadingState);
    expect(page.state?.skillWorkshopLoaded).toBe(false);

    manifest.resolve({
      schema: "openclaw.skill-workshop.proposals-manifest.v1",
      updatedAt: "2026-07-08T00:00:00.000Z",
      proposals: [],
    });
    await manifest.promise;
    await Promise.resolve();
    expect(page.state?.skillWorkshopLoaded).toBe(false);
    expect(page.state?.skillWorkshopProposals).toEqual([]);
  });

  it("does not prepare or navigate a revision resolved by a replaced context", async () => {
    const sessionList = deferred<SessionsListResult>();
    const oldSessions = {
      state: { agentId: null, result: null, loading: false, error: null },
      list: vi.fn(() => sessionList.promise),
      create: vi.fn(async () => null),
    } as unknown as ApplicationContext["sessions"];
    const oldContext = createContext(
      vi.fn(async () => ({})),
      { sessions: oldSessions },
    );
    const loadedState = createSkillWorkshopState();
    loadedState.skillWorkshopAgentId = "research";
    loadedState.skillWorkshopLoaded = true;
    const proposal = {
      key: "proposal-1",
      slug: "proposal-1",
      name: "Proposal",
      oneLine: "",
      body: "",
      status: "pending",
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      recencyGroup: "today",
      ageLabel: "now",
      supportFiles: [],
      isNew: false,
      origin: {
        agentId: "research",
        sessionKey: "agent:research:revision",
      },
    } satisfies SkillWorkshopProposal;
    loadedState.skillWorkshopProposals = [proposal];
    loadedState.skillWorkshopSelectedKey = proposal.key;
    const page = document.createElement(
      "openclaw-skill-workshop-page",
    ) as SkillWorkshopPageTestElement;
    page.data = skillWorkshopRouteData(loadedState);
    page.context = oldContext;
    document.body.append(page);
    await page.updateComplete;
    page.requestUpdate();
    await page.updateComplete;

    const revision = page.handleRevisionRequest("revise it", proposal, "research");
    await waitForSkillWorkshop(() => expect(oldSessions.list).toHaveBeenCalledTimes(1));

    const newContext = createContext(vi.fn(async () => ({})));
    page.context = newContext;
    page.requestUpdate();
    await page.updateComplete;

    sessionList.resolve({
      sessions: [
        {
          key: "agent:research:revision",
          archived: false,
          hasActiveRun: false,
        },
      ],
    } as SessionsListResult);
    await revision;

    expect(oldContext.skillWorkshopRevision.prepare).not.toHaveBeenCalled();
    expect(oldContext.navigate).not.toHaveBeenCalled();
    expect(newContext.skillWorkshopRevision.prepare).not.toHaveBeenCalled();
    expect(newContext.navigate).not.toHaveBeenCalled();
  });

  it("does not refresh the previous agent after a history scan finishes", async () => {
    const scan = deferred<unknown>();
    const scanStatus = {
      schema: "openclaw.skill-workshop.history-scan.v1",
      hasScanned: false,
      reviewedSessions: 0,
      ideasFound: 0,
      hasMore: false,
      lastScanReviewed: 0,
      lastScanIdeas: 0,
    } as const;
    const oldRequest = vi.fn((method: string) => {
      if (method === "skills.proposals.historyScan") {
        return scan.promise;
      }
      if (method === "skills.proposals.historyStatus") {
        return Promise.resolve(scanStatus);
      }
      return Promise.resolve({
        schema: "openclaw.skill-workshop.proposals-manifest.v1",
        updatedAt: "2026-07-13T00:00:00.000Z",
        proposals: [],
      });
    });
    const page = document.createElement(
      "openclaw-skill-workshop-page",
    ) as SkillWorkshopPageTestElement;
    page.context = createContext(oldRequest);
    document.body.append(page);
    await page.updateComplete;
    await waitForSkillWorkshop(() =>
      expect(callsFor(oldRequest, "skills.proposals.list")).toHaveLength(1),
    );
    await waitForSkillWorkshop(() =>
      expect(callsFor(oldRequest, "skills.proposals.historyStatus")).toHaveLength(1),
    );
    await waitForSkillWorkshop(() =>
      expect(page.state?.skillWorkshopHistoryScan.loaded).toBe(true),
    );

    page.querySelector<HTMLButtonElement>(".sw-history__action button")?.click();
    await waitForSkillWorkshop(() =>
      expect(oldRequest).toHaveBeenCalledWith("skills.proposals.historyScan", {
        agentId: "research",
        direction: "older",
      }),
    );

    const newRequest = vi.fn(async (method: string) =>
      method === "skills.proposals.historyStatus"
        ? scanStatus
        : {
            schema: "openclaw.skill-workshop.proposals-manifest.v1",
            updatedAt: "2026-07-13T00:00:00.000Z",
            proposals: [],
          },
    );
    const newContext = createContext(newRequest);
    newContext.agentSelection.state.selectedId = "writer";
    page.context = newContext;
    page.requestUpdate();
    await page.updateComplete;

    scan.resolve({ ...scanStatus, hasScanned: true });
    await scan.promise;
    await Promise.resolve();

    expect(callsFor(oldRequest, "skills.proposals.list")).toHaveLength(1);
  });

  it("reloads history when an agent is reselected during a scan", async () => {
    const scan = deferred<unknown>();
    const scanStatus = {
      schema: "openclaw.skill-workshop.history-scan.v1",
      hasScanned: false,
      reviewedSessions: 0,
      ideasFound: 0,
      hasMore: false,
      lastScanReviewed: 0,
      lastScanIdeas: 0,
    } as const;
    const firstRequest = vi.fn((method: string) =>
      method === "skills.proposals.historyScan"
        ? scan.promise
        : Promise.resolve(
            method === "skills.proposals.historyStatus"
              ? scanStatus
              : {
                  schema: "openclaw.skill-workshop.proposals-manifest.v1",
                  updatedAt: "2026-07-13T00:00:00.000Z",
                  proposals: [],
                },
          ),
    );
    const page = document.createElement(
      "openclaw-skill-workshop-page",
    ) as SkillWorkshopPageTestElement;
    page.context = createContext(firstRequest);
    document.body.append(page);
    await page.updateComplete;
    await waitForSkillWorkshop(() =>
      expect(page.state?.skillWorkshopHistoryScan.loaded).toBe(true),
    );

    page.querySelector<HTMLButtonElement>(".sw-history__action button")?.click();
    await waitForSkillWorkshop(() =>
      expect(firstRequest).toHaveBeenCalledWith("skills.proposals.historyScan", {
        agentId: "research",
        direction: "older",
      }),
    );

    const otherContext = createContext(vi.fn(async () => scanStatus));
    otherContext.agentSelection.state.selectedId = "writer";
    page.context = otherContext;
    page.requestUpdate();
    await page.updateComplete;

    const firstReturnedStatus = deferred<unknown>();
    let returnedStatusCalls = 0;
    const returnedRequest = vi.fn((method: string): Promise<unknown> => {
      if (method === "skills.proposals.historyStatus") {
        returnedStatusCalls += 1;
        return returnedStatusCalls === 1
          ? firstReturnedStatus.promise
          : Promise.resolve({ ...scanStatus, hasScanned: true, reviewedSessions: 8 });
      }
      return Promise.resolve({
        schema: "openclaw.skill-workshop.proposals-manifest.v1",
        updatedAt: "2026-07-13T00:00:00.000Z",
        proposals: [],
      });
    });
    page.context = createContext(returnedRequest);
    page.requestUpdate();
    await page.updateComplete;
    await waitForSkillWorkshop(() =>
      expect(callsFor(returnedRequest, "skills.proposals.historyStatus")).toHaveLength(1),
    );

    scan.resolve({ ...scanStatus, hasScanned: true, reviewedSessions: 8 });
    await Promise.resolve();
    firstReturnedStatus.resolve(scanStatus);
    await waitForSkillWorkshop(() =>
      expect(callsFor(returnedRequest, "skills.proposals.historyStatus")).toHaveLength(2),
    );
    expect(page.state?.skillWorkshopHistoryScan.result?.reviewedSessions).toBe(8);
  });

  it("refreshes proposals after a history scan fails", async () => {
    const scanStatus = {
      schema: "openclaw.skill-workshop.history-scan.v1",
      hasScanned: false,
      reviewedSessions: 0,
      ideasFound: 0,
      hasMore: false,
      lastScanReviewed: 0,
      lastScanIdeas: 0,
    } as const;
    const request = vi.fn((method: string) => {
      if (method === "skills.proposals.historyScan") {
        return Promise.reject(new Error("late review failure"));
      }
      if (method === "skills.proposals.historyStatus") {
        return Promise.resolve(scanStatus);
      }
      return Promise.resolve({
        schema: "openclaw.skill-workshop.proposals-manifest.v1",
        updatedAt: "2026-07-13T00:00:00.000Z",
        proposals: [],
      });
    });
    const page = document.createElement(
      "openclaw-skill-workshop-page",
    ) as SkillWorkshopPageTestElement;
    page.context = createContext(request);
    document.body.append(page);
    await page.updateComplete;
    await waitForSkillWorkshop(() =>
      expect(callsFor(request, "skills.proposals.list")).toHaveLength(1),
    );
    await waitForSkillWorkshop(() =>
      expect(callsFor(request, "skills.proposals.historyStatus")).toHaveLength(1),
    );
    await waitForSkillWorkshop(() =>
      expect(page.state?.skillWorkshopHistoryScan.loaded).toBe(true),
    );

    page.querySelector<HTMLButtonElement>(".sw-history__action button")?.click();

    await waitForSkillWorkshop(() =>
      expect(request).toHaveBeenCalledWith("skills.proposals.historyScan", {
        agentId: "research",
        direction: "older",
      }),
    );
    await waitForSkillWorkshop(() =>
      expect(callsFor(request, "skills.proposals.historyStatus")).toHaveLength(2),
    );
    await waitForSkillWorkshop(() =>
      expect(callsFor(request, "skills.proposals.list")).toHaveLength(2),
    );
    expect(page.state?.skillWorkshopHistoryScan.error).toBe("late review failure");
  });
});

describe("SkillWorkshopPage self-learning toggle", () => {
  function createLoadedPage(runtimeConfig: ReturnType<typeof createRuntimeConfigStub>) {
    const loadedState = createSkillWorkshopState();
    loadedState.skillWorkshopAgentId = "research";
    loadedState.skillWorkshopLoaded = true;
    const page = document.createElement(
      "openclaw-skill-workshop-page",
    ) as SkillWorkshopPageTestElement;
    page.data = skillWorkshopRouteData(loadedState);
    page.context = createContext(
      vi.fn(async () => ({})),
      { runtimeConfig },
    );
    document.body.append(page);
    return page;
  }

  it("reflects the config value in the header toggle and hides it without a snapshot", async () => {
    const enabledPage = createLoadedPage(
      createRuntimeConfigStub({
        sourceConfig: { skills: { workshop: { autonomous: { enabled: true } } } },
      }),
    );
    await enabledPage.updateComplete;
    const toggle = enabledPage.querySelector<HTMLInputElement>(
      ".sw-header-controls input[aria-label='Toggle self-learning skill proposals']",
    );
    expect(toggle?.checked).toBe(true);
    document.body.replaceChildren();

    const noSnapshotPage = createLoadedPage(createRuntimeConfigStub());
    await noSnapshotPage.updateComplete;
    expect(
      noSnapshotPage.querySelector(
        ".sw-header-controls input[aria-label='Toggle self-learning skill proposals']",
      ),
    ).toBeNull();
  });

  it("enables self-learning from the empty-state pitch via a config merge patch", async () => {
    const patch = vi.fn(async () => true);
    const runtimeConfig = createRuntimeConfigStub({ sourceConfig: {}, patch });
    const page = createLoadedPage(runtimeConfig);
    await page.updateComplete;

    const button = page.querySelector<HTMLButtonElement>(".sw-empty-state__selflearn button");
    expect(button).not.toBeNull();
    button?.click();

    await waitForSkillWorkshop(() =>
      expect(patch).toHaveBeenCalledWith({
        raw: { skills: { workshop: { autonomous: { enabled: true } } } },
        note: "Enable Skill Workshop self-learning",
      }),
    );
    await waitForSkillWorkshop(() => expect(runtimeConfig.refresh).toHaveBeenCalledTimes(1));
  });

  it("refreshes a stale config snapshot and retries the self-learning toggle", async () => {
    const runtimeConfig = createRuntimeConfigStub({ sourceConfig: {} });
    runtimeConfig.patch = vi
      .fn()
      .mockImplementationOnce(async () => {
        runtimeConfig.state.lastError =
          "GatewayRequestError: config changed since last load; re-run config.get and retry";
        return false;
      })
      .mockImplementationOnce(async () => {
        runtimeConfig.state.lastError = null;
        return true;
      });
    runtimeConfig.refresh = vi.fn(async () => {
      runtimeConfig.state.lastError = null;
      if (runtimeConfig.patch.mock.calls.length === 2) {
        runtimeConfig.state.configSnapshot = {
          hash: "hash-3",
          sourceConfig: { skills: { workshop: { autonomous: { enabled: true } } } },
        };
      }
    });
    const page = createLoadedPage(runtimeConfig);
    await page.updateComplete;

    page.querySelector<HTMLButtonElement>(".sw-empty-state__selflearn button")?.click();

    await waitForSkillWorkshop(() => expect(runtimeConfig.patch).toHaveBeenCalledTimes(2));
    await waitForSkillWorkshop(() => expect(runtimeConfig.refresh).toHaveBeenCalledTimes(2));
    await page.updateComplete;
    expect(page.querySelector(".sw-error")).toBeNull();
    expect(
      page.querySelector<HTMLInputElement>(
        ".sw-header-controls input[aria-label='Toggle self-learning skill proposals']",
      )?.checked,
    ).toBe(true);
  });

  it("surfaces a patch failure and keeps the toggle off", async () => {
    const patch = vi.fn(async () => false);
    const runtimeConfig = createRuntimeConfigStub({ sourceConfig: {}, patch });
    const page = createLoadedPage(runtimeConfig);
    await page.updateComplete;

    page.querySelector<HTMLButtonElement>(".sw-empty-state__selflearn button")?.click();
    await waitForSkillWorkshop(() =>
      expect(page.querySelector(".sw-error")?.textContent).toContain(
        "Could not update the self-learning setting.",
      ),
    );
    expect(runtimeConfig.refresh).not.toHaveBeenCalled();
    const toggle = page.querySelector<HTMLInputElement>(
      ".sw-header-controls input[aria-label='Toggle self-learning skill proposals']",
    );
    expect(toggle?.checked).toBe(false);
  });
});
