import type { ReactiveController, ReactiveControllerHost } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { buildDraftSessionCreateParams } from "./create-params.ts";
import { DraftGatewayState } from "./draft-gateway-state.ts";
import { DraftPlaceBrowser } from "./draft-place-browser.ts";
import { DraftPlaceState } from "./draft-place-state.ts";
import { DraftSubmissionFlow } from "./draft-submission-flow.ts";

class ControllerHost implements ReactiveControllerHost {
  readonly updateComplete = Promise.resolve(true);
  addController(_controller: ReactiveController) {}
  removeController(_controller: ReactiveController) {}
  requestUpdate() {}
}

afterEach(() => {
  sessionStorage.clear();
});

describe("DraftSubmissionFlow", () => {
  it("hands cloud startup to the application owner and navigates immediately", async () => {
    const createResult = vi.fn(async (params: Record<string, unknown>) => ({
      key: String(params.key),
      initialRun: { status: "idle" as const },
    }));
    const start = vi.fn(
      (_input: Parameters<ApplicationContext["cloudStartup"]["start"]>[0]) =>
        new Promise<void>(() => {
          // Application-owned startup intentionally outlives this route.
        }),
    );
    const navigate = vi.fn();
    const setSessionKey = vi.fn();
    const selectAgent = vi.fn();
    const client = {
      recoveryScope: "principal-a",
      recoveryScopeReady: true,
      request: vi.fn(async (method: string) => {
        if (method === "node.list") {
          return { nodes: [] };
        }
        if (method === "worktrees.branches") {
          return { repositoryStatus: "git", branches: [] };
        }
        return {};
      }),
    };
    const context = {
      basePath: "",
      gateway: {
        connection: { gatewayUrl: "ws://gateway.example" },
        snapshot: {
          phase: "connected",
          client,
          hello: {
            auth: {
              role: "operator",
              scopes: ["operator.read", "operator.write", "operator.admin"],
            },
            features: { methods: ["sessions.create", "sessions.dispatch"] },
          },
        },
        setSessionKey,
      },
      agents: {
        state: {
          connected: true,
          client,
          agentsList: {
            defaultId: "cloud",
            mainKey: "main",
            agents: [{ id: "cloud", workspace: "/workspace", workspaceGit: true }],
          },
        },
      },
      agentSelection: { state: { selectedId: "cloud" }, set: selectAgent },
      sessions: { state: { result: null }, createResult },
      cloudStartup: { start },
      config: { current: {} },
      navigate,
    } as unknown as ApplicationContext;
    const host = new ControllerHost();
    const gateway = new DraftGatewayState(
      host,
      () => ({
        context,
        data: undefined,
        isConnected: true,
        isAdmin: place?.isAdmin() ?? true,
        canStartAsDraft: flow?.canStartAsDraft() ?? false,
        visibility: flow?.visibility ?? "normal",
        cloudProfileId: place?.cloudProfileId ?? "",
        pendingCloud: flow?.pendingCloud ?? {
          sessionKey: "",
          gatewayUrl: "",
          recoveryScope: "",
        },
        agentsHydrated: place?.agentsHydrated ?? false,
      }),
      {
        requestUpdate: vi.fn(),
        updateComplete: () => Promise.resolve(),
        onInvalidate: vi.fn(),
        onVisibilityRetired: () => flow?.setVisibility("normal"),
        onCloudProfileCleared: () => place?.clearCloudProfile(),
        onCloudState: (error) => flow?.setError(error),
        onPendingCloudReset: () => flow?.resetPendingCloudWithoutClearingStorage(),
        onRecoveryReady: (gatewayUrl, recoveryScope) =>
          flow?.restorePendingCloudRecovery(gatewayUrl, recoveryScope),
        onAdoptAgentDefaults: () => place?.adoptAgentDefaults(),
      },
    );
    const browser = new DraftPlaceBrowser(
      host,
      gateway,
      () => ({
        context,
        projectId: place?.projectId ?? "",
        nodes: place?.nodes ?? [],
        folder: place?.folder ?? "",
        execNode: place?.execNode ?? "",
        isAdmin: place?.isAdmin() ?? true,
      }),
      {
        requestUpdate: vi.fn(),
        onProjectMissing: () => place?.clearProjectSelection(),
        onSelectProject: (projectId) => place?.selectProjectId(projectId),
        onApplyFolder: (folder, execNode, approved) =>
          place?.applyFolder(folder, execNode, approved),
        onApprovedListing: (listing) => place?.recordGatewayApprovedListing(listing),
        querySelector: () => null,
        activeElement: () => null,
        body: () => null,
      },
    );
    const place = new DraftPlaceState(
      gateway,
      browser,
      () => ({
        context,
        data: undefined,
        submitting: flow?.submitting ?? false,
        pendingCloudSessionKey: flow?.pendingCloud.sessionKey ?? "",
      }),
      {
        requestUpdate: vi.fn(),
        onError: (error) => flow?.setError(error),
        onClearError: (error) => flow?.clearErrorIf(error),
      },
    );
    const flow = new DraftSubmissionFlow(
      gateway,
      place,
      () => ({ context, data: undefined, isConnected: true }),
      { requestUpdate: vi.fn(), closeTransientUi: vi.fn() },
    );
    gateway.synchronize(context.gateway);
    place.setAgentsHydrated(true);
    place.adoptAgentDefaults();
    const apiAttachments = [{ fileName: "note.txt", content: "SGk=" }];
    const createParams = buildDraftSessionCreateParams({
      agentId: "cloud",
      message: "",
      worktree: true,
      cwd: "/workspace",
      workspace: "/workspace",
    });
    flow.pendingCloud.stageCreate({
      agentId: "cloud",
      profileId: "aws",
      message: "keep this cloud task",
      attachments: apiAttachments,
      gatewayUrl: "ws://gateway.example",
      recoveryScope: "principal-a",
      createParams,
    });
    flow.pendingCloud.retryAllowed = true;
    place.applyPendingCloud({ agentId: "cloud", profileId: "aws", cwd: "/workspace" });
    flow.attachmentDraft.replace([
      {
        id: "attachment-1",
        dataUrl: "data:text/plain;base64,SGk=",
        mimeType: "text/plain",
        fileName: "note.txt",
      },
    ]);

    await flow.submit();

    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]?.[0].recovery).toMatchObject({
      message: "keep this cloud task",
      attachments: apiAttachments,
      phase: "dispatching",
    });
    expect(flow.pendingCloud.capture()).toBeNull();
    expect(flow.attachmentDraft.attachments).toHaveLength(0);
    expect(flow.submitting).toBe(false);
    expect(createResult).toHaveBeenCalledOnce();
    expect(setSessionKey).toHaveBeenCalledWith(start.mock.calls[0]?.[0].recovery.sessionKey);
    expect(selectAgent).toHaveBeenCalledWith("cloud");
    expect(navigate).toHaveBeenCalledOnce();
  });
});
