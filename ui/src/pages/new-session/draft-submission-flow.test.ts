import type { ReactiveController, ReactiveControllerHost } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { CHAT_ROUTE_READY_EVENT } from "../../app/route-transition.ts";
import { writeSessionPlacementRecovery } from "../../lib/sessions/session-placement-recovery.ts";
import { buildChatApiAttachments } from "../chat/attachment-api.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
} from "../chat/attachment-payload-store.ts";
import { buildDraftSessionCreateParams } from "./create-params.ts";
import { DraftGatewayState } from "./draft-gateway-state.ts";
import { DraftPlaceBrowser } from "./draft-place-browser.ts";
import { DraftPlaceState } from "./draft-place-state.ts";
import { DraftSubmissionFlow } from "./draft-submission-flow.ts";
import { patchNewSessionPreference } from "./preferences.ts";

// The closed list of gates allowed to block without a visible reason: the busy
// Start button and an empty draft explain themselves. Growing it is a product
// decision — edit this list and the matching one in submit-gates.ts together.
const SILENT_SUBMIT_GATES = ["submitting", "empty-draft"];

class ControllerHost implements ReactiveControllerHost {
  readonly updateComplete = Promise.resolve(true);
  addController(_controller: ReactiveController) {}
  removeController(_controller: ReactiveController) {}
  requestUpdate() {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

type FixtureOptions = {
  phase?: "connected" | "connecting";
  agents?: unknown[];
  methods?: string[];
  scopes?: string[];
  selfUser?: { id: string };
  request?: (method: string) => Promise<unknown>;
};

function createDraftFixture(options: FixtureOptions = {}) {
  const request = vi.fn((method: string) => {
    if (options.request) {
      return options.request(method);
    }
    return Promise.resolve({});
  });
  const client = { recoveryScope: "principal-a", recoveryScopeReady: true, request };
  const phase = options.phase ?? "connected";
  const context = {
    gateway: {
      connection: { gatewayUrl: "ws://gateway.example" },
      snapshot: {
        phase,
        client: phase === "connected" ? client : null,
        ...(options.selfUser ? { selfUser: options.selfUser } : {}),
        hello:
          phase === "connected"
            ? {
                auth: {
                  role: "operator",
                  scopes: options.scopes ?? ["operator.read", "operator.write"],
                },
                features: { methods: options.methods ?? ["sessions.create"] },
              }
            : null,
      },
    },
    agents: {
      state: {
        agentsList: {
          defaultId: "main",
          agents: options.agents ?? [
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
  const gateway = new DraftGatewayState(
    host,
    () => ({
      context,
      data: undefined,
      isConnected: phase === "connected",
      isAdmin: place?.isAdmin() ?? false,
      canStartAsDraft: flow?.canStartAsDraft() ?? false,
      visibility: flow?.visibility ?? "normal",
      cloudProfileId: place?.cloudProfileId ?? "",
      pendingPlacement: flow?.pendingPlacement ?? {
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
      onPendingPlacementReset: () => flow?.releasePendingPlacementOwner(),
      onRecoveryReady: (gatewayUrl, recoveryScope) =>
        flow?.restorePendingPlacementRecovery(gatewayUrl, recoveryScope),
      onAdoptAgentDefaults: () => place?.adoptAgentDefaults(),
    },
  );
  const browser = new DraftPlaceBrowser(
    host,
    gateway,
    () => ({
      context,
      isAdmin: place?.isAdmin() ?? false,
    }),
    {
      requestUpdate: vi.fn(),
      onProjectMissing: () => place?.clearProjectSelection(),
      onSelectProject: (projectId) => place?.selectProjectId(projectId),
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
      pendingPlacementSessionKey: flow?.pendingPlacement.sessionKey ?? "",
    }),
    {
      requestUpdate: vi.fn(),
      onError: (error) => flow?.setError(error),
      onClearError: (error) => flow?.clearErrorIf(error),
    },
  );
  const requestUpdate = vi.fn();
  const flow = new DraftSubmissionFlow(
    gateway,
    place,
    () => ({ context, data: undefined, isConnected: phase === "connected" }),
    { requestUpdate, closeTransientUi: vi.fn() },
  );
  gateway.synchronize(context.gateway);
  place.setAgentsHydrated(true);
  place.adoptAgentDefaults();
  return { context, flow, gateway, place, request, requestUpdate };
}

function registerTextPayload(id: string) {
  return registerChatAttachmentPayload({
    attachment: { id, mimeType: "text/plain", fileName: `${id}.txt` },
    dataUrl: `data:text/plain;base64,${btoa(id)}`,
    file: new File([id], `${id}.txt`, { type: "text/plain" }),
  });
}

function stubObjectUrls(...urls: string[]) {
  const createObjectURL = vi.fn();
  urls.forEach((url) => createObjectURL.mockReturnValueOnce(url));
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  return revokeObjectURL;
}

describe("DraftSubmissionFlow submit gates", () => {
  it("keeps every blocking gate visible: canSubmit and the reason derive from one table", () => {
    const scenarios: Array<{ name: string; build: () => ReturnType<typeof createDraftFixture> }> = [
      { name: "empty draft", build: () => createDraftFixture() },
      {
        name: "gateway disconnected",
        build: () => {
          const fixture = createDraftFixture({ phase: "connecting" });
          fixture.flow.setMessage("hello");
          return fixture;
        },
      },
      {
        name: "attachment reads pending",
        build: () => {
          const fixture = createDraftFixture();
          fixture.flow.setMessage("hello");
          fixture.flow.attachmentDraft.updatePending(fixture.flow.attachmentDraft.readSignal, 1);
          return fixture;
        },
      },
      {
        name: "no agents on the gateway",
        build: () => {
          const fixture = createDraftFixture({ agents: [] });
          fixture.flow.setMessage("hello");
          return fixture;
        },
      },
      {
        name: "sessions.create not advertised",
        build: () => {
          const fixture = createDraftFixture({ methods: [] });
          fixture.flow.setMessage("hello");
          return fixture;
        },
      },
      {
        name: "submission outcome unknown",
        build: () => {
          const fixture = createDraftFixture();
          fixture.flow.setMessage("hello");
          fixture.flow.markPendingPlacementUnavailable("gateway-changed");
          return fixture;
        },
      },
    ];
    for (const scenario of scenarios) {
      const { flow } = scenario.build();
      const block = flow.submitBlock();
      expect(block, scenario.name).toBeDefined();
      expect(flow.canSubmit(), scenario.name).toBe(false);
      if (!(SILENT_SUBMIT_GATES as readonly string[]).includes(block?.gate ?? "")) {
        // A reasoned gate must explain itself, and the Start tooltip must
        // report the same first-gate reason canSubmit blocks on.
        expect(block?.reason, scenario.name).toBeTruthy();
        expect(flow.submitDisabledReason(), scenario.name).toBe(block?.reason);
      }
    }

    const ready = createDraftFixture();
    ready.flow.setMessage("hello");
    expect(ready.flow.submitBlock()).toBeUndefined();
    expect(ready.flow.canSubmit()).toBe(true);
    expect(ready.flow.submitDisabledReason()).toBeUndefined();
  });

  it("surfaces a reason for Enter during worktree preference restore, then clears it", async () => {
    patchNewSessionPreference("ws://gateway.example", "main", {
      folder: "/workspace",
      worktree: true,
    });
    let resolveBranches!: (value: unknown) => void;
    const fixture = createDraftFixture({
      agents: [
        {
          id: "main",
          workspace: "/workspace",
          workspaceGit: true,
          model: { primary: "openai/gpt-5.6-luna" },
        },
      ],
      request: (method) => {
        if (method === "worktrees.branches") {
          return new Promise((resolve) => {
            resolveBranches = resolve;
          });
        }
        return Promise.resolve({});
      },
    });
    const { context, flow } = fixture;
    flow.setMessage("start something");

    // The async preference restore is still in flight: submission is gated,
    // but the gate must be visible, not a silent no-op.
    expect(flow.canSubmit()).toBe(false);
    expect(flow.submitDisabledReason()).toBeTruthy();
    expect(flow.blockedSubmitNotice()).toBeUndefined();

    await flow.submit();
    expect(context.sessions.createResult).not.toHaveBeenCalled();
    expect(flow.blockedSubmitNotice()).toBe(flow.submitDisabledReason());

    resolveBranches({ repositoryStatus: "git", branches: ["main"], defaultBranch: "main" });
    await vi.waitFor(() => expect(flow.canSubmit()).toBe(true));
    // The transient gate lifted; the notice retires itself.
    expect(flow.blockedSubmitNotice()).toBeUndefined();
    expect(flow.submitDisabledReason()).toBeUndefined();
  });

  it("does not raise a notice for the silent empty-draft gate", async () => {
    const fixture = createDraftFixture();
    await fixture.flow.submit();
    expect(fixture.flow.canSubmit()).toBe(false);
    expect(fixture.flow.submitBlock()?.gate).toBe("empty-draft");
    expect(fixture.flow.blockedSubmitNotice()).toBeUndefined();
  });

  it("blocks a retained device choice when the selected runtime cannot dispatch there", async () => {
    const fixture = createDraftFixture({
      methods: ["environments.list", "sessions.create", "sessions.dispatch"],
      scopes: ["operator.admin", "operator.read", "operator.write"],
      agents: [
        {
          id: "main",
          workspace: "/workspace",
          workspaceGit: false,
          model: { primary: "openai/gpt-5.6-sol" },
          agentRuntime: {
            id: "codex",
            cloudPlacementSupported: true,
            devicePlacementSupported: false,
            source: "model",
          },
        },
      ],
      request: async (method) =>
        method === "environments.list"
          ? {
              environments: [
                {
                  id: "node:build-mac",
                  type: "node",
                  label: "Build Mac",
                  status: "available",
                  sessionHost: true,
                  workerSlots: { total: 1, available: 1 },
                },
              ],
              profiles: [],
            }
          : {},
    });
    await fixture.gateway.refreshCloudProfiles();
    await vi.waitFor(() => expect(fixture.place.devices()).toHaveLength(1));
    fixture.place.selectDevice("build-mac");
    fixture.flow.setMessage("run on the device");

    expect(fixture.flow.submitBlock()).toEqual({
      gate: "device-runtime",
      reason: "Needs the embedded runtime",
    });
    expect(fixture.flow.canSubmit()).toBe(false);
    expect(fixture.flow.submitDisabledReason()).toBe("Needs the embedded runtime");
    expect(fixture.request).not.toHaveBeenCalledWith("node.list", expect.anything());
  });
});

describe("DraftSubmissionFlow", () => {
  it("makes attachment restore release only displaced payload ids", () => {
    const revokeObjectURL = stubObjectUrls("blob:shared", "blob:displaced", "blob:incoming");
    const { flow, requestUpdate } = createDraftFixture();
    const noteUserMutation = vi.spyOn(flow.draftPersistence, "noteUserMutation");
    const shared = registerTextPayload("shared");
    const displaced = registerTextPayload("displaced");
    const incoming = registerTextPayload("incoming");
    flow.attachmentDraft.replace([shared, displaced]);
    noteUserMutation.mockClear();
    requestUpdate.mockClear();
    revokeObjectURL.mockClear();

    flow.attachmentDraft.restore([shared, incoming]);

    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:displaced");
    expect(getChatAttachmentDataUrl(shared)).not.toBeNull();
    expect(getChatAttachmentDataUrl(incoming)).not.toBeNull();
    expect(getChatAttachmentDataUrl(displaced)).toBeNull();
    expect(noteUserMutation).not.toHaveBeenCalled();
    expect(requestUpdate).toHaveBeenCalledOnce();
    flow.attachmentDraft.reset({ release: true });
  });

  it("releases the displaced payload and renders placement recovery once without a user mutation", () => {
    const revokeObjectURL = stubObjectUrls("blob:current-draft");
    const { flow, requestUpdate } = createDraftFixture();
    const noteUserMutation = vi.spyOn(flow.draftPersistence, "noteUserMutation");
    const current = registerTextPayload("current");
    flow.attachmentDraft.replace([current]);
    noteUserMutation.mockClear();
    requestUpdate.mockClear();
    revokeObjectURL.mockClear();
    expect(
      writeSessionPlacementRecovery({
        sessionKey: "agent:main:dashboard:recovery",
        messageId: "message-recovery",
        message: "recovered cloud prompt",
        attachments: [
          {
            type: "file",
            mimeType: "text/plain",
            fileName: "recovered.txt",
            content: "cmVjb3ZlcmVk",
          },
        ],
        target: { kind: "profile", profileId: "aws" },
        agentId: "main",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        phase: "creating",
        createParams: {
          key: "agent:main:dashboard:recovery",
          agentId: "main",
          message: "",
          worktree: true,
        },
      }),
    ).toBe(true);

    flow.restorePendingPlacementRecovery("ws://gateway.example", "principal-a");

    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(noteUserMutation).not.toHaveBeenCalled();
    expect(requestUpdate).toHaveBeenCalledOnce();
    expect(flow.message).toBe("recovered cloud prompt");
    expect(buildChatApiAttachments(flow.attachmentDraft.attachments)).toEqual([
      {
        type: "file",
        mimeType: "text/plain",
        fileName: "recovered.txt",
        content: "cmVjb3ZlcmVk",
      },
    ]);
    flow.attachmentDraft.reset({ release: true });
  });

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
        pendingPlacement: flow?.pendingPlacement ?? {
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
        onPendingPlacementReset: () => flow?.releasePendingPlacementOwner(),
        onRecoveryReady: (gatewayUrl, recoveryScope) =>
          flow?.restorePendingPlacementRecovery(gatewayUrl, recoveryScope),
        onAdoptAgentDefaults: () => place?.adoptAgentDefaults(),
      },
    );
    const browser = new DraftPlaceBrowser(
      host,
      gateway,
      () => ({
        context,
        isAdmin: place?.isAdmin() ?? false,
      }),
      {
        requestUpdate: vi.fn(),
        onProjectMissing: () => place?.clearProjectSelection(),
        onSelectProject: (projectId) => place?.selectProjectId(projectId),
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
        pendingPlacementSessionKey: flow?.pendingPlacement.sessionKey ?? "",
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
    expect(place.browser.remoteProject).toMatchObject({
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
      (_input: Parameters<ApplicationContext["placementStartup"]["start"]>[0]) =>
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
              scopes: ["operator.admin", "operator.read", "operator.write"],
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
      placementStartup: { start },
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
        isAdmin: place?.isAdmin() ?? false,
        canStartAsDraft: flow?.canStartAsDraft() ?? false,
        visibility: flow?.visibility ?? "normal",
        cloudProfileId: place?.cloudProfileId ?? "",
        pendingPlacement: flow?.pendingPlacement ?? {
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
        onPendingPlacementReset: () => flow?.releasePendingPlacementOwner(),
        onRecoveryReady: (gatewayUrl, recoveryScope) =>
          flow?.restorePendingPlacementRecovery(gatewayUrl, recoveryScope),
        onAdoptAgentDefaults: () => place?.adoptAgentDefaults(),
      },
    );
    const browser = new DraftPlaceBrowser(
      host,
      gateway,
      () => ({
        context,
        isAdmin: place?.isAdmin() ?? false,
      }),
      {
        requestUpdate: vi.fn(),
        onProjectMissing: () => place?.clearProjectSelection(),
        onSelectProject: (projectId) => place?.selectProjectId(projectId),
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
        pendingPlacementSessionKey: flow?.pendingPlacement.sessionKey ?? "",
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
    flow.pendingPlacement.stageCreate({
      agentId: "cloud",
      target: { kind: "profile", profileId: "aws" },
      message: "keep this cloud task",
      attachments: apiAttachments,
      gatewayUrl: "ws://gateway.example",
      recoveryScope: "principal-a",
      createParams,
    });
    flow.pendingPlacement.retryAllowed = true;
    place.applyPendingPlacement({ agentId: "cloud", profileId: "aws", cwd: "/workspace" });
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
    expect(flow.pendingPlacement.capture()).toBeNull();
    expect(flow.attachmentDraft.attachments).toHaveLength(0);
    expect(flow.submitting).toBe(false);
    expect(createResult).toHaveBeenCalledOnce();
    expect(setSessionKey).toHaveBeenCalledWith(start.mock.calls[0]?.[0].recovery.sessionKey);
    expect(selectAgent).toHaveBeenCalledWith("cloud");
    expect(preload).toHaveBeenCalledOnce();
  });
});
