import { describe, expect, it, vi } from "vitest";
import type { WorktreesBranchesResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { DraftCloudProfile } from "./discovery.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import { DraftPlaceBrowser } from "./draft-place-browser.ts";
import { DraftPlaceState } from "./draft-place-state.ts";
import type { NewSessionRouteData } from "./location.ts";
import type { NewSessionPreference } from "./preferences.ts";
import { TestReactiveControllerHost } from "./reactive-controller-host.test-support.ts";

const REMOTE_PROJECT = {
  identity: "openclaw/openclaw",
  cloneUrl: "https://github.com/openclaw/openclaw.git",
};

function createRepositoryFixture(
  options: {
    workspaceGit?: boolean;
    unavailable?: boolean;
    data?: NewSessionRouteData;
  } = {},
) {
  const requestUpdate = vi.fn();
  const persistPreference = vi.fn();
  const readPreference = vi.fn<() => NewSessionPreference>(() => ({ worktree: true }));
  const request = vi.fn<(method: string) => Promise<unknown>>(async (method) =>
    method === "fs.listDir"
      ? { path: "/plain", entries: [] }
      : { repositoryStatus: options.unavailable ? "unavailable" : "not_git", branches: [] },
  );
  const context = {
    gateway: {
      snapshot: {
        phase: "connected",
        client: { request },
        hello: { auth: { role: "operator", scopes: ["operator.admin"] } },
      },
    },
    agents: {
      state: {
        agentsList: {
          defaultId: "main",
          agents: [
            { id: "main", workspace: "/workspace", workspaceGit: options.workspaceGit ?? false },
          ],
        },
      },
    },
    sessions: { state: { result: null } },
  } as unknown as ApplicationContext;
  const gateway = {
    cloudProfiles: [{ id: "aws", providerId: "crabbox" }],
    cloudProfilesReady: true,
    environments: [
      {
        id: "node:desktop",
        type: "node",
        status: "available",
        sessionHost: true,
        workerSlots: { total: 1, available: 1 },
      },
    ],
    persistPreference,
    readPreference,
  } as unknown as DraftGatewayState;
  const browser = new DraftPlaceBrowser(
    new TestReactiveControllerHost(),
    gateway,
    () => ({ context, isAdmin: true }),
    {
      requestUpdate,
      onProjectMissing: vi.fn(),
      onSelectProject: vi.fn(),
      onApprovedListing: vi.fn(),
      querySelector: () => null,
      activeElement: () => null,
      body: () => null,
    },
  );
  const state = new DraftPlaceState(
    gateway,
    browser,
    () => ({ context, data: options.data, submitting: false, pendingPlacementSessionKey: "" }),
    { requestUpdate, onError: vi.fn(), onClearError: vi.fn() },
  );
  return { state, browser, persistPreference, readPreference, request, requestUpdate };
}

describe("DraftPlaceState repository selection", () => {
  it.each(["git", "unavailable", "rejected"] as const)(
    "preserves an edited base branch through reconnect discovery (%s)",
    async (result) => {
      const { state, request, persistPreference } = createRepositoryFixture({ workspaceGit: true });
      const git = { repositoryStatus: "git", branches: [], defaultBranch: "main" };
      request.mockResolvedValue(git);
      state.adoptAgentDefaults();
      await vi.waitFor(() => expect(state.repository.kind).toBe("git"));
      state.setBaseRef("my-branch");
      state.setWorktreeName("my-checkout");

      state.invalidateGatewayDiscovery(false);
      expect(state.baseRef).toBe("my-branch");
      const discovery = createDeferred<WorktreesBranchesResult>();
      request.mockReturnValue(discovery.promise);
      state.adoptAgentDefaults();
      expect(state.baseRef).toBe("my-branch");
      if (result === "rejected") {
        discovery.reject(new Error("Git unavailable"));
      } else {
        discovery.resolve({ ...git, repositoryStatus: result });
      }
      await vi.waitFor(() =>
        expect(state.repository.kind).toBe(result === "git" ? "git" : "unavailable"),
      );
      expect(state.baseRef).toBe("my-branch");
      expect(state.worktreeName).toBe("my-checkout");

      state.invalidateGatewayDiscovery(false);
      request.mockResolvedValue(git);
      state.adoptAgentDefaults();
      await vi.waitFor(() => expect(state.repository.kind).toBe("git"));
      expect(state.baseRef).toBe("my-branch");
      state.clearProjectSelection();
      await vi.waitFor(() => expect(state.repository.kind).toBe("git"));
      expect(state.baseRef).toBe("my-branch");
      state.applyFolder("/another-repo");
      await vi.waitFor(() => expect(state.repository.kind).toBe("git"));
      expect(state.baseRef).toBe("main");
      expect(state.worktreeName).toBe("");
      expect(persistPreference).toHaveBeenCalledWith("main", "/workspace", {
        baseRef: "",
        worktreeName: "",
      });
    },
  );

  it("preserves edited details when identity preferences arrive after discovery", async () => {
    const { state, request, readPreference } = createRepositoryFixture({ workspaceGit: true });
    request.mockResolvedValue({ repositoryStatus: "git", branches: [], defaultBranch: "main" });
    state.adoptAgentDefaults();
    await vi.waitFor(() => expect(state.repository.kind).toBe("git"));
    state.setBaseRef("my-branch");
    state.setWorktreeName("my-checkout");

    readPreference.mockReturnValue({
      worktree: true,
      baseRef: "saved-branch",
      worktreeName: "saved-checkout",
    });
    state.adoptAgentDefaults();

    expect(state.baseRef).toBe("my-branch");
    expect(state.worktreeName).toBe("my-checkout");
  });

  it.each([false, true])(
    "adopts a preference arriving during repository discovery without overwriting user edits (%s)",
    async (edited) => {
      const { state, request, readPreference } = createRepositoryFixture({ workspaceGit: true });
      const discovery = createDeferred<WorktreesBranchesResult>();
      request.mockImplementation(async (method) =>
        method === "worktrees.branches" ? discovery.promise : {},
      );
      state.adoptAgentDefaults();
      expect(state.repository.kind).toBe("checking");

      readPreference.mockReturnValue({ worktree: true, baseRef: "release/next" });
      state.adoptAgentDefaults();
      if (edited) {
        state.setBaseRef("my-branch");
      }
      discovery.resolve({ repositoryStatus: "git", branches: [], defaultBranch: "main" });

      await vi.waitFor(() => expect(state.repository.kind).toBe("git"));
      expect(state.baseRef).toBe(edited ? "my-branch" : "release/next");
      expect(request.mock.calls.filter(([method]) => method === "worktrees.branches")).toHaveLength(
        1,
      );
    },
  );

  it.each([false, true])(
    "finishes restoring a saved cloud preference for a non-Git workspace (unavailable: %s)",
    async (unavailable) => {
      const { state, readPreference, persistPreference } = createRepositoryFixture({
        workspaceGit: unavailable,
        unavailable,
      });
      readPreference.mockReturnValue({ where: { kind: "cloud", id: "aws" } });
      state.adoptAgentDefaults();
      await vi.waitFor(() =>
        expect(state.repository.kind).toBe(unavailable ? "unavailable" : "direct"),
      );

      state.restorePreferenceSelections();

      expect(state.placementPreferenceReady).toBe(true);
      expect(state.cloudProfileId).toBe("");
      expect(state.worktree).toBe(false);
      if (unavailable) {
        expect(persistPreference).not.toHaveBeenCalled();
      } else {
        expect(persistPreference).toHaveBeenCalledWith("main", "/workspace", {
          where: { kind: "local" },
        });
      }
    },
  );

  it.each([false, true])(
    "reconciles group defaults with cached repository discovery (unavailable: %s)",
    async (unavailable) => {
      const { state } = createRepositoryFixture({
        workspaceGit: unavailable,
        unavailable,
        data: {
          agentId: "main",
          requestedAgentId: "main",
          catalogId: "",
          model: "",
          catalogLabel: "",
          startTerminal: false,
          group: "Notes",
          groupStatus: "resolved",
          groupCwd: "/workspace",
          groupWorktree: true,
        },
      });
      state.adoptAgentDefaults();
      await vi.waitFor(() => expect(state.placementPreferenceReady).toBe(true));
      expect(state.worktree).toBe(false);

      state.adoptGroupDefaults();

      expect(state.placementPreferenceReady).toBe(true);
      expect(state.worktree).toBe(false);
      expect(state.worktreeAvailable()).toBe(false);
    },
  );

  it.each([false, true])(
    "does not offer worktrees for an unverified workspace (project selected: %s)",
    async (projectSelected) => {
      const { state, browser } = createRepositoryFixture({ workspaceGit: true, unavailable: true });
      if (projectSelected) {
        vi.spyOn(browser, "selectedProject").mockReturnValue({
          id: "workspace",
          displayName: "Workspace",
          repoRoot: "/workspace",
          source: "workspace",
        });
        browser.selectProject({ kind: "local", id: "workspace" });
      }

      state.adoptAgentDefaults();

      expect(state.repository.kind).toBe("checking");
      expect(state.worktreeAvailable()).toBe(false);
      await vi.waitFor(() => expect(state.repository.kind).toBe("unavailable"));
      expect(state.worktreeAvailable()).toBe(false);
      expect(state.worktree).toBe(false);
      expect(state.placementPreferenceReady).toBe(true);
    },
  );

  it("selects a checkout explicitly without resetting the typed base branch", () => {
    const { state, persistPreference, requestUpdate, request } = createRepositoryFixture();
    state.selectRemoteProject(REMOTE_PROJECT);

    expect(state.repository).toEqual({ kind: "pending-clone", cloneUrl: REMOTE_PROJECT.cloneUrl });
    expect(state.worktreeAvailable()).toBe(true);
    expect(state.worktree).toBe(false);
    state.selectWorktree(true);
    expect(state.worktree).toBe(true);
    state.setBaseRef("release");
    state.selectWorktree(false);
    expect(state.worktree).toBe(false);
    state.selectWorktree(true);
    expect(state.worktree).toBe(true);
    expect(state.baseRef).toBe("release");
    persistPreference.mockClear();
    requestUpdate.mockClear();
    request.mockClear();
    state.selectWorktree(true);
    expect(state.worktree).toBe(true);
    expect(persistPreference).not.toHaveBeenCalled();
    expect(requestUpdate).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["device", "cloud"] as const)(
    "preserves a remote project and base ref without a Gateway worktree when switching to %s placement",
    (placement) => {
      const { state, browser, persistPreference, requestUpdate } = createRepositoryFixture();
      state.selectRemoteProject(REMOTE_PROJECT);
      state.setBaseRef("release");
      if (placement === "device") {
        state.selectDevice("desktop");
        expect(state.deviceId).toBe("desktop");
      } else {
        state.selectCloudProfile("aws");
        expect(state.cloudProfileId).toBe("aws");
      }
      expect(browser.remoteProject).toEqual(REMOTE_PROJECT);
      expect(state.worktree).toBe(false);
      expect(state.remoteRepository).toEqual({ url: REMOTE_PROJECT.cloneUrl, ref: "release" });
      expect(state.baseRef).toBe("release");
      persistPreference.mockClear();
      requestUpdate.mockClear();
      state.selectWorktree(false);
      expect(state.worktree).toBe(false);
      expect(persistPreference).not.toHaveBeenCalled();
      expect(requestUpdate).not.toHaveBeenCalled();
    },
  );

  it.each(["/workspace", "/plain"])(
    "rejects and persists worktree off for a non-git folder %s",
    async (folder) => {
      const { state, persistPreference, requestUpdate } = createRepositoryFixture();
      state.adoptAgentDefaults();
      state.applyFolder(folder);
      await vi.waitFor(() => expect(state.repository.kind).toBe("direct"));
      persistPreference.mockClear();
      requestUpdate.mockClear();

      state.selectWorktree(true);

      await vi.waitFor(() => expect(state.worktree).toBe(false));
      expect(state.worktreeAvailable()).toBe(false);
      expect(persistPreference).toHaveBeenLastCalledWith("main", "/workspace", {
        worktree: false,
      });
      expect(requestUpdate).toHaveBeenCalled();
    },
  );

  it("restores a preferred worktree when a remote project awaits cloning", () => {
    const { state, browser } = createRepositoryFixture();
    browser.selectProject({ kind: "remote", project: REMOTE_PROJECT });

    state.adoptAgentDefaults();

    expect(state.worktree).toBe(true);
    expect(state.placementPreferenceReady).toBe(true);
  });
});

describe("DraftPlaceState cloud machine selection", () => {
  it("uses each profile default and retains only non-default overrides per destination", () => {
    const requestUpdate = vi.fn();
    const gateway = {
      cloudProfiles: [
        {
          id: "aws",
          providerId: "crabbox",
          machines: [
            { id: "standard", label: "Standard", default: true },
            { id: "fast", label: "Fast" },
          ],
        },
        {
          id: "hetzner",
          providerId: "crabbox",
          machines: [
            { id: "large", label: "Large", default: true },
            { id: "beast", label: "Beast" },
          ],
        },
      ],
      persistPreference: vi.fn(),
    } as unknown as DraftGatewayState;
    const browser = {
      close: vi.fn(),
      projectId: "",
      remoteProject: null,
      selectedProject: vi.fn(() => undefined),
    } as unknown as DraftPlaceBrowser;
    const state = new DraftPlaceState(
      gateway,
      browser,
      () => ({
        context: undefined,
        data: undefined,
        submitting: false,
        pendingPlacementSessionKey: "",
      }),
      { requestUpdate, onError: vi.fn(), onClearError: vi.fn() },
    );

    state.applyPendingPlacement({ agentId: "main", profileId: "aws" });
    expect(state.machineClass).toBe("");

    state.cloudMachines.select("aws", "fast", gateway.cloudProfiles);
    expect(state.machineClass).toBe("fast");

    vi.spyOn(state, "worktreeAvailable").mockReturnValue(true);
    state.selectCloudProfile("hetzner");
    expect(state.machineClass).toBe("");
    state.cloudMachines.select("hetzner", "beast", gateway.cloudProfiles);
    expect(state.machineClass).toBe("beast");

    state.selectCloudProfile("aws");
    expect(state.machineClass).toBe("fast");
    state.cloudMachines.select("aws", "standard", gateway.cloudProfiles);
    expect(state.machineClass).toBe("");
    expect(requestUpdate).toHaveBeenCalled();
  });

  it("restores the exact recovered choice instead of retaining a stale draft override", () => {
    const cloudProfiles: DraftCloudProfile[] = [
      {
        id: "aws",
        providerId: "crabbox",
        machines: [
          { id: "standard", label: "Standard", default: true },
          { id: "fast", label: "Fast" },
        ],
      },
    ];
    const state = new DraftPlaceState(
      {
        cloudProfiles,
      } as unknown as DraftGatewayState,
      {} as DraftPlaceBrowser,
      () => ({
        context: undefined,
        data: undefined,
        submitting: false,
        pendingPlacementSessionKey: "",
      }),
      { requestUpdate: vi.fn(), onError: vi.fn(), onClearError: vi.fn() },
    );

    state.applyPendingPlacement({ agentId: "main", profileId: "aws", machineClass: "fast" });
    expect(state.machineClass).toBe("fast");

    cloudProfiles.splice(0, cloudProfiles.length, { id: "aws", providerId: "crabbox" });
    expect(state.machineClass).toBe("fast");

    state.applyPendingPlacement({ agentId: "main", profileId: "aws" });
    expect(state.machineClass).toBe("");
  });

  it.each([
    {
      name: "preserves a recovered one-mode cloud profile when the runtime becomes incompatible",
      executionModes: ["worker-turn"] as const,
      selectedByUser: false,
    },
    {
      name: "preserves an explicitly chosen one-mode cloud profile when the runtime becomes incompatible",
      executionModes: ["worker-turn"] as const,
      selectedByUser: true,
    },
    {
      name: "retains a two-mode cloud profile and its machine when the runtime changes",
      executionModes: ["worker-turn", "remote-exec"] as const,
      selectedByUser: false,
    },
  ])("$name", ({ executionModes, selectedByUser }) => {
    const persistPreference = vi.fn();
    const cloudProfiles: DraftCloudProfile[] = [
      {
        id: "aws",
        providerId: "crabbox",
        executionModes,
        machines: [
          { id: "standard", label: "Standard", default: true },
          { id: "fast", label: "Fast" },
        ],
      },
    ];
    const state = new DraftPlaceState(
      { cloudProfiles, persistPreference } as unknown as DraftGatewayState,
      {
        clearProjectSelection: vi.fn(),
        close: vi.fn(),
        projectId: "",
        remoteProject: null,
        selectedProject: vi.fn(() => undefined),
      } as unknown as DraftPlaceBrowser,
      () => ({
        context: undefined,
        data: undefined,
        submitting: false,
        pendingPlacementSessionKey: "",
      }),
      { requestUpdate: vi.fn(), onError: vi.fn(), onClearError: vi.fn() },
    );
    const resolveRuntime = vi.spyOn(state.modelControl, "resolveAgentRuntime");
    resolveRuntime.mockReturnValue({
      id: "openclaw",
      cloudPlacementSupported: true,
      cloudPlacementExecutionMode: "worker-turn",
      source: "model",
    });
    if (selectedByUser) {
      vi.spyOn(state, "isAdmin").mockReturnValue(true);
      vi.spyOn(state, "worktreeAvailable").mockReturnValue(true);
      state.selectCloudProfile("aws");
      state.cloudMachines.select("aws", "fast", cloudProfiles);
      persistPreference.mockClear();
    } else {
      state.applyPendingPlacement({ agentId: "main", profileId: "aws", machineClass: "fast" });
    }
    state.restorePreferenceSelections();
    expect(state.cloudProfileId).toBe("aws");
    expect(state.machineClass).toBe("fast");

    resolveRuntime.mockReturnValue({
      id: "codex",
      cloudPlacementSupported: true,
      cloudPlacementExecutionMode: "remote-exec",
      source: "model",
    });
    state.restorePreferenceSelections();

    expect(state.cloudProfileId).toBe("aws");
    expect(state.machineClass).toBe("fast");
    expect(state.worktree).toBe(true);
    expect(persistPreference).not.toHaveBeenCalled();
  });
});
