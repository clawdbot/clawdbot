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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createContext(
  request: ReturnType<typeof vi.fn>,
  options?: {
    gatewaySubscribe?: (listener: (snapshot: ApplicationGatewaySnapshot) => void) => () => void;
    sessions?: ApplicationContext["sessions"];
  },
): ApplicationContext {
  const client = { request } as unknown as GatewayBrowserClient;
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    connected: true,
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
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("SkillWorkshopPage lifecycle", () => {
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

    await vi.waitFor(() =>
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
    expect(request).toHaveBeenCalledTimes(1);

    manifest.resolve({
      schema: "openclaw.skill-workshop.proposals-manifest.v1",
      updatedAt: "2026-07-08T00:00:00.000Z",
      proposals: [],
    });
    await vi.waitFor(() => expect(page.state?.skillWorkshopLoaded).toBe(true));
    expect(request).toHaveBeenCalledTimes(1);
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
    await vi.waitFor(() => expect(page.state?.skillWorkshopError).toContain("gateway offline"));

    page.requestUpdate();
    await page.updateComplete;
    page.requestUpdate();
    await page.updateComplete;
    expect(request).toHaveBeenCalledTimes(1);
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
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
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
    await vi.waitFor(() => expect(oldSessions.list).toHaveBeenCalledTimes(1));

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
});
