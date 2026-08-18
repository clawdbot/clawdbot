import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { SkillWorkshopProposal } from "../../lib/skill-workshop/index.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createSkillWorkshopState, skillWorkshopRouteData } from "./proposals.ts";
import type { SkillWorkshopRouteData, SkillWorkshopState } from "./proposals.ts";
import "./skill-workshop-page.ts";

type SkillWorkshopPageTestElement = HTMLElement & {
  context: ApplicationContext;
  data?: SkillWorkshopRouteData;
  state?: SkillWorkshopState;
  updateComplete: Promise<boolean>;
  requestUpdate: () => void;
};

function createContext(request: ReturnType<typeof vi.fn>): ApplicationContext {
  // SAFETY: this test client implements the only Gateway method exercised by the page.
  const client = { request } as unknown as GatewayBrowserClient;
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: gatewayHelloForMethods([]),
    assistantAgentId: "research",
    sessionKey: "global",
    lastError: null,
    lastErrorCode: null,
  };
  const subscribe = () => () => undefined;
  // SAFETY: the page reads only the ApplicationContext fields supplied by this fixture.
  return {
    basePath: "",
    gateway: { snapshot, subscribe },
    config: {
      current: { assistantIdentity: { name: "OpenClaw" } },
      subscribe,
    },
    agents: { state: { agentsList: null } },
    agentSelection: {
      state: { selectedId: "research" },
      subscribe,
    },
    agentIdentity: {
      get: () => ({ agentId: "research", name: "Research" }),
      subscribe,
    },
    sessions: { state: { result: null, loading: false } },
    skillWorkshopRevision: { prepare: vi.fn() },
    runtimeConfig: {
      state: { configSnapshot: null, configLoading: false, lastError: null },
      ensureLoaded: vi.fn(async () => undefined),
      refresh: vi.fn(async () => undefined),
      patch: vi.fn(async () => true),
      subscribe,
    },
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("Skill Workshop applied history", () => {
  it("renders one skill row and inspects a selected revision", async () => {
    const timestamps = [1, 2, 3, 4];
    const proposals = timestamps.map(
      (updatedAt): SkillWorkshopProposal => ({
        key: `proposal-${updatedAt}`,
        slug: "release-sanity",
        name: `${updatedAt === 1 ? "Create" : "Update"} release-sanity`,
        oneLine: `Revision ${updatedAt} description`,
        body: updatedAt === 1 ? "" : `## Workflow\n- Revision ${updatedAt}`,
        status: "applied",
        version: 1,
        revisionHash: null,
        createdAt: updatedAt,
        updatedAt,
        recencyGroup: "today",
        ageLabel: `${updatedAt}h`,
        supportFiles: [],
        isNew: false,
      }),
    );
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method !== "skills.proposals.inspect") {
        return {};
      }
      expect(params).toEqual({ agentId: "research", proposalId: "proposal-1" });
      return {
        record: {
          id: "proposal-1",
          kind: "create",
          status: "applied",
          title: "Create release-sanity",
          description: "Revision 1 description",
          createdAt: new Date(1).toISOString(),
          updatedAt: new Date(1).toISOString(),
          proposedVersion: "v1",
          draftHash: "a".repeat(64),
          target: { skillName: "Release sanity", skillKey: "release-sanity" },
        },
        revisionHash: "b".repeat(64),
        content: "## Workflow\n- Revision 1 inspected",
        supportFiles: [],
      };
    });
    const loadedState = createSkillWorkshopState();
    loadedState.skillWorkshopAgentId = "research";
    loadedState.skillWorkshopLoaded = true;
    loadedState.skillWorkshopProposals = proposals;
    loadedState.skillWorkshopSelectedKey = "proposal-4";
    // SAFETY: the registered custom element exposes the tested reactive page fields.
    const page = document.createElement(
      "openclaw-skill-workshop-page",
    ) as SkillWorkshopPageTestElement;
    page.data = skillWorkshopRouteData(loadedState);
    page.context = createContext(request);
    document.body.append(page);
    await page.updateComplete;
    if (!page.state) {
      throw new Error("Expected Skill Workshop state");
    }
    page.state.skillWorkshopMode = "board";
    page.state.skillWorkshopStatusFilter = "applied";
    page.requestUpdate();
    await page.updateComplete;

    expect(page.querySelectorAll(".sw-row")).toHaveLength(1);
    expect(page.querySelector(".sw-row")?.textContent).toContain("4 revisions");
    const history = page.querySelectorAll<HTMLButtonElement>(".sw-applied-history__item");
    expect(history).toHaveLength(4);
    expect(history[0]?.textContent).toContain("Update");
    expect(history[0]?.textContent).toContain("v4");
    expect(history[3]?.textContent).toContain("Create");
    expect(history[3]?.textContent).toContain("v1");

    history[3]?.click();
    await vi.waitFor(
      () => {
        const inspectCalls = request.mock.calls.filter(
          ([calledMethod]) => calledMethod === "skills.proposals.inspect",
        );
        expect(inspectCalls).toHaveLength(1);
        expect(page.querySelector(".sw-detail__body")?.textContent).toContain(
          "Revision 1 inspected",
        );
      },
      { interval: 1 },
    );
  });
});
