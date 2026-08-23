import type { ReactiveController, ReactiveControllerHost } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { DraftGatewayState } from "./draft-gateway-state.ts";
import { DraftPlaceBrowser } from "./draft-place-browser.ts";
import type { NewSessionRouteData } from "./location.ts";
import { loadNewSessionPreference, patchNewSessionPreference } from "./preferences.ts";

class ControllerHost implements ReactiveControllerHost {
  readonly updateComplete = Promise.resolve(true);
  addController(_controller: ReactiveController) {}
  removeController(_controller: ReactiveController) {}
  requestUpdate() {}
}

afterEach(() => {
  localStorage.clear();
});

function createBrowser(request: (method: string) => Promise<unknown>, data?: NewSessionRouteData) {
  const host = new ControllerHost();
  const client = { request, recoveryScope: "principal-a", recoveryScopeReady: true };
  const context = {
    gateway: {
      connection: { gatewayUrl: "ws://gateway.example" },
      snapshot: {
        phase: "connected",
        client,
        hello: {
          auth: { role: "operator", scopes: ["operator.read"] },
          features: { methods: ["projects.list"] },
        },
      },
    },
    sessions: {
      state: {
        groupSettings: [{ name: "Client", cwd: "/workspace/client", worktree: false }],
      },
      groupsGeneration: () => 1,
      groupsStatus: () => "ready",
    },
  } as unknown as ApplicationContext;
  const gateway = new DraftGatewayState(
    host,
    () => ({
      context,
      data,
      isConnected: true,
      isAdmin: false,
      canStartAsDraft: false,
      visibility: "normal",
      cloudProfileId: "",
      pendingPlacement: { sessionKey: "", gatewayUrl: "", recoveryScope: "" },
      agentsHydrated: false,
    }),
    {
      requestUpdate: vi.fn(),
      updateComplete: () => Promise.resolve(),
      onInvalidate: vi.fn(),
      onVisibilityRetired: vi.fn(),
      onCloudProfileCleared: vi.fn(),
      onCloudState: vi.fn(),
      onPendingPlacementReset: vi.fn(),
      onRecoveryReady: vi.fn(),
      onAdoptAgentDefaults: vi.fn(),
    },
  );
  gateway.synchronize(context.gateway);
  const browser = new DraftPlaceBrowser(
    host,
    gateway,
    () => ({
      context,
      isAdmin: false,
    }),
    {
      requestUpdate: vi.fn(),
      onProjectMissing: vi.fn(),
      onSelectProject: vi.fn(),
      onApprovedListing: vi.fn(),
      querySelector: () => null,
      activeElement: () => null,
      body: () => null,
    },
  );
  return { browser, gateway };
}

describe("DraftPlaceBrowser", () => {
  it("tracks overlapping popover hides independently", () => {
    const { browser } = createBrowser(async () => ({}));

    browser.onPopoverHide("project");
    browser.onPopoverHide("where");

    expect(browser.popoverHiding("project")).toBe(true);
    expect(browser.popoverHiding("where")).toBe(true);

    browser.onPopoverAfterHide("project");
    expect(browser.popoverHiding("project")).toBe(false);
    expect(browser.popoverHiding("where")).toBe(true);

    browser.onPopoverAfterHide("where");
    expect(browser.popoverHiding("where")).toBe(false);
  });

  it.each([
    ["the Gateway omits recents", async () => ({ projects: [] })],
    [
      "projects.list fails",
      async () => {
        throw new Error("projects unavailable");
      },
    ],
  ])("keeps roster recents when %s", async (_label, request) => {
    const { browser } = createBrowser(request);

    await browser.refreshProjects();

    expect(
      browser.resolveProjectRecents({
        sessions: [{ execCwd: "/workspace/recent" }],
        workspace: "/workspace",
        workspaceRoots: ["/workspace"],
        isAdmin: false,
      }),
    ).toEqual([
      {
        kind: "folder",
        folder: "/workspace/recent",
        displayName: "recent",
      },
    ]);
  });
});

describe("DraftGatewayState", () => {
  it("keeps group route defaults isolated from ordinary New Session preferences", () => {
    patchNewSessionPreference("ws://gateway.example", "main", {
      folder: "/workspace/ordinary",
      worktree: true,
    });
    const { gateway } = createBrowser(async () => ({}), {
      agentId: "main",
      requestedAgentId: "main",
      catalogId: "",
      group: "Client",
      groupStatus: "resolved",
      groupCwd: "/workspace/client",
      groupWorktree: false,
      groupCatalogGeneration: 1,
      groupDefaultsStatus: "ready",
      model: "",
      catalogLabel: "",
      startTerminal: false,
    });

    expect(gateway.readPreference("main")).toBeNull();
    gateway.persistPreference("main", "/workspace", {
      folder: "/workspace/client",
      worktree: false,
    });
    expect(loadNewSessionPreference("ws://gateway.example", "main")).toEqual({
      folder: "/workspace/ordinary",
      worktree: true,
    });
  });
});
