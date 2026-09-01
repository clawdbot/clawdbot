import type { ReactiveController } from "lit";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { DraftGatewayState } from "./draft-gateway-state.ts";
import { DraftPlaceBrowser } from "./draft-place-browser.ts";
import type { NewSessionRouteData } from "./location.ts";
import { loadNewSessionPreference, patchNewSessionPreference } from "./preferences.ts";
import { TestReactiveControllerHost } from "./reactive-controller-host.test-support.ts";

afterEach(() => {
  localStorage.clear();
});

function createBrowser(request: (method: string) => Promise<unknown>, data?: NewSessionRouteData) {
  const host = new TestReactiveControllerHost();
  const controllers: ReactiveController[] = [];
  vi.spyOn(host, "addController").mockImplementation((controller) => controllers.push(controller));
  const client = { request, recoveryScope: "principal-a", recoveryScopeReady: true };
  const hello = {
    auth: { role: "operator", scopes: ["operator.read"] },
    features: { methods: ["projects.list"] },
  };
  const context = {
    gateway: {
      connection: { gatewayUrl: "ws://gateway.example" },
      snapshot: {
        phase: "connected",
        client,
        hello,
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
  const onProjectMissing = vi.fn();
  const browser = new DraftPlaceBrowser(
    host,
    gateway,
    () => ({
      context,
      isAdmin: false,
    }),
    {
      requestUpdate: vi.fn(),
      onProjectMissing,
      onSelectProject: vi.fn(),
      onApprovedListing: vi.fn(),
      querySelector: () => null,
      activeElement: () => null,
      body: () => null,
    },
  );
  onTestFinished(() => {
    gateway.disconnect();
    browser.disconnect();
  });
  return {
    browser,
    onProjectMissing,
    gateway,
    client,
    context,
    hello,
    update() {
      gateway.synchronize(context.gateway);
      for (const controller of controllers) {
        controller.hostUpdate?.();
      }
    },
  };
}

describe("DraftPlaceBrowser", () => {
  it.each(["loaded", "pending"])(
    "reloads the project catalog after an owner reset without reconnecting (%s)",
    async (initial) => {
      const retired = { id: "retired", displayName: "Retired", repoRoot: "/retired" };
      const current = { id: "current", displayName: "Current", repoRoot: "/current" };
      const pending = createDeferred<{ projects: (typeof retired)[] }>();
      const request = vi.fn(() => pending.promise);
      const fixture = createBrowser(request);
      const previous = fixture.browser.refreshProjects();
      if (initial === "loaded") {
        pending.resolve({ projects: [retired] });
        await previous;
      }

      request.mockResolvedValue({ projects: [current] });
      fixture.browser.resetProjects();
      fixture.update();
      await waitForFast(() => expect(fixture.browser.projects).toEqual([current]));
      pending.resolve({ projects: [retired] });
      await previous;
      expect(fixture.browser.projects).toEqual([current]);
    },
  );

  it.each(["disconnect", "failure"])(
    "retains the selected project until a catalog confirms its removal (%s)",
    async (unavailable) => {
      const project = { id: "project", displayName: "Project", repoRoot: "/project" };
      const request = vi.fn(async () => ({ projects: [project] }));
      const fixture = createBrowser(request);
      await fixture.browser.refreshProjects();
      fixture.browser.selectProject({ kind: "local", id: project.id });

      if (unavailable === "disconnect") {
        fixture.context.gateway.snapshot.phase = "reconnecting";
        fixture.update();
      } else {
        request.mockRejectedValue(new Error("projects unavailable"));
      }
      await fixture.browser.refreshProjects();
      expect(fixture.browser.selectedProject()).toEqual(project);
      expect(fixture.onProjectMissing).not.toHaveBeenCalled();

      fixture.context.gateway.snapshot.phase = "connected";
      request.mockResolvedValue({ projects: [] });
      fixture.update();
      await fixture.browser.refreshProjects();
      expect(fixture.onProjectMissing).toHaveBeenCalled();
    },
  );

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
  it("retains a discovered name when the same connection's recovery scope arrives", async () => {
    const fixture = createBrowser(async () => ({ machineName: "Gateway A" }));
    fixture.hello.features.methods.push("system.info");
    fixture.client.recoveryScopeReady = false;
    fixture.update();
    await waitForFast(() => expect(fixture.gateway.gatewayName).toBe("Gateway A"));

    fixture.client.recoveryScope = "resolved-principal";
    fixture.client.recoveryScopeReady = true;
    fixture.update();
    expect(fixture.gateway.gatewayName).toBe("Gateway A");
  });

  it("hides a disconnected name until the same client's new discovery completes", async () => {
    const pending = createDeferred<{ machineName: string }>();
    const request = vi.fn(async () => ({ machineName: "Gateway A" }));
    const fixture = createBrowser(request);
    fixture.hello.features.methods.push("system.info");
    fixture.update();
    await waitForFast(() => expect(fixture.gateway.gatewayName).toBe("Gateway A"));

    fixture.context.gateway.snapshot.phase = "reconnecting";
    fixture.update();
    expect(fixture.gateway.gatewayName).toBe("");
    request.mockImplementation(() => pending.promise);
    fixture.context.gateway.snapshot.phase = "connected";
    fixture.update();
    expect(fixture.gateway.gatewayName).toBe("");
    pending.resolve({ machineName: "Gateway B" });
    await waitForFast(() => expect(fixture.gateway.gatewayName).toBe("Gateway B"));
  });

  it("ignores a late name from the replaced client", async () => {
    const oldName = createDeferred<{ machineName: string }>();
    const newName = createDeferred<{ machineName: string }>();
    const fixture = createBrowser(() => oldName.promise);
    fixture.hello.features.methods.push("system.info");
    fixture.update();
    fixture.context.gateway.snapshot.client = createTestGatewayClient(() => newName.promise);
    fixture.update();
    oldName.resolve({ machineName: "Retired Gateway" });
    // Flush the retired request's promise continuations before checking the active owner.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(fixture.gateway.gatewayName).toBe("");
    newName.resolve({ machineName: "Active Gateway" });
    await waitForFast(() => expect(fixture.gateway.gatewayName).toBe("Active Gateway"));
  });

  it.each([
    { advertised: false, response: { machineName: "Hidden Gateway" }, name: "" },
    { advertised: true, response: { hostname: "host.example" }, name: "host" },
    { advertised: true, response: null, name: "" },
  ])(
    "settles name discovery with advertisement $advertised and response $response",
    async ({ advertised, response, name }) => {
      let current: typeof response | { machineName: string } = { machineName: "Current Gateway" };
      const request = vi.fn(async (_method: string) => {
        if (!current) {
          throw new Error("System info unavailable");
        }
        return current;
      });
      const fixture = createBrowser(request);
      fixture.hello.features.methods.push("system.info");
      fixture.update();
      await waitForFast(() => expect(fixture.gateway.gatewayName).toBe("Current Gateway"));
      current = response;
      fixture.context.gateway.snapshot.phase = "reconnecting";
      fixture.update();
      fixture.hello.features.methods = advertised ? ["system.info"] : [];
      fixture.context.gateway.snapshot.phase = "connected";
      fixture.update();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      await waitForFast(() => expect(fixture.gateway.gatewayName).toBe(name));
      expect(request.mock.calls.filter(([method]) => method === "system.info")).toHaveLength(
        advertised ? 2 : 1,
      );
    },
  );

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
