import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import {
  buildDeveloperInstructions,
  buildTurnStartParams,
  buildThreadResumeParams,
  buildThreadStartParams,
  codexDynamicToolsFingerprint,
  resolveReasoningEffort,
} from "./thread-lifecycle.js";

function createAttemptParams(params: {
  provider: string;
  authProfileId?: string;
  authProfileProvider?: string;
  authProfileProviders?: Record<string, string>;
  bootstrapContextMode?: "full" | "lightweight";
  bootstrapContextRunKind?: "default" | "heartbeat" | "cron";
  images?: EmbeddedRunAttemptParams["images"];
}): EmbeddedRunAttemptParams {
  const authProfileProviders =
    params.authProfileProviders ??
    (params.authProfileId
      ? { [params.authProfileId]: params.authProfileProvider ?? "openai-codex" }
      : {});
  return {
    provider: params.provider,
    modelId: "gpt-5.4",
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
          {
            type: "oauth" as const,
            provider,
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          },
        ]),
      ),
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

  it("keeps durable dynamic tool fingerprints independent from presentation mode", () => {
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

    expect(searchableFingerprint).toBe(directFingerprint);
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
    });
    expect(request.personality).toBe("none");
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

describe("Codex app-server model provider selection", () => {
  it.each(["openai", "openai-codex"])(
    "omits public %s modelProvider when forwarding native Codex auth on thread/start",
    (provider) => {
      const request = buildThreadStartParams(
        createAttemptParams({ provider, authProfileId: "work" }),
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
        authProfileProviders: { bound: "openai-codex" },
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
        authProfileId: "openai-codex:work",
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
