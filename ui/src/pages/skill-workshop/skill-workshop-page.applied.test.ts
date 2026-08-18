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

function appliedProposals(): SkillWorkshopProposal[] {
  return [1, 2, 3, 4].map((updatedAt) => ({
    key: `proposal-${updatedAt}`,
    kind: updatedAt === 2 ? "create" : "update",
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
    bodyLoaded: updatedAt !== 1,
    isNew: false,
  }));
}

function inspectRequest() {
  return vi.fn(async (method: string, params?: unknown) => {
    if (method !== "skills.proposals.inspect") {
      return {};
    }
    expect(params).toEqual({ agentId: "research", proposalId: "proposal-1" });
    return {
      record: {
        id: "proposal-1",
        kind: "update",
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
}

async function mountAppliedPage(
  request: ReturnType<typeof inspectRequest>,
  proposals: SkillWorkshopProposal[],
): Promise<SkillWorkshopPageTestElement> {
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
  return page;
}

function historyItems(page: SkillWorkshopPageTestElement) {
  return page.querySelectorAll<HTMLButtonElement>(".sw-applied-history__item");
}

function modeButton(page: SkillWorkshopPageTestElement, label: string) {
  return [...page.querySelectorAll<HTMLButtonElement>(".sw-body-mode__button")].find(
    (button) => button.textContent?.trim() === label,
  );
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("Skill Workshop applied history", () => {
  it("renders one skill row and inspects a selected revision", async () => {
    const request = inspectRequest();
    const page = await mountAppliedPage(request, appliedProposals());

    expect(page.querySelectorAll(".sw-row")).toHaveLength(1);
    expect(page.querySelector(".sw-row")?.textContent).toContain("4 revisions");
    // The Applied tab counts grouped skills, matching the one-row-per-skill list.
    const appliedFilter = [...page.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Applied"),
    );
    expect(appliedFilter?.querySelector(".settings-count")?.textContent).toBe("1");
    await vi.waitFor(() => expect(historyItems(page)).toHaveLength(4), { interval: 1 });
    const history = historyItems(page);
    expect(history[0]?.textContent).toContain("Update");
    expect(history[0]?.textContent).toContain("v4");
    expect(history[2]?.textContent).toContain("Create");
    expect(history[2]?.textContent).toContain("v2");
    expect(history[3]?.textContent).toContain("Update");
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

  it("diffs a revision against its predecessor and toggles back to the full body", async () => {
    const page = await mountAppliedPage(inspectRequest(), appliedProposals());
    await vi.waitFor(() => expect(historyItems(page)).toHaveLength(4), { interval: 1 });

    await vi.waitFor(() => expect(page.querySelector(".sw-diff")).not.toBeNull(), { interval: 1 });
    const added = [...page.querySelectorAll(".sw-diff__row--add")].map((row) => row.textContent);
    const removed = [...page.querySelectorAll(".sw-diff__row--del")].map((row) => row.textContent);
    expect(added.join("")).toContain("Revision 4");
    expect(removed.join("")).toContain("Revision 3");
    expect(page.querySelector(".sw-diff__stat")?.textContent?.replace(/\s+/gu, "")).toBe("+1-1");

    modeButton(page, "Full body")?.click();
    await vi.waitFor(
      () => {
        expect(page.querySelector(".sw-diff")).toBeNull();
        expect(page.querySelector(".sw-body-card")?.textContent).toContain("Revision 4");
      },
      { interval: 1 },
    );
    expect(modeButton(page, "Full body")?.getAttribute("aria-pressed")).toBe("true");
    expect(modeButton(page, "Changes")?.getAttribute("aria-pressed")).toBe("false");
  });

  it.each([
    ["late-only", null, "The changed region is outside this preview."],
    ["partial", 500, "Some changed regions are outside this preview."],
  ])("labels %s revision comparisons as incomplete", async (_label, visibleIndex, message) => {
    const previousBody = Array.from({ length: 700 }, (_, index) => `line ${index}`);
    const latestBody = [...previousBody];
    if (visibleIndex !== null) {
      latestBody[visibleIndex] = "changed inside preview";
    }
    latestBody[650] = "changed outside preview";
    const proposals = appliedProposals();
    proposals[2]!.body = previousBody.join("\n");
    proposals[3]!.body = latestBody.join("\n");

    const page = await mountAppliedPage(inspectRequest(), proposals);
    await vi.waitFor(
      () => {
        expect(page.querySelector(".sw-diff__notice")?.textContent).toContain(message);
      },
      { interval: 1 },
    );

    expect(page.querySelector(".sw-diff__stat")).toBeNull();
    expect(page.querySelector(".sw-body-card")?.textContent).toContain("Full body");
  });

  it("shows the oldest revision as a full body with no diff toggle", async () => {
    const page = await mountAppliedPage(inspectRequest(), appliedProposals());
    await vi.waitFor(() => expect(historyItems(page)).toHaveLength(4), { interval: 1 });

    historyItems(page)[3]?.click();
    await vi.waitFor(
      () => {
        expect(page.querySelector(".sw-detail__body")?.textContent).toContain(
          "Revision 1 inspected",
        );
        expect(page.querySelector(".sw-body-mode")).toBeNull();
        expect(page.querySelector(".sw-diff")).toBeNull();
      },
      { interval: 1 },
    );
  });

  it("bounds large comparisons and keeps the full body available", async () => {
    const largeBody = "x".repeat(60_001);
    const proposals = appliedProposals();
    for (const proposal of proposals.slice(2)) {
      proposal.body = largeBody;
    }
    const page = await mountAppliedPage(inspectRequest(), proposals);

    await vi.waitFor(
      () => {
        expect(page.querySelector(".sw-diff")).toBeNull();
        expect(page.querySelector(".sw-body-card")?.textContent).toContain(
          "This comparison is too large to show here.",
        );
      },
      { interval: 1 },
    );

    modeButton(page, "Full body")?.click();
    await vi.waitFor(
      () => expect(page.querySelector(".sw-body-card")?.textContent).toContain(largeBody),
      { interval: 1 },
    );
  });
});
