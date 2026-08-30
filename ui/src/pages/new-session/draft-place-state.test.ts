import { describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import type { DraftCloudProfile } from "./discovery.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import { DraftPlaceBrowser } from "./draft-place-browser.ts";
import { DraftPlaceState } from "./draft-place-state.ts";
import { TestReactiveControllerHost } from "./reactive-controller-host.test-support.ts";

const REMOTE_PROJECT = {
  identity: "openclaw/openclaw",
  cloneUrl: "https://github.com/openclaw/openclaw.git",
};

function createRepositoryFixture() {
  const requestUpdate = vi.fn();
  const persistPreference = vi.fn();
  const readPreference = vi.fn(() => ({ worktree: true }));
  const request = vi.fn(async (method: string) =>
    method === "fs.listDir"
      ? { path: "/plain", entries: [] }
      : { repositoryStatus: "not_git", branches: [] },
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
          agents: [{ id: "main", workspace: "/workspace", workspaceGit: false }],
        },
      },
    },
    sessions: { state: { result: null } },
  } as unknown as ApplicationContext;
  const gateway = {
    cloudProfiles: [{ id: "aws", providerId: "crabbox" }],
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
    () => ({ context, data: undefined, submitting: false, pendingPlacementSessionKey: "" }),
    { requestUpdate, onError: vi.fn(), onClearError: vi.fn() },
  );
  return { state, browser, persistPreference, requestUpdate };
}

describe("DraftPlaceState repository selection", () => {
  it("offers remote-project worktrees locally without resetting the typed base branch on toggle", () => {
    const { state } = createRepositoryFixture();
    state.selectRemoteProject(REMOTE_PROJECT);

    expect(state.repository).toEqual({ kind: "pending-clone", cloneUrl: REMOTE_PROJECT.cloneUrl });
    expect(state.worktreeAvailable()).toBe(true);
    expect(state.worktree).toBe(false);
    state.toggleWorktree();
    expect(state.worktree).toBe(true);
    state.setBaseRef("release");
    state.toggleWorktree();
    state.toggleWorktree();
    expect(state.worktree).toBe(true);
    expect(state.baseRef).toBe("release");
  });

  it.each(["device", "cloud"] as const)(
    "preserves a remote project and enables worktree when switching to %s placement",
    (placement) => {
      const { state, browser } = createRepositoryFixture();
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
      expect(state.worktree).toBe(true);
      expect(state.baseRef).toBe("release");
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

      state.toggleWorktree();

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
