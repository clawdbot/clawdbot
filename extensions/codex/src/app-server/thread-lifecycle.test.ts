// Codex tests cover thread lifecycle plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  GPT5_BEHAVIOR_CONTRACT as CODEX_GPT5_BEHAVIOR_CONTRACT,
  type ModelCompatConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexCatalogHomeId } from "../session-catalog-home-id.js";
import { resolveCodexAppServerHomeDir } from "./auth-start-options.js";
import {
  ensureCodexAppServerClientRuntime,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { CodexAppServerRpcError } from "./client.js";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import type { CodexPluginThreadConfig } from "./plugin-thread-config.js";
import {
  CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
  type CodexDynamicToolFunctionSpec,
  type JsonObject,
  isJsonObject,
} from "./protocol.js";
import { resolveCodexAppServerReasoningEffort } from "./reasoning-effort.js";
import {
  createCodexAppServerBindingStore,
  sessionBindingIdentity,
  type CodexAppServerBindingStore,
  type CodexAppServerPendingSupervisionBranch,
} from "./session-binding.js";
import {
  createCodexTestBindingStateStore,
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import {
  createClientHarness,
  createCodexTestModel,
  withLeasedCodexTestClient,
} from "./test-support.js";
import {
  buildDeveloperInstructions,
  buildTurnCollaborationMode,
  buildTurnStartParams,
  buildThreadResumeParams,
  buildThreadStartParams,
  areCodexDynamicToolFingerprintsCompatible,
  codexDynamicToolsFingerprint,
  codexLegacyDynamicToolsFingerprint,
  resolveCodexAppServerThreadModelSelection,
  startOrResumeThread as startOrResumeThreadImpl,
} from "./thread-lifecycle.js";
import { createLeasedCodexLifecycleHarness } from "./thread-lifecycle.test-fixtures.js";
import { attestCodexRestrictedToolSurfaceMcpServersDisabled } from "./thread-requests.js";

type CodexThreadLifecycleTimingLogger = NonNullable<
  NonNullable<Parameters<typeof startOrResumeThreadImpl>[0]["timing"]>["log"]
>;

const PROGRESS_CARD_SYSTEM_PROMPT =
  "During multi-step work, keep your progress card current with the progress_card tool; the user follows it instead of reading the transcript.";

describe("Codex incognito thread persistence", () => {
  it("marks only incognito-shaped harness sessions ephemeral", () => {
    const appServer = createAppServerOptions() as never;
    const persistent = createAttemptParams({ provider: "openai" });
    persistent.sessionKey = "agent:main:dashboard:persistent-thread";
    const incognito = createAttemptParams({ provider: "openai" });
    incognito.sessionKey = "agent:main:internal-session-effects:incognito-private-thread";

    const build = (params: EmbeddedRunAttemptParams) =>
      buildThreadStartParams(params, {
        appServer,
        cwd: "/repo",
        dynamicTools: [],
      });

    expect(build(persistent)).not.toHaveProperty("ephemeral");
    expect(build(incognito)).toMatchObject({ ephemeral: true });
  });
});

describe("Codex context window config", () => {
  it("forwards only a prepared cap on thread start and resume (#124702)", () => {
    const appServer = createAppServerOptions() as never;
    const capped = createAttemptParams({ provider: "openai" });
    capped.authoredContextTokenCap = 32_000;
    const uncapped = createAttemptParams({ provider: "openai" });
    const build = (params: EmbeddedRunAttemptParams) => [
      buildThreadStartParams(params, {
        appServer,
        cwd: "/repo",
        dynamicTools: [],
      }),
      buildThreadResumeParams(params, {
        appServer,
        threadId: "thread-1",
      }),
    ];

    for (const request of build(capped)) {
      expect(request.config?.model_context_window).toBe(32_000);
    }
    for (const request of build(uncapped)) {
      expect(request.config).not.toHaveProperty("model_context_window");
    }
  });
});

describe("Codex managed shell environment", () => {
  it.each([
    { action: "start" as const, inherit: "none" },
    { action: "resume" as const, inherit: "core" },
  ])(
    "applies the host environment last for thread/$action with inherit=$inherit",
    ({ action, inherit }) => {
      const options = {
        appServer: createAppServerOptions() as never,
        config: {
          allow_login_shell: true,
          shell_environment_policy: {
            inherit,
            experimental_use_profile: true,
            exclude: ["GIT_*"],
            set: { GH_CONFIG_DIR: "/user-selected", KEEP_ME: "yes" },
            include_only: ["PATH"],
          },
        },
        shellEnvironment: {
          GH_CONFIG_DIR: "/host-selected",
          GH_TOKEN: "",
          GITHUB_TOKEN: "",
          PREVIEW_SERVICE_TOKEN: "",
          OPENCLAW_STATE_DIR: "/fixture/diagnosed",
          OPENCLAW_CONFIG_PATH: "/fixture/custom.json",
          OPENCLAW_WORKSPACE_DIR: "/fixture/default-workspace",
        },
        disableLoginShell: true,
      };
      const request =
        action === "start"
          ? buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
              ...options,
              cwd: "/repo",
              dynamicTools: [],
            })
          : buildThreadResumeParams(createAttemptParams({ provider: "openai" }), {
              ...options,
              threadId: "thread-1",
            });

      const shellEnvironmentPolicy = request.config?.shell_environment_policy;
      if (!isJsonObject(shellEnvironmentPolicy)) {
        throw new Error("expected shell environment policy");
      }
      expect(shellEnvironmentPolicy).toMatchObject({
        inherit,
        experimental_use_profile: false,
        exclude: ["GIT_*"],
        set: {
          GH_CONFIG_DIR: "/host-selected",
          KEEP_ME: "yes",
          GH_TOKEN: "",
          GITHUB_TOKEN: "",
          PREVIEW_SERVICE_TOKEN: "",
          OPENCLAW_STATE_DIR: "/fixture/diagnosed",
          OPENCLAW_CONFIG_PATH: "/fixture/custom.json",
          OPENCLAW_WORKSPACE_DIR: "/fixture/default-workspace",
        },
      });
      expect(request.config?.allow_login_shell).toBe(false);
      const includeOnly = shellEnvironmentPolicy.include_only;
      expect(includeOnly).toHaveLength(8);
      expect(includeOnly).toEqual(
        expect.arrayContaining([
          "PATH",
          "GH_CONFIG_DIR",
          "GITHUB_TOKEN",
          "GH_TOKEN",
          "PREVIEW_SERVICE_TOKEN",
          "OPENCLAW_STATE_DIR",
          "OPENCLAW_CONFIG_PATH",
          "OPENCLAW_WORKSPACE_DIR",
        ]),
      );
      expect(shellEnvironmentPolicy.experimental_use_profile).toBe(false);
      expect(shellEnvironmentPolicy).not.toHaveProperty("use_profile");
    },
  );

  it.each(["start", "resume"] as const)(
    "disables login profiles only for protected thread/%s environments",
    (action) => {
      const build = (
        config: JsonObject,
        shellEnvironment?: Readonly<Record<string, string>>,
        disableLoginShell?: boolean,
      ) => {
        const options = {
          appServer: createAppServerOptions() as never,
          config,
          shellEnvironment,
          disableLoginShell,
        };
        return action === "start"
          ? buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
              ...options,
              cwd: "/repo",
              dynamicTools: [],
            })
          : buildThreadResumeParams(createAttemptParams({ provider: "openai" }), {
              ...options,
              threadId: "thread-1",
            });
      };

      expect(build({ allow_login_shell: true }).config?.allow_login_shell).toBe(true);
      expect(build({}).config).not.toHaveProperty("allow_login_shell");
      expect(build({}, { GH_TOKEN: "", GITHUB_TOKEN: "" }).config).not.toHaveProperty(
        "allow_login_shell",
      );
      expect(build({}, { GH_TOKEN: "", GITHUB_TOKEN: "" }, true).config?.allow_login_shell).toBe(
        false,
      );
    },
  );

  it.each(["start", "resume"] as const)(
    "admits host values through restrictive filters for thread/%s",
    (action) => {
      const options = {
        appServer: createAppServerOptions() as never,
        config: {
          allow_login_shell: false,
          shell_environment_policy: {
            experimental_use_profile: true,
            filters: { PATH: "include", "GIT_*": "exclude" },
            set: { KEEP_ME: "yes" },
          },
        },
        shellEnvironment: {
          GH_CONFIG_DIR: "/host-selected",
          GH_TOKEN: "",
          PREVIEW_SERVICE_TOKEN: "",
        },
        disableLoginShell: true,
      };
      const request =
        action === "start"
          ? buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
              ...options,
              cwd: "/repo",
              dynamicTools: [],
            })
          : buildThreadResumeParams(createAttemptParams({ provider: "openai" }), {
              ...options,
              threadId: "thread-1",
            });

      expect(request.config?.shell_environment_policy).toMatchObject({
        experimental_use_profile: false,
        set: {
          KEEP_ME: "yes",
          GH_CONFIG_DIR: "/host-selected",
          GH_TOKEN: "",
          PREVIEW_SERVICE_TOKEN: "",
        },
        filters: {
          PATH: "include",
          "GIT_*": "exclude",
          GH_CONFIG_DIR: "include",
          GH_TOKEN: "include",
          PREVIEW_SERVICE_TOKEN: "include",
        },
      });
      expect(request.config?.shell_environment_policy).not.toHaveProperty("include_only");
    },
  );
});

describe("Codex ring-zero thread config", () => {
  it("accepts upstream-shaped inactive rows for the disabled MCP names", async () => {
    const request = vi.fn(async () => ({
      data: [disabledMcpServerStatus("inherited")],
      nextCursor: null,
    }));

    await expect(
      attestCodexRestrictedToolSurfaceMcpServersDisabled(
        { request } as never,
        "thread-restricted",
        { mcp_servers: { inherited: { enabled: false } } },
      ),
    ).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledWith(
      "mcpServerStatus/list",
      { threadId: "thread-restricted", detail: "toolsAndAuthOnly" },
      { signal: undefined },
    );
  });

  it("accepts the attested app server alongside disabled inherited servers", async () => {
    const request = vi.fn(async () => ({
      data: [
        disabledMcpServerStatus("inherited"),
        {
          name: "codex_apps",
          serverInfo: { name: "codex_apps", version: "1.0.0" },
          tools: { "calendar.list": {} },
        },
      ],
      nextCursor: null,
    }));

    await expect(
      attestCodexRestrictedToolSurfaceMcpServersDisabled(
        { request } as never,
        "thread-restricted",
        { mcp_servers: { inherited: { enabled: false } } },
        undefined,
        ["codex_apps"],
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    { name: "missing", rows: [], failure: "is missing admitted server codex_apps" },
    {
      name: "inactive",
      rows: [{ name: "codex_apps", serverInfo: null, tools: { lookup: {} } }],
      failure: "found inactive admitted server codex_apps",
    },
    {
      name: "empty tools",
      rows: [{ name: "codex_apps", serverInfo: { name: "codex_apps" }, tools: {} }],
      failure: "found inactive admitted server codex_apps",
    },
  ])("rejects an admitted app server with $name status", async ({ rows, failure }) => {
    const request = vi.fn(async () => ({ data: rows, nextCursor: null }));

    await expect(
      attestCodexRestrictedToolSurfaceMcpServersDisabled(
        { request } as never,
        "thread-restricted",
        {},
        undefined,
        ["codex_apps"],
      ),
    ).rejects.toThrow(failure);
  });

  it("rejects an admitted app server that the thread disabled", async () => {
    const request = vi.fn();

    await expect(
      attestCodexRestrictedToolSurfaceMcpServersDisabled(
        { request } as never,
        "thread-restricted",
        { mcp_servers: { codex_apps: { enabled: false } } },
        undefined,
        ["codex_apps"],
      ),
    ).rejects.toThrow("MCP server codex_apps has conflicting policy");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "an unexpected server",
      status: { name: "unexpected", serverInfo: null, tools: {} },
      failure: "found unexpected server unexpected",
    },
    {
      name: "an active disabled server",
      status: {
        name: "inherited",
        serverInfo: { name: "inherited", version: "1.0.0" },
        tools: {},
      },
      failure: "found active server inherited",
    },
    {
      name: "a disabled server without explicit inactive status",
      status: { name: "inherited", tools: {} },
      failure: "returned malformed server inherited",
    },
    {
      name: "tools from a disabled server",
      status: { name: "inherited", serverInfo: null, tools: { lookup: {} } },
      failure: "found tools for server inherited",
    },
  ])("rejects $name", async ({ status, failure }) => {
    const request = vi.fn(async () => ({ data: [status], nextCursor: null }));

    await expect(
      attestCodexRestrictedToolSurfaceMcpServersDisabled(
        { request } as never,
        "thread-restricted",
        { mcp_servers: { inherited: { enabled: false } } },
      ),
    ).rejects.toThrow(failure);
  });

  it.each([
    {
      name: "an empty status inventory",
      statuses: [],
      failure: "is missing server inherited",
    },
    {
      name: "one missing server",
      statuses: [disabledMcpServerStatus("inherited")],
      failure: "is missing server request",
    },
    {
      name: "a duplicate server",
      statuses: [disabledMcpServerStatus("inherited"), disabledMcpServerStatus("inherited")],
      failure: "returned duplicate server inherited",
    },
  ])("rejects $name", async ({ statuses, failure }) => {
    const request = vi.fn(async () => ({ data: statuses, nextCursor: null }));

    await expect(
      attestCodexRestrictedToolSurfaceMcpServersDisabled(
        { request } as never,
        "thread-restricted",
        {
          mcp_servers: {
            inherited: { enabled: false },
            request: { enabled: false },
          },
        },
      ),
    ).rejects.toThrow(failure);
  });

  it("applies the restriction to both thread start and resume", () => {
    const params = createAttemptParams({ provider: "openai" });
    params.toolsAllow = ["openclaw"];
    params.pluginHarnessToolPolicyRestricted = true;
    const appServer = createAppServerOptions() as never;
    const developerInstructions = "Host-authored ring-zero instructions.";
    const start = buildThreadStartParams(params, {
      appServer,
      cwd: "/repo",
      dynamicTools: [],
      developerInstructions,
      hostSystemAgentActive: true,
      nativeCodeModeEnabled: false,
      config: { project_doc_max_bytes: 64_000 },
    });
    const resume = buildThreadResumeParams(params, {
      appServer,
      dynamicTools: [],
      developerInstructions,
      hostSystemAgentActive: true,
      nativeCodeModeEnabled: false,
      threadId: "thread-1",
      config: { project_doc_max_bytes: 64_000 },
    });

    expect(start.environments).toEqual([]);
    expect(start.baseInstructions).toBe("");
    expect(start.developerInstructions).toBe(developerInstructions);
    expect(resume.developerInstructions).toBe(developerInstructions);
    for (const config of [start.config, resume.config]) {
      expect(config?.["agents.enabled"]).toBe(false);
      expect(config?.["tools.experimental_request_user_input.enabled"]).toBe(false);
      expect(config?.["features.multi_agent"]).toBe(false);
      expect(config?.["features.multi_agent_v2"]).toBe(false);
      expect(config?.["features.goals"]).toBe(false);
      expect(config?.["orchestrator.mcp.enabled"]).toBe(false);
      expect(config?.["orchestrator.skills.enabled"]).toBe(false);
      expect(config?.project_doc_max_bytes).toBe(0);
      expect(config?.hooks).toMatchObject({
        PreToolUse: [],
        SessionStart: [],
        UserPromptSubmit: [],
        Stop: [],
      });
    }

    const normal = buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
      appServer,
      cwd: "/repo",
      dynamicTools: [],
      hostSystemAgentActive: false,
      config: { "features.goals": true },
    });
    expect(normal.baseInstructions).toBeUndefined();
    expect(normal.config?.["features.goals"]).toBe(false);
  });

  it("preserves project documents for ordinary policy-restricted turns", () => {
    const params = createAttemptParams({ provider: "openai" });
    params.pluginHarnessToolPolicyRestricted = true;
    const appServer = createAppServerOptions() as never;
    const start = buildThreadStartParams(params, {
      appServer,
      cwd: "/repo",
      dynamicTools: [],
      hostSystemAgentActive: false,
      nativeCodeModeEnabled: false,
    });
    const resume = buildThreadResumeParams(params, {
      appServer,
      dynamicTools: [],
      hostSystemAgentActive: false,
      nativeCodeModeEnabled: false,
      threadId: "thread-1",
      config: { project_doc_max_bytes: 64_000 },
    });

    expect(start.config?.project_doc_max_bytes).toBe(131_072);
    expect(resume.config?.project_doc_max_bytes).toBe(64_000);
    for (const threadConfig of [start.config, resume.config]) {
      expect(threadConfig?.["features.multi_agent"]).toBe(false);
      expect(threadConfig?.["orchestrator.mcp.enabled"]).toBe(false);
    }

    const toolsDisabled = createAttemptParams({ provider: "openai" });
    toolsDisabled.disableTools = true;
    toolsDisabled.pluginHarnessToolPolicyRestricted = true;
    const disabled = buildThreadStartParams(toolsDisabled, {
      appServer,
      cwd: "/repo",
      dynamicTools: [],
      hostSystemAgentActive: false,
      nativeCodeModeEnabled: false,
      config: { project_doc_max_bytes: 64_000 },
    });
    expect(disabled.config?.project_doc_max_bytes).toBe(0);
  });

  it("keeps scheduled-authority apps enabled inside the restricted tool surface", () => {
    const params = createAttemptParams({ provider: "openai" });
    params.pluginHarnessToolPolicyRestricted = true;
    params.scheduledRuntimeAuthority = {
      version: 1,
      runtimeId: "codex",
      namespace: "codex.apps",
      payload: { version: 1, auth: {}, apps: [] },
    };
    const apps = {
      _default: { enabled: false },
      calendar: { enabled: true },
    };

    const appServer = createAppServerOptions() as never;
    const options = {
      appServer,
      cwd: "/repo",
      dynamicTools: [],
      hostSystemAgentActive: false,
      nativeCodeModeEnabled: false,
      config: {
        apps,
        mcp_servers: {
          inherited: { command: "inherited-mcp" },
        },
      },
    };
    const start = buildThreadStartParams(params, options);
    const resume = buildThreadResumeParams(params, {
      ...options,
      threadId: "thread-1",
    });

    for (const request of [start, resume]) {
      expect(request.config?.["features.apps"]).toBe(true);
      expect(request.config?.["orchestrator.mcp.enabled"]).toBe(true);
      expect(request.config?.apps).toEqual(apps);
      expect(request.config?.mcp_servers).toEqual({
        inherited: {
          command: "inherited-mcp",
          enabled: false,
        },
      });
      expect(request.config?.["features.multi_agent"]).toBe(false);
    }
  });
});

describe("Codex delegation capability", () => {
  it("disables native delegation and goal continuation on start and resume", () => {
    const params = createAttemptParams({ provider: "openai" });
    params.delegationCapability = "report_only";
    const appServer = createAppServerOptions() as never;
    const config = {
      "features.multi_agent": true,
      "features.multi_agent_v2": true,
      "features.goals": true,
    };
    const start = buildThreadStartParams(params, {
      appServer,
      cwd: "/repo",
      dynamicTools: [],
      config,
    });
    const resume = buildThreadResumeParams(params, {
      appServer,
      dynamicTools: [],
      threadId: "thread-1",
      config,
    });

    for (const request of [start, resume]) {
      expect(request.config?.["agents.enabled"]).toBe(false);
      expect(request.config?.["features.multi_agent"]).toBe(false);
      expect(request.config?.["features.multi_agent_v2"]).toBe(false);
      expect(request.config?.["features.goals"]).toBe(false);
    }
  });

  it("disables only native image generation for an audited image_generate deny", () => {
    const params = createAttemptParams({ provider: "openai" });
    params.pluginHarnessToolPolicySafeDeniedTools = ["image_generate"];
    const appServer = createAppServerOptions() as never;
    const config = {
      "features.image_generation": true,
      "features.multi_agent": true,
      "features.multi_agent_v2": true,
    };
    const start = buildThreadStartParams(params, {
      appServer,
      cwd: "/repo",
      dynamicTools: [],
      config,
    });
    const resume = buildThreadResumeParams(params, {
      appServer,
      dynamicTools: [],
      threadId: "thread-1",
      config,
    });

    for (const request of [start, resume]) {
      expect(request.config?.["features.image_generation"]).toBe(false);
      expect(request.config?.["features.multi_agent"]).toBe(true);
      expect(request.config?.["features.multi_agent_v2"]).toBe(true);
      expect(request.config?.["agents.enabled"]).toBeUndefined();
    }
  });

  it("keeps message-only completion threads and prompts free of native delegation", () => {
    const params = createAttemptParams({ provider: "openai" });
    params.toolsAllow = ["message"];
    params.sourceReplyDeliveryMode = "message_tool_only";
    params.inputProvenance = {
      kind: "inter_session",
      sourceSessionKey: "agent:main:subagent:child",
      sourceChannel: "internal",
      sourceTool: "subagent_announce",
    };
    const appServer = createAppServerOptions() as never;
    const config = {
      "features.apps": true,
      "features.current_time_reminder": true,
      "features.deferred_executor": true,
      "features.hooks": true,
      "features.image_generation": true,
      "features.multi_agent": true,
      "features.multi_agent_v2": true,
      "features.plugins": true,
      "features.standalone_web_search": true,
      "features.token_budget": true,
      "orchestrator.mcp.enabled": true,
      "tools.experimental_request_user_input.enabled": true,
      "tools.update_plan.enabled": true,
      mcp_servers: {
        "local-example": {
          command: "example-mcp",
          args: ["--stdio"],
          cwd: "/repo/mcp",
          env: { MCP_MODE: "restricted" },
        },
      },
      web_search: "live",
    };
    const dynamicTools: CodexDynamicToolFunctionSpec[] = [
      { type: "function", name: "message", description: "Send", inputSchema: { type: "object" } },
    ];
    const start = buildThreadStartParams(params, {
      appServer,
      cwd: "/repo",
      dynamicTools,
      config,
      nativeCodeModeEnabled: false,
    });
    const resume = buildThreadResumeParams(params, {
      appServer,
      dynamicTools,
      config,
      nativeCodeModeEnabled: false,
      threadId: "thread-1",
    });

    for (const request of [start, resume]) {
      for (const disabledFeature of [
        "agents.enabled",
        "features.apps",
        "features.current_time_reminder",
        "features.deferred_executor",
        "features.hooks",
        "features.image_generation",
        "features.multi_agent",
        "features.multi_agent_v2",
        "features.plugins",
        "features.standalone_web_search",
        "features.token_budget",
        "orchestrator.mcp.enabled",
        "tools.experimental_request_user_input.enabled",
        "tools.update_plan.enabled",
      ]) {
        expect(request.config?.[disabledFeature]).toBe(false);
      }
      expect(request.config?.web_search).toBe("disabled");
      expect(request.config?.mcp_servers).toEqual({
        "local-example": {
          command: "example-mcp",
          args: ["--stdio"],
          cwd: "/repo/mcp",
          env: { MCP_MODE: "restricted" },
          enabled: false,
        },
      });
      expect(request.developerInstructions).toContain("`message(action=send)`");
      expect(request.developerInstructions).not.toContain("`spawn_agent`");
      expect(request.developerInstructions).not.toContain("`tool_search`");
    }
    expect(start.environments).toEqual([]);

    const normalRequests = [
      buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
        appServer,
        cwd: "/repo",
        dynamicTools,
        config,
      }),
      buildThreadResumeParams(createAttemptParams({ provider: "openai" }), {
        appServer,
        dynamicTools,
        config,
        threadId: "thread-normal",
      }),
    ];
    for (const normal of normalRequests) {
      expect(normal.config?.["features.apps"]).toBe(true);
      expect(normal.config?.["features.image_generation"]).toBe(true);
      expect(normal.config?.["features.multi_agent"]).toBe(true);
      expect(normal.config?.["features.multi_agent_v2"]).toBe(true);
      expect(normal.config?.["features.plugins"]).toBe(true);
      expect(normal.config?.["tools.update_plan.enabled"]).toBe(false);
      expect(normal.config?.mcp_servers).toEqual({
        "local-example": {
          command: "example-mcp",
          args: ["--stdio"],
          cwd: "/repo/mcp",
          env: { MCP_MODE: "restricted" },
        },
      });
      expect(normal.developerInstructions).toContain("`spawn_agent`");
    }
  });
});

function startOrResumeThread(
  params: Omit<Parameters<typeof startOrResumeThreadImpl>[0], "bindingStore">,
) {
  return startOrResumeThreadImpl({ ...params, bindingStore: testCodexAppServerBindingStore });
}

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
    hostCapabilities: createCodexTestHostCapabilities(),
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
  };
}

function createNetworkProxyAppServerOptions() {
  const configPatch = {
    "features.network_proxy.enabled": true,
    default_permissions: "mock-proxy",
    permissions: {
      "mock-proxy": {
        filesystem: {
          ":minimal": "read",
          ":project_roots": {
            ".": "write",
          },
        },
        network: {
          enabled: true,
          domains: {
            "api.openai.com": "allow",
          },
          allow_upstream_proxy: true,
          proxy_url: "http://127.0.0.1:3128",
        },
      },
    },
  } as const;
  return {
    ...createAppServerOptions(),
    networkProxy: {
      profileName: "mock-proxy",
      configFingerprint: "test-network-proxy",
      configPatch,
    },
  } as const;
}

function createThreadLifecycleParams(
  sessionFile: string,
  workspaceDir: string,
): EmbeddedRunAttemptParams {
  return {
    hostCapabilities: createCodexTestHostCapabilities(),
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
    loopDetectionPreToolUseRelay: true,
    requestTimeoutMs: 60_000,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    connectionClass: "local-loopback",
    remoteAppsSubstrate: "preconfigured",
  };
}

function createProvisionalPluginThreadConfigProvider(appId: string) {
  const config: CodexPluginThreadConfig = {
    enabled: true,
    configPatch: {
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
        [appId]: {
          enabled: true,
          destructive_enabled: false,
          open_world_enabled: true,
          default_tools_approval_mode: "auto",
        },
      },
    },
    provisionalAppIds: [appId],
    fingerprint: `plugin-config-${appId}`,
    inputFingerprint: `plugin-input-${appId}`,
    policyContext: {
      fingerprint: `plugin-policy-${appId}`,
      apps: {
        [appId]: {
          configKey: "linear",
          marketplaceName: "openai-curated",
          pluginName: "linear",
          allowDestructiveActions: false,
          destructiveApprovalMode: "deny",
          mcpServerNames: [],
        },
      },
      pluginAppIds: { linear: [appId] },
    },
    diagnostics: [],
  };
  return {
    enabled: true,
    inputFingerprint: config.inputFingerprint,
    enabledPluginConfigKeys: ["linear"],
    recoverablePluginConfigKeys: ["linear"],
    build: vi.fn(async () => config),
  };
}

function createAttestedAccountAppThreadConfigProvider(appId: string) {
  const pluginProvider = createProvisionalPluginThreadConfigProvider(appId);
  const inputFingerprint = `account-input-${appId}`;
  return {
    enabled: true,
    inputFingerprint,
    enabledPluginConfigKeys: [],
    recoverablePluginConfigKeys: [],
    accountAppRecoveryEnabled: true,
    build: vi.fn(async (): Promise<CodexPluginThreadConfig> => {
      const pluginConfig = await pluginProvider.build();
      return {
        ...pluginConfig,
        fingerprint: `account-config-${appId}`,
        inputFingerprint,
        policyContext: {
          fingerprint: `account-policy-${appId}`,
          apps: {
            [appId]: {
              source: "account",
              appName: "Account App",
              allowDestructiveActions: false,
              destructiveApprovalMode: "deny",
              mcpServerNames: [],
            },
          },
          pluginAppIds: {},
        },
      };
    }),
  };
}

async function seedAdoptedThreadBinding(params: EmbeddedRunAttemptParams, cwd: string) {
  const threadId = "thread-adopted";
  const request = vi.fn(async (method: string) => {
    if (method === "thread/start") {
      return threadStartResult(threadId);
    }
    throw new Error(`unexpected method: ${method}`);
  });
  await startOrResumeThread({
    client: { request } as never,
    params,
    cwd,
    dynamicTools: [],
    appServer: createThreadLifecycleAppServerOptions(),
  });
  const identity = sessionBindingIdentity({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
  });
  const patched = await testCodexAppServerBindingStore.mutate(identity, {
    kind: "patch",
    threadId,
    patch: {
      model: undefined,
      modelProvider: undefined,
      preserveNativeModel: true,
    },
  });
  if (!patched) {
    throw new Error("failed to seed adopted Codex thread binding");
  }
  return { identity, threadId };
}

async function seedPendingSupervisionBinding(params: {
  attempt: EmbeddedRunAttemptParams;
  cwd: string;
  pending: CodexAppServerPendingSupervisionBranch;
}) {
  const pending = {
    connectionFingerprint: buildCodexAppServerConnectionFingerprint(
      createThreadLifecycleAppServerOptions(),
      params.attempt.agentDir,
    ),
    ...params.pending,
  };
  const identity = sessionBindingIdentity({
    sessionId: params.attempt.sessionId,
    sessionKey: params.attempt.sessionKey,
    agentId: params.attempt.agentId,
    config: params.attempt.config,
  });
  const written = await testCodexAppServerBindingStore.mutate(identity, {
    kind: "set",
    if: { kind: "absent" },
    binding: {
      threadId: pending.sourceThreadId,
      cwd: params.cwd,
      connectionScope: "supervision",
      supervisionSourceThreadId: pending.sourceThreadId,
      preserveNativeModel: true,
      pendingSupervisionBranch: pending,
      conversationSourceTransferComplete: true,
      historyCoveredThrough: new Date(0).toISOString(),
    },
  });
  if (!written) {
    throw new Error("failed to seed pending Codex supervision binding");
  }
  return identity;
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
      projectId: null,
      cliVersion: "0.149.0",
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

function nativeThreadResult(threadId: string, model: string, modelProvider: string) {
  const response = threadStartResult(threadId);
  return {
    ...response,
    model,
    modelProvider,
    thread: { ...response.thread, modelProvider },
  };
}

async function writeNativeCatalogFixture(
  rolloutPath: string,
  threadId: string,
  dynamicTools: unknown,
) {
  await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
  await fs.writeFile(
    rolloutPath,
    `${JSON.stringify({ type: "session_meta", payload: { id: threadId, dynamic_tools: dynamicTools } })}\n`,
  );
}

function disabledMcpServerStatus(name: string) {
  return {
    name,
    serverInfo: null,
    tools: {},
    resources: [],
    resourceTemplates: [],
    authStatus: "unsupported",
  };
}

function sourceThread(params: {
  threadId: string;
  status?: "idle" | "active" | "notLoaded";
  turns?: Array<Record<string, unknown>>;
}) {
  return {
    ...threadStartResult(params.threadId).thread,
    status: { type: params.status ?? "idle" },
    turns: params.turns ?? [],
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
  it("keeps credential collection out of transcript-bearing developer instructions", () => {
    const instructions = buildDeveloperInstructions({
      provider: "codex",
      modelId: "gpt-5.6-luna",
      disableTools: true,
      disableMessageTool: true,
    } as EmbeddedRunAttemptParams);
    const credentialGuidance = instructions
      .split("\n")
      .filter((line) => /credentials?|secrets?|authentication|pairing codes?/iu.test(line));

    expect(
      credentialGuidance.some(
        (line) =>
          /(?:never|do not)/iu.test(line) &&
          /(?:ask for|request)/iu.test(line) &&
          /(?:chat|conversation|message|reply|transcript)/iu.test(line),
      ),
    ).toBe(true);
    expect(
      credentialGuidance.some(
        (line) =>
          /(?:never|do not)/iu.test(line) &&
          /(?:echo|repeat)/iu.test(line) &&
          /(?:chat|conversation|message|reply|transcript)/iu.test(line),
      ),
    ).toBe(true);
    expect(
      credentialGuidance.some(
        (line) =>
          /(?:never|do not)/iu.test(line) &&
          /(?:place|put|include)/iu.test(line) &&
          /(?:recommend|suggest)/iu.test(line) &&
          /(?:command(?:-line)?|arguments?)/iu.test(line) &&
          /urls?/iu.test(line) &&
          /shell/iu.test(line) &&
          /(?:variable|interpolat)/iu.test(line),
      ),
    ).toBe(true);
    expect(
      credentialGuidance.some(
        (line) =>
          /(?:never|do not)/iu.test(line) &&
          /(?:ask|request)/iu.test(line) &&
          /(?:report|share|provide)/iu.test(line) &&
          /(?:authentication|pairing)/iu.test(line) &&
          /codes?/iu.test(line) &&
          /(?:chat|conversation|message|reply|transcript)/iu.test(line),
      ),
    ).toBe(true);
    expect(
      credentialGuidance.some(
        (line) => /(?:masked|secure)/iu.test(line) && /(?:entry|input|setup|wizard)/iu.test(line),
      ),
    ).toBe(true);
  });

  it("keeps Codex-native subagents primary while limiting OpenClaw spawn to OpenClaw delegation", () => {
    const instructions = buildDeveloperInstructions(createAttemptParams({ provider: "openai" }), {
      dynamicTools: [
        {
          type: "function",
          name: "sessions_spawn",
          description: "Start an OpenClaw session",
          inputSchema: { type: "object" },
        },
      ],
    });

    expect(instructions).toContain("Use Codex native `spawn_agent` for Codex subagents");
    // Codex defers native collab tools behind tool_search or code mode; the
    // instructions must teach both retrieval paths or models fall back to the
    // always-direct sessions_spawn.
    expect(instructions).toContain("Use `tool_search` when directly callable");
    expect(instructions).toContain(
      "On code-mode-only models, use `exec` instead: filter `ALL_TOOLS` by name and description",
    );
    expect(instructions).toContain("call the matching entry through `tools`");
    expect(instructions).toContain(
      "Use OpenClaw `sessions_spawn` only for OpenClaw or ACP delegation, never as a substitute for `spawn_agent` on internal legwork.",
    );
  });

  it("never advertises unavailable delegation or session tools", () => {
    const restrictedParams = [
      Object.assign(createAttemptParams({ provider: "openai" }), {
        delegationCapability: "report_only" as const,
      }),
      Object.assign(createAttemptParams({ provider: "openai" }), { toolsAllow: ["openclaw"] }),
      Object.assign(createAttemptParams({ provider: "openai" }), { modelId: "gpt-5.4-nano" }),
      Object.assign(createAttemptParams({ provider: "openai" }), { disableTools: true }),
    ];

    for (const params of restrictedParams) {
      const instructions = buildDeveloperInstructions(params);
      expect(instructions).not.toContain("`spawn_agent`");
      expect(instructions).not.toContain("`sessions_spawn`");
      expect(instructions).not.toContain("`wait_agent`");
    }

    const instructions = buildDeveloperInstructions(createAttemptParams({ provider: "openai" }), {
      dynamicTools: [],
    });
    expect(instructions).toContain("`spawn_agent`");
    expect(instructions).not.toContain("`sessions_spawn`");
  });

  it("adds native completion handoff guidance only when sessions_yield is available", () => {
    const withSessionsYield = buildDeveloperInstructions(
      createAttemptParams({ provider: "openai" }),
      {
        dynamicTools: [
          {
            type: "namespace",
            name: "openclaw_direct",
            description: "",
            tools: [
              {
                type: "function",
                name: "sessions_yield",
                description: "End the current turn",
                inputSchema: { type: "object" },
              },
            ],
          },
        ],
      },
    );
    const withoutSessionsYield = buildDeveloperInstructions(
      createAttemptParams({ provider: "openai" }),
      {
        dynamicTools: [],
      },
    );
    const withWrongNamespace = buildDeveloperInstructions(
      createAttemptParams({ provider: "openai" }),
      {
        dynamicTools: [
          {
            type: "namespace",
            name: "openclaw",
            description: "",
            tools: [
              {
                type: "function",
                name: "sessions_yield",
                description: "Different tool with the same leaf name",
                inputSchema: { type: "object" },
              },
            ],
          },
        ],
      },
    );

    expect(withSessionsYield).toContain(
      "end the current turn with `openclaw_direct.sessions_yield`",
    );
    expect(withSessionsYield).toContain(
      "Use native `wait_agent` only for an intentional same-turn wait",
    );
    expect(withSessionsYield).toContain("Never loop-poll for native child completion.");
    expect(withoutSessionsYield).not.toContain("`openclaw_direct.sessions_yield`");
    expect(withoutSessionsYield).not.toContain("native `wait_agent`");
    expect(withWrongNamespace).not.toContain("`openclaw_direct.sessions_yield`");
    expect(withWrongNamespace).not.toContain("native `wait_agent`");
  });

  it.each([
    { namespace: "openclaw_direct", exposesNativeYield: true },
    { namespace: "openclaw", exposesNativeYield: false },
  ])(
    "materializes the $namespace native-yield namespace exactly once",
    ({ namespace, exposesNativeYield }) => {
      let namespaceReads = 0;
      const yieldTool = {
        type: "function" as const,
        name: "sessions_yield",
        description: "End the current turn",
        inputSchema: { type: "object" },
      };

      const instructions = buildDeveloperInstructions(createAttemptParams({ provider: "openai" }), {
        dynamicTools: [
          yieldTool,
          {
            type: "namespace",
            name: namespace,
            description: "",
            get tools() {
              namespaceReads += 1;
              return [yieldTool];
            },
          },
        ],
      });

      expect(namespaceReads).toBe(1);
      expect(instructions.includes("`openclaw_direct.sessions_yield`")).toBe(exposesNativeYield);
      expect(instructions.includes("native `wait_agent`")).toBe(exposesNativeYield);
    },
  );

  it("summarizes deferred dynamic tool names in developer instructions", () => {
    const instructions = buildDeveloperInstructions(createAttemptParams({ provider: "openai" }), {
      dynamicTools: [
        {
          type: "function",
          name: "message",
          description: "Send a message",
          inputSchema: { type: "object" },
        },
        {
          type: "namespace",
          name: "openclaw",
          description: "",
          tools: [
            {
              type: "function",
              name: "music_generate",
              description: "Create music",
              inputSchema: { type: "object" },
              deferLoading: true,
            },
            {
              type: "function",
              name: "image_generate",
              description: "Create images",
              inputSchema: { type: "object" },
              deferLoading: true,
            },
          ],
        },
      ],
    });

    expect(instructions).toContain(
      "Deferred searchable OpenClaw dynamic tools available: image_generate, music_generate.",
    );
    expect(instructions).toContain("Use `tool_search` when directly callable");
    expect(instructions).toContain(
      "On code-mode-only models, use `exec` instead: filter `ALL_TOOLS` by name and description",
    );
    expect(instructions).toContain("call the matching entry through `tools`");
    expect(instructions).not.toContain("message,");
  });

  it("materializes namespaced prompt tools once while preserving all guidance", () => {
    const params = createAttemptParams({ provider: "openai" });
    params.sourceReplyDeliveryMode = "message_tool_only";
    let namespaceReads = 0;
    const tools: CodexDynamicToolFunctionSpec[] = [
      {
        type: "function" as const,
        name: "zeta_tool",
        description: "Deferred Zeta tool",
        inputSchema: { type: "object" },
        deferLoading: true,
      },
      {
        type: "function" as const,
        name: "message",
        description: "Send a source reply",
        inputSchema: { type: "object" },
      },
      {
        type: "function" as const,
        name: "skill_workshop",
        description: "Manage skill proposals",
        inputSchema: { type: "object" },
        deferLoading: true,
      },
      {
        type: "function" as const,
        name: "alpha_tool",
        description: "Deferred Alpha tool",
        inputSchema: { type: "object" },
        deferLoading: true,
      },
    ];

    const instructions = buildDeveloperInstructions(params, {
      dynamicTools: [
        {
          type: "namespace",
          name: "openclaw",
          description: "",
          get tools() {
            namespaceReads += 1;
            return tools;
          },
        },
      ],
    });

    expect(namespaceReads).toBe(1);
    expect(instructions).toContain(
      "Deferred searchable OpenClaw dynamic tools available: alpha_tool, skill_workshop, zeta_tool.",
    );
    expect(instructions).toContain("## Skill Workshop");
    expect(instructions).toContain("Visible source replies are not automatically delivered");
    expect(instructions).toContain("Use `message(action=send)`");
    expect(instructions).not.toContain("`openclaw_direct.sessions_yield`");
  });

  it("uses the shared Skill Workshop guidance when skill_workshop is available", () => {
    const instructions = buildDeveloperInstructions(createAttemptParams({ provider: "openai" }), {
      dynamicTools: [
        {
          type: "namespace",
          name: "openclaw",
          description: "",
          tools: [
            {
              type: "function",
              name: "skill_workshop",
              description: "Manage skill proposals",
              inputSchema: { type: "object" },
              deferLoading: true,
            },
          ],
        },
      ],
    });

    expect(instructions).toContain("## Skill Workshop");
    expect(instructions).toContain("Durable reusable skill/playbook/workflow work");
    expect(instructions).toContain("`skill_workshop`");
    expect(instructions).toContain(
      "unsolicited improvements stay pending proposals when supported",
    );
    expect(instructions).toContain(
      "Publication-only create/update requires an explicit user request",
    );
    expect(instructions).toContain("only explicit user ask");
  });

  it("keeps developer instructions compact when no dynamic tools are deferred", () => {
    const instructions = buildDeveloperInstructions(createAttemptParams({ provider: "openai" }), {
      dynamicTools: [
        {
          type: "function",
          name: "message",
          description: "Send a message",
          inputSchema: { type: "object" },
        },
      ],
    });

    expect(instructions).not.toContain("Deferred searchable OpenClaw dynamic tools available");
  });

  it("instructs Codex to mark only completed message-tool-only source replies final", () => {
    const params = createAttemptParams({ provider: "openai" });
    params.sourceReplyDeliveryMode = "message_tool_only";

    const instructions = buildDeveloperInstructions(params, {
      dynamicTools: [
        {
          type: "function",
          name: "message",
          description: "Send a message",
          inputSchema: { type: "object" },
        },
      ],
    });

    expect(instructions).toContain("For progress, set `final=false`.");
    expect(instructions).toContain("Set `final=true`, or omit it,");
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
        type: "function",
        name: "message",
        description: "Send a visible message",
        inputSchema,
      },
    ]);
    const searchableFingerprint = codexDynamicToolsFingerprint([
      {
        type: "namespace",
        name: "openclaw",
        description: "",
        tools: [
          {
            type: "function",
            name: "message",
            description: "Load and send a visible message",
            inputSchema,
            deferLoading: true,
          },
        ],
      },
    ]);

    expect(searchableFingerprint).not.toBe(directFingerprint);
  });

  it("keeps hashed dynamic tool fingerprints compatible with legacy JSON bindings", () => {
    const tools = [
      {
        type: "function" as const,
        name: "message",
        description: "Send a visible message",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string" },
          },
          required: ["text"],
        },
      },
    ];
    const hashed = codexDynamicToolsFingerprint(tools);
    const legacy = codexLegacyDynamicToolsFingerprint(tools);

    expect(hashed).toMatch(/^sha256:/);
    expect(legacy).toContain('"name":"message"');
    expect(
      areCodexDynamicToolFingerprintsCompatible({
        previous: legacy,
        next: hashed,
        nextLegacy: legacy,
      }),
    ).toBe(true);
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

  it.each([
    { name: "available", extraSystemPrompt: PROGRESS_CARD_SYSTEM_PROMPT, expected: true },
    { name: "denied", extraSystemPrompt: undefined, expected: false },
  ])(
    "$name progress-card nudge propagation into thread developer instructions",
    ({ extraSystemPrompt, expected }) => {
      const params = createAttemptParams({ provider: "openai" });
      params.toolsAllow = expected ? ["progress_card"] : ["read"];
      params.extraSystemPrompt = extraSystemPrompt;

      expect(buildDeveloperInstructions(params).includes(PROGRESS_CARD_SYSTEM_PROMPT)).toBe(
        expected,
      );
    },
  );

  it("enables Codex code mode on thread/start without clobbering other config", () => {
    const request = buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
      cwd: "/repo",
      dynamicTools: [],
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
      config: {
        "features.hooks": true,
        apps: { _default: { enabled: false } },
        mcp_servers: {
          local_docs: {
            command: "node",
            args: ["/opt/local-docs-mcp/dist/index.js"],
          },
        },
      },
    });

    expect(request.config).toEqual({
      project_doc_max_bytes: 131_072,
      "features.hooks": true,
      apps: { _default: { enabled: false } },
      mcp_servers: {
        local_docs: {
          command: "node",
          args: ["/opt/local-docs-mcp/dist/index.js"],
        },
      },
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.goals": false,
      "tools.update_plan.enabled": false,
      "features.apply_patch_streaming_events": true,
      suppress_unstable_features_warning: true,
      "features.standalone_web_search": false,
      web_search: "cached",
    });
    expect(request.personality).toBe("none");
  });

  it("enables hosted Codex web search on thread/start by default", () => {
    const request = buildThreadStartParams(createAttemptParams({ provider: "codex" }), {
      cwd: "/repo",
      dynamicTools: [],
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
    });

    expect(request.config).toMatchObject({
      "features.standalone_web_search": false,
      web_search: "cached",
    });
  });

  it("disables hosted Codex web search for tool-disabled runs", () => {
    const params = createAttemptParams({ provider: "codex" });
    params.disableTools = true;
    const request = buildThreadStartParams(params, {
      cwd: "/repo",
      dynamicTools: [],
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
    });

    expect(request.config).toMatchObject({
      "features.standalone_web_search": false,
      web_search: "disabled",
    });
  });

  it("disables hosted Codex web search when effective tool policy denies web_search", () => {
    const request = buildThreadStartParams(createAttemptParams({ provider: "codex" }), {
      cwd: "/repo",
      dynamicTools: [],
      webSearchAllowed: false,
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
    });

    expect(request.config).toMatchObject({
      "features.standalone_web_search": false,
      web_search: "disabled",
    });
  });

  it("disables native Codex search when runtime policy disables native tools", () => {
    const request = buildThreadResumeParams(createAttemptParams({ provider: "codex" }), {
      threadId: "thread-1",
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
      nativeCodeModeEnabled: false,
    });

    expect(request.config).toMatchObject({
      "features.standalone_web_search": false,
      web_search: "disabled",
    });
  });

  it("disables hosted Codex web search when the active provider lacks support", () => {
    const request = buildThreadStartParams(createAttemptParams({ provider: "codex" }), {
      cwd: "/repo",
      dynamicTools: [],
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
      nativeProviderWebSearchSupport: "unsupported",
    });

    expect(request.config).toMatchObject({
      "features.standalone_web_search": false,
      web_search: "disabled",
    });
  });

  it("selects the Codex network-proxy permissions profile in thread/start config", () => {
    const request = buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
      cwd: "/repo",
      dynamicTools: [],
      appServer: createNetworkProxyAppServerOptions() as never,
      developerInstructions: "test instructions",
    });

    expect(request).not.toHaveProperty("permissions");
    expect(request).not.toHaveProperty("sandbox");
    expect(request.config).toMatchObject({
      "features.network_proxy.enabled": true,
      default_permissions: "mock-proxy",
      permissions: {
        "mock-proxy": {
          network: {
            enabled: true,
            allow_upstream_proxy: true,
            proxy_url: "http://127.0.0.1:3128",
          },
        },
      },
    });
  });

  it("selects the Codex network-proxy permissions profile in thread/resume config", () => {
    const request = buildThreadResumeParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      appServer: createNetworkProxyAppServerOptions() as never,
      developerInstructions: "test instructions",
    });

    expect(request).not.toHaveProperty("permissions");
    expect(request).not.toHaveProperty("sandbox");
    expect(request.config).toMatchObject({
      "features.network_proxy.enabled": true,
      default_permissions: "mock-proxy",
      permissions: {
        "mock-proxy": {
          network: {
            domains: {
              "api.openai.com": "allow",
            },
          },
        },
      },
    });
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
      project_doc_max_bytes: 131_072,
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.goals": false,
      "tools.update_plan.enabled": false,
      "features.apply_patch_streaming_events": true,
      suppress_unstable_features_warning: true,
      "features.multi_agent": false,
      "features.standalone_web_search": false,
      web_search: "cached",
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

  it("omits OpenClaw model selection when adopting a native Codex thread", () => {
    const request = buildThreadResumeParams(createAttemptParams({ provider: "codex" }), {
      threadId: "thread-adopted",
      model: "openclaw-model",
      modelProvider: "openclaw-provider",
      preserveNativeModel: true,
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
    });

    expect(request).not.toHaveProperty("model");
    expect(request).not.toHaveProperty("modelProvider");
  });

  it("keeps Codex model personality disabled on turn/start", () => {
    const request = buildTurnStartParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      cwd: "/repo",
      appServer: createAppServerOptions() as never,
    });

    expect(request.personality).toBe("none");
  });

  it.each([undefined, "Permission change. Continue with updated permissions."])(
    "does not overwrite native supervised turn settings (notice: %s)",
    (notice) => {
      const params = createAttemptParams({ provider: "anthropic" });
      params.thinkLevel = "off";
      const compat: ModelCompatConfig = { supportedReasoningEfforts: ["none", "high"] };
      params.model = {
        ...createCodexTestModel("anthropic"),
        compat,
      };
      if (notice) {
        params.permissionChange = {
          owner: {},
          baseExecOverrides: {},
          notice,
          request: vi.fn(),
          applied: () => true,
          recordApplied: vi.fn(),
        };
      }
      const request = buildTurnStartParams(params, {
        threadId: "thread-supervised",
        cwd: "/repo",
        model: "native-model",
        modelProvider: "native-provider",
        appServer: createAppServerOptions() as never,
        preserveNativeTurnSettings: true,
      });

      expect(request).not.toHaveProperty("model");
      expect(request).not.toHaveProperty("effort");
      expect(request).not.toHaveProperty("collaborationMode");
      expect(request).not.toHaveProperty("personality");
      expect(request.additionalContext).toEqual({
        openclaw_temporal_context: {
          kind: "application",
          value: expect.stringContaining("## Temporal Context"),
        },
        ...(notice
          ? {
              openclaw_permission_change: { kind: "application", value: notice },
            }
          : {}),
      });
    },
  );

  it("honors an explicit top-level reviewer on thread start and resume", () => {
    const appServer = {
      ...createAppServerOptions(),
      approvalsReviewer: "auto_review" as const,
    };
    const config = { approvals_reviewer: "user" };

    const started = buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
      cwd: "/repo",
      dynamicTools: [],
      appServer: appServer as never,
      developerInstructions: "test instructions",
      config,
    });
    const resumed = buildThreadResumeParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      appServer: appServer as never,
      developerInstructions: "test instructions",
      config,
    });

    expect(started.approvalsReviewer).toBe("user");
    expect(resumed.approvalsReviewer).toBe("user");
  });

  it("keeps the configured runtime reviewer on turn start", () => {
    const request = buildTurnStartParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      cwd: "/repo",
      appServer: {
        ...createAppServerOptions(),
        approvalsReviewer: "auto_review",
      } as never,
    });

    expect(request.approvalsReviewer).toBe("auto_review");
  });

  it("preserves omitted native tiers until a previously owned sticky tier must be cleared", () => {
    const options = {
      threadId: "thread-1",
      cwd: "/repo",
      appServer: createAppServerOptions() as never,
    };
    const inherited = buildTurnStartParams(createAttemptParams({ provider: "openai" }), options);
    const cleared = buildTurnStartParams(createAttemptParams({ provider: "openai" }), {
      ...options,
      clearInheritedServiceTier: true,
    });

    expect(inherited).not.toHaveProperty("serviceTier");
    expect(cleared.serviceTier).toBeNull();
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
      project_doc_max_bytes: 131_072,
      "features.code_mode": true,
      "features.code_mode_only": true,
      "features.goals": false,
      "tools.update_plan.enabled": false,
      "features.apply_patch_streaming_events": true,
      suppress_unstable_features_warning: true,
      "features.standalone_web_search": false,
      web_search: "cached",
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
      project_doc_max_bytes: 131_072,
      "features.code_mode": true,
      "features.code_mode_only": true,
      "features.goals": false,
      "tools.update_plan.enabled": false,
      "features.apply_patch_streaming_events": true,
      suppress_unstable_features_warning: true,
      "features.standalone_web_search": false,
      web_search: "cached",
    });
  });

  it.each([
    { nativeCodeModeOnlyEnabled: false, configured: false },
    { nativeCodeModeOnlyEnabled: true, configured: false },
    { nativeCodeModeOnlyEnabled: false, configured: true },
    { nativeCodeModeOnlyEnabled: true, configured: true },
  ])(
    "keeps direct-only dynamic namespaces model-visible when code-mode-only=$nativeCodeModeOnlyEnabled, configured=$configured",
    ({ nativeCodeModeOnlyEnabled, configured }) => {
      const dynamicTools = [
        {
          type: "namespace" as const,
          name: CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
          description: "",
          tools: [],
        },
      ];
      const config = configured
        ? {
            "features.code_mode": {
              enabled: true,
              default_exec_yield_time_ms: 10000,
              excluded_tool_namespaces: ["vendor_excluded"],
              direct_only_tool_namespaces: ["vendor_direct"],
            },
          }
        : undefined;
      const startRequest = buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
        cwd: "/repo",
        dynamicTools,
        appServer: createAppServerOptions() as never,
        developerInstructions: "test instructions",
        nativeCodeModeOnlyEnabled,
        config,
      });
      const resumeRequest = buildThreadResumeParams(createAttemptParams({ provider: "openai" }), {
        threadId: "thread-1",
        dynamicTools,
        appServer: createAppServerOptions() as never,
        developerInstructions: "test instructions",
        nativeCodeModeOnlyEnabled,
        config,
      });

      for (const request of [startRequest, resumeRequest]) {
        expect(request.config?.["features.code_mode"]).toEqual({
          enabled: true,
          ...(configured
            ? {
                default_exec_yield_time_ms: 10000,
                excluded_tool_namespaces: ["vendor_excluded"],
              }
            : {}),
          direct_only_tool_namespaces: [
            ...(configured ? ["vendor_direct"] : []),
            CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
          ],
        });
        expect(request.config?.["code_mode.direct_only_tool_namespaces"]).toBeUndefined();
        expect(request.config?.["features.code_mode_only"]).toBe(nativeCodeModeOnlyEnabled);
      }
    },
  );

  it("enables Codex code mode on thread/resume", () => {
    const request = buildThreadResumeParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
    });

    expect(request.config).toEqual({
      project_doc_max_bytes: 131_072,
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.goals": false,
      "tools.update_plan.enabled": false,
      "features.apply_patch_streaming_events": true,
      suppress_unstable_features_warning: true,
      "features.standalone_web_search": false,
      web_search: "cached",
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
      project_doc_max_bytes: 131_072,
      "features.code_mode": false,
      "features.code_mode_only": false,
      "features.goals": false,
      "tools.update_plan.enabled": false,
      "features.standalone_web_search": false,
      web_search: "disabled",
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
      project_doc_max_bytes: 131_072,
      "features.code_mode": false,
      "features.code_mode_only": false,
      "features.goals": false,
      "tools.update_plan.enabled": false,
      "features.standalone_web_search": false,
      web_search: "disabled",
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
      "features.goals": false,
      "tools.update_plan.enabled": false,
      "features.apply_patch_streaming_events": true,
      suppress_unstable_features_warning: true,
      "features.standalone_web_search": false,
      web_search: "cached",
    });
  });

  it("defaults native Codex project docs to 128 KiB while honoring explicit overrides", () => {
    const defaultRequest = buildThreadStartParams(
      createAttemptParams({ provider: "openai", bootstrapContextRunKind: "cron" }),
      {
        cwd: "/repo",
        dynamicTools: [],
        appServer: createAppServerOptions() as never,
        developerInstructions: "test instructions",
      },
    );
    const overrideRequest = buildThreadResumeParams(
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

    expect(defaultRequest.config?.project_doc_max_bytes).toBe(131_072);
    expect(overrideRequest.config).toEqual({
      project_doc_max_bytes: 64_000,
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.goals": false,
      "tools.update_plan.enabled": false,
      "features.apply_patch_streaming_events": true,
      suppress_unstable_features_warning: true,
      "features.standalone_web_search": false,
      web_search: "cached",
    });
  });
});

describe("Codex app-server turn input image sanitizing", () => {
  const excludedTmpStart = {
    args: [
      "-csandbox_workspace_write.exclude_tmpdir_env_var=true",
      "-csandbox_workspace_write.exclude_slash_tmp=true",
      "app-server",
    ],
  };

  it.each([
    {
      name: "separate",
      args: [
        "-c",
        "sandbox_workspace_write.exclude_tmpdir_env_var=true",
        "--config",
        "sandbox_workspace_write.exclude_slash_tmp=true",
      ],
      excluded: true,
    },
    {
      name: "attached short",
      args: [
        "-csandbox_workspace_write.exclude_tmpdir_env_var=true",
        "-c=sandbox_workspace_write.exclude_slash_tmp=true",
      ],
      excluded: true,
    },
    {
      name: "mixed last true",
      args: [
        "--config=sandbox_workspace_write.exclude_tmpdir_env_var=false",
        "-csandbox_workspace_write.exclude_tmpdir_env_var=true",
        "--config=sandbox_workspace_write.exclude_slash_tmp=true",
      ],
      excluded: true,
    },
    {
      name: "mixed last false",
      args: [
        "-csandbox_workspace_write.exclude_tmpdir_env_var=true",
        "--config",
        "sandbox_workspace_write.exclude_tmpdir_env_var=false",
        "--config=sandbox_workspace_write.exclude_slash_tmp=true",
        "-c=sandbox_workspace_write.exclude_slash_tmp=false",
      ],
      excluded: false,
    },
    {
      name: "commented true across separate and attached forms",
      args: [
        "-c",
        "sandbox_workspace_write.exclude_tmpdir_env_var = false # earlier",
        "--config=sandbox_workspace_write.exclude_tmpdir_env_var = true # exclusion retained",
        "--config",
        "sandbox_workspace_write.exclude_slash_tmp = false # earlier",
        "-c=sandbox_workspace_write.exclude_slash_tmp = true # exclusion retained",
      ],
      excluded: true,
    },
    {
      name: "commented false wins last",
      args: [
        "-csandbox_workspace_write.exclude_tmpdir_env_var=true",
        "--config",
        "sandbox_workspace_write.exclude_tmpdir_env_var=false # explicit last value",
        "--config=sandbox_workspace_write.exclude_slash_tmp=true",
        "-csandbox_workspace_write.exclude_slash_tmp=false # explicit last value",
      ],
      excluded: false,
    },
    {
      name: "quoted booleans remain strings",
      args: [
        '-csandbox_workspace_write.exclude_tmpdir_env_var="true" # not a boolean',
        "--config=sandbox_workspace_write.exclude_slash_tmp='true' # not a boolean",
      ],
      excluded: false,
    },
    {
      name: "option value and terminator",
      args: [
        "--ws-issuer",
        "-csandbox_workspace_write.exclude_tmpdir_env_var=true",
        "--",
        "--config=sandbox_workspace_write.exclude_slash_tmp=true",
      ],
      excluded: false,
    },
  ])(
    "carries native workspace temporary-root overrides into turn policy: $name",
    ({ args, excluded }) => {
      const request = buildTurnStartParams(createAttemptParams({ provider: "openai" }), {
        threadId: "thread-1",
        cwd: "/tmp/qa/workspace",
        appServer: {
          ...createAppServerOptions(),
          start: { args: ["app-server", ...args] },
        } as never,
      });
      expect(request.sandboxPolicy).toEqual({
        type: "workspaceWrite",
        writableRoots: ["/tmp/qa/workspace"],
        networkAccess: false,
        excludeTmpdirEnvVar: excluded,
        excludeSlashTmp: excluded,
      });
    },
  );

  it("preserves implicit temporary writable roots for ordinary Codex turns", () => {
    const request = buildTurnStartParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      cwd: "/tmp/qa/workspace",
      appServer: createAppServerOptions() as never,
    });

    expect(request.sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/tmp/qa/workspace"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
  });

  it("uses an explicit turn sandbox policy override when provided", () => {
    const request = buildTurnStartParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      cwd: "/repo",
      appServer: {
        ...createAppServerOptions(),
        start: excludedTmpStart,
      } as never,
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

  it("uses Codex permissions for network-proxy turn/start requests", () => {
    const request = buildTurnStartParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      cwd: "/repo",
      appServer: {
        ...createNetworkProxyAppServerOptions(),
        start: excludedTmpStart,
      } as never,
    });

    expect(request).not.toHaveProperty("permissions");
    expect(request).not.toHaveProperty("sandboxPolicy");
  });

  it("keeps explicit sandbox policy overrides ahead of network-proxy turn permissions", () => {
    const request = buildTurnStartParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      cwd: "/repo",
      appServer: {
        ...createNetworkProxyAppServerOptions(),
        start: excludedTmpStart,
      } as never,
      sandboxPolicy: {
        type: "externalSandbox",
        networkAccess: "enabled",
      },
    });

    expect(request).not.toHaveProperty("permissions");
    expect(request.sandboxPolicy).toEqual({
      type: "externalSandbox",
      networkAccess: "enabled",
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
      loopDetectionPreToolUseRelay: true,
      requestTimeoutMs: 60_000,
      approvalPolicy: "on-request" as const,
      approvalsReviewer: "guardian_subagent" as const,
      sandbox: "danger-full-access" as const,
      connectionClass: "local-loopback" as const,
      remoteAppsSubstrate: "preconfigured" as const,
      serviceTier: "flex" as const,
    };

    const resumeParams = buildThreadResumeParams(params, { threadId: "thread-1", appServer });
    expect(resumeParams).toEqual({
      threadId: "thread-1",
      excludeTurns: true,
      initialTurnsPage: {
        limit: 1,
        sortDirection: "desc",
        itemsView: "notLoaded",
      },
      model: "gpt-5.4-codex",
      approvalPolicy: "on-request",
      approvalsReviewer: "guardian_subagent",
      config: {
        project_doc_max_bytes: 131_072,
        "features.code_mode": true,
        "features.code_mode_only": false,
        "features.goals": false,
        "tools.update_plan.enabled": false,
        "features.apply_patch_streaming_events": true,
        suppress_unstable_features_warning: true,
        "features.standalone_web_search": false,
        web_search: "cached",
      },
      sandbox: "danger-full-access",
      serviceTier: "flex",
      personality: "none",
      developerInstructions: resumeParams.developerInstructions,
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

  it("keeps heartbeat Codex turns in normal Default collaboration mode", () => {
    const params = createAttemptParams({ provider: "codex" });
    params.modelId = "gpt-5.4-codex";
    params.thinkLevel = "medium";
    params.trigger = "heartbeat";

    const heartbeatCollaborationMode = buildTurnCollaborationMode(params, {});
    expect(heartbeatCollaborationMode.mode).toBe("default");
    expect(heartbeatCollaborationMode.settings.model).toBe("gpt-5.4-codex");
    expect(heartbeatCollaborationMode.settings.reasoning_effort).toBe("medium");
    expect(heartbeatCollaborationMode.settings.developer_instructions).toBeNull();

    const workspaceInstructions = buildTurnCollaborationMode(params, {
      turnScopedDeveloperInstructions: "Turn-only workspace instructions.",
    }).settings.developer_instructions;
    expect(workspaceInstructions).toContain("Turn-only workspace instructions.");
    expect(workspaceInstructions).toContain("# Collaboration Mode: Default");
    expect(workspaceInstructions).not.toContain("This is an OpenClaw heartbeat turn");
    expect(workspaceInstructions).not.toContain("### Heartbeats");
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
  it("omits public openai modelProvider when forwarding native Codex auth on thread/start", () => {
    const request = buildThreadStartParams(
      createAttemptParams({
        provider: "openai",
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
  });

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

  it("splits provider-qualified model refs for app-server thread/start", () => {
    const request = buildThreadStartParams(
      createAttemptParams({ provider: "codex", modelId: "lmstudio/local-model" }),
      {
        cwd: "/repo",
        dynamicTools: [],
        appServer: createAppServerOptions() as never,
        developerInstructions: "test instructions",
      },
    );

    expect(request.model).toBe("local-model");
    expect(request.modelProvider).toBe("lmstudio");
  });

  it("uses provider-qualified model refs for thread capability selection", () => {
    expect(
      resolveCodexAppServerThreadModelSelection({
        provider: "codex",
        model: "amazon-bedrock/local-model",
      }),
    ).toEqual({
      model: "local-model",
      modelProvider: "amazon-bedrock",
    });
  });

  it("uses a matching bound provider for thread capability selection", () => {
    expect(
      resolveCodexAppServerThreadModelSelection({
        provider: "codex",
        model: "local-model",
        binding: {
          threadId: "thread-1",
          model: "local-model",
          modelProvider: "amazon-bedrock",
        },
      }),
    ).toEqual({
      model: "local-model",
      modelProvider: "amazon-bedrock",
    });
  });

  it("prefers provider-qualified models over bound providers for thread capability selection", () => {
    expect(
      resolveCodexAppServerThreadModelSelection({
        provider: "codex",
        model: "openai/gpt-5.5",
        binding: {
          threadId: "thread-1",
          model: "local-model",
          modelProvider: "amazon-bedrock",
        },
      }),
    ).toEqual({
      model: "gpt-5.5",
      modelProvider: "openai",
    });
  });

  it("normalizes provider-qualified model refs for turn/start metadata", () => {
    const request = buildTurnStartParams(
      createAttemptParams({ provider: "codex", modelId: "lmstudio/local-model" }),
      {
        threadId: "thread-1",
        cwd: "/repo",
        appServer: createAppServerOptions() as never,
      },
    );

    const collaborationMode = request.collaborationMode as { settings?: Record<string, unknown> };
    expect(request.model).toBe("local-model");
    expect(collaborationMode.settings?.model).toBe("local-model");
  });
});

describe("Codex plugin binding recovery", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-plugin-recovery-"));
    resetCodexTestBindingStore();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("records ownership before committing a newly created durable thread", async () => {
    const params = createThreadLifecycleParams(
      path.join(tempDir, "session-managed.jsonl"),
      path.join(tempDir, "workspace-managed"),
    );
    params.agentDir = path.join(tempDir, "agent");
    const mark = vi.fn(async () => undefined);
    const stateStore = createCodexTestBindingStateStore();
    const bindingStore = Object.assign(createCodexAppServerBindingStore(stateStore), {
      managedThreads: {
        has: vi.fn(async () => false),
        mark,
        snapshot: vi.fn(async () => new Map()),
      },
    });
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-managed");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThreadImpl({
      client: {
        request,
        getRuntimeIdentity: () => ({ codexHome: path.join(tempDir, "agent", "codex-home") }),
      } as never,
      params,
      cwd: params.workspaceDir!,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      bindingStore,
    });

    expect(mark).toHaveBeenCalledOnce();
    expect(mark).toHaveBeenCalledWith({
      sourceHomeId: expect.stringMatching(/^[a-f0-9]{64}$/),
      threadId: "thread-managed",
    });
    expect(stateStore.entries().map((entry) => entry.value)).toContainEqual(
      expect.objectContaining({
        state: "active",
        binding: expect.objectContaining({ threadId: "thread-managed" }),
      }),
    );
  });

  it.each([
    ["a different remote home", "remote"],
    ["a local-looking remote path", "local-looking"],
  ])("keys remote ownership to the selected catalog home for %s", async (_label, pathKind) => {
    const rolloutPath =
      pathKind === "remote"
        ? "/remote/codex/sessions/2026/08/thread-managed-remote.jsonl"
        : path.join(tempDir, "poison", "sessions", "2026", "08", "thread-managed-remote.jsonl");
    const params = createThreadLifecycleParams(
      path.join(tempDir, "session-managed-remote.jsonl"),
      path.join(tempDir, "workspace-managed-remote"),
    );
    params.agentDir = path.join(tempDir, "agent");
    const mark = vi.fn(async () => undefined);
    const bindingStore = Object.assign(
      createCodexAppServerBindingStore(createCodexTestBindingStateStore()),
      {
        managedThreads: {
          has: vi.fn(async () => false),
          mark,
          snapshot: vi.fn(async () => new Map()),
        },
      },
    );
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        const result = threadStartResult("thread-managed-remote");
        return { ...result, thread: { ...result.thread, path: rolloutPath } };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const appServer = createThreadLifecycleAppServerOptions();
    appServer.start = {
      ...appServer.start,
      transport: "websocket",
      url: "wss://codex.example.test/app-server",
    };
    appServer.connectionClass = "remote";

    await startOrResumeThreadImpl({
      client: {
        request,
        getRuntimeIdentity: () => ({ codexHome: "/remote/codex" }),
      } as never,
      params,
      cwd: params.workspaceDir!,
      dynamicTools: [],
      appServer,
      bindingStore,
    });

    expect(mark).toHaveBeenCalledWith({
      sourceHomeId: codexCatalogHomeId(resolveCodexAppServerHomeDir(params.agentDir)),
      threadId: "thread-managed-remote",
      rolloutPath,
    });
  });

  it("starts a durable thread when catalog ownership bookkeeping fails", async () => {
    const params = createThreadLifecycleParams(
      path.join(tempDir, "session-managed-failure.jsonl"),
      path.join(tempDir, "workspace-managed-failure"),
    );
    const stateStore = createCodexTestBindingStateStore();
    const bindingStore = Object.assign(createCodexAppServerBindingStore(stateStore), {
      managedThreads: {
        has: vi.fn(async () => false),
        mark: vi.fn(async () => {
          throw new Error("managed ownership unavailable");
        }),
        snapshot: vi.fn(async () => new Map()),
      },
    });
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-managed-without-index");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(
      startOrResumeThreadImpl({
        client: {
          request,
          getRuntimeIdentity: () => ({ codexHome: path.join(tempDir, "codex-home") }),
        } as never,
        params,
        cwd: params.workspaceDir!,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
        bindingStore,
      }),
    ).resolves.toMatchObject({ threadId: "thread-managed-without-index" });
  });

  it("does not rebuild a binding whose configured plugin is a settled negative", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createThreadLifecycleParams(sessionFile, workspaceDir);
    const respond = vi.fn(async (method: string) => {
      if (method === "thread/start" || method === "thread/resume") {
        return threadStartResult("thread-settled");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const build = vi.fn(async () => ({
      enabled: true,
      configPatch: {
        apps: {
          _default: {
            enabled: false,
            destructive_enabled: false,
            open_world_enabled: false,
          },
        },
      },
      fingerprint: "plugin-config-settled",
      inputFingerprint: "plugin-input-settled",
      policyContext: { fingerprint: "plugin-policy-settled", apps: {}, pluginAppIds: {} },
      diagnostics: [],
    }));
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });
    const { client, request } = fixture;
    const common = {
      client,
      signal: new AbortController().signal,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
    };

    await startOrResumeThread({
      ...common,
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-input-settled",
        enabledPluginConfigKeys: ["calendar"],
        recoverablePluginConfigKeys: ["calendar"],
        build,
      },
    });
    await fixture.endTurn("thread-settled");
    await startOrResumeThread({
      ...common,
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-input-settled",
        enabledPluginConfigKeys: ["calendar"],
        recoverablePluginConfigKeys: [],
        build,
      },
    });

    expect(build).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/unsubscribe",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
  });

  it("rebuilds once when a settled negative binding still enables the plugin", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createThreadLifecycleParams(sessionFile, workspaceDir);
    const respond = vi.fn(async (method: string) => {
      if (method === "thread/start" || method === "thread/resume") {
        return threadStartResult("thread-settled-transition");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const build = vi
      .fn()
      .mockResolvedValueOnce({
        enabled: true,
        configPatch: { apps: { calendar: { enabled: true } } },
        fingerprint: "plugin-config-active",
        inputFingerprint: "plugin-input-settled",
        policyContext: {
          fingerprint: "plugin-policy-active",
          apps: {
            calendar: {
              configKey: "calendar",
              marketplaceName: "openai-curated" as const,
              pluginName: "calendar",
              allowDestructiveActions: false,
              mcpServerNames: [],
            },
          },
          pluginAppIds: { calendar: ["calendar"] },
        },
        diagnostics: [],
      })
      .mockResolvedValue({
        enabled: true,
        configPatch: { apps: { _default: { enabled: false } } },
        fingerprint: "plugin-config-settled",
        inputFingerprint: "plugin-input-settled",
        policyContext: { fingerprint: "plugin-policy-settled", apps: {}, pluginAppIds: {} },
        diagnostics: [],
      });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });
    const { client, request } = fixture;
    const common = {
      client,
      signal: new AbortController().signal,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
    };

    await startOrResumeThread({
      ...common,
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-input-settled",
        enabledPluginConfigKeys: ["calendar"],
        recoverablePluginConfigKeys: ["calendar"],
        build,
      },
    });
    await fixture.endTurn("thread-settled-transition");
    const settledProvider = {
      enabled: true,
      inputFingerprint: "plugin-input-settled",
      enabledPluginConfigKeys: ["calendar"],
      recoverablePluginConfigKeys: [],
      build,
    };
    await startOrResumeThread({ ...common, pluginThreadConfig: settledProvider });
    await fixture.endTurn("thread-settled-transition");
    await startOrResumeThread({ ...common, pluginThreadConfig: settledProvider });

    expect(build).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/unsubscribe",
      "thread/read",
      "thread/resume",
      "thread/unsubscribe",
      "thread/start",
      "thread/unsubscribe",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
  });

  it("rotates warm bindings across scheduled authority changes and resumes after store restart", async () => {
    const sessionFile = path.join(tempDir, "session-authority.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-authority");
    const params = createThreadLifecycleParams(sessionFile, workspaceDir);
    const stateStore = createCodexTestBindingStateStore();
    let bindingStore = createCodexAppServerBindingStore(stateStore);
    let threadSequence = 0;
    const threadStarts: Array<Record<string, unknown>> = [];
    const respond = vi.fn(async (method: string, requestParams?: unknown) => {
      if (method === "thread/start") {
        threadSequence += 1;
        threadStarts.push(requestParams as Record<string, unknown>);
        return threadStartResult(`thread-authority-${threadSequence}`);
      }
      if (method === "thread/resume") {
        const threadId = (requestParams as { threadId?: string })?.threadId;
        return threadStartResult(threadId ?? "thread-resumed");
      }
      if (method === "app/installed") {
        return {
          apps: [{ id: "calendar", runtimeName: "Calendar", enabled: true, callable: true }],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const provider = (inputFingerprint: string, destructive: boolean) => {
      const base = createProvisionalPluginThreadConfigProvider("calendar");
      return {
        ...base,
        requiresCurrentPolicyCheck: true,
        inputFingerprint,
        build: vi.fn(async () => {
          const config = await base.build();
          const apps = config.configPatch?.apps as Record<string, Record<string, unknown>>;
          return {
            ...config,
            inputFingerprint,
            fingerprint: `${inputFingerprint}:${destructive}`,
            configPatch: {
              ...config.configPatch,
              apps: {
                ...apps,
                calendar: {
                  ...apps.calendar,
                  destructive_enabled: destructive,
                  tools: {
                    edit: { approval_mode: destructive ? "approve" : "prompt" },
                  },
                },
              },
            },
          };
        }),
      };
    };
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });
    const { client, request } = fixture;
    const common = {
      client,
      signal: new AbortController().signal,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
    };

    await startOrResumeThreadImpl({
      ...common,
      bindingStore,
      pluginThreadConfig: provider("unrestricted", true),
    });
    await fixture.endTurn("thread-authority-1");
    const revokedProvider = provider("unrestricted", true);
    revokedProvider.build.mockRejectedValueOnce(new Error("calendar revoked by current policy"));
    await expect(
      startOrResumeThreadImpl({
        ...common,
        bindingStore,
        pluginThreadConfig: revokedProvider,
      }),
    ).rejects.toThrow("calendar revoked by current policy");
    await startOrResumeThreadImpl({
      ...common,
      bindingStore,
      pluginThreadConfig: provider("scheduled-cap-1", false),
    });
    await fixture.endTurn("thread-authority-2");
    await startOrResumeThreadImpl({
      ...common,
      bindingStore,
      pluginThreadConfig: provider("unrestricted", true),
    });
    await fixture.endTurn("thread-authority-3");
    bindingStore = createCodexAppServerBindingStore(stateStore);
    await startOrResumeThreadImpl({
      ...common,
      bindingStore,
      pluginThreadConfig: provider("unrestricted", true),
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "app/installed",
      "thread/unsubscribe",
      "thread/read",
      "thread/start",
      "app/installed",
      "thread/unsubscribe",
      "thread/start",
      "app/installed",
      "thread/unsubscribe",
      "thread/read",
      "thread/resume",
      "app/installed",
      "thread/inject_items",
    ]);
    expect(threadStarts).toHaveLength(3);
    expect(threadStarts[1]?.config).toMatchObject({
      apps: { calendar: { destructive_enabled: false } },
    });
    expect(threadStarts[2]?.config).toMatchObject({
      apps: { calendar: { destructive_enabled: true } },
    });
    const resumeCall = request.mock.calls.find(([method]) => method === "thread/resume");
    expect((resumeCall?.[1] as { config?: unknown })?.config).toMatchObject({
      apps: {
        calendar: {
          destructive_enabled: true,
          tools: { edit: { approval_mode: "approve" } },
        },
      },
    });
  });
});

describe("Codex thread-effective app attestation", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-plugin-attestation-"));
    resetCodexTestBindingStore();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it.each([
    {
      source: "configured plugin",
      createProvider: createProvisionalPluginThreadConfigProvider,
      fingerprint: "plugin-config-linear-app",
    },
    {
      source: "account-wide policy",
      createProvider: createAttestedAccountAppThreadConfigProvider,
      fingerprint: "account-config-linear-app",
    },
  ])(
    "attests a $source app before committing the binding",
    async ({ createProvider, fingerprint }) => {
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
      const request = vi.fn(async (method: string, requestParams?: unknown) => {
        if (method === "thread/start") {
          return threadStartResult("thread-linear");
        }
        if (method === "app/installed") {
          expect(requestParams).toEqual({ threadId: "thread-linear", forceRefresh: false });
          return {
            apps: [
              {
                id: "linear-app",
                runtimeName: "Linear",
                enabled: true,
                callable: true,
              },
            ],
          };
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const mutate = vi.fn(
        async (...args: Parameters<typeof testCodexAppServerBindingStore.mutate>) =>
          await testCodexAppServerBindingStore.mutate(...args),
      );
      const bindingStore: CodexAppServerBindingStore = {
        ...testCodexAppServerBindingStore,
        mutate,
      };

      await startOrResumeThreadImpl({
        client: { request } as never,
        bindingStore,
        params,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
        pluginThreadConfig: createProvider("linear-app"),
      });

      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "thread/start",
        "app/installed",
      ]);
      expect(request.mock.invocationCallOrder[1]).toBeLessThan(
        mutate.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      await expect(
        testCodexAppServerBindingStore.read(
          sessionBindingIdentity({
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            agentId: params.agentId,
            config: params.config,
          }),
        ),
      ).resolves.toMatchObject({
        threadId: "thread-linear",
        pluginAppsFingerprint: fingerprint,
      });
    },
  );

  it.each([
    {
      state: "missing",
      apps: [],
      failure: "linear-app:missing",
    },
    {
      state: "disabled by managed or workspace policy",
      apps: [{ id: "linear-app", runtimeName: "Linear", enabled: false, callable: false }],
      failure: "linear-app:disabled",
    },
    {
      state: "not callable under thread policy",
      apps: [{ id: "linear-app", runtimeName: "Linear", enabled: true, callable: false }],
      failure: "linear-app:not-callable",
    },
  ])("deletes the unbound persistent thread when its app is $state", async ({ apps, failure }) => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const abandonClient = vi.fn(async () => undefined);
    const request = vi.fn(
      async (method: string, _requestParams?: unknown, _requestOptions?: unknown) => {
        if (method === "thread/start") {
          return threadStartResult("thread-linear-blocked");
        }
        if (method === "app/installed") {
          return { apps };
        }
        if (method === "thread/delete") {
          return {};
        }
        throw new Error(`unexpected method: ${method}`);
      },
    );

    await expect(
      startOrResumeThread({
        client: { request } as never,
        abandonClient,
        params,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
        pluginThreadConfig: createProvisionalPluginThreadConfigProvider("linear-app"),
      }),
    ).rejects.toThrow(failure);

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "app/installed",
      "thread/delete",
    ]);
    expect(request.mock.calls[2]?.[1]).toEqual({ threadId: "thread-linear-blocked" });
    expect(request.mock.calls[2]?.[2]).toEqual({ timeoutMs: 5_000 });
    expect(abandonClient).not.toHaveBeenCalled();
    await expect(
      testCodexAppServerBindingStore.read(
        sessionBindingIdentity({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          config: params.config,
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    {
      source: "globally ready configured plugin",
      createProvider: createProvisionalPluginThreadConfigProvider,
      state: "disabled by thread policy",
      enabled: false,
      callable: false,
      failure: "global-ready-app:disabled",
    },
    {
      source: "globally ready account-wide app",
      createProvider: createAttestedAccountAppThreadConfigProvider,
      state: "disabled by thread policy",
      enabled: false,
      callable: false,
      failure: "global-ready-app:disabled",
    },
    {
      source: "globally ready configured plugin",
      createProvider: createProvisionalPluginThreadConfigProvider,
      state: "not callable under thread policy",
      enabled: true,
      callable: false,
      failure: "global-ready-app:not-callable",
    },
    {
      source: "globally ready account-wide app",
      createProvider: createAttestedAccountAppThreadConfigProvider,
      state: "not callable under thread policy",
      enabled: true,
      callable: false,
      failure: "global-ready-app:not-callable",
    },
  ])(
    "rejects a $source when it is $state in the actual thread",
    async ({ createProvider, enabled, callable, failure }) => {
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
      const abandonClient = vi.fn(async () => undefined);
      const request = vi.fn(async (method: string, requestParams?: unknown) => {
        if (method === "thread/start") {
          return threadStartResult("thread-global-ready");
        }
        if (method === "app/installed") {
          expect(requestParams).toEqual({ threadId: "thread-global-ready", forceRefresh: false });
          return {
            apps: [{ id: "global-ready-app", runtimeName: "Global App", enabled, callable }],
          };
        }
        if (method === "thread/delete") {
          return {};
        }
        throw new Error(`unexpected method: ${method}`);
      });

      await expect(
        startOrResumeThread({
          client: { request } as never,
          abandonClient,
          params,
          cwd: workspaceDir,
          dynamicTools: [],
          appServer: createThreadLifecycleAppServerOptions(),
          pluginThreadConfig: createProvider("global-ready-app"),
        }),
      ).rejects.toThrow(failure);

      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "thread/start",
        "app/installed",
        "thread/delete",
      ]);
      expect(abandonClient).not.toHaveBeenCalled();
      await expect(
        testCodexAppServerBindingStore.read(
          sessionBindingIdentity({
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            agentId: params.agentId,
            config: params.config,
          }),
        ),
      ).resolves.toBeUndefined();
    },
  );

  it("retires the client when a persistent unattested thread cannot be deleted", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const abandonClient = vi.fn(async () => undefined);
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-linear-unsafe");
      }
      if (method === "app/installed") {
        return { apps: [] };
      }
      if (method === "thread/delete") {
        throw new Error("delete unavailable");
      }
      if (method === "thread/unsubscribe") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(
      startOrResumeThread({
        client: { request } as never,
        abandonClient,
        params,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
        pluginThreadConfig: createProvisionalPluginThreadConfigProvider("linear-app"),
      }),
    ).rejects.toThrow("Codex uncommitted thread cleanup failed");

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "app/installed",
      "thread/delete",
      "thread/unsubscribe",
    ]);
    expect(abandonClient).toHaveBeenCalledOnce();
  });

  it("deletes an unbound thread when its app snapshot request fails", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const abandonClient = vi.fn(async () => undefined);
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-linear-snapshot-error");
      }
      if (method === "app/installed") {
        throw new Error("committed app snapshot unavailable");
      }
      if (method === "thread/delete") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(
      startOrResumeThread({
        client: { request } as never,
        abandonClient,
        params,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
        pluginThreadConfig: createProvisionalPluginThreadConfigProvider("linear-app"),
      }),
    ).rejects.toMatchObject({
      name: "CodexPluginThreadAppAttestationError",
      cause: expect.objectContaining({ message: "committed app snapshot unavailable" }),
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "app/installed",
      "thread/delete",
    ]);
    expect(abandonClient).not.toHaveBeenCalled();
  });

  it("unsubscribes an ephemeral thread when its app cannot be attested", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.sessionKey = "agent:main:internal-session-effects:incognito-plugin-attestation";
    const abandonClient = vi.fn(async () => undefined);
    const request = vi.fn(async (method: string, requestParams?: unknown) => {
      if (method === "thread/start") {
        expect(requestParams).toEqual(expect.objectContaining({ ephemeral: true }));
        return threadStartResult("thread-linear-ephemeral");
      }
      if (method === "app/installed") {
        return { apps: [] };
      }
      if (method === "thread/unsubscribe") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(
      startOrResumeThread({
        client: { request } as never,
        abandonClient,
        params,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
        pluginThreadConfig: createProvisionalPluginThreadConfigProvider("linear-app"),
      }),
    ).rejects.toThrow("linear-app:missing");

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "app/installed",
      "thread/unsubscribe",
    ]);
    expect(abandonClient).not.toHaveBeenCalled();
  });

  it("retires the client when an ephemeral unattested thread cannot be unsubscribed", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.sessionKey = "agent:main:internal-session-effects:incognito-plugin-attestation";
    const abandonClient = vi.fn(async () => undefined);
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-linear-ephemeral-unsafe");
      }
      if (method === "app/installed") {
        return { apps: [] };
      }
      if (method === "thread/unsubscribe") {
        throw new Error("unsubscribe unavailable");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(
      startOrResumeThread({
        client: { request } as never,
        abandonClient,
        params,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
        pluginThreadConfig: createProvisionalPluginThreadConfigProvider("linear-app"),
      }),
    ).rejects.toThrow("Codex uncommitted thread cleanup failed");

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "app/installed",
      "thread/unsubscribe",
    ]);
    expect(abandonClient).toHaveBeenCalledOnce();
  });
});

describe("Codex app-server adopted thread lifecycle", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-thread-adoption-"));
    resetCodexTestBindingStore();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("keeps OpenClaw from overriding App Server model selection across resumes", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createThreadLifecycleParams(sessionFile, workspaceDir);
    const { identity, threadId } = await seedAdoptedThreadBinding(params, workspaceDir);
    let resumeCount = 0;
    const respond = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/resume") {
        resumeCount += 1;
        return {
          ...threadStartResult(threadId),
          model: `native-model-${resumeCount}`,
          modelProvider: resumeCount === 1 ? "lmstudio" : "ollama",
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
      persistedThreads: [threadId],
    });
    const { client, request } = fixture;
    const commonParams = {
      client,
      signal: new AbortController().signal,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
    };
    const firstBinding = await startOrResumeThread(commonParams);
    await fixture.endTurn(threadId);
    const secondBinding = await startOrResumeThread(commonParams);

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/resume",
      "thread/inject_items",
      "thread/unsubscribe",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
    expect(request.mock.calls[0]?.[1]).toEqual({ threadId, includeTurns: false });
    expect(request.mock.calls[4]?.[1]).toEqual({ threadId, includeTurns: false });
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("model");
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("modelProvider");
    expect(request.mock.calls[5]?.[1]).not.toHaveProperty("model");
    expect(request.mock.calls[5]?.[1]).not.toHaveProperty("modelProvider");
    expect(firstBinding).toMatchObject({
      model: "native-model-1",
      modelProvider: "lmstudio",
      preserveNativeModel: true,
    });
    expect(secondBinding).toMatchObject({
      model: "native-model-2",
      modelProvider: "ollama",
      preserveNativeModel: true,
    });

    const persisted = await testCodexAppServerBindingStore.read(identity);
    expect(persisted).toMatchObject({
      model: "native-model-2",
      modelProvider: "ollama",
      preserveNativeModel: true,
    });
  });

  it.each([
    { status: "active", canAcceptDirectInput: true, error: "active in another runner" },
    { status: "idle", canAcceptDirectInput: false, error: "controlled by its parent" },
  ])(
    "preserves retained adopted ownership when native preflight rejects: $status",
    async ({ status, canAcceptDirectInput, error }) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createThreadLifecycleParams(sessionFile, workspaceDir);
      const { identity, threadId } = await seedAdoptedThreadBinding(params, workspaceDir);
      const harness = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        respond: (method) => {
          throw new Error(`unexpected method: ${method}`);
        },
      });
      harness.seed(
        {
          ...threadStartResult(threadId),
          thread: {
            ...(threadStartResult(threadId).thread as object),
            status: { type: status },
            canAcceptDirectInput,
          },
        },
        { loaded: true, subscribed: true },
      );
      ensureCodexAppServerClientRuntime(harness.client, { agentDir: workspaceDir });
      await testCodexAppServerBindingStore.mutate(identity, {
        kind: "patch",
        threadId,
        patch: { clientId: harness.client.getInstanceId() },
      });
      const release = vi.fn();
      await retainCodexAppServerLiveThread(harness.client, threadId, release);
      const reserveResumeThread = vi.fn(() => ({ release: vi.fn() }));
      const before = await testCodexAppServerBindingStore.read(identity);
      try {
        await expect(
          startOrResumeThread({
            client: harness.client,
            reserveResumeThread,
            params,
            cwd: workspaceDir,
            dynamicTools: [],
            appServer: createThreadLifecycleAppServerOptions(),
          }),
        ).rejects.toThrow(error);

        expect(harness.request.mock.calls.map(([method]) => method)).toEqual(["thread/read"]);
        expect(release).not.toHaveBeenCalled();
        expect(await testCodexAppServerBindingStore.read(identity)).toEqual(before);
        expect(reserveResumeThread).not.toHaveBeenCalled();
      } finally {
        harness.client.close();
      }
    },
  );
});

describe("Codex app-server supervised branch lifecycle", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-supervision-"));
    resetCodexTestBindingStore();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it.each([
    { incognito: false, fault: "none" },
    { incognito: true, fault: "none" },
    { incognito: false, fault: "unsubscribe rejected" },
    { incognito: false, fault: "unsubscribe timeout" },
    { incognito: false, fault: "abort after fork" },
    { incognito: false, fault: "abort during unsubscribe" },
    { incognito: false, fault: "fork response lost" },
    { incognito: false, fault: "malformed probe response" },
  ])(
    "continues without archiving the model probe (incognito: $incognito, fault: $fault)",
    async ({ incognito, fault }) => {
      const sourceThreadId = "thread-source";
      const probeThreadId = "thread-probe";
      const finalThreadId = "thread-final";
      const workspaceDir = path.join(tempDir, "workspace");
      const attempt = createThreadLifecycleParams(
        path.join(tempDir, "session.jsonl"),
        workspaceDir,
      );
      if (incognito) {
        attempt.sessionKey = "agent:main:internal-session-effects:incognito-probe";
      }
      const identity = await seedPendingSupervisionBinding({
        attempt,
        cwd: workspaceDir,
        pending: { sourceThreadId },
      });
      const source = sourceThread({ threadId: sourceThreadId });
      const before = structuredClone(source);
      const subscriptions = new Set([sourceThreadId]);
      const harness = createClientHarness();
      const controller = new AbortController();
      const abandonClient = vi.fn(async () => {
        harness.client.close();
      });
      const initial = await testCodexAppServerBindingStore.read(identity);
      const write = harness.process.stdin.write.bind(harness.process.stdin);
      vi.spyOn(harness.process.stdin, "write").mockImplementation((...args) => {
        const written = write(...args);
        const request = JSON.parse(String(args[0]));
        let result: unknown;
        if (request.method === "thread/read") {
          result = { thread: source };
        } else if (request.method === "thread/fork" || request.method === "thread/start") {
          const threadId = request.method === "thread/fork" ? probeThreadId : finalThreadId;
          subscriptions.add(threadId);
          result =
            request.method === "thread/fork" && fault === "malformed probe response"
              ? { thread: { id: probeThreadId }, model: 42 }
              : nativeThreadResult(threadId, "gpt-5.6-luna", "openai");
          if (request.method === "thread/fork" && fault === "fork response lost") {
            queueMicrotask(() => controller.abort(new Error(fault)));
            return written;
          }
        } else if (request.method === "thread/unsubscribe") {
          if (fault === "unsubscribe timeout") {
            return written;
          }
          if (fault === "unsubscribe rejected") {
            queueMicrotask(() =>
              harness.send({
                id: request.id,
                error: { code: -32603, message: fault },
              }),
            );
            return written;
          }
          subscriptions.delete(request.params.threadId);
          result = { status: "unsubscribed" };
        } else if (request.method === "thread/archive") {
          // A native catalog scan can outlive the cleanup deadline. Leave this
          // request unanswered so the real client owns cancellation/uncertainty.
          return written;
        } else {
          throw new Error(`unexpected method: ${request.method}`);
        }
        queueMicrotask(() => {
          harness.send({ id: request.id, result });
          if (
            (request.method === "thread/fork" && fault === "abort after fork") ||
            (request.method === "thread/unsubscribe" && fault === "abort during unsubscribe")
          ) {
            controller.abort(new Error(fault));
          }
        });
        return written;
      });
      try {
        const outcome = startOrResumeThread({
          client: harness.client,
          abandonClient,
          signal: controller.signal,
          params: attempt,
          cwd: workspaceDir,
          dynamicTools: [],
          appServer: createThreadLifecycleAppServerOptions(),
        }).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        const settled = await outcome;
        const requests = harness.writes.map((line) => JSON.parse(line));
        expect(source).toEqual(before);
        if (fault !== "none") {
          const unsafe = fault.startsWith("unsubscribe") || fault === "fork response lost";
          expect(settled).toMatchObject({
            error: { name: unsafe ? "CodexAppServerUnsafeSubscriptionError" : "Error" },
          });
          expect(abandonClient).toHaveBeenCalledTimes(unsafe ? 1 : 0);
          expect(requests.map((request) => request.method)).toEqual(
            fault === "fork response lost"
              ? ["thread/read", "thread/fork"]
              : ["thread/read", "thread/fork", "thread/unsubscribe"],
          );
          if (fault === "unsubscribe timeout") {
            expect(settled).toMatchObject({
              error: {
                cause: {
                  code: "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED",
                  reason: "timed out",
                  mayHaveWritten: true,
                },
              },
            });
          }
          expect(await testCodexAppServerBindingStore.read(identity)).toEqual(initial);
          return;
        }
        expect(settled).toMatchObject({ value: { threadId: finalThreadId } });
        expect(requests[1].params).toMatchObject({ ephemeral: true, excludeTurns: true });
        expect(requests.map((request) => request.method)).toEqual([
          "thread/read",
          "thread/fork",
          "thread/unsubscribe",
          "thread/start",
        ]);
        expect(requests[2].params).toEqual({ threadId: probeThreadId });
        expect(requests[3].params.ephemeral === true).toBe(incognito);
        expect([...subscriptions]).toEqual([sourceThreadId, finalThreadId]);
        expect(await testCodexAppServerBindingStore.read(identity)).toMatchObject({
          threadId: finalThreadId,
          model: "gpt-5.6-luna",
          modelProvider: "openai",
        });
      } finally {
        harness.client.close();
      }
    },
  );

  it("materializes a model-locked canonical branch with frozen agent instructions", async () => {
    const sourceThreadId = "thread-source";
    const probeThreadId = "thread-probe";
    const finalThreadId = "thread-final";
    const lastTurnId = "turn-terminal";
    const agentWorkspaceDeveloperInstructions = "Follow the frozen supervised AGENTS guidance.";
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    attempt.agentDir = path.join(tempDir, "agent");
    const rolloutPath = path.join(
      resolveCodexAppServerHomeDir(attempt.agentDir),
      "sessions",
      `rollout-${finalThreadId}.jsonl`,
    );
    attempt.modelId = "outer-global-default";
    const identity = await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: { sourceThreadId, lastTurnId },
    });
    const terminalSource = sourceThread({
      threadId: sourceThreadId,
      turns: [
        {
          id: lastTurnId,
          status: "completed",
          items: [
            {
              id: "user-1",
              type: "userMessage",
              content: [{ type: "text", text: "Visible question" }],
            },
            { id: "reasoning-1", type: "reasoning", text: "Private reasoning" },
            {
              id: "assistant-1",
              type: "agentMessage",
              text: "Visible answer",
              phase: "final_answer",
            },
            { id: "tool-1", type: "commandExecution", command: "secret-tool" },
          ],
        },
      ],
    });
    const request = vi.fn(async (method: string, requestParams: unknown) => {
      if (method === "thread/read") {
        const threadId = (requestParams as { threadId?: string }).threadId;
        return {
          thread:
            threadId === sourceThreadId
              ? terminalSource
              : {
                  ...sourceThread({ threadId: finalThreadId, status: "notLoaded" }),
                  path: rolloutPath,
                },
        };
      }
      if (method === "thread/fork") {
        return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/start" || method === "thread/resume") {
        return nativeThreadResult(finalThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/inject_items" || method === "thread/unsubscribe") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const dynamicTools = [
      {
        type: "function" as const,
        name: "message",
        description: "Send a message",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    const commonParams = {
      client: { request } as never,
      params: attempt,
      cwd: workspaceDir,
      dynamicTools,
      developerInstructions: agentWorkspaceDeveloperInstructions,
      agentWorkspaceDeveloperInstructions,
      environmentSelection: [{ environmentId: "local", cwd: workspaceDir }],
      shellEnvironment: { GH_TOKEN: "", GITHUB_TOKEN: "" },
      disableLoginShell: true,
      appServer: createThreadLifecycleAppServerOptions(),
      appServerRuntimeFingerprint: "codex-runtime-v1",
    };

    const materialized = await startOrResumeThread(commonParams);

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/fork",
      "thread/unsubscribe",
      "thread/start",
      "thread/inject_items",
    ]);
    expect(request.mock.calls[0]?.[1]).toEqual({
      threadId: sourceThreadId,
      includeTurns: true,
    });
    const forkParams = request.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(forkParams).toMatchObject({
      threadId: sourceThreadId,
      lastTurnId,
      excludeTurns: true,
      developerInstructions: agentWorkspaceDeveloperInstructions,
      config: {
        project_doc_max_bytes: 131_072,
        allow_login_shell: false,
        shell_environment_policy: {
          experimental_use_profile: false,
          set: { GH_TOKEN: "", GITHUB_TOKEN: "" },
        },
      },
    });
    expect(forkParams).not.toHaveProperty("model");
    expect(forkParams).not.toHaveProperty("modelProvider");
    expect(forkParams).not.toHaveProperty("dynamicTools");
    expect(forkParams).not.toHaveProperty("environments");
    const startParams = request.mock.calls.find(
      ([method]) => method === "thread/start",
    )?.[1] as Record<string, unknown>;
    expect(startParams).toMatchObject({
      model: "native-effective",
      modelProvider: "native-provider",
      developerInstructions: agentWorkspaceDeveloperInstructions,
      dynamicTools,
      environments: [{ environmentId: "local", cwd: workspaceDir }],
      config: {
        project_doc_max_bytes: 131_072,
        allow_login_shell: false,
        shell_environment_policy: {
          experimental_use_profile: false,
          set: { GH_TOKEN: "", GITHUB_TOKEN: "" },
        },
      },
    });
    expect(startParams.model).not.toBe(attempt.modelId);
    expect(request.mock.calls.find(([method]) => method === "thread/inject_items")?.[1]).toEqual({
      threadId: finalThreadId,
      items: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Visible question" }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Visible answer" }],
          phase: "final_answer",
        },
      ],
    });
    expect(
      JSON.stringify(request.mock.calls.find(([method]) => method === "thread/inject_items")?.[1]),
    ).not.toContain("Private reasoning");
    expect(
      JSON.stringify(request.mock.calls.find(([method]) => method === "thread/inject_items")?.[1]),
    ).not.toContain("secret-tool");
    expect(request.mock.calls[2]?.[1]).toEqual({ threadId: probeThreadId });
    expect(materialized).toMatchObject({
      threadId: finalThreadId,
      model: "native-effective",
      modelProvider: "native-provider",
      preserveNativeModel: true,
      agentWorkspaceDeveloperInstructions,
      conversationSourceTransferComplete: true,
      lifecycle: { action: "forked" },
    });
    expect(materialized.pendingSupervisionBranch).toBeUndefined();
    expect(materialized.historyCoveredThrough).not.toBe(new Date(0).toISOString());
    await expect(testCodexAppServerBindingStore.read(identity)).resolves.toMatchObject({
      threadId: finalThreadId,
      model: "native-effective",
      modelProvider: "native-provider",
      preserveNativeModel: true,
      agentWorkspaceDeveloperInstructions,
      conversationSourceTransferComplete: true,
      appServerRuntimeFingerprint: buildCodexAppServerConnectionFingerprint(
        commonParams.appServer,
        attempt.agentDir,
      ),
    });

    await writeNativeCatalogFixture(rolloutPath, finalThreadId, startParams.dynamicTools);
    request.mockClear();
    const resumed = await withLeasedCodexTestClient({
      agentDir: path.join(tempDir, "agent"),
      request,
      run: (client) =>
        startOrResumeThread({
          ...commonParams,
          client,
          signal: AbortSignal.timeout(10_000),
          appServerRuntimeFingerprint: "codex-runtime-v2",
        }),
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
    expect(request.mock.calls[0]?.[1]).toEqual({ threadId: finalThreadId, includeTurns: false });
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("model");
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("modelProvider");
    expect(request.mock.calls[2]?.[1]).toMatchObject({
      developerInstructions: agentWorkspaceDeveloperInstructions,
    });
    expect(resumed).toMatchObject({
      threadId: finalThreadId,
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
      lifecycle: { action: "resumed" },
    });
    await expect(testCodexAppServerBindingStore.read(identity)).resolves.toMatchObject({
      appServerRuntimeFingerprint: buildCodexAppServerConnectionFingerprint(
        commonParams.appServer,
        attempt.agentDir,
      ),
    });
  });

  it("isolates both supervised threads and restores native MCP config on the next unrestricted turn", async () => {
    const sourceThreadId = "thread-source";
    const probeThreadId = "thread-probe";
    const finalThreadId = "thread-final";
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    attempt.agentDir = path.join(tempDir, "agent");
    const rolloutPath = path.join(
      resolveCodexAppServerHomeDir(attempt.agentDir),
      "sessions",
      `rollout-${finalThreadId}.jsonl`,
    );
    attempt.pluginHarnessToolPolicyRestricted = true;
    attempt.toolsAllow = ["openclaw"];
    const identity = await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: { sourceThreadId },
    });
    const request = vi.fn(async (method: string, requestParams?: unknown) => {
      if (method === "config/read") {
        return {
          config: { mcp_servers: { inherited: { command: "inherited-mcp" } } },
          layers: [{ name: { type: "user" } }],
        };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "thread/read") {
        const threadId = (requestParams as { threadId?: string }).threadId;
        return {
          thread:
            threadId === sourceThreadId
              ? sourceThread({ threadId: sourceThreadId })
              : {
                  ...sourceThread({ threadId: finalThreadId, status: "notLoaded" }),
                  path: rolloutPath,
                },
        };
      }
      if (method === "thread/fork") {
        return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/start" || method === "thread/resume") {
        return nativeThreadResult(finalThreadId, "native-effective", "native-provider");
      }
      if (method === "mcpServerStatus/list") {
        return {
          data: [disabledMcpServerStatus("inherited"), disabledMcpServerStatus("request-only")],
          nextCursor: null,
        };
      }
      if (
        method === "thread/archive" ||
        method === "thread/unsubscribe" ||
        method === "thread/inject_items"
      ) {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const common = {
      client: { request } as never,
      params: attempt,
      cwd: workspaceDir,
      dynamicTools: [],
      config: { mcp_servers: { "request-only": { command: "request-mcp" } } },
      appServer: createThreadLifecycleAppServerOptions(),
      nativeCodeModeEnabled: false,
      userMcpServersEnabled: false,
      hostSystemAgentActive: true,
    };

    await expect(startOrResumeThread(common)).resolves.toMatchObject({
      threadId: finalThreadId,
      lifecycle: { action: "forked" },
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/read",
      "thread/fork",
      "mcpServerStatus/list",
      "thread/unsubscribe",
      "thread/start",
      "mcpServerStatus/list",
    ]);
    for (const method of ["thread/fork", "thread/start"]) {
      const threadRequest = request.mock.calls.find(([candidate]) => candidate === method)?.[1] as
        | { config?: Record<string, unknown> }
        | undefined;
      expect(threadRequest?.config).toMatchObject({
        project_doc_max_bytes: 0,
        mcp_servers: {
          inherited: { enabled: false },
          "request-only": { command: "request-mcp", enabled: false },
        },
      });
    }
    expect(request.mock.calls.find(([method]) => method === "thread/start")?.[1]).toMatchObject({
      baseInstructions: "",
    });
    expect(
      request.mock.calls
        .filter(([method]) => method === "mcpServerStatus/list")
        .map(([, requestParams]) => requestParams),
    ).toEqual([
      { threadId: probeThreadId, detail: "toolsAndAuthOnly" },
      { threadId: finalThreadId, detail: "toolsAndAuthOnly" },
    ]);

    attempt.pluginHarnessToolPolicyRestricted = false;
    attempt.toolsAllow = undefined;
    await writeNativeCatalogFixture(rolloutPath, finalThreadId, common.dynamicTools);
    request.mockClear();
    await expect(
      withLeasedCodexTestClient({
        agentDir: path.join(tempDir, "agent"),
        request,
        run: (client) =>
          startOrResumeThread({
            ...common,
            client,
            signal: AbortSignal.timeout(10_000),
            hostSystemAgentActive: false,
            nativeCodeModeEnabled: true,
          }),
      }),
    ).resolves.toMatchObject({
      threadId: finalThreadId,
      lifecycle: { action: "resumed" },
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
    const resumeParams = request.mock.calls[2]?.[1] as { config?: Record<string, unknown> };
    expect(resumeParams.config).toMatchObject({
      mcp_servers: { "request-only": { command: "request-mcp" } },
    });
    expect(resumeParams.config).not.toHaveProperty("mcp_servers.inherited");
    const restoredBinding = await testCodexAppServerBindingStore.read(identity);
    expect(restoredBinding?.pendingSupervisionBranch).toBeUndefined();
    expect(restoredBinding).not.toHaveProperty("restrictedToolSurface");
  });

  it.each(["probe", "final"] as const)(
    "cleans tracked threads and preserves the pending binding when the %s MCP attestation fails",
    async (failedThread) => {
      const sourceThreadId = "thread-source";
      const probeThreadId = "thread-probe";
      const finalThreadId = "thread-final";
      const workspaceDir = path.join(tempDir, "workspace");
      const attempt = createThreadLifecycleParams(
        path.join(tempDir, "session.jsonl"),
        workspaceDir,
      );
      attempt.pluginHarnessToolPolicyRestricted = true;
      const identity = await seedPendingSupervisionBinding({
        attempt,
        cwd: workspaceDir,
        pending: { sourceThreadId },
      });
      let attestationCount = 0;
      const request = vi.fn(async (method: string, _requestParams?: unknown) => {
        if (method === "config/read") {
          return {
            config: { mcp_servers: { inherited: { command: "inherited-mcp" } } },
            layers: [{ name: { type: "user" } }],
          };
        }
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        if (method === "thread/read") {
          return { thread: sourceThread({ threadId: sourceThreadId }) };
        }
        if (method === "thread/fork") {
          return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
        }
        if (method === "thread/start") {
          return nativeThreadResult(finalThreadId, "native-effective", "native-provider");
        }
        if (method === "mcpServerStatus/list") {
          attestationCount += 1;
          const shouldFail = failedThread === "probe" || attestationCount === 2;
          return {
            data: shouldFail
              ? [{ name: "unexpected", serverInfo: null, tools: {} }]
              : [disabledMcpServerStatus("inherited")],
            nextCursor: null,
          };
        }
        if (method === "thread/archive" || method === "thread/unsubscribe") {
          return {};
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const abandonClient = vi.fn(async () => undefined);

      await expect(
        startOrResumeThread({
          client: { request } as never,
          abandonClient,
          params: attempt,
          cwd: workspaceDir,
          dynamicTools: [],
          appServer: createThreadLifecycleAppServerOptions(),
          nativeCodeModeEnabled: false,
          userMcpServersEnabled: false,
        }),
      ).rejects.toThrow("found unexpected server unexpected");

      const methods = request.mock.calls.map(([method]) => method);
      expect(methods).not.toContain("thread/inject_items");
      expect(methods.filter((method) => method === "thread/start")).toHaveLength(
        failedThread === "probe" ? 0 : 1,
      );
      expect(
        request.mock.calls
          .filter(([method]) => method === "thread/archive")
          .map(([, requestParams]) => requestParams),
      ).toEqual(
        (failedThread === "probe" ? [] : [finalThreadId]).map((threadId) => ({ threadId })),
      );
      expect(abandonClient).not.toHaveBeenCalled();
      await expect(testCodexAppServerBindingStore.read(identity)).resolves.toMatchObject({
        threadId: sourceThreadId,
        pendingSupervisionBranch: { sourceThreadId },
      });
    },
  );

  it.each([
    {
      source: "configured plugin",
      createProvider: createProvisionalPluginThreadConfigProvider,
      fingerprint: "plugin-config-linear-app",
    },
    {
      source: "account-wide policy",
      createProvider: createAttestedAccountAppThreadConfigProvider,
      fingerprint: "account-config-linear-app",
    },
  ])(
    "attests a supervised $source app before committing the canonical branch",
    async ({ createProvider, fingerprint }) => {
      const sourceThreadId = "thread-source";
      const probeThreadId = "thread-probe";
      const finalThreadId = "thread-final";
      const lastTurnId = "turn-terminal";
      const workspaceDir = path.join(tempDir, "workspace");
      const attempt = createThreadLifecycleParams(
        path.join(tempDir, "session.jsonl"),
        workspaceDir,
      );
      const identity = await seedPendingSupervisionBinding({
        attempt,
        cwd: workspaceDir,
        pending: { sourceThreadId, lastTurnId },
      });
      const request = vi.fn(async (method: string, requestParams?: unknown) => {
        if (method === "thread/read") {
          return {
            thread: sourceThread({
              threadId: sourceThreadId,
              turns: [
                {
                  id: lastTurnId,
                  status: "completed",
                  items: [
                    {
                      id: "user-1",
                      type: "userMessage",
                      content: [{ type: "text", text: "Visible question" }],
                    },
                  ],
                },
              ],
            }),
          };
        }
        if (method === "thread/fork") {
          return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
        }
        if (method === "thread/start") {
          return nativeThreadResult(finalThreadId, "native-effective", "native-provider");
        }
        if (method === "app/installed") {
          expect(requestParams).toEqual({ threadId: finalThreadId, forceRefresh: false });
          return {
            apps: [
              {
                id: "linear-app",
                runtimeName: "Linear",
                enabled: true,
                callable: true,
              },
            ],
          };
        }
        if (method === "thread/inject_items" || method === "thread/unsubscribe") {
          return {};
        }
        throw new Error(`unexpected method: ${method}`);
      });

      await expect(
        startOrResumeThread({
          client: { request } as never,
          params: attempt,
          cwd: workspaceDir,
          dynamicTools: [],
          appServer: createThreadLifecycleAppServerOptions(),
          pluginThreadConfig: createProvider("linear-app"),
        }),
      ).resolves.toMatchObject({ threadId: finalThreadId, lifecycle: { action: "forked" } });

      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "thread/read",
        "thread/fork",
        "thread/unsubscribe",
        "thread/start",
        "app/installed",
        "thread/inject_items",
      ]);
      await expect(testCodexAppServerBindingStore.read(identity)).resolves.toMatchObject({
        threadId: finalThreadId,
        pluginAppsFingerprint: fingerprint,
      });
      expect(
        (await testCodexAppServerBindingStore.read(identity))?.pendingSupervisionBranch,
      ).toBeUndefined();
    },
  );

  it.each([
    {
      source: "configured plugin",
      createProvider: createProvisionalPluginThreadConfigProvider,
      state: "missing from the effective thread",
      apps: [],
      failure: "linear-app:missing",
    },
    {
      source: "account-wide policy",
      createProvider: createAttestedAccountAppThreadConfigProvider,
      state: "missing from the effective thread",
      apps: [],
      failure: "linear-app:missing",
    },
    {
      source: "configured plugin",
      createProvider: createProvisionalPluginThreadConfigProvider,
      state: "disabled by managed or workspace policy",
      apps: [{ id: "linear-app", runtimeName: "Linear", enabled: false, callable: false }],
      failure: "linear-app:disabled",
    },
    {
      source: "account-wide policy",
      createProvider: createAttestedAccountAppThreadConfigProvider,
      state: "disabled by managed or workspace policy",
      apps: [{ id: "linear-app", runtimeName: "Linear", enabled: false, callable: false }],
      failure: "linear-app:disabled",
    },
    {
      source: "configured plugin",
      createProvider: createProvisionalPluginThreadConfigProvider,
      state: "not callable under thread policy",
      apps: [{ id: "linear-app", runtimeName: "Linear", enabled: true, callable: false }],
      failure: "linear-app:not-callable",
    },
    {
      source: "account-wide policy",
      createProvider: createAttestedAccountAppThreadConfigProvider,
      state: "not callable under thread policy",
      apps: [{ id: "linear-app", runtimeName: "Linear", enabled: true, callable: false }],
      failure: "linear-app:not-callable",
    },
  ])(
    "cleans both supervised branches when a $source app is $state",
    async ({ createProvider, apps, failure }) => {
      const sourceThreadId = "thread-source";
      const probeThreadId = "thread-probe";
      const finalThreadId = "thread-final";
      const workspaceDir = path.join(tempDir, "workspace");
      const attempt = createThreadLifecycleParams(
        path.join(tempDir, "session.jsonl"),
        workspaceDir,
      );
      const identity = await seedPendingSupervisionBinding({
        attempt,
        cwd: workspaceDir,
        pending: { sourceThreadId },
      });
      const abandonClient = vi.fn(async () => undefined);
      const request = vi.fn(async (method: string, requestParams?: unknown) => {
        if (method === "thread/read") {
          return { thread: sourceThread({ threadId: sourceThreadId }) };
        }
        if (method === "thread/fork") {
          return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
        }
        if (method === "thread/start") {
          return nativeThreadResult(finalThreadId, "native-effective", "native-provider");
        }
        if (method === "app/installed") {
          expect(requestParams).toEqual({ threadId: finalThreadId, forceRefresh: false });
          return { apps };
        }
        if (method === "thread/delete" || method === "thread/unsubscribe") {
          return {};
        }
        throw new Error(`unexpected method: ${method}`);
      });

      await expect(
        startOrResumeThread({
          client: { request } as never,
          abandonClient,
          params: attempt,
          cwd: workspaceDir,
          dynamicTools: [],
          appServer: createThreadLifecycleAppServerOptions(),
          pluginThreadConfig: createProvider("linear-app"),
        }),
      ).rejects.toThrow(failure);

      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "thread/read",
        "thread/fork",
        "thread/unsubscribe",
        "thread/start",
        "app/installed",
        "thread/delete",
      ]);
      expect(request.mock.calls[2]?.[1]).toEqual({ threadId: probeThreadId });
      expect(request.mock.calls[5]?.[1]).toEqual({ threadId: finalThreadId });
      expect(abandonClient).not.toHaveBeenCalled();
      await expect(testCodexAppServerBindingStore.read(identity)).resolves.toMatchObject({
        pendingSupervisionBranch: { sourceThreadId },
      });
      expect(
        (await testCodexAppServerBindingStore.read(identity))?.pendingSupervisionBranch
          ?.cleanupThreadIds ?? [],
      ).toEqual([]);
    },
  );

  it("retires a supervised client when its unattested canonical branch cannot be deleted", async () => {
    const sourceThreadId = "thread-source";
    const probeThreadId = "thread-probe";
    const finalThreadId = "thread-final";
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const identity = await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: { sourceThreadId },
    });
    const abandonClient = vi.fn(async () => undefined);
    const request = vi.fn(async (method: string) => {
      if (method === "thread/read") {
        return { thread: sourceThread({ threadId: sourceThreadId }) };
      }
      if (method === "thread/fork") {
        return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/start") {
        return nativeThreadResult(finalThreadId, "native-effective", "native-provider");
      }
      if (method === "app/installed") {
        return { apps: [] };
      }
      if (method === "thread/delete") {
        throw new Error("delete unavailable");
      }
      if (method === "thread/unsubscribe") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(
      startOrResumeThread({
        client: { request } as never,
        abandonClient,
        params: attempt,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
        pluginThreadConfig: createProvisionalPluginThreadConfigProvider("linear-app"),
      }),
    ).rejects.toThrow("Codex supervised plugin app attestation cleanup failed");

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/fork",
      "thread/unsubscribe",
      "thread/start",
      "app/installed",
      "thread/delete",
      "thread/unsubscribe",
    ]);
    expect(abandonClient).toHaveBeenCalledOnce();
    await expect(testCodexAppServerBindingStore.read(identity)).resolves.toMatchObject({
      pendingSupervisionBranch: {
        sourceThreadId,
        cleanupThreadIds: [finalThreadId],
      },
    });
  });

  it("rejects materialization after the supervised source connection changes", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: { sourceThreadId: "thread-source" },
    });
    const request = vi.fn();
    const appServer = createThreadLifecycleAppServerOptions();
    appServer.start.command = "different-codex";

    await expect(
      startOrResumeThread({
        client: { request } as never,
        params: attempt,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer,
      }),
    ).rejects.toThrow("source connection changed before branch materialization");
    expect(request).not.toHaveBeenCalled();
  });

  it("recovers every persisted orphan before materializing a fresh canonical branch", async () => {
    const sourceThreadId = "thread-source";
    const orphanProbeThreadId = "thread-orphan-probe";
    const orphanFinalThreadId = "thread-orphan-final";
    const probeThreadId = "thread-probe";
    const finalThreadId = "thread-final";
    const lastTurnId = "turn-terminal";
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const identity = await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: {
        sourceThreadId,
        lastTurnId,
        cleanupThreadIds: [orphanProbeThreadId, orphanFinalThreadId],
      },
    });
    const connectionFingerprint = buildCodexAppServerConnectionFingerprint(
      createThreadLifecycleAppServerOptions(),
    );
    const mutations: Parameters<CodexAppServerBindingStore["mutate"]>[1][] = [];
    const bindingStore: CodexAppServerBindingStore = {
      ...testCodexAppServerBindingStore,
      mutate: async (storeIdentity, mutation) => {
        mutations.push(mutation);
        return await testCodexAppServerBindingStore.mutate(storeIdentity, mutation);
      },
    };
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/archive" || method === "thread/unsubscribe") {
        return {};
      }
      if (method === "thread/read") {
        return {
          thread: sourceThread({
            threadId: sourceThreadId,
            turns: [{ id: lastTurnId, status: "completed", items: [] }],
          }),
        };
      }
      if (method === "thread/fork") {
        return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/start") {
        return nativeThreadResult(finalThreadId, "native-effective", "native-provider");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(
      startOrResumeThreadImpl({
        client: { request } as never,
        bindingStore,
        params: attempt,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
      }),
    ).resolves.toMatchObject({
      threadId: finalThreadId,
      lifecycle: { action: "forked" },
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/archive",
      "thread/archive",
      "thread/read",
      "thread/fork",
      "thread/unsubscribe",
      "thread/start",
    ]);
    expect(request.mock.calls.map(([, requestParams]) => requestParams)).toEqual([
      { threadId: orphanProbeThreadId },
      { threadId: orphanFinalThreadId },
      { threadId: sourceThreadId, includeTurns: true },
      expect.any(Object),
      { threadId: probeThreadId },
      expect.any(Object),
    ]);
    expect(mutations[0]).toEqual({
      kind: "patch-pending-supervision-branch",
      expected: {
        sourceThreadId,
        connectionFingerprint,
        lastTurnId,
        cleanupThreadIds: [orphanProbeThreadId, orphanFinalThreadId],
      },
      pending: { sourceThreadId, connectionFingerprint, lastTurnId },
    });
    const persisted = await testCodexAppServerBindingStore.read(identity);
    expect(persisted).toMatchObject({ threadId: finalThreadId });
    expect(persisted?.pendingSupervisionBranch).toBeUndefined();
  });

  it("persists exact remaining orphan cleanup and performs no branch work after partial failure", async () => {
    const sourceThreadId = "thread-source";
    const orphanProbeThreadId = "thread-orphan-probe";
    const orphanFinalThreadId = "thread-orphan-final";
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const identity = await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: {
        sourceThreadId,
        cleanupThreadIds: [orphanProbeThreadId, orphanFinalThreadId],
      },
    });
    const request = vi.fn(async (method: string, requestParams?: unknown) => {
      const threadId = (requestParams as { threadId?: string } | undefined)?.threadId;
      if (method === "thread/archive" && threadId === orphanProbeThreadId) {
        return {};
      }
      if (method === "thread/archive" && threadId === orphanFinalThreadId) {
        throw new CodexAppServerRpcError(
          { code: -32_000, message: "temporary archive failure" },
          method,
        );
      }
      if (method === "thread/unsubscribe") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(
      startOrResumeThread({
        client: { request } as never,
        params: attempt,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
      }),
    ).rejects.toThrow(`cleanup must finish before retry: ${orphanFinalThreadId}`);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/archive",
      "thread/archive",
      "thread/unsubscribe",
    ]);
    expect(request.mock.calls.some(([method]) => method === "thread/fork")).toBe(false);
    expect(request.mock.calls.some(([method]) => method === "thread/start")).toBe(false);
    await expect(testCodexAppServerBindingStore.read(identity)).resolves.toMatchObject({
      threadId: sourceThreadId,
      pendingSupervisionBranch: {
        sourceThreadId,
        cleanupThreadIds: [orphanFinalThreadId],
      },
    });
  });

  it("fails closed when persisted orphan cleanup loses its state CAS", async () => {
    const sourceThreadId = "thread-source";
    const orphanProbeThreadId = "thread-orphan-probe";
    const orphanFinalThreadId = "thread-orphan-final";
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const identity = await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: {
        sourceThreadId,
        cleanupThreadIds: [orphanProbeThreadId, orphanFinalThreadId],
      },
    });
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/archive") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const bindingStore: CodexAppServerBindingStore = {
      ...testCodexAppServerBindingStore,
      mutate: vi.fn(async (storeIdentity, mutation) => {
        if (
          mutation.kind === "patch-pending-supervision-branch" &&
          mutation.expected.cleanupThreadIds?.length === 2 &&
          !mutation.pending.cleanupThreadIds
        ) {
          return false;
        }
        return await testCodexAppServerBindingStore.mutate(storeIdentity, mutation);
      }),
    };

    await expect(
      startOrResumeThreadImpl({
        client: { request } as never,
        bindingStore,
        params: attempt,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
      }),
    ).rejects.toThrow("recovering a supervised Codex branch");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/archive",
      "thread/archive",
    ]);
    expect(request.mock.calls.some(([method]) => method === "thread/fork")).toBe(false);
    expect(request.mock.calls.some(([method]) => method === "thread/start")).toBe(false);
    await expect(testCodexAppServerBindingStore.read(identity)).resolves.toMatchObject({
      threadId: sourceThreadId,
      pendingSupervisionBranch: {
        sourceThreadId,
        cleanupThreadIds: [orphanProbeThreadId, orphanFinalThreadId],
      },
    });
  });

  it.each([
    {
      name: "active source",
      thread: sourceThread({ threadId: "thread-source", status: "active" }),
    },
    {
      name: "source with uncaptured turns",
      thread: sourceThread({
        threadId: "thread-source",
        turns: [{ id: "turn-late", status: "completed", items: [] }],
      }),
    },
  ])("fails closed for a zero-turn snapshot when the $name changed", async ({ thread }) => {
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: { sourceThreadId: "thread-source" },
    });
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/read") {
        return { thread };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(
      startOrResumeThread({
        client: { request } as never,
        params: attempt,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
      }),
    ).rejects.toThrow("source changed after Continue");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/read"]);
  });

  it("keeps a structured fork rejection retryable without touching the source", async () => {
    const sourceThreadId = "thread-source";
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const identity = await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: { sourceThreadId },
    });
    let forkAttempts = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/read") {
        return { thread: sourceThread({ threadId: sourceThreadId }) };
      }
      if (method === "thread/fork") {
        forkAttempts += 1;
        if (forkAttempts === 1) {
          throw new CodexAppServerRpcError(
            { code: -32_000, message: "temporary fork rejected" },
            method,
          );
        }
        return nativeThreadResult("thread-probe", "native-effective", "native-provider");
      }
      if (method === "thread/start") {
        return nativeThreadResult("thread-final", "native-effective", "native-provider");
      }
      if (method === "thread/archive" || method === "thread/unsubscribe") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const commonParams = {
      client: { request } as never,
      params: attempt,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
    };

    await expect(startOrResumeThread(commonParams)).rejects.toThrow("temporary fork rejected");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/read", "thread/fork"]);
    await expect(testCodexAppServerBindingStore.read(identity)).resolves.toMatchObject({
      threadId: sourceThreadId,
      pendingSupervisionBranch: { sourceThreadId },
    });

    request.mockClear();
    await expect(startOrResumeThread(commonParams)).resolves.toMatchObject({
      threadId: "thread-final",
      lifecycle: { action: "forked" },
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/fork",
      "thread/unsubscribe",
      "thread/start",
    ]);
  });

  it("tracks the canonical thread before observing abort and archives it", async () => {
    const sourceThreadId = "thread-source";
    const probeThreadId = "thread-probe";
    const finalThreadId = "thread-final";
    const lastTurnId = "turn-terminal";
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const identity = await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: { sourceThreadId, lastTurnId },
    });
    const abortController = new AbortController();
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/read") {
        return {
          thread: sourceThread({
            threadId: sourceThreadId,
            turns: [{ id: lastTurnId, status: "completed", items: [] }],
          }),
        };
      }
      if (method === "thread/fork") {
        return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/start") {
        abortController.abort("cancelled after canonical start");
        return nativeThreadResult(finalThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/archive" || method === "thread/unsubscribe") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(
      startOrResumeThread({
        client: { request } as never,
        params: attempt,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
        signal: abortController.signal,
      }),
    ).rejects.toThrow("cancelled after canonical start");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/fork",
      "thread/unsubscribe",
      "thread/start",
      "thread/archive",
    ]);
    expect(request.mock.calls[2]?.[1]).toEqual({ threadId: probeThreadId });
    expect(request.mock.calls[4]?.[1]).toEqual({ threadId: finalThreadId });
    const persisted = await testCodexAppServerBindingStore.read(identity);
    expect(persisted).toMatchObject({
      threadId: sourceThreadId,
      pendingSupervisionBranch: { sourceThreadId, lastTurnId },
    });
    expect(persisted?.pendingSupervisionBranch?.cleanupThreadIds).toBeUndefined();
  });

  it("archives the canonical thread when cleanup tracking loses its CAS", async () => {
    const sourceThreadId = "thread-source";
    const probeThreadId = "thread-probe";
    const finalThreadId = "thread-final";
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const identity = await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: { sourceThreadId },
    });
    const request = vi.fn(async (method: string, requestParams?: unknown) => {
      if (method === "thread/read") {
        return { thread: sourceThread({ threadId: sourceThreadId }) };
      }
      if (method === "thread/fork") {
        return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/start") {
        return nativeThreadResult(finalThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/archive" || method === "thread/unsubscribe") {
        return {};
      }
      throw new Error(`unexpected method: ${method} ${JSON.stringify(requestParams)}`);
    });
    const bindingStore: CodexAppServerBindingStore = {
      ...testCodexAppServerBindingStore,
      mutate: vi.fn(async (storeIdentity, mutation) => {
        if (
          mutation.kind === "patch-pending-supervision-branch" &&
          mutation.pending.cleanupThreadIds?.join(",") === finalThreadId
        ) {
          return false;
        }
        return await testCodexAppServerBindingStore.mutate(storeIdentity, mutation);
      }),
    };
    const abandonClient = vi.fn(async () => undefined);

    await expect(
      startOrResumeThreadImpl({
        client: { request } as never,
        abandonClient,
        bindingStore,
        params: attempt,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
      }),
    ).rejects.toThrow("tracking supervised Codex branch cleanup");
    const archivedThreadIds = request.mock.calls
      .filter(([method]) => method === "thread/archive")
      .map(([, requestParams]) => (requestParams as { threadId: string }).threadId);
    expect(archivedThreadIds).toEqual([finalThreadId]);
    expect(abandonClient).not.toHaveBeenCalled();
    const persisted = await testCodexAppServerBindingStore.read(identity);
    expect(persisted).toMatchObject({
      threadId: sourceThreadId,
      pendingSupervisionBranch: {
        sourceThreadId,
      },
    });
  });

  it.each(
    ["before write", "after write"].flatMap((failure) =>
      ["confirmed", "rejected", "acknowledgement lost"].map((archive) => ({
        failure,
        archive,
      })),
    ),
  )(
    "cleans canonical tracking failure $failure (archive: $archive) before retry",
    async ({ failure, archive }) => {
      const archiveFails = archive !== "confirmed";
      const sourceThreadId = "thread-source";
      const probeThreadId = "thread-probe";
      const finalThreadId = "thread-final";
      const workspaceDir = path.join(tempDir, "workspace");
      const attempt = createThreadLifecycleParams(
        path.join(tempDir, "session.jsonl"),
        workspaceDir,
      );
      const identity = await seedPendingSupervisionBinding({
        attempt,
        cwd: workspaceDir,
        pending: { sourceThreadId },
      });
      const initial = await testCodexAppServerBindingStore.read(identity);
      const storageError = new Error("tracking storage failure");
      let failed = false;
      let retry = false;
      const unarchivedId = finalThreadId;
      const nativeThreads = new Set([sourceThreadId]);
      const request = vi.fn(async (method: string, requestParams?: unknown) => {
        if (method === "thread/read") {
          return { thread: sourceThread({ threadId: sourceThreadId }) };
        }
        if (method === "thread/fork" || method === "thread/start") {
          const threadId = `${method === "thread/fork" ? probeThreadId : finalThreadId}${retry ? "-retry" : ""}`;
          nativeThreads.add(threadId);
          return nativeThreadResult(threadId, "native-effective", "native-provider");
        }
        if (method === "thread/archive") {
          const threadId = (requestParams as { threadId: string }).threadId;
          if (!retry && threadId === unarchivedId && archive === "rejected") {
            throw new Error("archive rejected");
          }
          nativeThreads.delete(threadId);
          if (!retry && threadId === unarchivedId && archive === "acknowledgement lost") {
            throw new Error("archive acknowledgement lost");
          }
          return {};
        }
        if (method === "thread/unsubscribe") {
          const threadId = (requestParams as { threadId: string }).threadId;
          if (threadId === `${probeThreadId}${retry ? "-retry" : ""}`) {
            nativeThreads.delete(threadId);
          }
          return {};
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const targetIds = [finalThreadId];
      const bindingStore: CodexAppServerBindingStore = {
        ...testCodexAppServerBindingStore,
        mutate: async (storeIdentity, mutation) => {
          if (
            !failed &&
            mutation.kind === "patch-pending-supervision-branch" &&
            mutation.pending.cleanupThreadIds?.join(",") === targetIds.join(",")
          ) {
            failed = true;
            if (failure === "after write") {
              await testCodexAppServerBindingStore.mutate(storeIdentity, mutation);
            }
            throw storageError;
          }
          return await testCodexAppServerBindingStore.mutate(storeIdentity, mutation);
        },
      };
      const abandonClient = vi.fn(async () => undefined);
      const common = {
        client: { request } as never,
        abandonClient,
        bindingStore,
        params: attempt,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
      };
      const error = await startOrResumeThreadImpl(common).catch(
        (caughtError: unknown) => caughtError,
      );
      expect(failed).toBe(true);
      expect(
        request.mock.calls
          .filter(([method]) => method === "thread/archive")
          .map(([, params]) => params),
      ).toEqual(
        [finalThreadId].map((threadId) => ({
          threadId,
        })),
      );
      if (archiveFails) {
        expect(error).toMatchObject({
          name: "CodexAppServerUnsafeSubscriptionError",
          cause: storageError,
        });
        expect(abandonClient).toHaveBeenCalledOnce();
      } else {
        expect(error).toBe(storageError);
        expect(abandonClient).not.toHaveBeenCalled();
      }
      expect([...nativeThreads]).toEqual(
        archive === "rejected" ? [sourceThreadId, unarchivedId] : [sourceThreadId],
      );
      expect(await testCodexAppServerBindingStore.read(identity)).toEqual({
        ...initial,
        pendingSupervisionBranch: {
          ...initial!.pendingSupervisionBranch,
          ...(archiveFails ? { cleanupThreadIds: [unarchivedId] } : {}),
        },
      });

      retry = true;
      request.mockClear();
      await expect(startOrResumeThreadImpl(common)).resolves.toMatchObject({
        threadId: `${finalThreadId}-retry`,
        lifecycle: { action: "forked" },
      });
      expect([...nativeThreads]).toEqual([sourceThreadId, `${finalThreadId}-retry`]);
      const persisted = await testCodexAppServerBindingStore.read(identity);
      expect(persisted?.threadId).toBe(`${finalThreadId}-retry`);
      expect(persisted?.pendingSupervisionBranch).toBeUndefined();
      if (archiveFails) {
        expect(request.mock.calls[0]).toEqual([
          "thread/archive",
          { threadId: unarchivedId },
          expect.any(Object),
        ]);
      }
    },
  );

  it.each(["unreadable", "pending successor", "materialized successor", "other generation"])(
    "abandons the exact client when failed tracking finds an %s binding",
    async (owner) => {
      const sourceThreadId = "thread-source";
      const probeThreadId = "thread-probe";
      const finalThreadId = "thread-final";
      const workspaceDir = path.join(tempDir, "workspace");
      const attempt = createThreadLifecycleParams(
        path.join(tempDir, "session.jsonl"),
        workspaceDir,
      );
      const identity = await seedPendingSupervisionBinding({
        attempt,
        cwd: workspaceDir,
        pending: { sourceThreadId },
      });
      const storageError = new Error("tracking storage failure");
      const readError = new Error("tracking verification unavailable");
      let failed = false;
      let preserved: Awaited<ReturnType<CodexAppServerBindingStore["read"]>>;
      const request = vi.fn(async (method: string) => {
        if (method === "thread/read") {
          return { thread: sourceThread({ threadId: sourceThreadId }) };
        }
        if (method === "thread/fork" || method === "thread/start") {
          return nativeThreadResult(
            method === "thread/fork" ? probeThreadId : finalThreadId,
            "native-effective",
            "native-provider",
          );
        }
        if (method === "thread/unsubscribe") {
          return {};
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const bindingStore: CodexAppServerBindingStore = {
        ...testCodexAppServerBindingStore,
        read: async (storeIdentity) => {
          if (failed && owner === "unreadable") {
            throw readError;
          }
          return await testCodexAppServerBindingStore.read(storeIdentity);
        },
        mutate: async (storeIdentity, mutation) => {
          if (
            !failed &&
            mutation.kind === "patch-pending-supervision-branch" &&
            mutation.pending.cleanupThreadIds?.includes(finalThreadId)
          ) {
            failed = true;
            if (owner === "pending successor") {
              await testCodexAppServerBindingStore.mutate(storeIdentity, {
                ...mutation,
                pending: { ...mutation.expected, lastTurnId: "turn-successor" },
              });
            } else if (owner === "materialized successor") {
              await testCodexAppServerBindingStore.mutate(storeIdentity, {
                kind: "commit-pending-supervision-branch",
                expected: mutation.expected,
                threadId: finalThreadId,
                patch: { model: "native-effective", modelProvider: "native-provider" },
              });
            } else if (owner === "other generation") {
              await testCodexAppServerBindingStore.adoptSessionGeneration(
                { ...identity, sessionId: "successor" },
                identity.sessionId,
              );
            }
            preserved = await testCodexAppServerBindingStore.read(
              owner === "other generation" ? { ...identity, sessionId: "successor" } : identity,
            );
            throw storageError;
          }
          return await testCodexAppServerBindingStore.mutate(storeIdentity, mutation);
        },
      };
      const abandonClient = vi.fn(async () => undefined);
      const error = await startOrResumeThreadImpl({
        client: { request } as never,
        abandonClient,
        bindingStore,
        params: attempt,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
      }).catch((caughtError: unknown) => caughtError);
      expect(error).toMatchObject({
        name: "CodexAppServerUnsafeSubscriptionError",
        cause: { cause: storageError, errors: expect.arrayContaining([storageError]) },
      });
      expect(abandonClient).toHaveBeenCalledOnce();
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "thread/read",
        "thread/fork",
        "thread/unsubscribe",
        "thread/start",
      ]);
      expect(
        await testCodexAppServerBindingStore.read(
          owner === "other generation" ? { ...identity, sessionId: "successor" } : identity,
        ),
      ).toEqual(preserved);
    },
  );

  it("does not clean the committed canonical thread when post-commit diagnostics fail", async () => {
    const sourceThreadId = "thread-source";
    const probeThreadId = "thread-probe";
    const finalThreadId = "thread-final";
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const identity = await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: { sourceThreadId },
    });
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/read") {
        return { thread: sourceThread({ threadId: sourceThreadId }) };
      }
      if (method === "thread/fork") {
        return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/start") {
        return nativeThreadResult(finalThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/archive" || method === "thread/unsubscribe") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const abandonClient = vi.fn(async () => undefined);

    await expect(
      startOrResumeThread({
        client: { request } as never,
        abandonClient,
        params: attempt,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
        timing: {
          enabled: true,
          now: () => 0,
          log: {
            isEnabled: () => true,
            trace: () => {
              throw new Error("timing log failed");
            },
            warn: vi.fn(),
          },
        },
      }),
    ).rejects.toThrow("timing log failed");
    expect(
      request.mock.calls
        .filter(([method]) => method === "thread/unsubscribe" || method === "thread/archive")
        .map(([, requestParams]) => requestParams),
    ).toEqual([{ threadId: probeThreadId }]);
    expect(abandonClient).not.toHaveBeenCalled();
    const committedBinding = await testCodexAppServerBindingStore.read(identity);
    expect(committedBinding).toMatchObject({ threadId: finalThreadId });
    expect(committedBinding).not.toHaveProperty("pendingSupervisionBranch");
  });

  it("confirms an applied canonical commit after the binding write reports failure", async () => {
    const sourceThreadId = "thread-source";
    const probeThreadId = "thread-probe";
    const finalThreadId = "thread-final";
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const identity = await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: { sourceThreadId },
    });
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/read") {
        return { thread: sourceThread({ threadId: sourceThreadId }) };
      }
      if (method === "thread/fork") {
        return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/start") {
        return nativeThreadResult(finalThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/archive" || method === "thread/unsubscribe") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const bindingStore: CodexAppServerBindingStore = {
      ...testCodexAppServerBindingStore,
      mutate: vi.fn(async (storeIdentity, mutation) => {
        const result = await testCodexAppServerBindingStore.mutate(storeIdentity, mutation);
        if (mutation.kind === "commit-pending-supervision-branch") {
          throw new Error("binding write failed after commit");
        }
        return result;
      }),
    };

    await expect(
      startOrResumeThreadImpl({
        client: { request } as never,
        bindingStore,
        params: attempt,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
      }),
    ).resolves.toMatchObject({
      threadId: finalThreadId,
      lifecycle: { action: "forked" },
    });
    expect(
      request.mock.calls
        .filter(([method]) => method === "thread/unsubscribe" || method === "thread/archive")
        .map(([, requestParams]) => requestParams),
    ).toEqual([{ threadId: probeThreadId }]);
    const committedBinding = await testCodexAppServerBindingStore.read(identity);
    expect(committedBinding).toMatchObject({ threadId: finalThreadId });
    expect(committedBinding).not.toHaveProperty("pendingSupervisionBranch");
  });

  it("rejects an applied commit when verification sees a changed connection", async () => {
    const sourceThreadId = "thread-source";
    const probeThreadId = "thread-probe";
    const finalThreadId = "thread-final";
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const identity = await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: { sourceThreadId },
    });
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/read") {
        return { thread: sourceThread({ threadId: sourceThreadId }) };
      }
      if (method === "thread/fork") {
        return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/start") {
        return nativeThreadResult(finalThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/archive" || method === "thread/unsubscribe") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const bindingStore: CodexAppServerBindingStore = {
      ...testCodexAppServerBindingStore,
      read: vi.fn(async (storeIdentity) => {
        const current = await testCodexAppServerBindingStore.read(storeIdentity);
        if (current?.threadId !== finalThreadId || current.pendingSupervisionBranch) {
          return current;
        }
        return { ...current, appServerRuntimeFingerprint: "changed-connection" };
      }),
      mutate: vi.fn(async (storeIdentity, mutation) => {
        const result = await testCodexAppServerBindingStore.mutate(storeIdentity, mutation);
        if (mutation.kind === "commit-pending-supervision-branch") {
          throw new Error("binding write failed after commit");
        }
        return result;
      }),
    };
    const abandonClient = vi.fn(async () => undefined);

    await expect(
      startOrResumeThreadImpl({
        client: { request } as never,
        abandonClient,
        bindingStore,
        params: attempt,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
      }),
    ).rejects.toThrow(`binding changed while commit was uncertain: ${finalThreadId}`);
    expect(
      request.mock.calls
        .filter(([method]) => method === "thread/unsubscribe" || method === "thread/archive")
        .map(([, requestParams]) => requestParams),
    ).toEqual([{ threadId: probeThreadId }]);
    expect(abandonClient).toHaveBeenCalledOnce();
    await expect(testCodexAppServerBindingStore.read(identity)).resolves.toMatchObject({
      threadId: finalThreadId,
    });
  });

  it("abandons without cleanup when a failed canonical commit cannot be verified", async () => {
    const sourceThreadId = "thread-source";
    const probeThreadId = "thread-probe";
    const finalThreadId = "thread-final";
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const identity = await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: { sourceThreadId },
    });
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/read") {
        return { thread: sourceThread({ threadId: sourceThreadId }) };
      }
      if (method === "thread/fork") {
        return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/start") {
        return nativeThreadResult(finalThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/archive" || method === "thread/unsubscribe") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    let commitFailed = false;
    const bindingStore: CodexAppServerBindingStore = {
      ...testCodexAppServerBindingStore,
      read: vi.fn(async (storeIdentity) => {
        if (commitFailed) {
          throw new Error("binding verification read failed");
        }
        return await testCodexAppServerBindingStore.read(storeIdentity);
      }),
      mutate: vi.fn(async (storeIdentity, mutation) => {
        if (mutation.kind === "commit-pending-supervision-branch") {
          commitFailed = true;
          throw new Error("binding commit failed");
        }
        return await testCodexAppServerBindingStore.mutate(storeIdentity, mutation);
      }),
    };
    const abandonClient = vi.fn(async () => undefined);

    await expect(
      startOrResumeThreadImpl({
        client: { request } as never,
        abandonClient,
        bindingStore,
        params: attempt,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
      }),
    ).rejects.toThrow(`binding could not be verified: ${finalThreadId}`);
    expect(
      request.mock.calls
        .filter(([method]) => method === "thread/unsubscribe" || method === "thread/archive")
        .map(([, requestParams]) => requestParams),
    ).toEqual([{ threadId: probeThreadId }]);
    expect(abandonClient).toHaveBeenCalledOnce();
    await expect(testCodexAppServerBindingStore.read(identity)).resolves.toMatchObject({
      threadId: sourceThreadId,
      pendingSupervisionBranch: {
        sourceThreadId,
        cleanupThreadIds: [finalThreadId],
      },
    });
  });

  it("abandons without cleanup when failed commit verification sees a changed connection", async () => {
    const sourceThreadId = "thread-source";
    const probeThreadId = "thread-probe";
    const finalThreadId = "thread-final";
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const identity = await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: { sourceThreadId },
    });
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/read") {
        return { thread: sourceThread({ threadId: sourceThreadId }) };
      }
      if (method === "thread/fork") {
        return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/start") {
        return nativeThreadResult(finalThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/archive" || method === "thread/unsubscribe") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    let commitFailed = false;
    const bindingStore: CodexAppServerBindingStore = {
      ...testCodexAppServerBindingStore,
      read: vi.fn(async (storeIdentity) => {
        const current = await testCodexAppServerBindingStore.read(storeIdentity);
        if (!commitFailed || !current?.pendingSupervisionBranch) {
          return current;
        }
        return {
          ...current,
          pendingSupervisionBranch: {
            ...current.pendingSupervisionBranch,
            connectionFingerprint: "changed-connection",
          },
        };
      }),
      mutate: vi.fn(async (storeIdentity, mutation) => {
        if (mutation.kind === "commit-pending-supervision-branch") {
          commitFailed = true;
          throw new Error("binding commit failed");
        }
        return await testCodexAppServerBindingStore.mutate(storeIdentity, mutation);
      }),
    };
    const abandonClient = vi.fn(async () => undefined);

    await expect(
      startOrResumeThreadImpl({
        client: { request } as never,
        abandonClient,
        bindingStore,
        params: attempt,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
      }),
    ).rejects.toThrow(`binding changed while commit was uncertain: ${finalThreadId}`);
    expect(
      request.mock.calls
        .filter(([method]) => method === "thread/unsubscribe" || method === "thread/archive")
        .map(([, requestParams]) => requestParams),
    ).toEqual([{ threadId: probeThreadId }]);
    expect(abandonClient).toHaveBeenCalledOnce();
    await expect(testCodexAppServerBindingStore.read(identity)).resolves.toMatchObject({
      threadId: sourceThreadId,
      pendingSupervisionBranch: {
        sourceThreadId,
        cleanupThreadIds: [finalThreadId],
      },
    });
  });

  it.each(["", "thread-source", undefined])(
    "abandons an unsafe probe id %s without touching the source",
    async (returnedId) => {
      const sourceThreadId = "thread-source";
      const workspaceDir = path.join(tempDir, "workspace");
      const attempt = createThreadLifecycleParams(
        path.join(tempDir, "session.jsonl"),
        workspaceDir,
      );
      await seedPendingSupervisionBinding({
        attempt,
        cwd: workspaceDir,
        pending: { sourceThreadId },
      });
      const request = vi.fn(async (method: string) => {
        if (method === "thread/read") {
          return { thread: sourceThread({ threadId: sourceThreadId }) };
        }
        if (method === "thread/fork") {
          return { thread: { id: returnedId } };
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const abandonClient = vi.fn(async () => undefined);

      await expect(
        startOrResumeThread({
          client: { request } as never,
          abandonClient,
          params: attempt,
          cwd: workspaceDir,
          dynamicTools: [],
          appServer: createThreadLifecycleAppServerOptions(),
        }),
      ).rejects.toThrow(
        returnedId === "thread-source"
          ? "model probe reused an existing thread"
          : "model probe may have materialized without a safe thread id",
      );
      expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/read", "thread/fork"]);
      expect(abandonClient).toHaveBeenCalledOnce();
    },
  );

  it.each(["", "thread-source", "thread-probe"])(
    "releases the probe before abandoning unsafe canonical id %s",
    async (returnedId) => {
      const sourceThreadId = "thread-source";
      const probeThreadId = "thread-probe";
      const workspaceDir = path.join(tempDir, "workspace");
      const attempt = createThreadLifecycleParams(
        path.join(tempDir, "session.jsonl"),
        workspaceDir,
      );
      const identity = await seedPendingSupervisionBinding({
        attempt,
        cwd: workspaceDir,
        pending: { sourceThreadId },
      });
      const request = vi.fn(async (method: string, _requestParams?: unknown) => {
        if (method === "thread/read") {
          return { thread: sourceThread({ threadId: sourceThreadId }) };
        }
        if (method === "thread/fork") {
          return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
        }
        if (method === "thread/start") {
          return { thread: { id: returnedId } };
        }
        if (method === "thread/archive" || method === "thread/unsubscribe") {
          return {};
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const abandonClient = vi.fn(async () => undefined);

      await expect(
        startOrResumeThread({
          client: { request } as never,
          abandonClient,
          params: attempt,
          cwd: workspaceDir,
          dynamicTools: [],
          appServer: createThreadLifecycleAppServerOptions(),
        }),
      ).rejects.toThrow(
        returnedId
          ? "canonical branch reused an existing thread"
          : "canonical branch may have materialized without a safe thread id",
      );
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "thread/read",
        "thread/fork",
        "thread/unsubscribe",
        "thread/start",
      ]);
      expect(request.mock.calls[2]?.[1]).toEqual({ threadId: probeThreadId });
      expect(request.mock.invocationCallOrder[2]).toBeLessThan(
        abandonClient.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      expect(abandonClient).toHaveBeenCalledOnce();
      const persisted = await testCodexAppServerBindingStore.read(identity);
      expect(persisted).toMatchObject({
        threadId: sourceThreadId,
        pendingSupervisionBranch: { sourceThreadId },
      });
      expect(persisted?.pendingSupervisionBranch?.cleanupThreadIds).toBeUndefined();
    },
  );
});

describe("Codex app-server thread lifecycle timing", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-thread-lifecycle-"));
    // Bindings are keyed by session identity, not tempDir, so sibling tests
    // would otherwise leak resumable threads into fresh-start expectations.
    resetCodexTestBindingStore();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
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
    const respond = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-existing");
      }
      if (method === "thread/resume") {
        nowMs += 9;
        return threadStartResult("thread-existing");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });
    const { client } = fixture;
    const commonParams = {
      client,
      signal: new AbortController().signal,
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
    await fixture.endTurn("thread-existing");
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

describe("resolveCodexAppServerReasoningEffort (#71946)", () => {
  const standardEfforts = ["low", "medium", "high", "xhigh"];
  const maxEfforts = [...standardEfforts, "max"];
  const ultraEfforts = [...maxEfforts, "ultra"];

  it.each([
    { requested: "minimal", supported: standardEfforts, expected: "low" },
    { requested: "low", supported: standardEfforts, expected: "low" },
    { requested: "medium", supported: standardEfforts, expected: "medium" },
    { requested: "high", supported: standardEfforts, expected: "high" },
    { requested: "xhigh", supported: standardEfforts, expected: "xhigh" },
    { requested: "minimal", supported: ["medium", "high", "xhigh"], expected: "medium" },
    { requested: "low", supported: ["medium", "high", "xhigh"], expected: "medium" },
    { requested: "max", supported: ["medium", "high", "xhigh"], expected: "xhigh" },
    { requested: "max", supported: maxEfforts, expected: "max" },
    { requested: "ultra", supported: maxEfforts, expected: "ultra" },
    { requested: "ultra", supported: ultraEfforts, expected: "ultra" },
    { requested: "high", supported: ["none", "max"], expected: "max" },
    { requested: "high", supported: ["none"], expected: null },
    { requested: "high", supported: ["ultra"], expected: null },
  ] as const)(
    "maps $requested to $expected using provider-supported efforts",
    ({ requested, supported, expected }) => {
      expect(
        resolveCodexAppServerReasoningEffort({
          thinkLevel: requested,
          modelId: "catalog-model",
          supportedReasoningEfforts: supported,
        }),
      ).toBe(expected);
    },
  );

  it.each([
    { thinkLevel: "minimal", modelId: "gpt-5.5", expected: "low" },
    { thinkLevel: "minimal", modelId: "gpt-4o", expected: "minimal" },
    { thinkLevel: "low", modelId: "gpt-5.5-pro", expected: "medium" },
    { thinkLevel: "max", modelId: "gpt-5.5-pro", expected: "xhigh" },
    { thinkLevel: "max", modelId: "gpt-5.6-sol", expected: null },
    { thinkLevel: "ultra", modelId: "gpt-5.6-sol", expected: "ultra" },
  ] as const)("maps $thinkLevel for $modelId without effort metadata", (params) => {
    expect(resolveCodexAppServerReasoningEffort(params)).toBe(params.expected);
  });

  it("omits non-effort think levels", () => {
    for (const thinkLevel of ["off", "adaptive"] as const) {
      expect(
        resolveCodexAppServerReasoningEffort({
          thinkLevel,
          modelId: "catalog-model",
          supportedReasoningEfforts: ultraEfforts,
        }),
      ).toBeNull();
    }
    expect(
      resolveCodexAppServerReasoningEffort({
        thinkLevel: "adaptive",
        modelId: "catalog-model",
        supportedReasoningEfforts: ["none", ...ultraEfforts],
      }),
    ).toBeNull();
  });
});

describe("native Codex Ultra turn mapping", () => {
  it.each([
    { modelId: "gpt-5.6-sol", requested: "ultra", expected: "ultra" },
    { modelId: "gpt-5.6-terra", requested: "ultra", expected: "ultra" },
    { modelId: "gpt-5.6-luna", requested: "max", expected: "max" },
  ] as const)(
    "preserves resolved $requested for $modelId with direct OpenAI API metadata",
    ({ modelId, requested, expected }) => {
      const params = createAttemptParams({
        provider: "openai",
        modelId,
        authProfileId: "openai:api-key",
        authProfileType: "api_key",
      });
      params.thinkLevel = requested;
      const compat: ModelCompatConfig = {
        supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      };
      params.model = {
        ...createCodexTestModel("openai"),
        id: modelId,
        compat,
      };

      const request = buildTurnStartParams(params, {
        threadId: "thread-ultra",
        cwd: "/repo",
        appServer: createAppServerOptions() as never,
      });

      expect(request.effort).toBe(expected);
      expect(request.collaborationMode?.settings.reasoning_effort).toBe(expected);
      expect(request).not.toHaveProperty("multiAgentMode");
    },
  );

  it("preserves resolved Ultra independently of scalar reasoning presets", () => {
    const params = createAttemptParams({ provider: "codex", modelId: "gpt-5.6-sol" });
    params.thinkLevel = "ultra";
    const compat: ModelCompatConfig = {
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    };
    params.model = {
      ...createCodexTestModel("codex"),
      id: "gpt-5.6-sol",
      compat,
    };

    const request = buildTurnStartParams(params, {
      threadId: "thread-native-catalog",
      cwd: "/repo",
      appServer: createAppServerOptions() as never,
    });

    expect(request.effort).toBe("ultra");
    expect(request.collaborationMode?.settings.reasoning_effort).toBe("ultra");
    expect(request).not.toHaveProperty("multiAgentMode");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
