// Verifies update_plan registration gates and base OpenClaw tool inclusion policy.
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setEmbeddedMode } from "../infra/embedded-mode.js";
import { isToolWrappedWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { resolveCoreToolFactoryFamily } from "./core-tool-factory-descriptors.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import {
  shouldIncludeAskUserToolForOpenClawTools,
  shouldIncludeUpdatePlanToolForOpenClawTools,
} from "./openclaw-tools.registration.js";
import { createUpdatePlanTool } from "./tools/update-plan-tool.js";

type UpdatePlanGatingParams = Parameters<typeof shouldIncludeUpdatePlanToolForOpenClawTools>[0];
type CreateOpenClawToolsOptions = NonNullable<Parameters<typeof createOpenClawTools>[0]>;

function expectUpdatePlanEnabled(params: UpdatePlanGatingParams, expected: boolean): void {
  expect(shouldIncludeUpdatePlanToolForOpenClawTools(params)).toBe(expected);
}

function toolNames(tools: ReturnType<typeof createOpenClawTools>): string[] {
  return tools.map((tool) => tool.name);
}

function createFastToolNames(options: CreateOpenClawToolsOptions): string[] {
  // Disable unrelated dynamic surfaces so registration assertions stay deterministic.
  return toolNames(
    createOpenClawTools({
      disableMessageTool: true,
      disablePluginTools: true,
      wrapBeforeToolCallHook: false,
      ...options,
    }),
  );
}

function expectToolNamed(
  tools: ReturnType<typeof createOpenClawTools>,
  name: string,
): ReturnType<typeof createOpenClawTools>[number] {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Expected tool ${name} to be registered`);
  }
  return tool;
}

describe("openclaw-tools update_plan gating", () => {
  afterEach(() => {
    setEmbeddedMode(false);
  });

  it("keeps concrete OpenClaw tool names in the factory descriptor catalog", () => {
    const emittedNames = createFastToolNames({
      agentSessionKey: "agent:main:main",
      config: {
        tools: { allow: ["update_plan"] },
        transcripts: { enabled: true },
      } as OpenClawConfig,
      cwd: "/repo",
      enableHeartbeatTool: true,
      taskSuggestionDeliveryMode: "gateway",
    });

    expect(
      emittedNames.filter((name) => resolveCoreToolFactoryFamily(name) !== "openclaw"),
    ).toEqual([]);
  });

  it("enables update_plan by default", () => {
    expectUpdatePlanEnabled({ config: {} as OpenClawConfig }, true);
  });

  it("exposes update_plan from default tool construction for every embedded model", () => {
    const defaultTools = createFastToolNames({
      config: {} as OpenClawConfig,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
    const emptyAllowlistParams = {
      config: {} as OpenClawConfig,
      pluginToolAllowlist: [],
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-6",
    };

    expect(defaultTools).toContain("update_plan");
    expect(defaultTools).not.toContain("ask_user");
    expect(shouldIncludeUpdatePlanToolForOpenClawTools(emptyAllowlistParams)).toBe(true);
  });

  it("keeps ask_user on primary sessions and excludes spawned worker sessions", () => {
    expect(shouldIncludeAskUserToolForOpenClawTools({})).toBe(false);
    expect(shouldIncludeAskUserToolForOpenClawTools({ agentSessionKey: "agent:main:main" })).toBe(
      true,
    );
    expect(
      shouldIncludeAskUserToolForOpenClawTools({
        agentSessionKey: "agent:main:subagent:worker",
      }),
    ).toBe(false);
    expect(
      shouldIncludeAskUserToolForOpenClawTools({ agentSessionKey: "agent:main:acp:worker" }),
    ).toBe(false);
    // ask_user must not depend on the TUI embedded-host flag; normal gateway
    // runs are the primary consumer.
    expect(
      createFastToolNames({
        config: {} as OpenClawConfig,
        runSessionKey: "agent:main:non-embedded",
      }),
    ).toContain("ask_user");
    setEmbeddedMode(true);

    expect(
      createFastToolNames({
        config: {} as OpenClawConfig,
        agentSessionKey: "agent:main:subagent:worker",
      }),
    ).not.toContain("ask_user");
    expect(
      createFastToolNames({
        config: {} as OpenClawConfig,
        runSessionKey: "agent:main:run",
      }),
    ).toContain("ask_user");
  });

  it("wraps constructed tools with before-tool-call hooks by default", () => {
    const tools = createOpenClawTools({
      config: {} as OpenClawConfig,
      disablePluginTools: true,
    });
    const unwrappedTools = createOpenClawTools({
      config: {} as OpenClawConfig,
      disablePluginTools: true,
      wrapBeforeToolCallHook: false,
    });

    expect(isToolWrappedWithBeforeToolCallHook(expectToolNamed(tools, "sessions_list"))).toBe(true);
    expect(
      isToolWrappedWithBeforeToolCallHook(expectToolNamed(unwrappedTools, "sessions_list")),
    ).toBe(false);
  });

  it("keeps message tool in embedded message-tool-only completions", () => {
    setEmbeddedMode(true);
    const tools = createOpenClawTools({
      config: {} as OpenClawConfig,
      disablePluginTools: true,
      wrapBeforeToolCallHook: false,
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expect(toolNames(tools)).toContain("message");
  });

  it("exposes delegation only to regular unsandboxed gateway agents", () => {
    const regular = createFastToolNames({
      config: {} as OpenClawConfig,
      agentSessionKey: "agent:main:main",
    });
    const sandboxed = createFastToolNames({
      config: {} as OpenClawConfig,
      agentSessionKey: "agent:main:main",
      sandboxed: true,
    });
    const system = createFastToolNames({
      config: {} as OpenClawConfig,
      agentSessionKey: "agent:openclaw:main",
    });
    setEmbeddedMode(true);
    const embedded = createFastToolNames({
      config: {} as OpenClawConfig,
      agentSessionKey: "agent:main:main",
    });

    expect(regular).toContain("openclaw");
    expect(sandboxed).not.toContain("openclaw");
    expect(system).not.toContain("openclaw");
    expect(embedded).not.toContain("openclaw");
  });

  it("registers transcripts by default with an explicit global opt-out", () => {
    const defaultTools = createFastToolNames({
      config: {} as OpenClawConfig,
    });
    const disabledTools = createFastToolNames({
      config: { transcripts: { enabled: false } } as OpenClawConfig,
    });

    expect(defaultTools).toContain("transcripts");
    expect(disabledTools).not.toContain("transcripts");
  });

  it("registers task suggestions only for sessions with an actionable gateway sink", () => {
    const withoutSession = createFastToolNames({
      config: {} as OpenClawConfig,
      cwd: "/repo",
      taskSuggestionDeliveryMode: "gateway",
    });
    const withoutSink = createFastToolNames({
      config: {} as OpenClawConfig,
      agentSessionKey: "agent:main:main",
      cwd: "/repo",
    });
    const withSink = createFastToolNames({
      config: {} as OpenClawConfig,
      agentSessionKey: "agent:main:main",
      cwd: "/repo",
      taskSuggestionDeliveryMode: "gateway",
    });

    expect(withoutSession).not.toContain("spawn_task");
    expect(withoutSession).not.toContain("dismiss_task");
    expect(withoutSink).not.toContain("spawn_task");
    expect(withoutSink).not.toContain("dismiss_task");
    expect(withSink).toEqual(expect.arrayContaining(["spawn_task", "dismiss_task"]));
  });

  it("keeps explicitly allowed message tool in embedded completions", () => {
    setEmbeddedMode(true);
    const fromRuntimeAllowlist = createOpenClawTools({
      config: {} as OpenClawConfig,
      disablePluginTools: true,
      pluginToolAllowlist: ["message"],
      wrapBeforeToolCallHook: false,
    });
    const fromGlobalAlsoAllow = createOpenClawTools({
      config: { tools: { profile: "minimal", alsoAllow: ["message"] } } as OpenClawConfig,
      disablePluginTools: true,
      wrapBeforeToolCallHook: false,
    });
    const denied = createOpenClawTools({
      config: {} as OpenClawConfig,
      disablePluginTools: true,
      pluginToolAllowlist: ["message"],
      pluginToolDenylist: ["message"],
      wrapBeforeToolCallHook: false,
    });

    expect(toolNames(fromRuntimeAllowlist)).toContain("message");
    expect(toolNames(fromGlobalAlsoAllow)).toContain("message");
    expect(toolNames(denied)).not.toContain("message");
  });

  it("keeps subagent spawn available for trusted embedded gateway-bound runs", () => {
    setEmbeddedMode(true);
    const defaultTools = createFastToolNames({
      config: {} as OpenClawConfig,
    });
    const gatewayBoundTools = createFastToolNames({
      config: {} as OpenClawConfig,
      allowGatewaySubagentBinding: true,
    });

    expect(defaultTools).not.toContain("sessions_spawn");
    expect(defaultTools).not.toContain("sessions_send");
    expect(gatewayBoundTools).toContain("sessions_spawn");
    expect(gatewayBoundTools).not.toContain("sessions_send");
  });

  it("registers update_plan when explicitly enabled", () => {
    const config = {
      tools: {
        experimental: {
          planTool: true,
        },
      },
    } as OpenClawConfig;

    expectUpdatePlanEnabled({ config }, true);
    expect(createUpdatePlanTool().displaySummary).toBe("Track short work plan.");
  });

  it("registers update_plan when the runtime allowlist explicitly requests it", () => {
    const tools = createFastToolNames({
      config: {} as OpenClawConfig,
      pluginToolAllowlist: ["update_plan"],
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });

    expect(tools).toContain("update_plan");
  });

  it("includes update_plan when a config allowlist group includes it", () => {
    const includeUpdatePlan = shouldIncludeUpdatePlanToolForOpenClawTools({
      config: { tools: { allow: ["group:agents"] } } as OpenClawConfig,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });

    expect(includeUpdatePlan).toBe(true);
  });

  it("includes update_plan when a runtime allowlist group includes it", () => {
    const includeUpdatePlan = shouldIncludeUpdatePlanToolForOpenClawTools({
      config: {} as OpenClawConfig,
      pluginToolAllowlist: ["group:agents"],
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });

    expect(includeUpdatePlan).toBe(true);
  });

  it("leaves normal deny policy enforcement to the assembled tool set", () => {
    const tools = createFastToolNames({
      config: {} as OpenClawConfig,
      pluginToolAllowlist: ["group:agents"],
      pluginToolDenylist: ["update_plan"],
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });

    expect(tools).not.toContain("update_plan");
  });

  it("lets explicit planTool false disable every model and override allowlists", () => {
    const cfg = {
      tools: {
        experimental: {
          planTool: false,
        },
      },
    } as OpenClawConfig;

    expectUpdatePlanEnabled({ config: cfg, modelProvider: "openai", modelId: "gpt-5.4" }, false);
    expectUpdatePlanEnabled(
      {
        config: cfg,
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-6",
        pluginToolAllowlist: ["update_plan"],
      },
      false,
    );
  });
});
