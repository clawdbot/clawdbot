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
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import { DraftSubmissionFlow } from "./draft-submission-flow.ts";
import { TestReactiveControllerHost } from "./reactive-controller-host.test-support.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

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

describe("DraftSubmissionFlow", () => {
  it("keeps a direct background completion watch through a Gateway reconnect", async () => {
    vi.useFakeTimers();
    const { context, flow, request } = createDraftFixture();
    request.mockImplementation(async (method) => {
      if (method !== "agent.wait") {
        return {};
      }
      if (
        request.mock.calls.filter(([calledMethod]) => calledMethod === "agent.wait").length === 1
      ) {
        context.gateway.snapshot.phase = "reconnecting";
        throw new Error("gateway closed");
      }
      return { status: "ok", endedAt: 1 };
    });
    vi.mocked(context.sessions.createResult).mockResolvedValue({
      key: "agent:main:dashboard:background",
      initialRun: { status: "started", runId: "run-background" },
    });
    flow.setMessage("start this in the background");
    stubObjectUrls("blob:background-note");
    const attachment = registerTextPayload("background-note");
    flow.attachmentDraft.replace([attachment]);

    await flow.submit(undefined, true);
    await Promise.resolve();
    context.gateway.snapshot.phase = "connected";
    await vi.advanceTimersByTimeAsync(1_000);

    expect(context.sessions.createResult).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        message: "start this in the background",
      }),
      { reconciliation: "background" },
    );
    expect(context.navigateAndWait).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      "agent.wait",
      { runId: "run-background", timeoutMs: 30_000 },
      { timeoutMs: null },
    );
    expect(request.mock.calls.filter(([method]) => method === "agent.wait")).toHaveLength(2);
    expect(context.sessions.createResult).toHaveBeenCalledOnce();
    expect(request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
    expect(getChatAttachmentDataUrl(attachment)).toBeNull();
    const retained = context.chatSubmissions.readInitial(
      "agent:main:dashboard:background",
      context.gateway.snapshot.client,
    );
    expect(retained?.message.content).toContainEqual({
      type: "attachment",
      attachment: {
        url: `data:text/plain;base64,${btoa("background-note")}`,
        kind: "document",
        label: "background-note.txt",
        mimeType: "text/plain",
      },
    });
    expect(flow.message).toBe("");
    expect(flow.submitting).toBe(false);
  });

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

  it.each(["codex", "claude"])(
    "primary submission starts %s in a native terminal, never Chat",
    async (catalogId) => {
      const dispatch = vi.spyOn(window, "dispatchEvent");
      const { context, flow, request } = createDraftFixture({
        scopes: ["operator.admin", "operator.read", "operator.write"],
        methods: ["sessions.create", "sessions.catalog.startTerminal", "terminal.open"],
        data: {
          agentId: "main",
          requestedAgentId: "main",
          catalogId,
          model: "openai/test",
          catalogLabel: catalogId,
          startTerminal: true,
          terminalHosts: [{ hostId: "gateway:local", label: "Local CLI" }],
        },
        request: async (method) =>
          method === "sessions.catalog.startTerminal" ? { sessionId: "terminal-created" } : {},
      });
      flow.setMessage("start this task");
      await flow.submit();

      expect(request).toHaveBeenCalledWith("sessions.catalog.startTerminal", {
        catalogId,
        agentId: "main",
        hostId: "gateway:local",
        cwd: "/workspace",
        initialMessage: "start this task",
      });
      expect(context.sessions.createResult).not.toHaveBeenCalled();
      expect(request.mock.calls.some(([method]) => method === "sessions.create")).toBe(false);
      expect(context.navigateAndWait).not.toHaveBeenCalled();
      expect(flow.message).toBe("");
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: { open: true, terminalSessionId: "terminal-created", agentOwned: false },
        }),
      );
    },
  );

  it("provisions the chosen local worktree before opening the native CLI", async () => {
    const { flow, place, request, context } = createDraftFixture({
      scopes: ["operator.admin"],
      methods: ["sessions.catalog.startTerminal", "worktrees.create", "terminal.open"],
      agents: [{ id: "main", workspace: "/repo", workspaceGit: true }],
      data: {
        agentId: "main",
        requestedAgentId: "main",
        catalogId: "codex",
        catalogLabel: "Codex",
        model: "",
        startTerminal: true,
        terminalHosts: [{ hostId: "gateway:local", label: "Local" }],
      },
      request: async (method) =>
        method === "worktrees.branches"
          ? { repositoryStatus: "git", branches: ["main"], headBranch: "main" }
          : method === "worktrees.create"
            ? { path: "/repo/worktrees/native" }
            : { sessionId: "native-worktree" },
    });
    await vi.waitFor(() => expect(place.repository.kind).toBe("git"));
    place.toggleWorktree();
    place.setWorktreeName("native");
    place.setBaseRef("main");
    await flow.submit();
    expect(request).toHaveBeenCalledWith("worktrees.create", {
      repoRoot: "/repo",
      name: "native",
      baseRef: "main",
    });
    expect(request).toHaveBeenLastCalledWith("sessions.catalog.startTerminal", {
      catalogId: "codex",
      agentId: "main",
      hostId: "gateway:local",
      cwd: "/repo/worktrees/native",
    });
    expect(context.sessions.createResult).not.toHaveBeenCalled();
  });

  it.each(["codex", "claude"])(
    "%s native launch preserves node ownership and refuses stale capabilities",
    async (catalogId) => {
      const data = {
        agentId: "main",
        requestedAgentId: "main",
        catalogId,
        model: "",
        catalogLabel: catalogId,
        startTerminal: true,
        terminalHosts: [{ hostId: "node:chosen", label: "Chosen" }],
      };
      const { context, flow, gateway, place, request } = createDraftFixture({
        data,
        agents: [{ id: "main", workspace: "/gateway-only" }],
        scopes: ["operator.admin"],
        methods: ["sessions.catalog.startTerminal", "terminal.open"],
        request: async () => ({ sessionId: "native-node" }),
      });
      place.selectTerminalHost("node:chosen");
      expect(flow.submitDisabledReason()).toBeTruthy();
      place.applyFolder("/node/existing-project");
      const persistPreference = vi.spyOn(gateway, "persistPreference");
      request.mockClear();
      place.invalidateGatewayDiscovery(false);
      place.adoptAgentDefaults({ preserveSelectedAgent: true, preserveSelectedFolder: true });
      expect(persistPreference).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      flow.setMessage("native prompt");
      await flow.submit();
      expect(request).toHaveBeenCalledWith("sessions.catalog.startTerminal", {
        catalogId,
        agentId: "main",
        hostId: "node:chosen",
        cwd: "/node/existing-project",
        initialMessage: "native prompt",
      });
      expect(context.sessions.createResult).not.toHaveBeenCalled();
      request.mockClear();
      data.terminalHosts = [];
      await flow.submit();
      expect(flow.blockedSubmitNotice()).toContain("Native CLI host unavailable");
      expect(request).not.toHaveBeenCalled();
      expect(place.terminalHostId).toBe("node:chosen");
      expect(place.folder).toBe("/node/existing-project");
    },
  );

  it.each(["disabled", "attachments", "overrides", "missing method", "non-admin"])(
    "native launch fails visibly for %s without Chat fallback",
    async (failure) => {
      const { context, flow, request } = createDraftFixture({
        scopes: failure === "non-admin" ? ["operator.write"] : ["operator.admin"],
        methods:
          failure === "missing method"
            ? ["sessions.create"]
            : ["sessions.catalog.startTerminal", "terminal.open"],
        data: {
          agentId: "main",
          requestedAgentId: "main",
          catalogId: "codex",
          model: "",
          catalogLabel: "Codex",
          startTerminal: true,
          terminalHosts: [{ hostId: "gateway:local", label: "Local" }],
        },
      });
      if (failure === "disabled") {
        context.config.current.cliAgentsEnabled = false;
      }
      if (failure === "attachments") {
        stubObjectUrls("blob:native-attachment");
        flow.attachmentDraft.replace([registerTextPayload("native-attachment")]);
      }
      if (failure === "overrides") {
        flow.capabilities.setToolOverrides({ skills: { release: false } });
      }
      flow.setMessage("do not turn this into Chat");
      await flow.submit();
      expect(flow.blockedSubmitNotice()).toBeTruthy();
      expect(context.sessions.createResult).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(flow.message).toBe("do not turn this into Chat");
      if (failure === "overrides") {
        flow.capabilities.setToolOverrides(null);
        expect(flow.canSubmit()).toBe(true);
      }
    },
  );

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
    { methods: ["sessions.create"], allowed: true, worktree: true },
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
    { scenario: "an empty worktree session", message: "", worktree: true },
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
    // Empty-draft button gating is independent from the remote-project submission contract.
    vi.spyOn(flow, "canSubmit").mockReturnValue(true);

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
    { scenario: "an initial prompt and attachments", message: "keep this prompt", worktree: false },
    { scenario: "attachments without an initial prompt", message: "", worktree: false },
    { scenario: "a prompted worktree", message: "keep this prompt", worktree: true },
    { scenario: "an attachment-only worktree", message: "", worktree: true },
  ])("admits a remote project once with $scenario", async ({ message, worktree }) => {
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
    if (worktree) {
      place.toggleWorktree();
    }
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
    expect(vi.mocked(context.sessions.createResult).mock.calls[0]?.[0]?.worktree).toBe(
      worktree || undefined,
    );

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
    {
      scenario: "keeps a background placement on New Session",
      navigationError: null,
      canonicalSessionKey: "agent:cloud:dashboard:background-placement",
      background: true,
    },
  ])("$scenario", async ({ background = false, canonicalSessionKey, navigationError }) => {
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
    let startupPending = background;
    let backgroundWaitAttempts = 0;
    const client = {
      recoveryScope: "principal-a",
      recoveryScopeReady: true,
      request: vi.fn(async (method: string) => {
        if (method === "worktrees.branches") {
          return { repositoryStatus: "git", branches: [] };
        }
        if (method === "agent.wait") {
          backgroundWaitAttempts += 1;
          if (background && backgroundWaitAttempts === 1) {
            context.gateway.snapshot.phase = "reconnecting";
            throw new Error("gateway closed");
          }
          if (background && backgroundWaitAttempts === 2) {
            // Placement custody retires when sending is accepted, before the run finishes.
            startupPending = false;
            return { status: "timeout" };
          }
          if (background && backgroundWaitAttempts === 3) {
            return { status: "pending" };
          }
          return { status: "ok", endedAt: 1 };
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
              recoveryScope: client.recoveryScope,
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
      placementStartup: {
        start,
        get: vi.fn(() => undefined),
        hasPendingTurn: vi.fn(() => startupPending),
      },
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

    const submission = flow.submit(undefined, background);
    if (background) {
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
      expect(navigateAndWait).not.toHaveBeenCalled();
      expect(preload).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() => expect(navigateAndWait).toHaveBeenCalledOnce());
      expect(preload).toHaveBeenCalledWith("chat", navigateAndWait.mock.calls[0]?.[1]);
      expect(preload.mock.invocationCallOrder[0]).toBeLessThan(
        navigateAndWait.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
    }
    if (!navigationError && !background) {
      expect(flow.submitting).toBe(true);
      finishNavigation();
      document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT));
    }
    await submission;
    if (background) {
      context.gateway.snapshot.phase = "connected";
      await vi.waitFor(
        () =>
          expect(
            client.request.mock.calls.filter(([method]) => method === "agent.wait"),
          ).toHaveLength(4),
        { timeout: 4_000 },
      );
    }

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
    if (background) {
      expect(setSessionKey).not.toHaveBeenCalled();
      expect(selectAgent).not.toHaveBeenCalled();
      expect(flow.message).toBe("");
      expect(client.request).toHaveBeenCalledWith(
        "agent.wait",
        {
          runId: start.mock.calls[0]?.[0].recovery.messageId,
          timeoutMs: 30_000,
        },
        { timeoutMs: null },
      );
      expect(client.request.mock.calls.filter(([method]) => method === "agent.wait")).toHaveLength(
        4,
      );
    } else {
      expect(setSessionKey).toHaveBeenCalledWith(start.mock.calls[0]?.[0].recovery.sessionKey);
      expect(selectAgent).toHaveBeenCalledWith("cloud");
      expect(preload).toHaveBeenCalledOnce();
    }

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
