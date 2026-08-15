import type { ReactiveController, ReactiveControllerHost } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { DraftGatewayState } from "./draft-gateway-state.ts";
import { DraftPlaceBrowser } from "./draft-place-browser.ts";

class ControllerHost implements ReactiveControllerHost {
  readonly updateComplete = Promise.resolve(true);
  addController(_controller: ReactiveController) {}
  removeController(_controller: ReactiveController) {}
  requestUpdate() {}
}

function createBrowser(request: (method: string) => Promise<unknown>) {
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
  } as unknown as ApplicationContext;
  const gateway = new DraftGatewayState(
    host,
    () => ({
      context,
      data: undefined,
      isConnected: true,
      isAdmin: false,
      canStartAsDraft: false,
      visibility: "normal",
      cloudProfileId: "",
      pendingCloud: { sessionKey: "", gatewayUrl: "", recoveryScope: "" },
      agentsHydrated: false,
    }),
    {
      requestUpdate: vi.fn(),
      updateComplete: () => Promise.resolve(),
      onInvalidate: vi.fn(),
      onVisibilityRetired: vi.fn(),
      onCloudProfileCleared: vi.fn(),
      onCloudState: vi.fn(),
      onPendingCloudReset: vi.fn(),
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
      nodes: [],
      folder: "",
      execNode: "",
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
  return browser;
}

describe("DraftPlaceBrowser", () => {
  it.each([
    ["the Gateway omits recents", async () => ({ projects: [] })],
    [
      "projects.list fails",
      async () => {
        throw new Error("projects unavailable");
      },
    ],
  ])("keeps roster recents when %s", async (_label, request) => {
    const browser = createBrowser(request);

    await browser.refreshProjects();

    expect(
      browser.resolveProjectRecents({
        sessions: [{ execCwd: "/workspace/recent" }],
        workspace: "/workspace",
        workspaceRoots: ["/workspace"],
        execNodes: [],
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
