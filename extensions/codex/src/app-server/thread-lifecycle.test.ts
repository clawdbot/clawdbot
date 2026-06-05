// Codex tests cover thread lifecycle plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_GPT5_BEHAVIOR_CONTRACT } from "../../prompt-overlay.js";
import { createCodexTestModel } from "./test-support.js";
import {
  buildDeveloperInstructions,
  buildTurnCollaborationMode,
  buildTurnStartParams,
  buildThreadResumeParams,
  buildThreadStartParams,
  codexDynamicToolsFingerprint,
  formatCodexThreadLifecycleTimingSummary,
  resolveReasoningEffort,
  shouldWarnCodexThreadLifecycleTimingSummary,
  startOrResumeThread,
  type CodexThreadLifecycleTimingLogger,
} from "./thread-lifecycle.js";

let tempDir: string;

function createAttemptParams(params: {
  provider: string;
  authProfileId?: string;
  authProfileType?: "oauth" | "api_key";
  authProfileProvider?: string;
  authProfileProviders?: Record<string, string>;
  runtimeExternalProfileIds?: string[];
  bootstrapContextMode?: "full" | "lightweight";
  bootstrapContextRunKind?: "default" | "heartbeat" | "cron";
  images?: EmbeddedRunAttemptParams["images"];
  modelId?: string;
}): EmbeddedRunAttemptParams {
  const authProfileProviders =
    params.authProfileProviders ??
    (params.authProfileId
      ? { [params.authProfileId]: params.authProfileProvider ?? "openai" }
      : {});
  const authProfileType = params.authProfileType ?? "oauth";
  return {
    provider: params.provider,
    modelId: params.modelId ?? "gpt-5.4",
    prompt: "test prompt",
    authProfileId: params.authProfileId,
    ...(params.bootstrapContextMode ? { bootstrapContextMode: params.bootstrapContextMode } : {}),
    ...(params.bootstrapContextRunKind
      ? { bootstrapContextRunKind: params.bootstrapContextRunKind }
      : {}),
    ...(params.images ? { images: params.images } : {}),
    authProfileStore: {
      version: 1,
      profiles: Object.fromEntries(
        Object.entries(authProfileProviders).map(([profileId, provider]) => [
          profileId,
          authProfileType === "api_key"
            ? {
                type: "api_key" as const,
                provider,
                key: "sk-test",
              }
            : {
                type: "oauth" as const,
                provider,
                access: "access-token",
                refresh: "refresh-token",
                expires: Date.now() + 60_000,
              },
        ]),
      ),
      ...(params.runtimeExternalProfileIds
        ? { runtimeExternalProfileIds: params.runtimeExternalProfileIds }
        : {}),
    },
  } as EmbeddedRunAttemptParams;
}

function createAppServerOptions() {
  return {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
  } as const;
}

function createThreadLifecycleParams(
  sessionFile: string,
  workspaceDir: string,
): EmbeddedRunAttemptParams {
  return {
    prompt: "hello",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir,
    runId: "run-1",
    provider: "codex",
    modelId: "gpt-5.4-codex",
    model: createCodexTestModel("codex"),
    thinkLevel: "medium",
    disableTools: true,
    timeoutMs: 5_000,
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
  } as EmbeddedRunAttemptParams;
}

function createThreadLifecycleAppServerOptions(): Parameters<
  typeof startOrResumeThread
>[0]["appServer"] {
  return {
    start: {
      transport: "stdio",
      command: "codex",
      args: ["app-server"],
      headers: {},
    },
    codeModeOnly: false,
    requestTimeoutMs: 60_000,
    turnCompletionIdleTimeoutMs: 60_000,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
  };
}

function threadStartResult(threadId = "thread-1") {
  return {
    thread: {
      id: threadId,
      sessionId: "session-1",
      forkedFromId: null,
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      path: null,
      cwd: tempDir,
      cliVersion: "0.125.0",
      source: "unknown",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.4-codex",
    modelProvider: "openai",
    serviceTier: null,
    cwd: tempDir,
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    permissionProfile: null,
    reasoningEffort: null,
  };
}

function createTimingLogger(traceEnabled: boolean): CodexThreadLifecycleTimingLogger {
  return {
    isEnabled: vi.fn((level: "trace") => level === "trace" && traceEnabled),
    trace: vi.fn(),
    warn: vi.fn(),
  };
}

function expectSingleLogMessage(
  log: CodexThreadLifecycleTimingLogger,
  level: "trace" | "warn",
): string {
  const mock = log[level] as ReturnType<typeof vi.fn>;
  expect(mock).toHaveBeenCalledTimes(1);
  const message = mock.mock.calls[0]?.[0];
  expect(typeof message).toBe("string");
  return message as string;
}

describe("Codex app-server native code mode config", () => {
  it("keeps Codex-native subagents primary while limiting OpenClaw spawn to OpenClaw delegation", () => {
    const instructions = buildDeveloperInstructions(createAttemptParams({ provider: "openai" }));

    expect(instructions).toContain("Use Codex native `spawn_agent` for Codex subagents");
    expect(instructions).toContain(
      "Use OpenClaw `sessions_spawn` only for OpenClaw or ACP delegation.",
    );
  });

  it("summarizes deferred dynamic tool names in developer instructions", () => {
    const instructions = buildDeveloperInstructions(createAttemptParams({ provider: "openai" }), {
      dynamicTools: [
        {
          name: "message",
          description: "Send a message",
          inputSchema: { type: "object" },
        },
        {
          name: "music_generate",
          description: "Create music",
          inputSchema: { type: "object" },
          namespace: "openclaw",
          deferLoading: true,
        },
        {
          name: "image_generate",
          description: "Create images",
          inputSchema: { type: "object" },
          namespace: "openclaw",
          deferLoading: true,
        },
      ],
    });

    expect(instructions).toContain(
      "Deferred searchable OpenClaw dynamic tools available: image_generate, music_generate.",
    );
    expect(instructions).toContain("Use `tool_search` to load exact callable specs before use.");
    expect(instructions).not.toContain("message,");
  });

  it("uses the shared Skill Workshop guidance when skill_workshop is available", () => {
    const instructions = buildDeveloperInstructions(createAttemptParams({ provider: "openai" }), {
      dynamicTools: [
        {
          name: "skill_workshop",
          description: "Manage skill proposals",
          inputSchema: { type: "object" },
          namespace: "openclaw",
          deferLoading: true,
        },
      ],
    });

    expect(instructions).toContain("## Skill Workshop");
    expect(instructions).toContain(
      "Use `skill_workshop` when the user wants to create, update, revise, list, inspect, apply, reject, or quarantine a reusable skill, Skill Workshop proposal, playbook, workflow, procedure, or durable instruction.",
    );
    expect(instructions).toContain(
      "Use `action=apply`, `action=reject`, or `action=quarantine` only after the user explicitly asks to approve/use/apply, reject, or quarantine a specific proposal.",
    );
  });

  it("keeps developer instructions compact when no dynamic tools are deferred", () => {
    const instructions = buildDeveloperInstructions(createAttemptParams({ provider: "openai" }), {
      dynamicTools: [
        {
          name: "message",
          description: "Send a message",
          inputSchema: { type: "object" },
        },
      ],
    });

    expect(instructions).not.toContain("Deferred searchable OpenClaw dynamic tools available");
  });

  it("keeps durable dynamic tool fingerprints scoped to loading mode", () => {
    const inputSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
    };
    const directFingerprint = codexDynamicToolsFingerprint([
      {
        name: "message",
        description: "Send a visible message",
        inputSchema,
      },
    ]);
    const searchableFingerprint = codexDynamicToolsFingerprint([
      {
        name: "message",
        description: "Load and send a visible message",
        inputSchema,
        namespace: "openclaw",
        deferLoading: true,
      },
    ]);

    expect(searchableFingerprint).not.toBe(directFingerprint);
  });

  it("keeps OpenClaw skill catalogs out of developer instructions", () => {
    const params = createAttemptParams({ provider: "openai" });
    params.skillsSnapshot = {
      prompt: "<available_skills><skill><name>demo</name></skill></available_skills>",
      skills: [],
    };

    const instructions = buildDeveloperInstructions(params);

    expect(instructions).not.toContain("<available_skills>");
  });

  it("enables Codex code mode on thread/start without clobbering other config", () => {
    const request = buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
      cwd: "/repo",
      dynamicTools: [],
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
      config: {
        "features.hooks": true,
        apps: { _default: { enabled: false } },
      },
    });

    expect(request.config).toEqual({
      "features.hooks": true,
      apps: { _default: { enabled: false } },
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.apply_patch_streaming_events": true,
    });
    expect(request.personality).toBe("none");
  });

  it("disables Codex tool-search features for nano models", () => {
    const request = buildThreadStartParams(
      createAttemptParams({ provider: "openai", modelId: "gpt-5.4-nano" }),
      {
        cwd: "/repo",
        dynamicTools: [],
        appServer: createAppServerOptions() as never,
        developerInstructions: "test instructions",
      },
    );

    expect(request.config).toEqual({
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.apply_patch_streaming_events": true,
      "features.multi_agent": false,
    });
  });

  it("removes Codex model personality on thread/resume", () => {
    const request = buildThreadResumeParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
    });

    expect(request.personality).toBe("none");
  });

  it("keeps Codex model personality disabled on turn/start", () => {
    const request = buildTurnStartParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      cwd: "/repo",
      appServer: createAppServerOptions() as never,
    });

    expect(request.personality).toBe("none");
  });

  it("allows thread config to opt into Codex code-mode-only", () => {
    const request = buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
      cwd: "/repo",
      dynamicTools: [],
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
      config: {
        "features.code_mode_only": true,
      },
    });

    expect(request.config).toEqual({
      "features.code_mode": true,
      "features.code_mode_only": true,
      "features.apply_patch_streaming_events": true,
    });
  });

  it("forces Codex code-mode-only when app-server policy opts in", () => {
    const request = buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
      cwd: "/repo",
      dynamicTools: [],
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
      nativeCodeModeOnlyEnabled: true,
      config: {
        "features.code_mode_only": false,
      },
    });

    expect(request.config).toEqual({
      "features.code_mode": true,
      "features.code_mode_only": true,
      "features.apply_patch_streaming_events": true,
    });
  });

  it("enables Codex code mode on thread/resume", () => {
    const request = buildThreadResumeParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
    });

    expect(request.config).toEqual({
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.apply_patch_streaming_events": true,
    });
  });

  it("disables Codex native code mode on thread/start when runtime policy denies it", () => {
    const request = buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
      cwd: "/repo",
      dynamicTools: [],
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
      nativeCodeModeEnabled: false,
      nativeCodeModeOnlyEnabled: true,
      config: {
        "features.code_mode": true,
        "features.code_mode_only": true,
        "features.apply_patch_streaming_events": true,
      },
    });

    expect(request.config).toEqual({
      "features.code_mode": false,
      "features.code_mode_only": false,
    });
  });

  it("disables Codex native code mode on thread/resume when runtime policy denies it", () => {
    const request = buildThreadResumeParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
      nativeCodeModeEnabled: false,
      config: {
        "features.apply_patch_streaming_events": true,
      },
    });

    expect(request.config).toEqual({
      "features.code_mode": false,
      "features.code_mode_only": false,
    });
  });

  it("disables native Codex project docs for lightweight context threads", () => {
    const request = buildThreadStartParams(
      createAttemptParams({
        provider: "openai",
        bootstrapContextMode: "lightweight",
        bootstrapContextRunKind: "cron",
      }),
      {
        cwd: "/repo",
        dynamicTools: [],
        appServer: createAppServerOptions() as never,
        developerInstructions: "test instructions",
        config: {
          project_doc_max_bytes: 64_000,
          "features.hooks": true,
        },
      },
    );

    expect(request.config).toEqual({
      project_doc_max_bytes: 0,
      "features.hooks": true,
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.apply_patch_streaming_events": true,
    });
  });

  it("keeps native Codex project docs enabled when context is not lightweight", () => {
    const request = buildThreadResumeParams(
      createAttemptParams({ provider: "openai", bootstrapContextRunKind: "cron" }),
      {
        threadId: "thread-1",
        appServer: createAppServerOptions() as never,
        developerInstructions: "test instructions",
        config: {
          project_doc_max_bytes: 64_000,
        },
      },
    );

    expect(request.config).toEqual({
      project_doc_max_bytes: 64_000,
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.apply_patch_streaming_events": true,
    });
  });
});

describe("Codex app-server turn input image sanitizing", () => {
  it("uses an explicit turn sandbox policy override when provided", () => {
    const request = buildTurnStartParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      cwd: "/repo",
      appServer: createAppServerOptions() as never,
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/repo"],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });

    expect(request.sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/repo"],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
  });

  it("attaches turn-scoped developer instructions without changing thread config", () => {
    const request = buildTurnStartParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      cwd: "/repo",
      appServer: createAppServerOptions() as never,
      turnScopedDeveloperInstructions: "SOUL.md turn-only context",
    });

    expect(request.collaborationMode?.settings.developer_instructions).toContain(
      "# Collaboration Mode: Default",
    );
    expect(request.collaborationMode?.settings.developer_instructions).toContain(
      "SOUL.md turn-only context",
    );
  });

  it("places memory collaboration instructions before skills", () => {
    const request = buildTurnStartParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      cwd: "/repo",
      appServer: createAppServerOptions() as never,
      turnScopedDeveloperInstructions: "SOUL.md turn-only context",
      memoryCollaborationInstructions: "MEMORY.md pointer",
      skillsCollaborationInstructions: "<available_skills>",
    });
    const developerInstructions = request.collaborationMode?.settings.developer_instructions ?? "";

    expect(developerInstructions.indexOf("SOUL.md turn-only context")).toBeLessThan(
      developerInstructions.indexOf("MEMORY.md pointer"),
    );
    expect(developerInstructions.indexOf("MEMORY.md pointer")).toBeLessThan(
      developerInstructions.indexOf("<available_skills>"),
    );
  });

  it("replaces malformed inline images before turn/start", () => {
    const request = buildTurnStartParams(
      createAttemptParams({
        provider: "openai",
        images: [{ type: "image", mimeType: "image/jpeg", data: "not base64!" }] as never,
      }),
      {
        threadId: "thread-1",
        cwd: "/repo",
        appServer: createAppServerOptions() as never,
      },
    );

    expect(request.input).toEqual([
      { type: "text", text: "test prompt", text_elements: [] },
      {
        type: "text",
        text: "[codex user input] omitted image payload: invalid inline image data",
        text_elements: [],
      },
    ]);
  });
});

describe("Codex app-server turn params", () => {
  it("builds resume and turn params from the currently selected OpenClaw model", () => {
    const params = createAttemptParams({ provider: "codex" });
    params.modelId = "gpt-5.4-codex";
    params.thinkLevel = "medium";
    const appServer = {
      start: {
        transport: "stdio" as const,
        command: "codex",
        args: ["app-server", "--listen", "stdio://"],
        headers: {},
      },
      codeModeOnly: false,
      requestTimeoutMs: 60_000,
      turnCompletionIdleTimeoutMs: 60_000,
      approvalPolicy: "on-request" as const,
      approvalsReviewer: "guardian_subagent" as const,
      sandbox: "danger-full-access" as const,
      serviceTier: "flex" as const,
    };

    const resumeParams = buildThreadResumeParams(params, { threadId: "thread-1", appServer });
    expect(resumeParams).toEqual({
      threadId: "thread-1",
      model: "gpt-5.4-codex",
      approvalPolicy: "on-request",
      approvalsReviewer: "guardian_subagent",
      config: {
        "features.code_mode": true,
        "features.code_mode_only": false,
        "features.apply_patch_streaming_events": true,
      },
      sandbox: "danger-full-access",
      serviceTier: "flex",
      personality: "none",
      developerInstructions: resumeParams.developerInstructions,
      persistExtendedHistory: true,
    });
    expect(resumeParams.developerInstructions).not.toContain(CODEX_GPT5_BEHAVIOR_CONTRACT);
    const turnParams = buildTurnStartParams(params, {
      threadId: "thread-1",
      cwd: "/tmp/workspace",
      appServer,
    });
    expect(turnParams.threadId).toBe("thread-1");
    expect(turnParams.cwd).toBe("/tmp/workspace");
    expect(turnParams.model).toBe("gpt-5.4-codex");
    expect(turnParams.approvalPolicy).toBe("on-request");
    expect(turnParams.approvalsReviewer).toBe("guardian_subagent");
    expect(turnParams.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    expect(turnParams.serviceTier).toBe("flex");
    expect(turnParams.collaborationMode).toEqual({
      mode: "default",
      settings: {
        model: "gpt-5.4-codex",
        reasoning_effort: "medium",
        developer_instructions: null,
      },
    });
  });

  it("uses turn-scoped collaboration instructions for heartbeat Codex turns", () => {
    const params = createAttemptParams({ provider: "codex" });
    params.modelId = "gpt-5.4-codex";
    params.thinkLevel = "medium";
    params.trigger = "heartbeat";

    const heartbeatCollaborationMode = buildTurnCollaborationMode(params, {
      heartbeatCollaborationInstructions:
        "HEARTBEAT.md exists at /tmp/workspace/HEARTBEAT.md. Read it before proceeding.",
    });
    expect(heartbeatCollaborationMode.mode).toBe("default");
    expect(heartbeatCollaborationMode.settings.model).toBe("gpt-5.4-codex");
    expect(heartbeatCollaborationMode.settings.reasoning_effort).toBe("medium");
    expect(heartbeatCollaborationMode.settings.developer_instructions).toContain(
      "This is an OpenClaw heartbeat turn. Apply these instructions only to this heartbeat wake",
    );
    expect(heartbeatCollaborationMode.settings.developer_instructions).toContain(
      "Use heartbeats to create useful proactive progress",
    );
    expect(heartbeatCollaborationMode.settings.developer_instructions).toContain(
      "If `heartbeat_respond` is not already available and `tool_search` is available",
    );
    expect(heartbeatCollaborationMode.settings.developer_instructions).toContain(
      "HEARTBEAT.md exists at /tmp/workspace/HEARTBEAT.md.",
    );

    params.trigger = "user";
    expect(
      buildTurnCollaborationMode(params, {
        turnScopedDeveloperInstructions: "Turn-only workspace instructions.",
        heartbeatCollaborationInstructions:
          "HEARTBEAT.md exists at /tmp/workspace/HEARTBEAT.md. Read it before proceeding.",
      }).settings.developer_instructions,
    ).toContain("Turn-only workspace instructions.");
    expect(
      buildTurnCollaborationMode(params, {
        turnScopedDeveloperInstructions: "Turn-only workspace instructions.",
      }).settings.developer_instructions,
    ).toContain("# Collaboration Mode: Default");
  });

  it("uses turn-scoped collaboration instructions for cron Codex turns", () => {
    const params = createAttemptParams({ provider: "codex" });
    params.modelId = "gpt-5.4-codex";
    params.thinkLevel = "medium";
    params.trigger = "cron";

    const cronCollaborationMode = buildTurnCollaborationMode(params, {
      turnScopedDeveloperInstructions: "Turn-only workspace instructions.",
    });
    expect(cronCollaborationMode.mode).toBe("default");
    expect(cronCollaborationMode.settings.model).toBe("gpt-5.4-codex");
    expect(cronCollaborationMode.settings.reasoning_effort).toBe("medium");
    expect(cronCollaborationMode.settings.developer_instructions).toContain(
      "This is an OpenClaw cron automation turn",
    );
    expect(cronCollaborationMode.settings.developer_instructions).toContain(
      "If it asks you to run an exact command, run that command before doing any investigation",
    );
    expect(cronCollaborationMode.settings.developer_instructions).toContain(
      "Use context already provided by the runtime",
    );
    expect(cronCollaborationMode.settings.developer_instructions).toContain(
      "Turn-only workspace instructions.",
    );
  });
});

describe("Codex app-server model provider selection", () => {
  it.each(["openai", "openai"])(
    "omits public %s modelProvider when forwarding native Codex auth on thread/start",
    (provider) => {
      const request = buildThreadStartParams(
        createAttemptParams({
          provider,
          authProfileId: "work",
          runtimeExternalProfileIds: ["work"],
        }),
        {
          cwd: "/repo",
          dynamicTools: [],
          appServer: createAppServerOptions() as never,
          developerInstructions: "test instructions",
        },
      );

      expect(request).not.toHaveProperty("modelProvider");
    },
  );

  it("uses the bound native Codex auth profile when deciding thread/resume modelProvider", () => {
    const request = buildThreadResumeParams(
      createAttemptParams({
        provider: "openai",
        authProfileProviders: { bound: "openai" },
        runtimeExternalProfileIds: ["bound"],
      }),
      {
        threadId: "thread-1",
        authProfileId: "bound",
        appServer: createAppServerOptions() as never,
        developerInstructions: "test instructions",
      },
    );

    expect(request).not.toHaveProperty("modelProvider");
  });

  it("does not infer native Codex auth from the profile id prefix", () => {
    const request = buildThreadStartParams(
      createAttemptParams({
        provider: "openai",
        authProfileId: "openai:work",
        authProfileType: "api_key",
        authProfileProvider: "openai",
      }),
      {
        cwd: "/repo",
        dynamicTools: [],
        appServer: createAppServerOptions() as never,
        developerInstructions: "test instructions",
      },
    );

    expect(request.modelProvider).toBe("openai");
  });

  it("omits public OpenAI modelProvider for persisted Codex OAuth profiles", () => {
    const request = buildThreadStartParams(
      createAttemptParams({
        provider: "openai",
        authProfileId: "openai:work",
        authProfileProvider: "openai",
      }),
      {
        cwd: "/repo",
        dynamicTools: [],
        appServer: createAppServerOptions() as never,
        developerInstructions: "test instructions",
      },
    );

    expect(request).not.toHaveProperty("modelProvider");
  });

  it("keeps public OpenAI modelProvider when no native Codex auth profile is selected", () => {
    const request = buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
      cwd: "/repo",
      dynamicTools: [],
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
    });

    expect(request.modelProvider).toBe("openai");
  });
});

describe("Codex app-server thread lifecycle timing", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-thread-lifecycle-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("formats stage summaries with run, session, action, and elapsed timing", () => {
    const message = formatCodexThreadLifecycleTimingSummary({
      runId: "run-a",
      sessionId: "session-a",
      sessionKey: "agent:main:session-a",
      action: "started",
      summary: {
        totalMs: 12,
        spans: [
          { name: "read-binding", durationMs: 4, elapsedMs: 4 },
          { name: "thread-start-request", durationMs: 8, elapsedMs: 12 },
        ],
      },
    });

    expect(message).toBe(
      "[trace:codex-app-server] thread lifecycle: runId=run-a sessionId=session-a " +
        "sessionKey=agent:main:session-a action=started totalMs=12 " +
        "stages=read-binding:4ms@4ms,thread-start-request:8ms@12ms",
    );
  });

  it("warns when the total or a single stage crosses the lifecycle threshold", () => {
    expect(
      shouldWarnCodexThreadLifecycleTimingSummary(
        {
          totalMs: 9,
          spans: [{ name: "thread-start-request", durationMs: 10, elapsedMs: 10 }],
        },
        { totalThresholdMs: 50, stageThresholdMs: 10 },
      ),
    ).toBe(true);
    expect(
      shouldWarnCodexThreadLifecycleTimingSummary(
        {
          totalMs: 50,
          spans: [{ name: "thread-start-request", durationMs: 1, elapsedMs: 1 }],
        },
        { totalThresholdMs: 50, stageThresholdMs: 10 },
      ),
    ).toBe(true);
  });

  it("emits a trace stage summary when starting a new thread with trace enabled", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    let nowMs = 0;
    const log = createTimingLogger(true);
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        nowMs += 17;
        return threadStartResult("thread-started");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createThreadLifecycleParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      timing: {
        enabled: true,
        now: () => nowMs,
        log,
        totalThresholdMs: 1_000,
        stageThresholdMs: 1_000,
      },
    });

    const message = expectSingleLogMessage(log, "trace");
    expect(log.warn).not.toHaveBeenCalled();
    expect(message).toContain("action=started");
    expect(message).toContain("thread-start-request:17ms@17ms");
    expect(message).toContain("thread-ready:0ms@17ms");
  });

  it("emits a trace stage summary when resuming an existing thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    let nowMs = 0;
    const log = createTimingLogger(true);
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-existing");
      }
      if (method === "thread/resume") {
        nowMs += 9;
        return threadStartResult("thread-existing");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const commonParams = {
      client: { request } as never,
      params: createThreadLifecycleParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
    };

    await startOrResumeThread({
      ...commonParams,
      timing: {
        enabled: true,
        now: () => nowMs,
        log: createTimingLogger(false),
      },
    });
    await startOrResumeThread({
      ...commonParams,
      timing: {
        enabled: true,
        now: () => nowMs,
        log,
        totalThresholdMs: 1_000,
        stageThresholdMs: 1_000,
      },
    });

    const message = expectSingleLogMessage(log, "trace");
    expect(message).toContain("action=resumed");
    expect(message).toContain("thread-resume-request:9ms@9ms");
  });

  it("warns on slow start even when trace logging is disabled", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    let nowMs = 0;
    const log = createTimingLogger(false);
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        nowMs += 25;
        return threadStartResult("thread-slow");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createThreadLifecycleParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      timing: {
        enabled: true,
        now: () => nowMs,
        log,
        totalThresholdMs: 10,
        stageThresholdMs: 10,
      },
    });

    const message = expectSingleLogMessage(log, "warn");
    expect(log.trace).not.toHaveBeenCalled();
    expect(message).toContain("action=started");
    expect(message).toContain("thread-start-request:25ms@25ms");
  });
});

describe("resolveReasoningEffort (#71946)", () => {
  describe("modern Codex models (none/low/medium/high/xhigh enum)", () => {
    it.each(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"] as const)(
      "translates 'minimal' -> 'low' for %s so the first request is accepted",
      (modelId) => {
        expect(resolveReasoningEffort("minimal", modelId)).toBe("low");
      },
    );

    it.each(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"] as const)(
      "passes 'low' / 'medium' / 'high' / 'xhigh' through unchanged for %s",
      (modelId) => {
        expect(resolveReasoningEffort("low", modelId)).toBe("low");
        expect(resolveReasoningEffort("medium", modelId)).toBe("medium");
        expect(resolveReasoningEffort("high", modelId)).toBe("high");
        expect(resolveReasoningEffort("xhigh", modelId)).toBe("xhigh");
      },
    );

    it("normalizes case-variant model ids", () => {
      expect(resolveReasoningEffort("minimal", "GPT-5.5")).toBe("low");
      expect(resolveReasoningEffort("minimal", " gpt-5.4-mini ")).toBe("low");
    });
  });

  describe("legacy / non-modern Codex models", () => {
    it.each(["gpt-5", "gpt-4o", "o3-mini", "codex-mini-latest"] as const)(
      "preserves 'minimal' for %s — pre-modern enum still supports it",
      (modelId) => {
        expect(resolveReasoningEffort("minimal", modelId)).toBe("minimal");
      },
    );

    it("preserves 'minimal' for empty / unknown model ids (conservative default)", () => {
      expect(resolveReasoningEffort("minimal", "")).toBe("minimal");
      expect(resolveReasoningEffort("minimal", "unknown-model-xyz")).toBe("minimal");
    });
  });

  describe("non-effort thinkLevel values", () => {
    it("returns null for 'off'", () => {
      expect(resolveReasoningEffort("off", "gpt-5.5")).toBeNull();
      expect(resolveReasoningEffort("off", "gpt-4o")).toBeNull();
    });

    it("returns null for 'adaptive' (non-effort enum value)", () => {
      expect(resolveReasoningEffort("adaptive", "gpt-5.5")).toBeNull();
      expect(resolveReasoningEffort("adaptive", "gpt-4o")).toBeNull();
    });

    it("returns null for 'max' (non-effort enum value)", () => {
      expect(resolveReasoningEffort("max", "gpt-5.5")).toBeNull();
      expect(resolveReasoningEffort("max", "gpt-4o")).toBeNull();
    });
  });
});
