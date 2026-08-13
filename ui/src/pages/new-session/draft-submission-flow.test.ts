import type { ReactiveController, ReactiveControllerHost } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { CHAT_ROUTE_READY_EVENT } from "../../app/route-transition.ts";
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
  it("deduplicates remote materialization and preserves the draft when cloning fails", async () => {
    let rejectClone!: (error: Error) => void;
    const cloneResult = new Promise<never>((_resolve, reject) => {
      rejectClone = reject;
    });
    const request = vi.fn((method: string) => {
      if (method === "projects.add") {
        return cloneResult;
      }
      return Promise.resolve({});
    });
    const client = { recoveryScope: "principal-a", recoveryScopeReady: true, request };
    const context = {
      gateway: {
        connection: { gatewayUrl: "ws://gateway.example" },
        snapshot: {
          phase: "connected",
          client,
          hello: {
            auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
            features: { methods: ["projects.add", "sessions.create"] },
          },
        },
      },
      agents: {
        state: {
          agentsList: {
            defaultId: "main",
            agents: [
              {
                id: "main",
                workspace: "/workspace",
                workspaceGit: false,
                model: { primary: "openai/gpt-5.6-luna" },
              },
            ],
          },
        },
      },
      sessions: { state: { result: null }, createResult: vi.fn() },
      config: { current: {} },
    } as unknown as ApplicationContext;
    const host = new ControllerHost();
    let place!: DraftPlaceState;
    let flow!: DraftSubmissionFlow;
    const gateway = new DraftGatewayState(
      host,
      () => ({
        context,
        data: undefined,
        isConnected: true,
        isAdmin: place?.isAdmin() ?? false,
        canStartAsDraft: flow?.canStartAsDraft() ?? false,
        visibility: flow?.visibility ?? "normal",
        cloudProfileId: place?.cloudProfileId ?? "",
        pendingCloud: flow?.pendingCloud ?? { sessionKey: "", gatewayUrl: "", recoveryScope: "" },
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
        isAdmin: place?.isAdmin() ?? false,
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
    place = new DraftPlaceState(
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
    flow = new DraftSubmissionFlow(
      gateway,
      place,
      () => ({ context, data: undefined, isConnected: true }),
      { requestUpdate: vi.fn(), closeTransientUi: vi.fn() },
    );
    gateway.synchronize(context.gateway);
    place.setAgentsHydrated(true);
    place.adoptAgentDefaults();
    place.selectRemoteProject({
      identity: "openclaw/openclaw",
      cloneUrl: "https://github.com/openclaw/openclaw.git",
    });
    flow.setMessage("keep this prompt");
    flow.attachmentDraft.replace([
      {
        id: "attachment-1",
        dataUrl: "data:text/plain;base64,SGk=",
        mimeType: "text/plain",
        fileName: "note.txt",
      },
    ]);

    const first = flow.submit();
    const duplicate = flow.submit();
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === "projects.add")).toHaveLength(1),
    );
    rejectClone(new Error("clone failed"));
    await Promise.all([first, duplicate]);

    expect(flow.error).toBe("clone failed");
    expect(flow.message).toBe("keep this prompt");
    expect(flow.attachmentDraft.attachments).toHaveLength(1);
    expect(place.remoteProject).toMatchObject({
      identity: "openclaw/openclaw",
      cloneUrl: "https://github.com/openclaw/openclaw.git",
    });
    expect(context.sessions.createResult).not.toHaveBeenCalled();
  });

  it("keeps startup progress active through the navigation handoff", async () => {
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
    let finishNavigation!: () => void;
    const navigateAndWait = vi.fn(
      (_routeId: string, _options?: Parameters<ApplicationContext["navigateAndWait"]>[1]) =>
        new Promise<void>((resolve) => {
          finishNavigation = resolve;
        }),
    );
    const preload = vi.fn(
      async (_routeId: string, _options?: Parameters<ApplicationContext["preload"]>[1]) =>
        undefined,
    );
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
      navigateAndWait,
      preload,
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

    const submission = flow.submit();
    await vi.waitFor(() => expect(navigateAndWait).toHaveBeenCalledOnce());

    expect(flow.submitting).toBe(true);
    expect(preload).toHaveBeenCalledWith("chat", navigateAndWait.mock.calls[0]?.[1]);
    expect(preload.mock.invocationCallOrder[0]).toBeLessThan(
      navigateAndWait.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    finishNavigation();
    document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT));
    await submission;

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
    expect(preload).toHaveBeenCalledOnce();
  });
});
