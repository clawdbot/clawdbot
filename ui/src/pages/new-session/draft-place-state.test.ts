import { describe, expect, it, vi } from "vitest";
import type { DraftCloudProfile } from "./discovery.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import type { DraftPlaceBrowser } from "./draft-place-browser.ts";
import { DraftPlaceState } from "./draft-place-state.ts";

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

  it("clears a selected cloud profile when the runtime switches to an incompatible mode", () => {
    const persistPreference = vi.fn();
    const cloudProfiles: DraftCloudProfile[] = [
      { id: "aws", providerId: "crabbox", executionMode: "worker-turn" },
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
    state.applyPendingPlacement({ agentId: "main", profileId: "aws" });
    state.restorePreferenceSelections();
    expect(state.cloudProfileId).toBe("aws");

    resolveRuntime.mockReturnValue({
      id: "codex",
      cloudPlacementSupported: true,
      cloudPlacementExecutionMode: "remote-exec",
      source: "model",
    });
    state.restorePreferenceSelections();

    expect(state.cloudProfileId).toBe("");
    expect(state.worktree).toBe(false);
    expect(persistPreference).toHaveBeenLastCalledWith(
      "main",
      "",
      expect.objectContaining({ where: { kind: "local" }, worktree: false }),
    );
  });
});
