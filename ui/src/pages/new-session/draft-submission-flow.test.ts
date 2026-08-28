import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_CREATE_RETRY_WINDOW_MS } from "../../../../packages/gateway-protocol/src/index.js";
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
import type { NewSessionRouteData } from "./location.ts";
import { patchNewSessionPreference } from "./preferences.ts";
import { TestReactiveControllerHost } from "./reactive-controller-host.test-support.ts";

// The closed list of gates allowed to block without a visible reason: the busy
// Start button and an empty draft explain themselves. Growing it is a product
// decision — edit this list and the matching one in submit-gates.ts together.
const SILENT_SUBMIT_GATES = ["submitting", "empty-draft"];

afterEach(() => {
  vi.restoreAllMocks();
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
  data?: NewSessionRouteData;
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
        sessionKey: "",
        ...(options.selfUser ? { selfUser: options.selfUser } : {}),
        hello:
          phase === "connected"
            ? {
                server: { bootId: "gateway-boot-a" },
                auth: {
                  role: "operator",
                  scopes: options.scopes ?? ["operator.read", "operator.write"],
                },
                features: { methods: options.methods ?? ["sessions.create"] },
              }
            : null,
      },
      setSessionKey: vi.fn(),
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
    agentSelection: { state: { selectedId: "main" }, set: vi.fn() },
    config: { current: { cliAgentsEnabled: true, terminalEnabled: true } },
    navigateAndWait: vi.fn(async () => undefined),
    preload: vi.fn(async () => undefined),
  } as unknown as ApplicationContext;
  vi.mocked(context.gateway.setSessionKey).mockImplementation((sessionKey) => {
    context.gateway.snapshot.sessionKey = sessionKey;
  });
  const host = new TestReactiveControllerHost();
  const gateway = new DraftGatewayState(
    host,
    () => ({
      context,
      data: options.data,
      isConnected: phase === "connected",
      isAdmin: place?.isAdmin() ?? false,
      canStartAsDraft: flow?.capabilities.canStartAsDraft(context) ?? false,
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
      data: options.data,
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
    () => ({ context, data: options.data, isConnected: phase === "connected" }),
    { requestUpdate, closeTransientUi: vi.fn() },
  );
  gateway.synchronize(context.gateway);
  place.setAgentsHydrated(true);
  place.adoptAgentDefaults();
  return { capabilities: flow.capabilities, context, flow, gateway, place, request, requestUpdate };
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
      scopes: ["operator.admin", "operator.read", "operator.write"],
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
            id: "cloud-only",
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
      reason: "This runtime does not support paired devices",
    });
    expect(fixture.flow.canSubmit()).toBe(false);
    expect(fixture.flow.submitDisabledReason()).toBe(
      "This runtime does not support paired devices",
    );
    expect(fixture.request).not.toHaveBeenCalledWith("node.list", expect.anything());
  });
});

describe("DraftSubmissionFlow", () => {
  it("replays a frozen direct create without inheriting refreshed placement or mutable submit gates", async () => {
    const { context, flow, place } = createDraftFixture({
      methods: ["sessions.create", "sessions.dispatch"],
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    let finishOriginal!: (value: { key: string; initialRun: { status: "idle" } }) => void;
    const original = new Promise<{ key: string; initialRun: { status: "idle" } }>((resolve) => {
      finishOriginal = resolve;
    });
    const result = { key: "agent:main:direct-resumed", initialRun: { status: "idle" as const } };
    vi.mocked(context.sessions.createResult)
      .mockImplementationOnce(() => original)
      .mockResolvedValueOnce(result);
    vi.mocked(context.navigateAndWait).mockImplementation(async () => {
      queueMicrotask(() => document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT)));
    });
    flow.setMessage("keep the original direct request");

    const initialSubmission = flow.submit();
    await vi.waitFor(() => expect(context.sessions.createResult).toHaveBeenCalledOnce());
    const originalParams = vi.mocked(context.sessions.createResult).mock.calls[0]?.[0];
    flow.invalidate("gateway-changed");
    place.applyPendingPlacement({ agentId: "main", profileId: "new-cloud-discovery" });
    expect(flow.canSubmit()).toBe(false);
    expect(flow.submitting).toBe(true);

    flow.resumeInterruptedSubmission();
    await vi.waitFor(() => expect(context.sessions.createResult).toHaveBeenCalledTimes(2));
    expect(vi.mocked(context.sessions.createResult).mock.calls[1]?.[0]).toEqual(originalParams);
    expect(flow.pendingPlacement.sessionKey).toBe("");
    finishOriginal(result);
    await initialSubmission;
    await vi.waitFor(() => expect(flow.submitting).toBe(false));
  });

  it("unlocks visibly when a frozen retry loses sessions.create access", async () => {
    const { context, flow } = createDraftFixture();
    let finishOriginal!: (value: { key: string; initialRun: { status: "idle" } }) => void;
    vi.mocked(context.sessions.createResult).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOriginal = resolve;
        }),
    );
    flow.setMessage("do not replay without authority");
    const initialSubmission = flow.submit();
    await vi.waitFor(() => expect(context.sessions.createResult).toHaveBeenCalledOnce());
    flow.invalidate("gateway-changed");
    if (context.gateway.snapshot.hello?.features) {
      context.gateway.snapshot.hello.features.methods = [];
    }

    flow.resumeInterruptedSubmission();

    expect(flow.error).toBeTruthy();
    expect(flow.submitting).toBe(false);
    expect(context.sessions.createResult).toHaveBeenCalledOnce();
    finishOriginal({ key: "agent:main:old", initialRun: { status: "idle" } });
    await initialSubmission;
  });

  it("expires an interrupted direct create and unlocks with an explicit unknown outcome", async () => {
    const clock = vi.spyOn(Date, "now");
    let now = 1_000;
    clock.mockImplementation(() => now);
    const { context, flow } = createDraftFixture();
    let finishOriginal!: (value: { key: string; initialRun: { status: "idle" } }) => void;
    vi.mocked(context.sessions.createResult).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOriginal = resolve;
        }),
    );
    flow.setMessage("the original outcome is unknown");
    const initialSubmission = flow.submit();
    await vi.waitFor(() => expect(context.sessions.createResult).toHaveBeenCalledOnce());
    flow.invalidate("gateway-changed");
    now += SESSION_CREATE_RETRY_WINDOW_MS;

    flow.resumeInterruptedSubmission();

    expect(flow.submissionOutcomeUnknown).toBe("gateway-changed");
    expect(flow.submitting).toBe(false);
    expect(flow.canSubmit()).toBe(false);
    expect(context.sessions.createResult).toHaveBeenCalledOnce();
    finishOriginal({ key: "agent:main:old", initialRun: { status: "idle" } });
    await initialSubmission;
    clock.mockRestore();
  });

  it("surfaces navigation failure after a session has already been created", async () => {
    const { context, flow } = createDraftFixture();
    vi.mocked(context.sessions.createResult).mockResolvedValue({
      key: "agent:main:dashboard:created",
      initialRun: { status: "idle" },
    });
    vi.mocked(context.navigateAndWait)
      .mockRejectedValueOnce(new Error("Chat route failed to load"))
      .mockImplementationOnce(async () => {
        queueMicrotask(() => document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT)));
      });
    flow.setMessage("start this task");

    await flow.submit();

    expect(context.sessions.createResult).toHaveBeenCalledOnce();
    expect(context.navigateAndWait).toHaveBeenCalledOnce();
    expect(flow.error).toBe("Chat route failed to load");
    expect(flow.submitting).toBe(false);

    const readSignal = flow.attachmentDraft.readSignal;
    flow.attachmentDraft.updatePending(readSignal, 1);
    expect(flow.submitBlock()?.gate).toBe("attachment-reads");
    expect(flow.canSubmit()).toBe(false);
    await flow.submit();
    expect(context.sessions.createResult).toHaveBeenCalledOnce();
    expect(context.navigateAndWait).toHaveBeenCalledOnce();
    flow.attachmentDraft.updatePending(readSignal, -1);

    expect(flow.canSubmit()).toBe(true);
    await flow.submit();

    expect(context.navigateAndWait).toHaveBeenCalledTimes(2);
    expect(context.sessions.createResult).toHaveBeenCalledOnce();
    expect(flow.error).toBeNull();
  });

  it.each([
    {
      scenario: "the user edits the draft",
      retire: ({ flow }: ReturnType<typeof createDraftFixture>) => flow.setMessage("a new task"),
    },
    {
      scenario: "the Gateway lifecycle is invalidated",
      retire: ({ flow }: ReturnType<typeof createDraftFixture>) => flow.invalidate(),
    },
    {
      scenario: "the draft attachments change",
      retire: ({ flow }: ReturnType<typeof createDraftFixture>) => flow.attachmentDraft.replace([]),
    },
    {
      scenario: "the requested session visibility changes",
      retire: ({ flow }: ReturnType<typeof createDraftFixture>) => flow.setVisibility("draft"),
    },
    {
      scenario: "the requested session capabilities change",
      retire: ({ capabilities }: ReturnType<typeof createDraftFixture>) =>
        capabilities.setToolOverrides({ skills: { release: false } }),
    },
    {
      scenario: "another session becomes selected",
      retire: ({ context }: ReturnType<typeof createDraftFixture>) => {
        context.gateway.snapshot.sessionKey = "agent:main:dashboard:elsewhere";
      },
    },
    {
      scenario: "the selected agent changes",
      retire: ({ place }: ReturnType<typeof createDraftFixture>) => place.selectAgentId("other"),
    },
    {
      scenario: "the Gateway client changes",
      retire: ({ context }: ReturnType<typeof createDraftFixture>) => {
        const client = context.gateway.snapshot.client;
        if (client) {
          context.gateway.snapshot.client = new Proxy(client, {});
        }
      },
    },
  ])("never retries a committed session after $scenario", async ({ retire }) => {
    const fixture = createDraftFixture({
      scopes: ["operator.admin", "operator.read", "operator.write"],
      agents: [
        { id: "main", workspace: "/workspace", model: { primary: "openai/test" } },
        { id: "other", workspace: "/workspace", model: { primary: "openai/test" } },
      ],
    });
    const { context, flow } = fixture;
    vi.mocked(context.sessions.createResult)
      .mockResolvedValueOnce({ key: "agent:main:dashboard:old", initialRun: { status: "idle" } })
      .mockImplementationOnce(async (params) => ({
        key: `agent:${params?.agentId ?? fixture.place.agentId}:dashboard:new`,
        initialRun: { status: "idle" },
      }));
    vi.mocked(context.navigateAndWait)
      .mockRejectedValueOnce(new Error("old navigation failed"))
      .mockImplementationOnce(async () => {
        queueMicrotask(() => document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT)));
      });
    flow.setMessage("the committed task");
    await flow.submit();

    retire(fixture);
    await flow.submit();

    expect(context.sessions.createResult).toHaveBeenCalledTimes(2);
    expect(context.gateway.snapshot.sessionKey).toBe(
      `agent:${fixture.place.agentId}:dashboard:new`,
    );
    expect(context.navigateAndWait).toHaveBeenCalledTimes(2);
  });

  it("retires failed chat navigation after the same draft starts in a terminal", async () => {
    const fixture = createDraftFixture({
      scopes: ["operator.admin", "operator.read", "operator.write"],
      methods: ["sessions.create", "sessions.catalog.startTerminal", "terminal.open"],
      data: {
        agentId: "main",
        requestedAgentId: "main",
        catalogId: "terminal-agent",
        model: "openai/test",
        catalogLabel: "Terminal agent",
        startTerminal: true,
      },
      request: async (method) =>
        method === "sessions.catalog.startTerminal" ? { sessionId: "terminal-created" } : {},
    });
    const { context, flow, request } = fixture;
    vi.mocked(context.sessions.createResult).mockResolvedValue({
      key: "agent:main:dashboard:chat-created",
      initialRun: { status: "idle" },
    });
    vi.mocked(context.navigateAndWait).mockRejectedValue(new Error("Chat route failed to load"));
    flow.setMessage("start this task");

    await flow.submit();
    expect(flow.error).toBe("Chat route failed to load");
    expect(flow.showStartInTerminal()).toBe(true);

    await flow.startInTerminal();

    expect(request).toHaveBeenCalledWith(
      "sessions.catalog.startTerminal",
      expect.objectContaining({ catalogId: "terminal-agent" }),
    );
    expect(flow.message).toBe("");
    expect(flow.canSubmit()).toBe(false);
    expect(context.sessions.createResult).toHaveBeenCalledOnce();
    expect(context.navigateAndWait).toHaveBeenCalledOnce();
  });

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

  it.each([
    { methods: ["sessions.create"], allowed: false, worktree: false },
    { methods: ["projects.add"], allowed: false, worktree: false },
    { methods: ["projects.add", "sessions.create"], allowed: true, worktree: false },
    { methods: ["sessions.create"], allowed: false, worktree: true },
  ])("checks remote-project access with worktree=$worktree", ({ methods, allowed, worktree }) => {
    const { flow, place } = createDraftFixture({ methods });
    place.selectRemoteProject({
      identity: "openclaw/openclaw",
      cloneUrl: "https://github.com/openclaw/openclaw.git",
    });
    if (worktree) {
      place.toggleWorktree();
      flow.setMessage("start in a worktree");
    }

    expect(flow.submissionAccess().allowed).toBe(allowed);
  });

  it.each([
    { scenario: "an empty session", message: "", worktree: false },
    { scenario: "a prompted worktree", message: "inspect the project", worktree: true },
    { scenario: "an attachment-only worktree", message: "", worktree: true },
  ])("materializes a remote project before $scenario", async ({ message, worktree }) => {
    let materializeProject!: (project: { id: string }) => void;
    const materializedProject = new Promise<{ id: string }>((resolve) => {
      materializeProject = resolve;
    });
    const { context, flow, place, request } = createDraftFixture({
      methods: ["projects.add", "sessions.create"],
      request: async (method) => (method === "projects.add" ? materializedProject : {}),
    });
    vi.mocked(context.sessions.createResult).mockResolvedValue({
      key: "agent:main:empty-remote-project",
      initialRun: { status: "idle" },
    });
    vi.mocked(context.navigateAndWait).mockImplementation(async () => {
      queueMicrotask(() => document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT)));
    });
    place.selectRemoteProject({
      identity: "openclaw/openclaw",
      cloneUrl: "https://github.com/openclaw/openclaw.git",
    });
    if (worktree) {
      place.toggleWorktree();
    }
    flow.setMessage(message);
    if (worktree && !message) {
      flow.attachmentDraft.replace([
        {
          id: "attachment-1",
          dataUrl: "data:text/plain;base64,SGk=",
          mimeType: "text/plain",
          fileName: "note.txt",
        },
      ]);
    } else if (!message) {
      // Empty-draft button gating is independent from the remote-project submission contract.
      vi.spyOn(flow, "canSubmit").mockReturnValue(true);
    }

    const submitted = flow.submit();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "projects.add",
        { gitUrl: "https://github.com/openclaw/openclaw.git" },
        { timeoutMs: null },
      ),
    );
    expect(context.sessions.createResult).not.toHaveBeenCalled();
    materializeProject({ id: "openclaw" });
    await submitted;

    const createParams = vi.mocked(context.sessions.createResult).mock.calls[0]?.[0];
    expect(createParams).toMatchObject({ agentId: "main", message, projectId: "openclaw" });
    expect(createParams?.worktree).toBe(worktree || undefined);
    expect(createParams).not.toHaveProperty("projectGitUrl");
    expect(createParams).not.toHaveProperty("cwd");
    expect(request.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(context.sessions.createResult).mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
  });

  it("retains an empty remote-project selection when pre-session materialization fails", async () => {
    const { context, flow, place } = createDraftFixture({
      methods: ["projects.add", "sessions.create"],
      request: async () => {
        throw new Error("clone failed");
      },
    });
    place.selectRemoteProject({
      identity: "openclaw/openclaw",
      cloneUrl: "https://github.com/openclaw/openclaw.git",
    });
    vi.spyOn(flow, "canSubmit").mockReturnValue(true);

    await flow.submit();

    expect(flow.error).toBe("clone failed");
    expect(place.browser.remoteProject?.identity).toBe("openclaw/openclaw");
    expect(context.sessions.createResult).not.toHaveBeenCalled();
  });

  it.each([
    { scenario: "an initial prompt and attachments", message: "keep this prompt" },
    { scenario: "attachments without an initial prompt", message: "" },
  ])("admits a remote project once with $scenario", async ({ message }) => {
    const { context, flow, place, request } = createDraftFixture();
    let admitSession!: (value: { key: string; initialRun: { status: "idle" } }) => void;
    vi.mocked(context.sessions.createResult).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          admitSession = resolve;
        }),
    );
    vi.mocked(context.navigateAndWait).mockImplementation(async () => {
      queueMicrotask(() => document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT)));
    });
    place.selectRemoteProject({
      identity: "openclaw/openclaw",
      cloneUrl: "https://github.com/openclaw/openclaw.git",
    });
    flow.setMessage(message);
    flow.attachmentDraft.replace([
      {
        id: "attachment-1",
        dataUrl: "data:text/plain;base64,SGk=",
        mimeType: "text/plain",
        fileName: "note.txt",
      },
    ]);

    const submitted = flow.submit();
    const duplicate = flow.submit();
    await vi.waitFor(() => expect(context.sessions.createResult).toHaveBeenCalledOnce());
    expect(context.sessions.createResult).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        message,
        projectGitUrl: "https://github.com/openclaw/openclaw.git",
        attachments: [expect.objectContaining({ fileName: "note.txt", mimeType: "text/plain" })],
      }),
      { reconciliation: "background" },
    );
    expect(request).not.toHaveBeenCalledWith("projects.add", expect.anything(), expect.anything());

    admitSession({ key: "agent:main:remote-project", initialRun: { status: "idle" } });
    await Promise.all([submitted, duplicate]);

    expect(context.sessions.createResult).toHaveBeenCalledOnce();
    expect(context.navigateAndWait).toHaveBeenCalledOnce();
  });

  it.each([
    {
      scenario: "keeps startup progress active through navigation",
      navigationError: null,
      canonicalSessionKey: null,
    },
    {
      scenario: "keeps placement ownership when the Gateway promotes a new session key",
      navigationError: null,
      canonicalSessionKey: "agent:cloud:dashboard:server-key",
    },
    {
      scenario: "surfaces navigation failure after placement startup commits",
      navigationError: "Placement chat route failed to load",
      canonicalSessionKey: null,
    },
  ])("$scenario", async ({ canonicalSessionKey, navigationError }) => {
    const createResult = vi.fn(async (params: Record<string, unknown>) => ({
      key: canonicalSessionKey ?? String(params.key),
      initialRun: { status: "idle" as const },
    }));
    const start = vi.fn(
      (_input: Parameters<ApplicationContext["placementStartup"]["start"]>[0]) =>
        new Promise<void>(() => {
          // Application-owned startup intentionally outlives this route.
        }),
    );
    let finishNavigation!: () => void;
    let failedNavigation = false;
    const navigateAndWait = vi.fn(
      (_routeId: string, _options?: Parameters<ApplicationContext["navigateAndWait"]>[1]) => {
        if (navigationError && !failedNavigation) {
          failedNavigation = true;
          return Promise.reject(new Error(navigationError));
        }
        return new Promise<void>((resolve) => {
          finishNavigation = resolve;
        });
      },
    );
    const preload = vi.fn(
      async (_routeId: string, _options?: Parameters<ApplicationContext["preload"]>[1]) =>
        undefined,
    );
    const setSessionKey = vi.fn((sessionKey: string) => {
      context.gateway.snapshot.sessionKey = sessionKey;
    });
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
          sessionKey: "",
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
    const host = new TestReactiveControllerHost();
    const gateway = new DraftGatewayState(
      host,
      () => ({
        context,
        data: undefined,
        isConnected: true,
        isAdmin: place?.isAdmin() ?? false,
        canStartAsDraft: flow?.capabilities.canStartAsDraft(context) ?? false,
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

    expect(preload).toHaveBeenCalledWith("chat", navigateAndWait.mock.calls[0]?.[1]);
    expect(preload.mock.invocationCallOrder[0]).toBeLessThan(
      navigateAndWait.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    if (!navigationError) {
      expect(flow.submitting).toBe(true);
      finishNavigation();
      document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT));
    }
    await submission;

    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]?.[0].recovery).toMatchObject({
      message: "keep this cloud task",
      attachments: apiAttachments,
      phase: "dispatching",
    });
    expect(flow.pendingPlacement.capture()).toBeNull();
    expect(flow.attachmentDraft.attachments).toHaveLength(0);
    expect(flow.error).toBe(navigationError);
    expect(flow.submitting).toBe(false);
    expect(createResult).toHaveBeenCalledOnce();
    expect(setSessionKey).toHaveBeenCalledWith(start.mock.calls[0]?.[0].recovery.sessionKey);
    expect(selectAgent).toHaveBeenCalledWith("cloud");
    expect(preload).toHaveBeenCalledOnce();

    if (navigationError) {
      expect(flow.canSubmit()).toBe(true);
      const retry = flow.submit();
      await vi.waitFor(() => expect(navigateAndWait).toHaveBeenCalledTimes(2));
      expect(flow.canSubmit()).toBe(false);
      finishNavigation();
      document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT));
      await retry;

      expect(createResult).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledOnce();
      expect(flow.error).toBeNull();
    }
  });
});
