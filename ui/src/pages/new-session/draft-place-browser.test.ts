import type { ReactiveController } from "lit";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { DraftGatewayState } from "./draft-gateway-state.ts";
import { DraftPlaceBrowser } from "./draft-place-browser.ts";
import type { NewSessionRouteData } from "./location.ts";
import { PICKER_INPUT_DEBOUNCE_MS } from "./place-browser-state.ts";
import { loadNewSessionPreference, patchNewSessionPreference } from "./preferences.ts";
import { TestReactiveControllerHost } from "./reactive-controller-host.test-support.ts";

afterEach(() => {
  localStorage.clear();
});

function createBrowser(
  request: (method: string) => Promise<unknown>,
  data?: NewSessionRouteData,
  recoveryReady = true,
  isAdmin = false,
) {
  const host = new TestReactiveControllerHost();
  const controllers: ReactiveController[] = [];
  vi.spyOn(host, "addController").mockImplementation((controller) => controllers.push(controller));
  const client = {
    request,
    recoveryScope: recoveryReady ? "principal-a" : "",
    recoveryScopeReady: recoveryReady,
  };
  const onInvalidate = vi.fn((reset: boolean) => {
    browser?.resetProjects(reset);
  });
  const hello = {
    auth: { recoveryScope: "principal-a", role: "operator", scopes: ["operator.read"] },
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
      runtimeId: "",
    }),
    {
      requestUpdate: vi.fn(),
      updateComplete: () => Promise.resolve(),
      onInvalidate,
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
  const onSelectProject = vi.fn();
  const browser = new DraftPlaceBrowser(
    host,
    gateway,
    () => ({
      context,
      isAdmin,
    }),
    {
      requestUpdate: vi.fn(),
      onProjectMissing,
      onSelectProject,
      onApprovedListing: vi.fn(),
      querySelector: () => null,
      activeElement: () => null,
      body: () => null,
    },
  );
  onTestFinished(() => {
    gateway.disconnect();
    browser?.disconnect();
  });
  return {
    browser,
    onProjectMissing,
    onSelectProject,
    onInvalidate,
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
  it("keeps the current listing's repository probe while filtering its entries", async () => {
    const branches = createDeferred<{ repositoryStatus: "git" }>();
    const request = vi.fn(async (method: string) => {
      if (method === "worktrees.branches") {
        return branches.promise;
      }
      if (method === "fs.listDir") {
        return {
          path: "/workspace",
          home: "/home/test",
          entries: [{ name: "packages", path: "/workspace/packages" }],
        };
      }
      return { projects: [] };
    });
    const { browser } = createBrowser(request, undefined, true, true);
    browser.selectGatewayBrowser("/workspace");
    await waitForFast(() => expect(browser.browser.listing?.path).toBe("/workspace"));
    browser.browser.setDraft("/workspace/pa");
    branches.resolve({ repositoryStatus: "git" });
    await waitForFast(() => expect(browser.browserProjectPath).toBe("/workspace"));
  });

  it.each([
    "filtering",
    "navigation",
    "navigate away and back",
    "typed directory",
    "typed directory fails",
    "reopen",
  ])("selects a registered project only while its browser remains current (%s)", async (change) => {
    const project = {
      id: "registered-workspace",
      displayName: "Workspace",
      repoRoot: "/workspace",
    };
    const registration = createDeferred<typeof project>();
    let directoryPath = "/workspace";
    const request = vi.fn(async (method: string, params?: { path?: string }) => {
      if (method === "projects.register") {
        return registration.promise;
      }
      if (method === "worktrees.branches") {
        return { repositoryStatus: "git" };
      }
      if (method === "fs.listDir") {
        if (params?.path === "/elsewhere") {
          throw new Error("directory not found");
        }
        return {
          path: directoryPath,
          home: "/home/test",
          entries: [{ name: "packages", path: `${directoryPath}/packages` }],
        };
      }
      return { projects: [project] };
    });
    const { browser, onSelectProject } = createBrowser(request, undefined, true, true);
    browser.selectGatewayBrowser("/workspace");
    await waitForFast(() => expect(browser.browserProjectPath).toBe("/workspace"));
    const pending = browser.registerBrowserProject("/workspace");
    const initiallyBusy = browser.browserRegistering;
    const failedDirectory = change === "typed directory fails";
    if (failedDirectory) {
      vi.useFakeTimers();
    }
    try {
      if (change === "filtering") {
        browser.browser.setDraft("/workspace/pa");
      } else if (change === "navigation" || change === "navigate away and back") {
        directoryPath = "/other";
        await browser.browser.navigate(directoryPath);
        if (change === "navigate away and back") {
          directoryPath = "/workspace";
          await browser.browser.navigate(directoryPath);
          await waitForFast(() => expect(browser.browserProjectPath).toBe("/workspace"));
        }
      } else if (change === "typed directory" || failedDirectory) {
        browser.browser.setDraft("/elsewhere/x");
        if (failedDirectory) {
          await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
          expect(browser.browser.listing?.path).toBe("/workspace");
          expect(browser.browser.loading).toBe(false);
          expect(browser.browser.error).toBeNull();
          expect(browser.browserProjectPath).toBeNull();
        } else {
          // Flush request continuations while the directory debounce is still pending.
          await Promise.resolve();
        }
      } else {
        browser.close();
        browser.selectGatewayBrowser("/workspace");
        await waitForFast(() => expect(browser.browserProjectPath).toBe("/workspace"));
      }
      const stillBusy = browser.browserRegistering;
      const duplicate =
        change === "reopen" ? undefined : browser.registerBrowserProject(directoryPath);
      registration.resolve(project);
      await Promise.all([pending, duplicate]);

      expect(initiallyBusy).toBe(true);
      expect(stillBusy).toBe(change !== "reopen");
      expect(request.mock.calls.filter(([method]) => method === "projects.register")).toHaveLength(
        1,
      );
      expect(browser.browserRegistering).toBe(false);
      if (change === "filtering") {
        expect(onSelectProject).toHaveBeenCalledExactlyOnceWith(project.id);
      } else {
        expect(onSelectProject).not.toHaveBeenCalled();
      }
    } finally {
      registration.resolve(project);
      try {
        await pending;
      } finally {
        if (failedDirectory) {
          browser.browser.reset();
          vi.useRealTimers();
        }
      }
    }
  });

  it("keeps the register action available after a registration failure", async () => {
    const project = {
      id: "registered-workspace",
      displayName: "Workspace",
      repoRoot: "/workspace",
    };
    let registrations = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "projects.register") {
        registrations += 1;
        if (registrations === 1) {
          throw new Error("registry unavailable");
        }
        return project;
      }
      if (method === "worktrees.branches") {
        return { repositoryStatus: "git" };
      }
      if (method === "fs.listDir") {
        return {
          path: "/workspace",
          home: "/home/test",
          entries: [{ name: "packages", path: "/workspace/packages" }],
        };
      }
      return { projects: [project] };
    });
    const { browser, onSelectProject } = createBrowser(request, undefined, true, true);
    browser.selectGatewayBrowser("/workspace");
    await waitForFast(() => expect(browser.browserProjectPath).toBe("/workspace"));

    await browser.registerBrowserProject("/workspace");
    expect(browser.browser.error).toContain("registry unavailable");
    expect(browser.browserRegistering).toBe(false);
    expect(browser.browserProjectPath).toBe("/workspace");

    await browser.registerBrowserProject("/workspace");
    expect(registrations).toBe(2);
    expect(onSelectProject).toHaveBeenCalledExactlyOnceWith(project.id);
  });

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
  it.each(["disconnect", "credential", "gateway"])(
    "rejects late place catalogs synchronously after %s invalidation",
    async (change) => {
      const pending = createDeferred<{
        projects: { id: string }[];
        environments: { id: string }[];
        profiles: [];
      }>();
      const request = vi.fn(() => pending.promise);
      const fixture = createBrowser(request);
      fixture.hello.auth.scopes.push("operator.write");
      fixture.update();
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));

      if (change === "disconnect") {
        fixture.context.gateway.snapshot.phase = "reconnecting";
      }
      if (change === "credential") {
        fixture.hello.auth.recoveryScope = "principal-b";
      }
      if (change === "gateway") {
        fixture.context.gateway.connection.gatewayUrl = "ws://gateway-b.example";
      }
      // Retirement must happen in synchronize, before Lit schedules hostUpdate.
      fixture.gateway.synchronize(fixture.context.gateway);
      pending.resolve({
        projects: [{ id: "retired" }],
        environments: [{ id: "retired" }],
        profiles: [],
      });
      await pending.promise;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(fixture.browser.projects).toEqual([]);
      expect(fixture.gateway.environments).toBeNull();
    },
  );

  it("discovers places from authenticated hello without refetching or losing input during migration", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "system.info") {
        return { machineName: "Gateway A" };
      }
      if (method === "projects.list") {
        return { projects: [{ id: "project", displayName: "Project" }] };
      }
      return { environments: [], profiles: [] };
    });
    const fixture = createBrowser(request, undefined, false);
    fixture.hello.features.methods.push("system.info");
    fixture.hello.auth.scopes.push("operator.write");
    fixture.browser.browser.setDraft("/draft-folder");
    fixture.update();
    await waitForFast(() => expect(fixture.gateway.gatewayName).toBe("Gateway A"));
    await waitForFast(() => expect(fixture.browser.projects).toHaveLength(1));
    await waitForFast(() => expect(fixture.gateway.cloudProfilesReady).toBe(true));
    fixture.browser.selectProject({ kind: "local", id: "project" });

    fixture.client.recoveryScope = "principal-a";
    fixture.client.recoveryScopeReady = true;
    fixture.update();
    expect(fixture.onInvalidate).not.toHaveBeenCalled();
    expect(fixture.browser.browser.draft).toBe("/draft-folder");
    expect(fixture.browser.projectId).toBe("project");
    expect(request.mock.calls.filter(([method]) => method === "projects.list")).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "environments.list")).toHaveLength(1);

    fixture.context.gateway.snapshot.phase = "reconnecting";
    fixture.client.recoveryScopeReady = false;
    fixture.update();
    fixture.context.gateway.snapshot.phase = "connected";
    fixture.update();
    await waitForFast(() =>
      expect(request.mock.calls.filter(([method]) => method === "projects.list")).toHaveLength(2),
    );
    fixture.client.recoveryScopeReady = true;
    fixture.update();
    expect(fixture.browser.projectId).toBe("project");
    expect(request.mock.calls.filter(([method]) => method === "environments.list")).toHaveLength(2);

    fixture.hello.auth.recoveryScope = "principal-b";
    fixture.update();
    expect(fixture.onInvalidate).toHaveBeenLastCalledWith(true, "gateway-changed");
    expect(fixture.browser.projectId).toBe("");
  });

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
