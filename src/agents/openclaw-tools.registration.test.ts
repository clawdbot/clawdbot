// Verifies OpenClaw tool registration, availability, and construction policy.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setEmbeddedMode } from "../infra/embedded-mode.js";
import { withEnv } from "../test-utils/env.js";
import { isToolWrappedWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { resolveCoreToolFactoryFamily } from "./core-tool-factory-descriptors.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "./cron-creator-authority-context.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import {
  collectPresentOpenClawTools,
  shouldIncludeAskUserToolForOpenClawTools,
  shouldIncludeUpdatePlanToolForOpenClawTools,
} from "./openclaw-tools.registration.js";
import { textResult, type AnyAgentTool } from "./tools/common.js";
import { createPdfTool } from "./tools/pdf-tool.js";
import { createUpdatePlanTool } from "./tools/update-plan-tool.js";

vi.mock("./openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
}));

type UpdatePlanGatingParams = Parameters<typeof shouldIncludeUpdatePlanToolForOpenClawTools>[0];
type CreateOpenClawToolsOptions = NonNullable<Parameters<typeof createOpenClawTools>[0]>;

function withDefaultRoster(config: OpenClawConfig | undefined): OpenClawConfig {
  return {
    ...config,
    agents: config?.agents ?? { entries: { main: { default: true } } },
  };
}

function expectUpdatePlanEnabled(params: UpdatePlanGatingParams, expected: boolean): void {
  expect(
    shouldIncludeUpdatePlanToolForOpenClawTools({
      ...params,
      config: withDefaultRoster(params.config),
    }),
  ).toBe(expected);
}

function toolNames(tools: ReturnType<typeof createOpenClawTools>): string[] {
  return tools.map((tool) => tool.name);
}

function createFastToolNames(options: CreateOpenClawToolsOptions): string[] {
  // Disable unrelated dynamic surfaces so registration assertions stay deterministic.
  return toolNames(
    createTestOpenClawTools({
      disableMessageTool: true,
      disablePluginTools: true,
      wrapBeforeToolCallHook: false,
      ...options,
    }),
  );
}

function createTestOpenClawTools(options: CreateOpenClawToolsOptions = {}) {
  return createOpenClawTools({
    ...options,
    config: withDefaultRoster(options.config),
  });
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

    expect(defaultTools).toContain("update_plan");
    expect(defaultTools).not.toContain("ask_user");
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
    const tools = createTestOpenClawTools({
      config: {} as OpenClawConfig,
      disablePluginTools: true,
    });
    const unwrappedTools = createTestOpenClawTools({
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
    const tools = createTestOpenClawTools({
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

  it("registers transcripts for an active local operator with an explicit global opt-out", () => {
    const capability = createCronCreatorAuthorityCapability("run-local", { kind: "local" })!;
    const { defaultTools, disabledTools } = runWithCronCreatorAuthorityCapability(
      capability,
      () => ({
        defaultTools: createFastToolNames({
          config: {} as OpenClawConfig,
          runId: "run-local",
        }),
        disabledTools: createFastToolNames({
          config: { transcripts: { enabled: false } } as OpenClawConfig,
          runId: "run-local",
        }),
      }),
    );

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

    expect(withoutSession).not.toContain("suggest_task");
    expect(withoutSession).not.toContain("dismiss_task");
    expect(withoutSink).not.toContain("suggest_task");
    expect(withoutSink).not.toContain("dismiss_task");
    expect(withSink).toEqual(expect.arrayContaining(["suggest_task", "dismiss_task"]));
  });

  it("keeps explicitly allowed message tool in embedded completions", () => {
    setEmbeddedMode(true);
    const fromRuntimeAllowlist = createTestOpenClawTools({
      config: {} as OpenClawConfig,
      disablePluginTools: true,
      pluginToolAllowlist: ["message"],
      wrapBeforeToolCallHook: false,
    });
    const fromGlobalAlsoAllow = createTestOpenClawTools({
      config: { tools: { profile: "minimal", alsoAllow: ["message"] } } as OpenClawConfig,
      disablePluginTools: true,
      wrapBeforeToolCallHook: false,
    });
    const denied = createTestOpenClawTools({
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
    const config = { tools: { updatePlan: true } } as OpenClawConfig;

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

  it("lets an explicit updatePlan false override an allowlist that includes the tool", () => {
    expectUpdatePlanEnabled(
      { config: { tools: { updatePlan: false, allow: ["update_plan"] } } as OpenClawConfig },
      false,
    );
  });
});

function findOpenClawTool(name: string, modelHasVision?: boolean) {
  return createTestOpenClawTools({ modelHasVision }).find((tool) => tool.name === name);
}

describe("model capability registration", () => {
  it("omits computer input for models that cannot see the reference frame", () => {
    expect(findOpenClawTool("computer", false)).toBeUndefined();
  });

  it("keeps computer when vision is supported or not yet resolved", () => {
    expect(findOpenClawTool("computer", true)).toBeDefined();
    expect(findOpenClawTool("computer")).toBeDefined();
  });

  it("keeps computer screenshots on the direct model-visible tool surface", () => {
    expect(findOpenClawTool("computer", true)?.catalogMode).toBe("direct-only");
  });

  it("registers mobile UI independent of model vision", () => {
    expect(findOpenClawTool("mobile_ui", false)).toBeDefined();
    expect(findOpenClawTool("mobile_ui", true)).toBeDefined();
    expect(findOpenClawTool("mobile_ui")).toBeDefined();
  });

  it("keeps mobile UI one-action-at-a-time execution explicit", () => {
    expect(findOpenClawTool("mobile_ui")?.executionMode).toBe("sequential");
  });
});

function stubAgentTool(name: string): AnyAgentTool {
  return {
    label: name,
    name,
    description: `${name} stub`,
    parameters: { type: "object", properties: {} },
    async execute() {
      return textResult("ok", {});
    },
  };
}

describe.each([
  { suite: "image", toolName: "image_generate", article: "an", label: "image-generation tool" },
  { suite: "video", toolName: "video_generate", article: "a", label: "video-generation tool" },
])("openclaw tools $suite generation registration", ({ toolName, article, label }) => {
  it(`registers ${toolName} when ${article} ${label} is present`, () => {
    const tool = stubAgentTool(toolName);
    expect(collectPresentOpenClawTools([tool])).toEqual([tool]);
  });

  it(`omits ${toolName} when ${article} ${label} is absent`, () => {
    expect(collectPresentOpenClawTools([null]).map((tool) => tool.name)).not.toContain(toolName);
  });
});

describe("PDF registration", () => {
  it("includes the pdf tool when the pdf factory returns a tool", () => {
    const pdfTool = createPdfTool({
      agentDir: "/tmp/openclaw-agent-main",
      config: {
        agents: { defaults: { pdfModel: { primary: "openai/gpt-5.4-mini" } } },
      },
    });

    expect(pdfTool?.name).toBe("pdf");
    expect(collectPresentOpenClawTools([pdfTool]).map((tool) => tool.name)).toEqual(["pdf"]);
  });
});

function createSwarmToolNames(options: NonNullable<Parameters<typeof createOpenClawTools>[0]>) {
  const config = options.config ?? {};
  return createOpenClawTools({
    disableMessageTool: true,
    disablePluginTools: true,
    wrapBeforeToolCallHook: false,
    ...options,
    config: {
      ...config,
      agents: config.agents ?? { entries: { main: {} } },
    },
  }).map((tool) => tool.name);
}

describe("Swarm registration", () => {
  it("registers agents_wait only when tools.swarm is enabled", () => {
    const base = { agentSessionKey: "agent:main:main" };
    expect(createSwarmToolNames(base)).not.toContain("agents_wait");
    expect(createSwarmToolNames({ ...base, config: { tools: { swarm: true } } })).toContain(
      "agents_wait",
    );
  });

  it("uses the effective requester agent override for the agents_wait gate", () => {
    const base = {
      agentSessionKey: "agent:worker:main",
      requesterAgentIdOverride: "worker",
    };
    expect(
      createSwarmToolNames({
        ...base,
        config: {
          tools: { swarm: false },
          agents: {
            list: [{ id: "main" }, { id: "worker", tools: { swarm: true } }],
          },
        },
      }),
    ).toContain("agents_wait");
    expect(
      createSwarmToolNames({
        ...base,
        config: {
          tools: { swarm: true },
          agents: {
            list: [{ id: "main" }, { id: "worker", tools: { swarm: false } }],
          },
        },
      }),
    ).not.toContain("agents_wait");
  });

  it("injects structured_output only for schema-backed collector runs", () => {
    const base = {
      agentSessionKey: "agent:worker:subagent:child",
      runId: "collector-run",
      config: { tools: { swarm: true } },
    };
    expect(createSwarmToolNames({ ...base, swarmCollector: true })).not.toContain(
      "structured_output",
    );
    expect(
      createSwarmToolNames({
        ...base,
        swarmCollector: true,
        swarmOutputSchema: { type: "object", properties: { answer: { type: "string" } } },
      }),
    ).toContain("structured_output");
  });

  it("keeps structured_output through restrictive child tool policy", () => {
    const names = createOpenClawCodingTools({
      sessionKey: "agent:worker:subagent:child",
      runId: "collector-run",
      config: {
        agents: { entries: { main: { default: true } } },
        tools: { allow: ["read"], swarm: true },
      },
      swarmCollector: true,
      swarmOutputSchema: { type: "object", properties: { answer: { type: "string" } } },
    }).map((tool) => tool.name);

    expect(names).toContain("read");
    expect(names).toContain("structured_output");
    expect(names).not.toContain("exec");
  });

  it("omits the message tool for collector runs by invariant", () => {
    const names = createOpenClawCodingTools({
      sessionKey: "agent:worker:subagent:child",
      runId: "collector-run",
      config: {
        agents: { entries: { main: { default: true } } },
        tools: { swarm: true },
      },
      swarmCollector: true,
    }).map((tool) => tool.name);

    expect(names).not.toContain("message");
  });

  it("omits interactive and pausing tools for non-interactive collector runs", () => {
    const names = createOpenClawCodingTools({
      sessionKey: "agent:worker:main",
      runId: "collector-run",
      config: {
        agents: { entries: { main: { default: true } } },
        tools: { swarm: true },
      },
      swarmCollector: true,
    }).map((tool) => tool.name);

    expect(names).not.toContain("ask_user");
    expect(names).not.toContain("sessions_send");
    expect(names).not.toContain("sessions_yield");
  });
});

describe("sessions_yield completion ownership", () => {
  const controllerSessionKey = "agent:main:telegram:default:direct:1234";

  it.each([
    ["the durable run owner", "agent:main:main", "agent:main:main"],
    ["a trimmed durable run owner", "  agent:main:main  ", "agent:main:main"],
    ["the controller when the run owner is blank", "   ", controllerSessionKey],
    ["the controller when the run owner is absent", undefined, controllerSessionKey],
  ] as const)("records yield intent against %s", async (_, runSessionKey, expectedSessionKey) => {
    const registry = await import("./subagents/registry/subagent-registry.js");
    const markRequesterTurnYielded = vi
      .spyOn(registry, "markRequesterTurnYielded")
      .mockReturnValue(1);
    const onYield = vi.fn(async () => undefined);

    try {
      const tool = expectToolNamed(
        createTestOpenClawTools({
          agentSessionKey: controllerSessionKey,
          runSessionKey,
          sessionId: "requester-session",
          runId: "run-requester",
          onYield,
          disableMessageTool: true,
          disablePluginTools: true,
          wrapBeforeToolCallHook: false,
        }),
        "sessions_yield",
      );

      const result = await tool.execute("yield-requester", {});

      expect(result.details).toMatchObject({ status: "yielded" });
      expect(markRequesterTurnYielded).toHaveBeenCalledExactlyOnceWith({
        requesterAgentId: "main",
        requesterSessionKey: expectedSessionKey,
        requesterTurnRunId: "run-requester",
      });
      expect(onYield).toHaveBeenCalledOnce();
      expect(markRequesterTurnYielded.mock.invocationCallOrder[0]).toBeLessThan(
        onYield.mock.invocationCallOrder[0]!,
      );
    } finally {
      markRequesterTurnYielded.mockRestore();
    }
  });
});

function hasTool(tools: readonly { name: string }[], name: string): boolean {
  return tools.some((tool) => tool.name === name);
}

describe("gateway client capability tool filtering", () => {
  it.each([
    { name: "no gateway client caps exist", clientCaps: undefined },
    { name: "a required cap is absent", clientCaps: ["tool-events"] },
  ])("excludes capability-gated tools when $name", ({ clientCaps }) => {
    expect(hasTool(createOpenClawTools({ clientCaps }), "show_widget")).toBe(false);
  });

  it("includes capability-gated tools when the client caps are a superset", () => {
    expect(
      hasTool(
        createOpenClawTools({ clientCaps: ["tool-events", "inline-widgets"] }),
        "show_widget",
      ),
    ).toBe(true);
  });

  it("keeps the core widget tool out of Discord sessions", () => {
    expect(
      hasTool(
        createOpenClawTools({ agentChannel: "discord", clientCaps: ["inline-widgets"] }),
        "show_widget",
      ),
    ).toBe(false);
  });

  it("keeps the core widget tool out when Canvas host config disables it", () => {
    expect(
      hasTool(
        createOpenClawTools({
          clientCaps: ["inline-widgets"],
          config: {
            plugins: { entries: { canvas: { config: { host: { enabled: false } } } } },
          },
        }),
        "show_widget",
      ),
    ).toBe(false);
  });

  it("keeps the core widget tool out when OPENCLAW_SKIP_CANVAS_HOST is set", () => {
    withEnv({ OPENCLAW_SKIP_CANVAS_HOST: "1" }, () => {
      expect(hasTool(createOpenClawTools({ clientCaps: ["inline-widgets"] }), "show_widget")).toBe(
        false,
      );
    });
  });

  it("only exposes screen to UI-command clients", () => {
    expect(hasTool(createOpenClawTools(), "screen")).toBe(false);
    expect(hasTool(createOpenClawTools({ clientCaps: ["ui-commands"] }), "screen")).toBe(true);
  });

  it("omits host UI runtime tools for sandboxed agents", () => {
    expect(hasTool(createOpenClawTools({ agentSessionKey: "agent:main:main" }), "terminal")).toBe(
      true,
    );
    expect(hasTool(createOpenClawTools({ agentSessionKey: "agent:main:main" }), "portal")).toBe(
      true,
    );
    expect(
      hasTool(
        createOpenClawTools({ agentSessionKey: "agent:main:main", sandboxed: true }),
        "terminal",
      ),
    ).toBe(false);
    expect(
      hasTool(
        createOpenClawTools({ agentSessionKey: "agent:main:main", sandboxed: true }),
        "portal",
      ),
    ).toBe(false);
  });

  it("does not let tools.allow resurrect a gated tool for a channel run", () => {
    const tools = createOpenClawCodingTools({
      messageProvider: "telegram",
      disableMessageTool: true,
      config: { tools: { allow: ["show_widget"] } },
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: true,
      },
    });

    expect(hasTool(tools, "show_widget")).toBe(false);
  });

  it("does not add the core widget tool to plugin-only construction plans", () => {
    const plan = {
      includeBaseCodingTools: false,
      includeShellTools: false,
      includeChannelTools: false,
      includeOpenClawTools: false,
      includePluginTools: true,
    };

    expect(
      hasTool(
        createOpenClawCodingTools({ messageProvider: "telegram", toolConstructionPlan: plan }),
        "show_widget",
      ),
    ).toBe(false);
    expect(
      hasTool(
        createOpenClawCodingTools({
          messageProvider: "webchat",
          clientCaps: ["inline-widgets"],
          toolConstructionPlan: plan,
        }),
        "show_widget",
      ),
    ).toBe(false);
  });
});
