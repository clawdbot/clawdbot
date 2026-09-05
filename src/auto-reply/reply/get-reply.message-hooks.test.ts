// Tests get-reply message hooks before and after agent execution.
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { isPathInside } from "../../infra/path-guards.js";
import type { ApplyMediaUnderstandingResult } from "../../media-understanding/apply.js";
import { AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE } from "../../sessions/agent-harness-session-key.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { MsgContext } from "../templating.js";
import { withFastReplyConfig } from "./get-reply-fast-path.test-support.js";
import {
  buildGetReplyGroupCtx,
  createGetReplyContinueDirectivesResult,
  createGetReplySessionState,
  registerGetReplyBaselineBypass,
  registerGetReplyRuntimeOverrides,
} from "./get-reply.test-fixtures.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import "./get-reply.test-mocks.js";

registerGetReplyBaselineBypass();

const mocks = vi.hoisted(() => ({
  applyMediaUnderstanding: vi.fn<
    (..._args: unknown[]) => Promise<ApplyMediaUnderstandingResult | undefined>
  >(async (..._args: unknown[]) => undefined),
  applyLinkUnderstanding: vi.fn(async (..._args: unknown[]) => undefined),
  createInternalHookEvent: vi.fn(),
  triggerInternalHook: vi.fn(async (..._args: unknown[]) => undefined),
  resolveReplyDirectives: vi.fn(),
  handleInlineActions: vi.fn(),
  initSessionState: vi.fn(),
  resolveReplySessionPreprocessingState: vi.fn(),
}));

vi.mock("../../globals.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../globals.js")>()),
  logVerbose: vi.fn(),
}));
vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: mocks.createInternalHookEvent,
  triggerInternalHook: mocks.triggerInternalHook,
}));
vi.mock("../../link-understanding/apply.runtime.js", () => ({
  applyLinkUnderstanding: mocks.applyLinkUnderstanding,
}));
vi.mock("../../media-understanding/apply.runtime.js", () => ({
  applyMediaUnderstanding: mocks.applyMediaUnderstanding,
}));
registerGetReplyRuntimeOverrides(mocks);

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;
let resolveAgentWorkspaceDirMock: typeof import("../../agents/agent-scope.js").resolveAgentWorkspaceDir;
let resolveDefaultModelMock: typeof import("./directive-handling.defaults.js").resolveDefaultModel;
let runPreparedReplyMock: typeof import("./get-reply-run.js").runPreparedReply;
let stageSandboxMediaMock: typeof import("./stage-sandbox-media.runtime.js").stageSandboxMedia;

async function loadGetReplyRuntimeForTest() {
  ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
  ({ resolveAgentWorkspaceDir: resolveAgentWorkspaceDirMock } =
    await import("../../agents/agent-scope.js"));
  ({ resolveDefaultModel: resolveDefaultModelMock } =
    await import("./directive-handling.defaults.js"));
  ({ runPreparedReply: runPreparedReplyMock } = await import("./get-reply-run.js"));
  ({ stageSandboxMedia: stageSandboxMediaMock } = await import("./stage-sandbox-media.runtime.js"));
  const scope = await import("../../agents/agent-scope.js");
  const actualScope = await vi.importActual<typeof scope>("../../agents/agent-scope.js");
  vi.mocked(scope.resolveSessionAgentId).mockImplementation(actualScope.resolveSessionAgentId);
}

function emptyAliasIndex() {
  return { byAlias: new Map(), byKey: new Map() };
}

function buildCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return buildGetReplyGroupCtx({
    Body: "<media:audio>",
    BodyForAgent: "<media:audio>",
    RawBody: "<media:audio>",
    CommandBody: "<media:audio>",
    GroupChannel: "ops",
    media: [
      {
        path: "/tmp/voice.ogg",
        url: "https://example.test/voice.ogg",
        contentType: "audio/ogg",
      },
    ],
    ...overrides,
  });
}

function buildConfiguredAudioCfg() {
  return withFastReplyConfig({
    tools: {
      media: {
        models: [
          {
            type: "cli",
            command: "/usr/local/bin/stt-transcribe",
            args: ["{{MediaPath}}"],
            capabilities: ["audio"],
          },
        ],
        audio: {
          enabled: true,
        },
      },
    },
  });
}

function buildTextCtx(body: string, overrides: Partial<MsgContext> = {}): MsgContext {
  return buildCtx({
    Body: body,
    BodyForAgent: body,
    RawBody: body,
    CommandBody: body,
    BodyForCommands: body,
    media: undefined,
    ...overrides,
  });
}

function hookEventCall(index: number): [string, string, string, Record<string, unknown>] {
  const call = mocks.createInternalHookEvent.mock.calls[index];
  if (!call) {
    throw new Error(`expected hook event call ${index + 1}`);
  }
  return call as [string, string, string, Record<string, unknown>];
}

function verboseMessages(): string[] {
  return vi.mocked(logVerbose).mock.calls.map(([message]) => message);
}

async function resetMessageHookTestState() {
  await loadGetReplyRuntimeForTest();
  delete process.env.OPENCLAW_TEST_FAST;
  mocks.applyMediaUnderstanding.mockReset();
  mocks.applyLinkUnderstanding.mockReset();
  mocks.createInternalHookEvent.mockReset();
  mocks.triggerInternalHook.mockReset();
  mocks.resolveReplyDirectives.mockReset();
  mocks.handleInlineActions.mockReset();
  mocks.initSessionState.mockReset();
  mocks.resolveReplySessionPreprocessingState.mockReset();
  vi.mocked(resolveDefaultModelMock).mockReset();
  vi.mocked(runPreparedReplyMock).mockReset();
  vi.mocked(stageSandboxMediaMock).mockReset();
  vi.mocked(logVerbose).mockReset();

  mocks.applyMediaUnderstanding.mockImplementation(async (...args: unknown[]) => {
    const { ctx } = args[0] as { ctx: MsgContext };
    ctx.Transcript = "voice transcript";
    ctx.Body = "[Audio]\nTranscript:\nvoice transcript";
    ctx.BodyForAgent = "[Audio]\nTranscript:\nvoice transcript";
  });
  mocks.applyLinkUnderstanding.mockResolvedValue(undefined);
  mocks.createInternalHookEvent.mockImplementation(
    (type: string, action: string, sessionKey: string, context: Record<string, unknown>) => ({
      type,
      action,
      sessionKey,
      context,
      timestamp: new Date(),
      messages: [],
    }),
  );
  mocks.triggerInternalHook.mockResolvedValue(undefined);
  mocks.handleInlineActions.mockImplementation(async (...args: unknown[]) => {
    const params = args[0] as {
      directives?: unknown;
      cleanedBody?: string;
      abortedLastRun?: boolean;
    };
    return {
      kind: "continue",
      directives: params.directives ?? {},
      cleanedBody: params.cleanedBody ?? "",
      abortedLastRun: params.abortedLastRun,
    };
  });
  mocks.resolveReplyDirectives.mockResolvedValue({ kind: "reply", reply: { text: "ok" } });
  vi.mocked(resolveDefaultModelMock).mockReturnValue({
    defaultProvider: "openai",
    defaultModel: "gpt-4o-mini",
    aliasIndex: emptyAliasIndex(),
  });
  vi.mocked(runPreparedReplyMock).mockResolvedValue({ text: "ok" });
  vi.mocked(stageSandboxMediaMock).mockResolvedValue({ staged: new Map() });
  mocks.resolveReplySessionPreprocessingState.mockReturnValue({
    sessionEntry: undefined,
    sessionKey: "agent:main:telegram:-100123",
    storePath: "/tmp/sessions.json",
  });
  mocks.initSessionState.mockResolvedValue(
    createGetReplySessionState({
      sessionKey: "agent:main:telegram:-100123",
      sessionScope: "per-chat",
      isGroup: true,
    }),
  );
}

async function runLocalPathSelfServeCase(params: {
  ctx: Partial<MsgContext>;
  cfg: OpenClawConfig;
  opts?: Parameters<typeof getReplyFromConfig>[1];
  provider?: string;
  model?: string;
  senderIsOwner?: boolean;
  sessionKey?: string;
}) {
  const ctx = buildCtx(params.ctx);
  const enableLocalPathSelfServe = vi.fn();
  mocks.applyMediaUnderstanding.mockResolvedValueOnce({
    outputs: [],
    decisions: [],
    extractedFileImages: [],
    appliedImage: false,
    appliedAudio: false,
    appliedVideo: false,
    appliedFile: true,
    enableLocalPathSelfServe,
  });
  mocks.initSessionState.mockResolvedValueOnce(
    createGetReplySessionState({
      sessionCtx: ctx,
      sessionKey: params.sessionKey ?? ctx.SessionKey,
      isGroup: false,
    }),
  );
  mocks.resolveReplyDirectives.mockResolvedValueOnce(
    createGetReplyContinueDirectivesResult({
      body: ctx.BodyForAgent ?? "read the document",
      abortKey: ctx.SessionKey ?? "agent:main:main",
      from: ctx.From ?? "webchat:operator",
      to: ctx.To ?? "webchat:local",
      senderId: ctx.SenderId ?? "operator",
      commandSource: "message",
      senderIsOwner: params.senderIsOwner ?? false,
      resetHookTriggered: false,
      provider: params.provider,
      model: params.model,
    }),
  );

  await getReplyFromConfig(ctx, params.opts, withFastReplyConfig(params.cfg));
  return enableLocalPathSelfServe;
}

describe("getReplyFromConfig message hooks", () => {
  let enrichedHookCase: {
    transcribed: ReturnType<typeof hookEventCall>;
    preprocessed: ReturnType<typeof hookEventCall>;
    triggerCount: number;
  };

  beforeAll(async () => {
    await resetMessageHookTestState();
    const ctx = buildCtx();

    await getReplyFromConfig(ctx, undefined, withFastReplyConfig({}));

    enrichedHookCase = {
      transcribed: hookEventCall(0),
      preprocessed: hookEventCall(1),
      triggerCount: mocks.triggerInternalHook.mock.calls.length,
    };
  });

  beforeEach(async () => {
    await resetMessageHookTestState();
  });

  it("emits transcribed + preprocessed hooks with enriched context", () => {
    const { transcribed, preprocessed, triggerCount } = enrichedHookCase;
    expect(transcribed[0]).toBe("message");
    expect(transcribed[1]).toBe("transcribed");
    expect(transcribed[2]).toBe("agent:main:telegram:-100123");
    expect(transcribed[3].transcript).toBe("voice transcript");
    expect(transcribed[3].channelId).toBe("telegram");
    expect(transcribed[3].conversationId).toBe("telegram:-100123");

    expect(preprocessed[0]).toBe("message");
    expect(preprocessed[1]).toBe("preprocessed");
    expect(preprocessed[2]).toBe("agent:main:telegram:-100123");
    expect(preprocessed[3].transcript).toBe("voice transcript");
    expect(preprocessed[3].isGroup).toBe(true);
    expect(preprocessed[3].groupId).toBe("telegram:-100123");
    expect(triggerCount).toBe(2);
  });

  it("prepares durable session state before media understanding", async () => {
    const order: string[] = [];
    mocks.resolveReplySessionPreprocessingState.mockImplementationOnce(() => {
      order.push("preflight");
      return {
        sessionEntry: undefined,
        sessionKey: "agent:main:telegram:-100123",
        storePath: "/tmp/sessions.json",
      };
    });
    mocks.initSessionState.mockImplementationOnce(async (...args: unknown[]) => {
      order.push("session");
      const { ctx } = args[0] as { ctx: MsgContext };
      expect(ctx.BodyForAgent).toBe("[Audio]\nTranscript:\nresolved after admission");
      return createGetReplySessionState({
        sessionCtx: { ...ctx, BodyStripped: ctx.BodyForAgent },
        sessionKey: "agent:main:telegram:-100123",
        sessionScope: "per-chat",
        isGroup: true,
      });
    });
    mocks.applyMediaUnderstanding.mockImplementationOnce(async (...args: unknown[]) => {
      order.push("media");
      const { ctx } = args[0] as { ctx: MsgContext };
      ctx.Body = "[Audio]\nTranscript:\nresolved after admission";
      ctx.BodyForAgent = ctx.Body;
      ctx.Transcript = "resolved after admission";
      return undefined;
    });

    await getReplyFromConfig(buildCtx(), undefined, withFastReplyConfig({}));

    expect(order).toEqual(["preflight", "media", "session"]);
    expect(mocks.resolveReplyDirectives.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        sessionCtx: expect.objectContaining({
          BodyForAgent: "[Audio]\nTranscript:\nresolved after admission",
          BodyStripped: "[Audio]\nTranscript:\nresolved after admission",
          Transcript: "resolved after admission",
        }),
      }),
    );
  });

  it("runs configured audio transcription for a model-locked harness voice note", async () => {
    const sessionKey = "agent:main:harness:claude-cli:locked-audio";
    const sessionEntry = {
      sessionId: "locked-session",
      updatedAt: 1,
      agentHarnessId: "claude-cli",
      modelSelectionLocked: true,
    };
    mocks.resolveReplySessionPreprocessingState.mockReturnValueOnce({
      sessionEntry,
      sessionKey,
      storePath: "/tmp/sessions.json",
    });
    mocks.initSessionState.mockResolvedValueOnce(
      createGetReplySessionState({
        sessionCtx: {
          BodyForAgent: "<media:audio>",
          SessionKey: sessionKey,
        },
        sessionEntry,
        sessionKey,
      }),
    );

    await getReplyFromConfig(
      buildCtx({ SessionKey: sessionKey }),
      undefined,
      buildConfiguredAudioCfg(),
    );

    expect(mocks.resolveReplySessionPreprocessingState).toHaveBeenCalledOnce();
    expect(mocks.initSessionState).toHaveBeenCalledOnce();
    expect(mocks.applyMediaUnderstanding).toHaveBeenCalledOnce();
    expect(mocks.applyMediaUnderstanding.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ processingMode: "audio-only" }),
    );
    expect(mocks.resolveReplyDirectives.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        sessionEntry: expect.objectContaining({
          agentHarnessId: "claude-cli",
          modelSelectionLocked: true,
        }),
        ctx: expect.objectContaining({
          BodyForAgent: "[Audio]\nTranscript:\nvoice transcript",
          SessionKey: sessionKey,
        }),
      }),
    );
  });

  it("does not infer locked-harness audio from its filename when MIME metadata is missing", async () => {
    const sessionKey = "agent:main:harness:claude-cli:locked-audio-filename";
    mocks.resolveReplySessionPreprocessingState.mockReturnValueOnce({
      sessionEntry: {
        sessionId: "locked-filename-session",
        updatedAt: 1,
        agentHarnessId: "claude-cli",
        modelSelectionLocked: true,
      },
      sessionKey,
      storePath: "/tmp/sessions.json",
    });

    await getReplyFromConfig(
      buildCtx({
        SessionKey: sessionKey,
        Body: "<media:file>",
        BodyForAgent: "<media:file>",
        BodyForCommands: "<media:file>",
        RawBody: "<media:file>",
        CommandBody: "<media:file>",
        media: [{ path: "/tmp/voice.ogg", url: "https://example.test/voice.ogg" }],
      }),
      undefined,
      buildConfiguredAudioCfg(),
    );

    expect(mocks.applyMediaUnderstanding).not.toHaveBeenCalled();
  });

  it("runs normal media understanding for an unlocked voice note", async () => {
    await getReplyFromConfig(buildCtx(), undefined, buildConfiguredAudioCfg());

    expect(mocks.applyMediaUnderstanding).toHaveBeenCalledOnce();
    expect(mocks.applyMediaUnderstanding.mock.calls[0]?.[0]).not.toHaveProperty("processingMode");
    expect(mocks.resolveReplyDirectives.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        ctx: expect.objectContaining({
          BodyForAgent: "[Audio]\nTranscript:\nvoice transcript",
        }),
      }),
    );
  });

  const hostDocumentCtx = {
    SessionKey: "agent:main:main",
    OriginatingChannel: undefined,
    Provider: "webchat",
    Surface: "webchat",
    ChatType: "direct",
    SenderId: "operator",
  } as const;

  it.each(["agent:main:main", "global"])(
    "promotes local document self-service for the prepared %s owner",
    async (sessionKey) => {
      const enable = await runLocalPathSelfServeCase({
        ctx: hostDocumentCtx,
        sessionKey,
        cfg: { agents: { ownership: "explicit", entries: { main: {}, other: {} } } },
      });
      expect(enable).toHaveBeenCalledOnce();
    },
  );

  it.each([true, false])(
    "enables sandboxed document self-service only after staging succeeds (%s)",
    async (staged) => {
      const stagedPaths = new Map(staged ? [[0, "media/inbound/report.docx"]] : []);
      vi.mocked(stageSandboxMediaMock).mockResolvedValueOnce({ staged: stagedPaths });
      const enable = await runLocalPathSelfServeCase({
        ctx: {
          ...hostDocumentCtx,
          OriginatingChannel: "telegram",
          AccountId: "default",
          SenderId: "42",
        },
        cfg: {
          agents: {
            defaults: { sandbox: { mode: "non-main", scope: "agent" } },
            list: [{ id: "main", default: true }],
          },
        },
      });
      expect(enable.mock.calls).toEqual(staged ? [[expect.any(Array), stagedPaths]] : []);
      expect(stageSandboxMediaMock).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "main" }),
      );
    },
  );

  it("promotes a remote document staged before media understanding", async () => {
    const remotePath = "/remote/report.docx";
    const stagedPath = "media/inbound/report.docx";
    const contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    vi.mocked(stageSandboxMediaMock).mockImplementationOnce(async (params) => {
      const stagedFacts = [
        {
          path: stagedPath,
          contentType,
          workspaceDir: "/tmp/workspace",
        },
      ];
      params.ctx.media = stagedFacts;
      params.sessionCtx.media = stagedFacts;
      return { staged: new Map([[0, stagedPath]]) };
    });
    const enable = await runLocalPathSelfServeCase({
      ctx: {
        ...hostDocumentCtx,
        media: [
          {
            path: remotePath,
            contentType,
          },
        ],
        MediaRemoteHost: "user@gateway-host",
        OriginatingChannel: "telegram",
        AccountId: "default",
        SenderId: "42",
      },
      cfg: {
        agents: {
          defaults: { sandbox: { mode: "non-main", scope: "agent" } },
          list: [{ id: "main", default: true }],
        },
      },
    });

    expect(stageSandboxMediaMock).toHaveBeenCalledOnce();
    expect(stageSandboxMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main" }),
    );
    expect(enable).toHaveBeenCalledWith(expect.any(Array), new Map([[0, stagedPath]]));
  });

  it("withholds local document self-service when the turn cannot read files", async () => {
    const enable = await runLocalPathSelfServeCase({
      ctx: hostDocumentCtx,
      cfg: {},
      opts: { toolsAllow: ["message"] },
    });
    expect(enable).not.toHaveBeenCalled();
  });

  it("withholds local document self-service from workspace-only file tools", async () => {
    const enable = await runLocalPathSelfServeCase({
      ctx: hostDocumentCtx,
      cfg: { tools: { fs: { workspaceOnly: true } } },
    });
    expect(enable).not.toHaveBeenCalled();
  });

  it("projects local document self-service against the final provider", async () => {
    const cfg = { tools: { byProvider: { anthropic: { deny: ["read"] } } } };
    const denied = await runLocalPathSelfServeCase({
      ctx: hostDocumentCtx,
      cfg,
      provider: "anthropic",
      model: "claude-sonnet",
    });
    expect(denied).not.toHaveBeenCalled();

    await resetMessageHookTestState();
    const unrelated = await runLocalPathSelfServeCase({
      ctx: hostDocumentCtx,
      cfg,
      provider: "openai",
      model: "gpt-5",
    });
    expect(unrelated).toHaveBeenCalledOnce();
  });

  it("applies wildcard sender policy only to non-owner turns", async () => {
    const cfg = { tools: { toolsBySender: { "*": { deny: ["read"] } } } };
    const nonOwner = await runLocalPathSelfServeCase({ ctx: hostDocumentCtx, cfg });
    expect(nonOwner).not.toHaveBeenCalled();

    await resetMessageHookTestState();
    const owner = await runLocalPathSelfServeCase({
      ctx: hostDocumentCtx,
      cfg,
      senderIsOwner: true,
    });
    expect(owner).toHaveBeenCalledOnce();
  });

  it("keeps unconfigured audio with a model-locked harness", async () => {
    const sessionKey = "agent:main:harness:claude-cli:locked-unconfigured-audio";
    const sessionEntry = {
      sessionId: "locked-unconfigured-session",
      updatedAt: 1,
      agentHarnessId: "claude-cli",
      modelSelectionLocked: true,
    };
    mocks.resolveReplySessionPreprocessingState.mockReturnValueOnce({
      sessionEntry,
      sessionKey,
      storePath: "/tmp/sessions.json",
    });

    await getReplyFromConfig(
      buildCtx({ SessionKey: sessionKey }),
      undefined,
      withFastReplyConfig({}),
    );

    expect(mocks.applyMediaUnderstanding).not.toHaveBeenCalled();
  });

  it("skips utility link understanding for a model-locked harness session", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:locked-link";
    const body = "read https://example.test/page";
    const sessionEntry = {
      sessionId: "locked-link-session",
      updatedAt: 1,
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    };
    mocks.resolveReplySessionPreprocessingState.mockReturnValueOnce({
      sessionEntry,
      sessionKey,
      storePath: "/tmp/sessions.json",
    });
    mocks.initSessionState.mockResolvedValueOnce(
      createGetReplySessionState({
        sessionCtx: { BodyForAgent: body, SessionKey: sessionKey },
        sessionEntry,
        sessionKey,
      }),
    );

    await getReplyFromConfig(
      buildTextCtx(body, { SessionKey: sessionKey }),
      undefined,
      withFastReplyConfig({}),
    );

    expect(mocks.resolveReplySessionPreprocessingState).toHaveBeenCalledOnce();
    expect(mocks.applyLinkUnderstanding).not.toHaveBeenCalled();
    expect(mocks.initSessionState).toHaveBeenCalledOnce();
  });

  it("fails closed before link understanding when the reserved session is missing", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:missing-link";
    mocks.resolveReplySessionPreprocessingState.mockImplementationOnce(() => {
      throw new Error(AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE);
    });

    await expect(
      getReplyFromConfig(
        buildTextCtx("read https://example.test/page", { SessionKey: sessionKey }),
        undefined,
        withFastReplyConfig({}),
      ),
    ).rejects.toThrow(AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE);

    expect(mocks.applyLinkUnderstanding).not.toHaveBeenCalled();
    expect(mocks.initSessionState).not.toHaveBeenCalled();
  });

  it("enriches staged text-only images before reply without switching the reply model", async () => {
    const enrichedBody = "describe image\n\n[Image 1]\na tiny dot image";
    const extractedPdfPage = {
      type: "image",
      data: "pdf-page",
      mimeType: "image/png",
      attachmentIndex: 0,
    } as const;
    vi.mocked(resolveDefaultModelMock).mockReturnValueOnce({
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      aliasIndex: emptyAliasIndex(),
    });
    mocks.applyMediaUnderstanding.mockImplementationOnce(async (...args: unknown[]) => {
      const params = args[0] as {
        ctx: MsgContext;
        activeModel?: { provider: string; model: string };
        agentId?: string;
      };
      expect(params.activeModel).toEqual({
        provider: "anthropic",
        model: "claude-opus-4-6",
      });
      expect(params.agentId).toBe("main");
      params.ctx.MediaUnderstanding = [
        {
          kind: "image.description",
          attachmentIndex: 0,
          provider: "openai",
          model: "gpt-4o",
          text: "a tiny dot image",
        },
      ];
      params.ctx.Body = enrichedBody;
      params.ctx.BodyForAgent = enrichedBody;
      params.ctx.BodyForCommands = enrichedBody;
      params.ctx.CommandBody = enrichedBody;
      params.ctx.RawBody = enrichedBody;
      return {
        outputs: params.ctx.MediaUnderstanding,
        decisions: [],
        extractedFileImages: [extractedPdfPage],
        appliedImage: true,
        appliedAudio: false,
        appliedVideo: false,
        appliedFile: true,
      };
    });
    mocks.resolveReplyDirectives.mockResolvedValueOnce(
      createGetReplyContinueDirectivesResult({
        body: enrichedBody,
        abortKey: "agent:main:webchat:direct:user",
        from: "webchat:user",
        to: "webchat:local",
        senderId: "webchat:user",
        commandSource: "native",
        senderIsOwner: true,
        resetHookTriggered: false,
        provider: "anthropic",
        model: "claude-opus-4-6",
      }),
    );

    await expect(
      getReplyFromConfig(
        buildCtx({
          Provider: "webchat",
          Surface: "webchat",
          OriginatingChannel: "webchat",
          OriginatingTo: "webchat:local",
          ChatType: "direct",
          Body: "describe image",
          BodyForAgent: "describe image",
          RawBody: "describe image",
          CommandBody: "describe image",
          BodyForCommands: "describe image",
          SessionKey: "agent:main:webchat:direct:user",
          From: "webchat:user",
          To: "webchat:local",
          media: [{ path: "/tmp/1.png", contentType: "image/png", workspaceDir: "/tmp" }],
        }),
        undefined,
        withFastReplyConfig({
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-6",
              imageModel: { primary: "openai/gpt-4o" },
            },
          },
        }),
      ),
    ).resolves.toEqual({ text: "ok" });

    expect(mocks.applyMediaUnderstanding).toHaveBeenCalledTimes(1);
    expect(mocks.resolveReplyDirectives).toHaveBeenCalledTimes(1);
    expect(mocks.resolveReplyDirectives.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-opus-4-6",
      }),
    );
    expect(vi.mocked(runPreparedReplyMock)).toHaveBeenCalledOnce();
    const runParams = vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0];
    expect(runParams).toEqual(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-opus-4-6",
      }),
    );
    expect(runParams?.ctx.BodyForAgent).toContain("a tiny dot image");
    expect(runParams?.ctx.MediaUnderstanding).toEqual([
      expect.objectContaining({
        provider: "openai",
        model: "gpt-4o",
        text: "a tiny dot image",
      }),
    ]);
    expect(runParams?.opts).toEqual(
      expect.objectContaining({
        extractedFileImages: [extractedPdfPage],
      }),
    );
    expect(stageSandboxMediaMock).not.toHaveBeenCalled();
  });

  it("adopts SDK-staged legacy paths without staging them again", async () => {
    const stagedPath = "/tmp/sdk-staged-photo.jpg";
    const { finalizeInboundContext } =
      await vi.importActual<typeof import("./inbound-context.js")>("./inbound-context.js");
    mocks.applyMediaUnderstanding.mockImplementationOnce(async (...args: unknown[]) => {
      const { ctx } = args[0] as { ctx: MsgContext };
      expect(ctx.media).toEqual([
        expect.objectContaining({ path: stagedPath, url: stagedPath, contentType: "image/jpeg" }),
      ]);
    });

    await getReplyFromConfig(
      finalizeInboundContext(
        buildCtx({
          media: [{ path: "/remote/photo.jpg", contentType: "image/jpeg" }],
          MediaPath: stagedPath,
          MediaUrl: stagedPath,
          MediaType: "image/jpeg",
          MediaPaths: [stagedPath],
          MediaUrls: [stagedPath],
          MediaTypes: ["image/jpeg"],
          MediaStaged: true,
        }),
      ),
      undefined,
      withFastReplyConfig({}),
    );

    expect(stageSandboxMediaMock).not.toHaveBeenCalled();
  });

  it("stages remaining facts when an SDK staged projection is only partial", async () => {
    const stagedPath = "/tmp/sdk-staged-photo.jpg";
    const remainingPath = "/remote/remaining.pdf";
    const { finalizeInboundContext } =
      await vi.importActual<typeof import("./inbound-context.js")>("./inbound-context.js");

    await getReplyFromConfig(
      finalizeInboundContext(
        buildCtx({
          media: [
            { path: "/remote/photo.jpg", contentType: "image/jpeg", messageId: "photo" },
            { path: remainingPath, contentType: "application/pdf", messageId: "document" },
          ],
          MediaPath: stagedPath,
          MediaStaged: true,
          MediaRemoteHost: "user@gateway-host",
        }),
      ),
      undefined,
      withFastReplyConfig({}),
    );

    expect(stageSandboxMediaMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(stageSandboxMediaMock).mock.calls[0]?.[0].ctx.media).toEqual([
      expect.objectContaining({ path: stagedPath, messageId: "photo" }),
      expect.objectContaining({ path: remainingPath, messageId: "document" }),
    ]);
  });

  it("stages remaining remote iMessage media in a mixed staged context", async () => {
    await withOpenClawTestState({ label: "reply-message-hooks-mixed-media" }, async (state) => {
      const order: string[] = [];
      const alreadyStagedPath = "/tmp/already-staged.jpg";
      const remotePath = "/Users/demo/Library/Messages/Attachments/ab/cd/photo.jpg";
      const stagedPath = "/tmp/openclaw-remote-cache/photo.jpg";
      vi.mocked(stageSandboxMediaMock).mockImplementationOnce(async (params) => {
        order.push("stage");
        const stagedFacts = [
          { path: alreadyStagedPath, contentType: "image/jpeg", workspaceDir: "/tmp" },
          { path: stagedPath, contentType: "image/jpeg", workspaceDir: "/tmp" },
        ];
        params.ctx.media = stagedFacts;
        params.sessionCtx.media = stagedFacts;
        return { staged: new Map([[1, stagedPath]]) };
      });
      mocks.applyMediaUnderstanding.mockImplementationOnce(async (...args: unknown[]) => {
        order.push("understand");
        const { ctx } = args[0] as { ctx: MsgContext };
        expect(ctx.media).toEqual([
          { path: alreadyStagedPath, contentType: "image/jpeg", workspaceDir: "/tmp" },
          { path: stagedPath, contentType: "image/jpeg", workspaceDir: "/tmp" },
        ]);
      });

      await getReplyFromConfig(
        buildCtx({
          Provider: "imessage",
          Surface: "imessage",
          OriginatingChannel: "imessage",
          OriginatingTo: "imessage:chat:abc",
          ChatType: "direct",
          Body: "please describe this",
          BodyForAgent: "please describe this",
          RawBody: "please describe this",
          CommandBody: "please describe this",
          BodyForCommands: "please describe this",
          SessionKey: "agent:main:imessage:direct:user",
          From: "imessage:user",
          To: "imessage:chat:abc",
          media: [
            {
              path: alreadyStagedPath,
              contentType: "image/jpeg",
              workspaceDir: "/tmp",
            },
            { path: remotePath, url: remotePath, contentType: "image/jpeg" },
          ],
          MediaRemoteHost: "user@gateway-host",
        }),
        undefined,
        withFastReplyConfig({ agents: { defaults: { workspace: state.workspaceDir } } }),
      );

      expect(order).toEqual(["stage", "understand"]);
      expect(stageSandboxMediaMock).toHaveBeenCalledTimes(1);
      expect(stageSandboxMediaMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:imessage:direct:user",
          workspaceDir: state.workspaceDir,
        }),
      );
    });
  });

  it("emits only preprocessed when no transcript is produced", async () => {
    mocks.applyMediaUnderstanding.mockImplementationOnce(async (...args: unknown[]) => {
      const { ctx } = args[0] as { ctx: MsgContext };
      ctx.Transcript = undefined;
      ctx.Body = "<media:audio>";
      ctx.BodyForAgent = "<media:audio>";
    });

    await getReplyFromConfig(buildCtx(), undefined, withFastReplyConfig({}));

    expect(mocks.createInternalHookEvent).toHaveBeenCalledTimes(1);
    const preprocessed = hookEventCall(0);
    expect(preprocessed[0]).toBe("message");
    expect(preprocessed[1]).toBe("preprocessed");
    expect(preprocessed[2]).toBe("agent:main:telegram:-100123");
    expect(preprocessed[3]).toBeTypeOf("object");
  });

  it("skips message hooks in fast test mode", async () => {
    await withOpenClawTestState(
      { label: "reply-message-hooks-fast", env: { OPENCLAW_TEST_FAST: "1" } },
      async (state) => {
        const storePath = path.join(state.sessionsDir("main"), "sessions.json");
        const cfg = withFastReplyConfig({
          agents: { defaults: { workspace: state.workspaceDir } },
          session: { store: storePath },
        });
        const sqliteTarget = resolveUnsuffixedSqliteTargetFromSessionStorePath(cfg.session.store);
        expect(isPathInside(state.root, sqliteTarget.path)).toBe(true);
        expect(isPathInside(state.root, resolveAgentWorkspaceDirMock(cfg, "main"))).toBe(true);

        await getReplyFromConfig(buildCtx(), undefined, cfg);

        expect(mocks.applyMediaUnderstanding).not.toHaveBeenCalled();
        expect(mocks.applyLinkUnderstanding).not.toHaveBeenCalled();
        expect(mocks.createInternalHookEvent).not.toHaveBeenCalled();
        expect(mocks.triggerInternalHook).not.toHaveBeenCalled();
      },
    );
  });

  it("skips message hooks when SessionKey is unavailable", async () => {
    await getReplyFromConfig(
      buildCtx({ SessionKey: undefined }),
      undefined,
      withFastReplyConfig({}),
    );

    expect(mocks.createInternalHookEvent).not.toHaveBeenCalled();
    expect(mocks.triggerInternalHook).not.toHaveBeenCalled();
  });

  it("skips media and link understanding on plain text without attachments or urls", async () => {
    await getReplyFromConfig(
      buildTextCtx("hello there", { Sticker: undefined, StickerMediaIncluded: undefined }),
      undefined,
      withFastReplyConfig({}),
    );

    expect(mocks.applyMediaUnderstanding).not.toHaveBeenCalled();
    expect(mocks.applyLinkUnderstanding).not.toHaveBeenCalled();
  });

  it("keeps cached sticker media attached without repeating media understanding", async () => {
    const stickerPath = "/tmp/cached-sticker.webp";

    await getReplyFromConfig(
      buildCtx({
        Body: "[Sticker] Cached description",
        BodyForAgent: "[Sticker] Cached description",
        RawBody: "[Sticker] Cached description",
        CommandBody: "[Sticker] Cached description",
        BodyForCommands: "[Sticker] Cached description",
        media: [{ path: stickerPath, url: stickerPath, contentType: "image/webp" }],
        Sticker: { cachedDescription: "Cached description" },
        StickerMediaIncluded: true,
        SkipStickerMediaUnderstanding: true,
      }),
      undefined,
      withFastReplyConfig({}),
    );

    expect(mocks.applyMediaUnderstanding).not.toHaveBeenCalled();
  });

  it("still understands supplemental media attached to a cached sticker reply", async () => {
    await getReplyFromConfig(
      buildCtx({
        Body: "[Sticker] Cached description",
        BodyForAgent: "[Sticker] Cached description",
        RawBody: "[Sticker] Cached description",
        CommandBody: "[Sticker] Cached description",
        BodyForCommands: "[Sticker] Cached description",
        media: [
          {
            path: "/tmp/cached-sticker.webp",
            url: "/tmp/cached-sticker.webp",
            contentType: "image/webp",
          },
          {
            path: "/tmp/replied-audio.ogg",
            url: "/tmp/replied-audio.ogg",
            contentType: "audio/ogg",
          },
        ],
        Sticker: { cachedDescription: "Cached description" },
        StickerMediaIncluded: true,
        SkipStickerMediaUnderstanding: true,
      }),
      undefined,
      withFastReplyConfig({}),
    );

    expect(mocks.applyMediaUnderstanding).toHaveBeenCalledOnce();
  });

  it("continues dispatching when media understanding fails before reply routing", async () => {
    mocks.applyMediaUnderstanding.mockRejectedValueOnce(
      new Error("Cannot find module '/tmp/openclaw/dist/media-understanding/apply.runtime-old.js'"),
    );

    const reply = await getReplyFromConfig(buildCtx(), undefined, withFastReplyConfig({}));

    expect(reply).toEqual({ text: "ok" });
    expect(mocks.applyMediaUnderstanding).toHaveBeenCalledTimes(1);
    expect(mocks.initSessionState).toHaveBeenCalledTimes(1);
    expect(mocks.resolveReplyDirectives).toHaveBeenCalledTimes(1);
    expect(mocks.createInternalHookEvent).toHaveBeenCalledTimes(1);
    const preprocessed = hookEventCall(0);
    expect(preprocessed[0]).toBe("message");
    expect(preprocessed[1]).toBe("preprocessed");
    expect(preprocessed[2]).toBe("agent:main:telegram:-100123");
    expect(preprocessed[3]).toBeTypeOf("object");
    expect(verboseMessages()).toContainEqual(
      expect.stringContaining("media understanding failed, proceeding with raw content"),
    );
  });

  it.each([false, true])("stops canceled replies when link work resolves: %s", async (resolves) => {
    const controller = new AbortController();
    const reason = resolves ? new Error("reply canceled") : undefined;
    mocks.applyLinkUnderstanding.mockImplementationOnce(async (...args: unknown[]) => {
      const { signal } = args[0] as { signal?: AbortSignal };
      controller.abort(reason);
      if (!resolves) {
        signal?.throwIfAborted();
      }
    });

    await expect
      .soft(
        getReplyFromConfig(
          buildTextCtx("read https://example.test/page"),
          { abortSignal: controller.signal },
          withFastReplyConfig({}),
        ),
      )
      .rejects.toMatchObject({ name: "AbortError", ...(reason ? { cause: reason } : {}) });

    expect(mocks.applyLinkUnderstanding).toHaveBeenCalledOnce();
    expect.soft(mocks.initSessionState).not.toHaveBeenCalled();
    expect.soft(mocks.resolveReplyDirectives).not.toHaveBeenCalled();
    expect.soft(mocks.createInternalHookEvent).not.toHaveBeenCalled();
    expect.soft(mocks.triggerInternalHook).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps URL input after link failure (literal: %s)", async (suppressed) => {
    const ctx = buildTextCtx("read https://example.test/page", {
      CommandInterpretationSuppressed: suppressed,
    });
    mocks.applyLinkUnderstanding.mockRejectedValueOnce(
      new Error("Cannot find module '/tmp/openclaw/dist/link-understanding/apply.runtime-old.js'"),
    );

    const reply = await getReplyFromConfig(ctx, undefined, withFastReplyConfig({}));

    expect(reply).toEqual({ text: "ok" });
    expect(mocks.applyMediaUnderstanding).not.toHaveBeenCalled();
    expect(mocks.applyLinkUnderstanding).toHaveBeenCalledTimes(1);
    expect(mocks.initSessionState).toHaveBeenCalledTimes(1);
    expect(mocks.resolveReplyDirectives).toHaveBeenCalledTimes(1);
    expect(verboseMessages()).toContainEqual(
      expect.stringContaining("link understanding failed, proceeding with raw content"),
    );
  });
});
