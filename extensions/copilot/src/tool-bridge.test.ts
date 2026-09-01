// Copilot tests cover tool bridge plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Tool as SdkTool, ToolInvocation, ToolResultObject } from "@github/copilot-sdk";
import { expectDefined } from "@openclaw/normalization-core";
import { createOpenClawCodingTools as createRealOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import {
  type AnyAgentTool,
  type SandboxContext,
  wrapToolWithBeforeToolCallHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  buildContractReplyPayloads,
  createContractToolTerminalObserver,
  createOwnerBackedContractTool,
  textToolResult,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { readMemoryArtifactProvenance } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  loadPluginManifestRegistryCore,
  resetPluginRuntimeStateForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCopilotTestHostCapabilities } from "./host-capability.test-support.js";
import { createCopilotToolBridge as createCopilotToolBridgeImpl } from "./tool-bridge.js";

type CopilotToolBridgeInput = Parameters<typeof createCopilotToolBridgeImpl>[0];
type CopilotToolBridgeAttemptParams = NonNullable<CopilotToolBridgeInput["attemptParams"]>;
type CopilotToolBridgeTestInput = Omit<
  CopilotToolBridgeInput,
  "agentId" | "attemptParams" | "modelId" | "modelProvider" | "sessionId"
> &
  Partial<Pick<CopilotToolBridgeInput, "agentId" | "modelId" | "modelProvider" | "sessionId">> & {
    attemptParams?: Omit<CopilotToolBridgeAttemptParams, "hostCapabilities"> &
      Partial<Pick<CopilotToolBridgeAttemptParams, "hostCapabilities">>;
  };
const testHostCapabilities = createCopilotTestHostCapabilities();

function createCopilotToolBridge(input: CopilotToolBridgeTestInput) {
  const { attemptParams, ...baseInput } = input;
  const preparedInput: CopilotToolBridgeInput = {
    agentId: "agent-1",
    modelId: "gpt-4o",
    modelProvider: "github-copilot",
    sessionId: "session-1",
    ...baseInput,
    attemptParams: {
      ...attemptParams,
      hostCapabilities: attemptParams?.hostCapabilities ?? testHostCapabilities,
    },
  };
  return createCopilotToolBridgeImpl(preparedInput);
}
type ConvertToolOptions = Pick<
  CopilotToolBridgeInput,
  "abortSignal" | "beforeExecute" | "onToolCompleted"
> & {
  onAgentToolResult?: NonNullable<CopilotToolBridgeInput["attemptParams"]>["onAgentToolResult"];
  observeToolTerminal?: NonNullable<CopilotToolBridgeInput["attemptParams"]>["observeToolTerminal"];
};

type FakeTool = AnyAgentTool & {
  execute: ReturnType<typeof vi.fn>;
  prepareArguments?: ReturnType<typeof vi.fn>;
};

function flushAsync() {
  return Promise.resolve().then(() => {});
}

function makeInvocation(overrides: Partial<ToolInvocation> = {}): ToolInvocation {
  return {
    arguments: { value: "input" },
    sessionId: "session-1",
    toolCallId: "call-1",
    toolName: "tool-a",
    ...overrides,
  };
}

function makeTool(
  overrides: Partial<FakeTool> = {},
  result: { content?: unknown; details: unknown } = {
    content: [{ text: "done", type: "text" }],
    details: null,
  },
): FakeTool {
  return {
    description: "A fake tool",
    execute: vi.fn(async () => result),
    label: "Fake Tool",
    name: "tool-a",
    parameters: {
      properties: { value: { type: "string" } },
      type: "object",
    } as never,
    ...overrides,
  } as unknown as FakeTool;
}

function getError(result: ToolResultObject): string | undefined {
  return result.error;
}

function runSdkTool(tool: SdkTool, args: unknown, invocation = makeInvocation()) {
  if (!tool.handler) {
    throw new Error(`SDK tool '${tool.name}' has no handler`);
  }
  return tool.handler(args, invocation);
}

async function convertOpenClawToolToSdkToolForTest(
  sourceTool: AnyAgentTool,
  options: ConvertToolOptions,
): Promise<SdkTool> {
  const bridge = await createCopilotToolBridge({
    abortSignal: options.abortSignal,
    allowModelTools: true,
    attemptParams:
      options.onAgentToolResult || options.observeToolTerminal
        ? {
            ...(options.onAgentToolResult ? { onAgentToolResult: options.onAgentToolResult } : {}),
            ...(options.observeToolTerminal
              ? { observeToolTerminal: options.observeToolTerminal }
              : {}),
          }
        : undefined,
    beforeExecute: options.beforeExecute,
    createOpenClawCodingTools: async () => [sourceTool],
    modelId: "gpt-test",
    onToolCompleted: options.onToolCompleted,
  });
  return expectDefined(bridge.promptToolPolicy.apply().tools[0], "Copilot SDK tool");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createCopilotToolBridge", () => {
  it("rejects a direct caller that omits the required host capability", async () => {
    const createOpenClawCodingTools = vi.fn(async () => [makeTool()]);
    await expect(
      createCopilotToolBridgeImpl({
        agentId: "agent-1",
        attemptParams: {} as never,
        createOpenClawCodingTools,
        modelId: "gpt-test",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      }),
    ).rejects.toThrow("Copilot attempt tools require host-bound capabilities");
    expect(createOpenClawCodingTools).not.toHaveBeenCalled();
  });

  it("binds every tool surface and retained source/SDK tools fail after capability closure", async () => {
    let active = true;
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const bindToolSurface = vi.fn((tools: AnyAgentTool[], _options?: Readonly<{ cwd?: string }>) =>
      tools.map((tool) => ({
        ...tool,
        execute: async (...args: Parameters<NonNullable<AnyAgentTool["execute"]>>) => {
          if (!active) {
            throw new Error("agent harness host capability is no longer active");
          }
          return await tool.execute?.(...args);
        },
      })),
    );
    const bridge = await createCopilotToolBridge({
      cwd: "/tmp/copilot-native-cwd",
      attemptParams: {
        hostCapabilities: { ...testHostCapabilities, bindToolSurface },
      },
      createOpenClawCodingTools: async () => [makeTool({ execute })],
      modelId: "gpt-test",
    });
    const source = expectDefined(bridge.sourceTools[0], "bound Copilot source tool");
    const sdk = expectDefined(bridge.promptToolPolicy.apply().tools[0], "bound Copilot SDK tool");
    const copiedSourceExecute = source.execute;
    const copiedSdkHandler = sdk.handler;
    active = false;

    await expect(copiedSourceExecute?.("call-1", {})).rejects.toThrow("no longer active");
    await expect(copiedSdkHandler?.({}, makeInvocation())).resolves.toMatchObject({
      resultType: "failure",
      textResultForLlm: expect.stringContaining("no longer active"),
    });
    expect(bindToolSurface).toHaveBeenCalledTimes(1);
    expect(bindToolSurface).toHaveBeenCalledWith(expect.any(Array), {
      cwd: "/tmp/copilot-native-cwd",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns empty arrays for unsupported providers without calling the seam", async () => {
    const createOpenClawCodingTools = vi.fn(async () => [makeTool()]);

    const result = await createCopilotToolBridge({
      createOpenClawCodingTools,
      modelProvider: "openai",
    });

    expect(result.codeModeEngaged).toBe(false);
    expect(result.promptToolPolicy.apply()).toEqual({ tools: [], callableToolNames: [] });
    expect(result.sourceTools).toEqual([]);
    expect(createOpenClawCodingTools).toHaveBeenCalledTimes(0);
  });

  it("allows vetted BYOK providers to expose model tools", async () => {
    const sourceTools = [makeTool()];
    const createOpenClawCodingTools = vi.fn(async () => sourceTools);

    const result = await createCopilotToolBridge({
      allowModelTools: true,
      createOpenClawCodingTools,
      modelId: "gpt-test",
      modelProvider: "custom-openai",
    });

    expect(createOpenClawCodingTools).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "gpt-test",
        modelProvider: "custom-openai",
      }),
    );
    expect(result.sourceTools).toEqual(sourceTools);
    expect(result.promptToolPolicy.apply().tools.map((tool) => tool.name)).toEqual(["tool-a"]);
  });

  it("forwards supported fields to injected createOpenClawCodingTools", async () => {
    const controller = new AbortController();
    const computerContextEpoch = { value: 0 };
    const createOpenClawCodingTools = vi.fn(async () => [makeTool()]);

    await createCopilotToolBridge({
      abortSignal: controller.signal,
      agentDir: "/agent",
      computerContextEpoch,
      createOpenClawCodingTools,
      cwd: "/workspace/task",
      sessionKey: "session-key",
      workspaceDir: "/workspace",
    });

    expect(createOpenClawCodingTools).toHaveBeenCalledTimes(1);
    // F6: the bridge now forwards PI-parity context fields too. This
    // test continues to assert the core flat fields plumb through; full
    // PI-parity is asserted in dedicated tests below.
    expect(createOpenClawCodingTools).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: controller.signal,
        agentDir: "/agent",
        agentId: "agent-1",
        computerContextEpoch,
        cwd: "/workspace/task",
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
        // sessionKey is the sandboxSessionKey derivation; with no
        // attemptParams the bridge falls back to input.sessionKey.
        sessionKey: "session-key",
        workspaceDir: "/workspace",
      }),
    );
  });

  it("preserves prepared manifest-profile grants across direct and cataloged surfaces", async () => {
    await withTempDir("openclaw-copilot-profile-tools-", async (pluginRoot) => {
      const pluginId = "profile-probe-plugin";
      const profiledToolName = "profile_probe";
      const siblingToolName = "profile_sibling";
      const declaredToolNames = [profiledToolName, siblingToolName];
      const config = {
        plugins: {
          allow: [pluginId],
          entries: { [pluginId]: { enabled: true } },
          load: { paths: [pluginRoot] },
        },
      };
      await fs.writeFile(
        path.join(pluginRoot, "openclaw.plugin.json"),
        JSON.stringify({
          id: pluginId,
          configSchema: { type: "object", additionalProperties: false },
          contracts: { tools: declaredToolNames },
        }),
      );
      await fs.writeFile(
        path.join(pluginRoot, "index.cjs"),
        `module.exports = {
          id: ${JSON.stringify(pluginId)},
          register(api) {
            for (const name of ${JSON.stringify(declaredToolNames)}) {
              api.registerTool({
                name,
                label: name,
                description: name,
                parameters: { type: "object", properties: {} },
                execute() {
                  return { content: [{ type: "text", text: "ok" }], details: {} };
                },
              });
            }
          },
        };\n`,
      );
      const manifestRegistry = loadPluginManifestRegistryCore({ config });
      const manifest = expectDefined(
        manifestRegistry.plugins.find((candidate) => candidate.id === pluginId),
        "profile probe manifest",
      );
      const preparedModelRuntime = {
        metadataSnapshot: {
          index: { plugins: [] },
          plugins: [
            {
              ...manifest,
              toolMetadata: {
                [profiledToolName]: { profiles: ["coding", "messaging"] },
              },
            },
          ],
        },
      } as never;
      try {
        const sharedFullControl = createRealOpenClawCodingTools({
          config: { ...config, tools: { profile: "full" } },
          includeCoreTools: false,
          toolConstructionPlan: {
            includeBaseCodingTools: false,
            includeChannelTools: false,
            includeOpenClawTools: false,
            includePluginTools: true,
            includeShellTools: false,
          },
        });
        expect({
          names: sharedFullControl.map((tool) => tool.name),
        }).toEqual({ names: declaredToolNames });

        for (const profile of ["coding", "messaging"] as const) {
          const sharedTools = createRealOpenClawCodingTools({
            config: { ...config, tools: { profile } },
            includeCoreTools: false,
            preparedModelRuntime,
            toolConstructionPlan: {
              includeBaseCodingTools: false,
              includeChannelTools: false,
              includeOpenClawTools: false,
              includePluginTools: true,
              includeShellTools: false,
            },
          });
          expect(sharedTools.map((tool) => tool.name)).toEqual([profiledToolName]);
        }

        const cases = [
          { profile: "coding", surface: "direct" },
          { profile: "messaging", surface: "direct" },
          { profile: "coding", surface: "tool-search" },
          { profile: "messaging", surface: "code-mode" },
        ] as const;
        const observedSurfaces: Array<{
          profile: (typeof cases)[number]["profile"];
          surface: (typeof cases)[number]["surface"];
          profiledTool: boolean;
          undeclaredSibling: boolean;
        }> = [];
        for (const { profile, surface } of cases) {
          let catalogRef: { current?: { entries?: Array<{ name: string }> } } | undefined;
          const result = await createCopilotToolBridge({
            attemptParams: {
              config: {
                ...config,
                tools: {
                  profile,
                  ...(surface === "tool-search" ? { toolSearch: true } : {}),
                  ...(surface === "code-mode" ? { codeMode: true } : {}),
                },
              },
              preparedModelRuntime,
              runId: `profile-${profile}-${surface}`,
              sessionKey: `agent:agent-1:${profile}-${surface}`,
            } as never,
            createOpenClawCodingTools: (options) => {
              catalogRef = options?.toolSearchCatalogRef as typeof catalogRef;
              return createRealOpenClawCodingTools(options);
            },
            sessionId: `${profile}-${surface}`,
          });
          const surfacedNames =
            surface === "direct"
              ? result.sourceTools.map((tool) => tool.name)
              : (catalogRef?.current?.entries?.map((entry) => entry.name) ?? []);
          observedSurfaces.push({
            profile,
            surface,
            profiledTool: surfacedNames.includes(profiledToolName),
            undeclaredSibling: surfacedNames.includes(siblingToolName),
          });
        }
        expect(observedSurfaces).toEqual(
          cases.map(({ profile, surface }) => ({
            profile,
            surface,
            profiledTool: true,
            undeclaredSibling: false,
          })),
        );

        const fullWithoutPrepared = await createCopilotToolBridge({
          attemptParams: { config: { ...config, tools: { profile: "full" } } } as never,
          createOpenClawCodingTools: createRealOpenClawCodingTools,
          sessionId: "full-without-prepared",
        });
        expect(
          fullWithoutPrepared.sourceTools
            .map((tool) => tool.name)
            .filter((name) => declaredToolNames.includes(name)),
        ).toEqual(declaredToolNames);
      } finally {
        resetPluginRuntimeStateForTest();
      }
    });
  });

  it("returns prompt-policy and source tools with matching direct surfaces", async () => {
    const sourceTools = [makeTool(), makeTool({ name: "tool-b" })];

    const result = await createCopilotToolBridge({
      createOpenClawCodingTools: async () => sourceTools,
    });

    expect(result.sourceTools).toEqual(sourceTools);
    expect(result.promptToolPolicy.apply().tools).toHaveLength(2);
    expect(result.promptToolPolicy.apply().tools.map((tool) => tool.name)).toEqual([
      "tool-a",
      "tool-b",
    ]);
  });

  it("preserves direct-only OpenClaw through the exact Copilot allowlist", async () => {
    const systemAgentTool = makeTool({
      name: "openclaw",
      catalogMode: "direct-only",
    } as never);

    const result = await createCopilotToolBridge({
      agentId: "openclaw",
      attemptParams: {
        runId: "openclaw-turn-1",
        sessionKey: "agent:openclaw:main",
        toolsAllow: ["openclaw"],
      } as never,
      createOpenClawCodingTools: async () => [systemAgentTool],
      modelId: "gpt-4.1",
      sessionId: "openclaw-session",
    });

    expect(result.sourceTools).toEqual([systemAgentTool]);
    expect(result.promptToolPolicy.apply().tools.map((tool) => tool.name)).toEqual(["openclaw"]);
  });

  it("compacts the Copilot tool surface behind tool_search controls when enabled", async () => {
    const createOpenClawCodingTools = vi.fn(async (opts: unknown) => {
      const includeToolSearchControls = Boolean(
        (opts as { includeToolSearchControls?: boolean }).includeToolSearchControls,
      );
      return includeToolSearchControls
        ? [
            makeTool({ name: "tool_search_code" }),
            makeTool({ name: "fake_hidden" }),
            makeTool({ name: "read" }),
          ]
        : [makeTool({ name: "fake_hidden" }), makeTool({ name: "read" })];
    });

    const result = await createCopilotToolBridge({
      attemptParams: {
        config: { tools: { toolSearch: true } },
        runId: "run-tool-search",
        sessionKey: "agent:agent-1:main",
      } as never,
      createOpenClawCodingTools,
    });

    expect(createOpenClawCodingTools).toHaveBeenCalledWith(
      expect.objectContaining({
        includeToolSearchControls: true,
        toolSearchCatalogRef: expect.any(Object),
        toolSearchCatalogExecutor: expect.any(Function),
      }),
    );
    expect(result.sourceTools.map((tool) => tool.name)).toEqual(["tool_search_code", "read"]);
    expect(result.promptToolPolicy.apply().tools.map((tool) => tool.name)).toEqual([
      "tool_search_code",
      "read",
    ]);
    expect(result.promptToolPolicy.apply().callableToolNames).toEqual([
      "tool_search_code",
      "read",
      "fake_hidden",
    ]);
    expect(result.promptToolPolicy.apply({ toolsAllow: ["fake_hidden"] })).toMatchObject({
      callableToolNames: ["tool_search_code", "fake_hidden"],
      tools: [expect.objectContaining({ name: "tool_search_code" })],
    });
  });

  it("keeps tool_search controls visible when a narrow allowlist is active", async () => {
    const createOpenClawCodingTools = vi.fn(async (opts: unknown) => {
      const includeToolSearchControls = Boolean(
        (opts as { includeToolSearchControls?: boolean }).includeToolSearchControls,
      );
      return includeToolSearchControls
        ? [makeTool({ name: "tool_search_code" }), makeTool({ name: "read" })]
        : [makeTool({ name: "read" })];
    });

    const result = await createCopilotToolBridge({
      attemptParams: {
        config: { tools: { toolSearch: true } },
        runId: "run-tool-search",
        sessionKey: "agent:agent-1:main",
        toolsAllow: ["read"],
      } as never,
      createOpenClawCodingTools,
    });

    expect(result.sourceTools.map((tool) => tool.name)).toEqual(["tool_search_code", "read"]);
    expect(result.promptToolPolicy.apply().tools.map((tool) => tool.name)).toEqual([
      "tool_search_code",
      "read",
    ]);
  });

  it("filters the hidden tool_search catalog before compacting narrowed tools", async () => {
    let catalogRef: { current?: { entries?: Array<{ name: string }> } } | undefined;
    const createOpenClawCodingTools = vi.fn(async (opts: unknown) => {
      catalogRef = (opts as { toolSearchCatalogRef?: typeof catalogRef }).toolSearchCatalogRef;
      return [
        makeTool({ name: "tool_search_code" }),
        makeTool({ name: "read" }),
        makeTool({ name: "edit" }),
        makeTool({ name: "write" }),
      ];
    });

    await createCopilotToolBridge({
      attemptParams: {
        config: { tools: { toolSearch: true } },
        runId: "run-tool-search",
        sessionKey: "agent:agent-1:main",
        toolsAllow: ["read"],
      } as never,
      createOpenClawCodingTools,
    });

    expect(catalogRef?.current?.entries?.map((entry) => entry.name)).toEqual(["read"]);
  });

  it("compacts the Copilot tool surface behind code-mode exec/wait when enabled", async () => {
    const createOpenClawCodingTools = vi.fn(async () => [
      makeTool({ name: "fake_hidden" }),
      makeTool({ name: "read" }),
    ]);

    const result = await createCopilotToolBridge({
      attemptParams: {
        config: { tools: { codeMode: true } },
        runId: "run-code-mode",
        sessionKey: "agent:agent-1:main",
      } as never,
      createOpenClawCodingTools,
    });

    expect(createOpenClawCodingTools).toHaveBeenCalledWith(
      expect.objectContaining({
        includeToolSearchControls: false,
        toolSearchCatalogRef: expect.any(Object),
        toolSearchCatalogExecutor: expect.any(Function),
      }),
    );
    expect(result.codeModeEngaged).toBe(true);
    expect(result.sourceTools.map((tool) => tool.name)).toEqual(["exec", "wait"]);
    expect(result.promptToolPolicy.apply().tools.map((tool) => tool.name)).toEqual([
      "exec",
      "wait",
    ]);
    expect(result.promptToolPolicy.apply().callableToolNames).toEqual([
      "exec",
      "wait",
      "fake_hidden",
      "read",
    ]);
  });

  it("binds retained code-mode source and SDK controls exactly once", async () => {
    let active = true;
    const hiddenExecute = vi.fn(async () => ({ content: [], details: {} }));
    const bindToolSurface = vi.fn((tools: AnyAgentTool[], _options?: Readonly<{ cwd?: string }>) =>
      tools.map((tool) => {
        const execute = tool.execute;
        const bound = {
          ...tool,
          execute: async (...args: Parameters<NonNullable<AnyAgentTool["execute"]>>) => {
            if (!active) {
              throw new Error("agent harness host capability is no longer active");
            }
            return await execute?.(...args);
          },
        } as AnyAgentTool;
        return bound;
      }),
    );
    const bridge = await createCopilotToolBridge({
      cwd: "/tmp/copilot-code-mode-cwd",
      attemptParams: {
        config: { tools: { codeMode: true } },
        hostCapabilities: { ...testHostCapabilities, bindToolSurface },
        runId: "run-code-mode-bound",
        sessionKey: "agent:agent-1:main",
      },
      createOpenClawCodingTools: async () => [makeTool({ execute: hiddenExecute, name: "read" })],
      modelId: "gpt-test",
    });
    const source = expectDefined(
      bridge.sourceTools.find((tool) => tool.name === "exec"),
      "bound code-mode source control",
    );
    const sdk = expectDefined(
      bridge.promptToolPolicy.apply().tools.find((tool) => tool.name === "exec"),
      "bound code-mode SDK control",
    );
    const copiedSourceExecute = source.execute;
    const copiedSdkHandler = sdk.handler;
    active = false;

    await expect(copiedSourceExecute?.("call-1", { code: "return 1" })).rejects.toThrow(
      "no longer active",
    );
    await expect(copiedSdkHandler?.({ code: "return 1" }, makeInvocation())).resolves.toMatchObject(
      {
        resultType: "failure",
        textResultForLlm: expect.stringContaining("no longer active"),
      },
    );
    expect(bindToolSurface).toHaveBeenCalledTimes(2);
    expect(bindToolSurface.mock.calls.map(([tools]) => tools.map((tool) => tool.name))).toEqual([
      ["read"],
      ["exec", "wait"],
    ]);
    expect(bindToolSurface.mock.calls.map(([, options]) => options)).toEqual([
      { cwd: "/tmp/copilot-code-mode-cwd" },
      { cwd: "/tmp/copilot-code-mode-cwd" },
    ]);
    expect(hiddenExecute).not.toHaveBeenCalled();
  });

  it.each([
    { configured: false, override: undefined },
    { configured: true, override: false },
  ])(
    "keeps the direct surface when configured=$configured, invocation=$override",
    async ({ configured, override }) => {
      const result = await createCopilotToolBridge({
        attemptParams: {
          config: {
            tools: { codeMode: configured, toolSearch: false },
            agents: {
              entries: { "agent-1": {} },
              defaults: { models: { "github-copilot/gpt-4o": { codeMode: configured } } },
            },
          },
          codeModeOverride: override,
          runId: "run-no-code-mode",
          sessionKey: "agent:agent-1:main",
        },
        createOpenClawCodingTools: vi.fn(async () => [makeTool({ name: "read" })]),
      });
      try {
        expect(result.codeModeEngaged).toBe(false);
        expect(result.promptToolPolicy.apply().tools.map((tool) => tool.name)).toEqual(["read"]);
      } finally {
        result.cleanup?.();
      }
    },
  );

  it("keeps code-mode controls visible when a narrow allowlist is active", async () => {
    const createOpenClawCodingTools = vi.fn(async () => [
      makeTool({ name: "fake_hidden" }),
      makeTool({ name: "read" }),
    ]);

    const result = await createCopilotToolBridge({
      attemptParams: {
        config: { tools: { codeMode: true } },
        runId: "run-code-mode",
        sessionKey: "agent:agent-1:main",
        toolsAllow: ["read"],
      } as never,
      createOpenClawCodingTools,
    });

    expect(result.sourceTools.map((tool) => tool.name)).toEqual(["exec", "wait"]);
    expect(result.promptToolPolicy.apply().tools.map((tool) => tool.name)).toEqual([
      "exec",
      "wait",
    ]);
  });

  it("filters the hidden code-mode catalog before compacting narrowed tools", async () => {
    let catalogRef: { current?: { entries?: Array<{ name: string }> } } | undefined;
    const createOpenClawCodingTools = vi.fn(async (opts: unknown) => {
      catalogRef = (opts as { toolSearchCatalogRef?: typeof catalogRef }).toolSearchCatalogRef;
      return [makeTool({ name: "read" }), makeTool({ name: "edit" }), makeTool({ name: "write" })];
    });

    await createCopilotToolBridge({
      attemptParams: {
        config: { tools: { codeMode: true } },
        runId: "run-code-mode",
        sessionKey: "agent:agent-1:main",
        toolsAllow: ["read"],
      } as never,
      createOpenClawCodingTools,
    });

    expect(catalogRef?.current?.entries?.map((entry) => entry.name)).toEqual(["read"]);
  });

  it("throws when createOpenClawCodingTools returns a non-array", async () => {
    await expect(
      createCopilotToolBridge({
        agentId: "agent-1",
        createOpenClawCodingTools: async () => ({ tools: [] }) as never,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      }),
    ).rejects.toThrow("createOpenClawCodingTools must return an array");
  });

  it("throws when createOpenClawCodingTools rejects and includes the cause", async () => {
    await expect(
      createCopilotToolBridge({
        agentId: "agent-1",
        createOpenClawCodingTools: async () => {
          throw new Error("factory failed");
        },
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      }),
    ).rejects.toThrow("factory failed");
  });

  it("throws on duplicate tool names and lists all duplicates", async () => {
    await expect(
      createCopilotToolBridge({
        agentId: "agent-1",
        createOpenClawCodingTools: async () => [
          makeTool({ name: "alpha" }),
          makeTool({ name: "beta" }),
          makeTool({ name: "alpha" }),
          makeTool({ name: "beta" }),
        ],
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      }),
    ).rejects.toThrow("duplicate tool names: alpha, beta");
  });

  // F6: PI-parity tool context. The bridged OpenClaw tools register
  // with the SDK as `overridesBuiltInTool: true, skipPermission: true`,
  // so the wrapped-tool enforcement layer
  // (src/agents/pi-tools.before-tool-call.ts) is the single gate for
  // permission, owner-only allowlists, loop detection, trusted-plugin
  // policies, and two-phase plugin approvals. Missing context fields
  // silently degrade those policy decisions. See round-3 maintainer
  // finding F6 and docs/plugins/copilot.md.
  describe("PI-parity attempt context (F6)", () => {
    function captureCall() {
      const createOpenClawCodingTools = vi.fn(async () => [makeTool()]);
      return {
        createOpenClawCodingTools,
        getOpts: () =>
          (createOpenClawCodingTools.mock.calls[0] as unknown[] | undefined)?.[0] as Record<
            string,
            unknown
          >,
      };
    }

    it("forwards identity, owner/policy, and channel/routing fields from attemptParams", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();
      const toolBindings = {
        browser: { kind: "tab", tabId: 7, target: "host", profile: "chrome", targetId: "target-7" },
      };

      await createCopilotToolBridge({
        attemptParams: {
          agentAccountId: "acct-1",
          toolBindings,
          senderId: "sender-1",
          senderName: "Ada",
          senderUsername: "ada",
          senderE164: "+15551234567",
          senderIsOwner: true,
          memberRoleIds: ["role-admin"],
          allowGatewaySubagentBinding: true,
          spawnedBy: "parent:agent",
          groupId: "g-1",
          groupChannel: "#general",
          groupSpace: "team-1",
          currentChannelId: "C123",
          currentMessagingTarget: "user:U123",
          currentThreadTs: "1700000000.000100",
          currentMessageId: "M-1",
          messageProvider: "slack",
          messageTo: "U-1",
          messageThreadId: "1700000000.000100",
          replyToMode: "first",
          requireExplicitMessageTarget: true,
          disableMessageTool: false,
          forceMessageTool: true,
          enableHeartbeatTool: true,
          forceHeartbeatTool: false,
          delegationCapability: "report_only",
        } as never,
        createOpenClawCodingTools,
      });

      const opts = getOpts();
      expect(opts).toMatchObject({
        agentAccountId: "acct-1",
        toolBindings,
        senderId: "sender-1",
        senderName: "Ada",
        senderUsername: "ada",
        senderE164: "+15551234567",
        senderIsOwner: true,
        memberRoleIds: ["role-admin"],
        allowGatewaySubagentBinding: true,
        spawnedBy: "parent:agent",
        groupId: "g-1",
        groupChannel: "#general",
        groupSpace: "team-1",
        currentChannelId: "C123",
        currentMessagingTarget: "user:U123",
        currentThreadTs: "1700000000.000100",
        currentMessageId: "M-1",
        messageProvider: "slack",
        messageTo: "U-1",
        messageThreadId: "1700000000.000100",
        replyToMode: "first",
        requireExplicitMessageTarget: true,
        forceMessageTool: true,
        enableHeartbeatTool: true,
        delegationCapability: "report_only",
      });
    });

    it("falls back messageProvider to attemptParams.messageChannel when messageProvider is absent (codex parity)", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();

      await createCopilotToolBridge({
        attemptParams: { messageChannel: "telegram" } as never,
        createOpenClawCodingTools,
      });

      expect(getOpts().messageProvider).toBe("telegram");
    });

    it("preserves the Discord channel separately from the voice provider", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();

      await createCopilotToolBridge({
        attemptParams: {
          agentAccountId: "account-a",
          messageChannel: "discord",
          messageProvider: "discord-voice",
        } as never,
        createOpenClawCodingTools,
      });

      expect(getOpts()).toMatchObject({
        agentAccountId: "account-a",
        messageChannel: "discord",
        messageProvider: "discord-voice",
      });
    });

    it("forwards authProfileStore, runId, config, and run hooks (onToolOutcome) from attemptParams", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();
      const authProfileStore = { kind: "fake-store" } as never;
      const config = { agents: {} } as never;
      const onToolOutcome = vi.fn();

      await createCopilotToolBridge({
        attemptParams: {
          authProfileStore,
          runId: "run-1",
          config,
          onToolOutcome,
          messageActionTurnCapability: "turn-capability-1",
        } as never,
        createOpenClawCodingTools,
      });

      const opts = getOpts();
      expect(opts.authProfileStore).toBe(authProfileStore);
      expect(opts.runId).toBe("run-1");
      expect(opts.config).toBe(config);
      expect(opts.onToolOutcome).toBe(onToolOutcome);
      expect(opts.messageActionTurnCapability).toBe("turn-capability-1");
    });

    it("quarantines owner memory writes, edits, and patches after a network tool", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-copilot-memory-"));
      await fs.mkdir(path.join(workspaceDir, "memory"));
      try {
        let turnTainted = false;
        const onToolOutcome = vi.fn<
          NonNullable<NonNullable<CopilotToolBridgeInput["attemptParams"]>["onToolOutcome"]>
        >((outcome) => {
          if (!outcome.presentationOnly && outcome.resultContentSource === "network") {
            turnTainted = true;
          }
        });
        const createTools = (rawOptions: unknown) => {
          const options = rawOptions as NonNullable<
            Parameters<typeof createRealOpenClawCodingTools>[0]
          >;
          const filesystemTools = createRealOpenClawCodingTools(options).filter((tool) =>
            ["write", "edit", "apply_patch"].includes(tool.name),
          );
          const networkTool = wrapToolWithBeforeToolCallHook(
            makeTool({ name: "web_fetch", resultContentSource: "network" }),
            {
              agentId: "main",
              sessionKey: options.sessionKey,
              sessionId: options.sessionId,
              runId: options.runId,
              onToolOutcome: options.onToolOutcome,
            },
            { emitDiagnostics: false },
          );
          return [...filesystemTools, networkTool];
        };
        const sessionKey = "agent:main:copilot-memory-session";
        const bridge = await createCopilotToolBridge({
          agentId: "main",
          attemptParams: {
            config: { tools: { fs: { workspaceOnly: true } } },
            onToolOutcome,
            isTurnTainted: () => turnTainted,
            runId: "copilot-memory-run",
            senderIsOwner: true,
            sessionKey,
            workspaceDir,
          },
          createOpenClawCodingTools: createTools,
          sessionId: "copilot-memory-session",
          sessionKey,
          workspaceDir,
        });
        const tool = (name: string) =>
          expectDefined(
            bridge.promptToolPolicy.apply().tools.find((candidate) => candidate.name === name),
            `Copilot ${name} tool`,
          );
        await runSdkTool(tool("write"), {
          path: "memory/trusted.md",
          content: "owner note\n",
        });
        await runSdkTool(
          tool("web_fetch"),
          {},
          makeInvocation({
            sessionId: "copilot-memory-session",
            toolCallId: "copilot-network-call",
            toolName: "web_fetch",
          }),
        );
        expect(onToolOutcome).toHaveBeenCalledWith(
          expect.objectContaining({ toolName: "web_fetch", resultContentSource: "network" }),
        );
        expect(turnTainted).toBe(true);

        await runSdkTool(tool("write"), {
          path: "memory/network.md",
          content: "network note\n",
        });
        await runSdkTool(tool("edit"), {
          path: "memory/trusted.md",
          edits: [{ oldText: "owner note", newText: "network edit" }],
        });
        await runSdkTool(tool("apply_patch"), {
          input: [
            "*** Begin Patch",
            "*** Add File: memory/patched.md",
            "+network patch",
            "*** End Patch",
          ].join("\n"),
        });

        const freshBridge = await createCopilotToolBridge({
          agentId: "main",
          attemptParams: {
            config: { tools: { fs: { workspaceOnly: true } } },
            isTurnTainted: () => false,
            runId: "copilot-fresh-run",
            senderIsOwner: true,
            sessionKey: "agent:main:copilot-fresh-session",
            workspaceDir,
          },
          createOpenClawCodingTools: createTools,
          sessionId: "copilot-fresh-session",
          sessionKey: "agent:main:copilot-fresh-session",
          workspaceDir,
        });
        await runSdkTool(
          expectDefined(
            freshBridge.promptToolPolicy
              .apply()
              .tools.find((candidate) => candidate.name === "write"),
            "fresh Copilot write tool",
          ),
          { path: "memory/fresh.md", content: "fresh owner note\n" },
        );

        await expect(
          Promise.all(
            ["memory/trusted.md", "memory/network.md", "memory/patched.md", "memory/fresh.md"].map(
              (relativePath) => readMemoryArtifactProvenance({ workspaceDir, relativePath }),
            ),
          ),
        ).resolves.toEqual([
          expect.objectContaining({ originClass: "untrusted" }),
          expect.objectContaining({ originClass: "untrusted" }),
          expect.objectContaining({ originClass: "untrusted" }),
          expect.objectContaining({ originClass: "agent" }),
        ]);
        await expect(
          fs.readFile(path.join(workspaceDir, "memory/trusted.md"), "utf8"),
        ).resolves.toBe("network edit\n");
        await expect(
          fs.readFile(path.join(workspaceDir, "memory/patched.md"), "utf8"),
        ).resolves.toBe("network patch\n");
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("prefers the unscoped toolAuthProfileStore when building OpenClaw tools", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();
      const authProfileStore = { kind: "transport-scoped-store" } as never;
      const toolAuthProfileStore = { kind: "tool-store" } as never;

      await createCopilotToolBridge({
        attemptParams: {
          authProfileStore,
          toolAuthProfileStore,
        } as never,
        createOpenClawCodingTools,
      });

      expect(getOpts().authProfileStore).toBe(toolAuthProfileStore);
    });

    it("derives sandboxSessionKey and runSessionKey from attemptParams (PI parity)", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();

      await createCopilotToolBridge({
        // Mirrors PI attempt.ts:1053-1060: when sandboxSessionKey
        // differs from sessionKey, sessionKey is published as the
        // sandbox key and the real run key is exposed as runSessionKey
        // so `session_status: "current"` resolves to the live session.
        attemptParams: {
          sandboxSessionKey: "sandbox:agent:agent-1",
          sessionKey: "agent:agent-1:main",
        } as never,
        createOpenClawCodingTools,
      });

      const opts = getOpts();
      expect(opts.sessionKey).toBe("sandbox:agent:agent-1");
      expect(opts.runSessionKey).toBe("agent:agent-1:main");
    });

    it("derives runSessionKey as undefined when sandboxSessionKey equals sessionKey", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();

      await createCopilotToolBridge({
        attemptParams: { sessionKey: "agent:agent-1:main" } as never,
        createOpenClawCodingTools,
      });

      const opts = getOpts();
      expect(opts.sessionKey).toBe("agent:agent-1:main");
      expect(opts.runSessionKey).toBeUndefined();
    });

    it("falls back sessionKey to input.sessionKey when attemptParams omits it (legacy callers)", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();

      await createCopilotToolBridge({
        attemptParams: {},
        createOpenClawCodingTools,
        sessionKey: "fallback-key",
      });

      expect(getOpts().sessionKey).toBe("fallback-key");
    });

    it.each([undefined, 8000])(
      "uses the effective read context (%s) with prepared model capabilities",
      async (contextTokenBudget) => {
        const { createOpenClawCodingTools, getOpts } = captureCall();

        await createCopilotToolBridge({
          attemptParams: {
            contextTokenBudget,
            model: {
              api: "openai-responses",
              contextWindow: 200_000,
              input: ["text", "image"],
              compat: { some: "shape" },
            },
          } as never,
          createOpenClawCodingTools,
        });

        const opts = getOpts();
        expect(opts.modelApi).toBe("openai-responses");
        expect(opts.modelContextWindowTokens).toBe(contextTokenBudget ?? 200_000);
        expect(opts.modelHasVision).toBe(true);
        expect(opts.modelCompat).toEqual({ some: "shape" });
      },
    );

    it("modelHasVision is false when model.input does not include 'image'", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();

      await createCopilotToolBridge({
        attemptParams: { model: { input: ["text"] } } as never,
        createOpenClawCodingTools,
      });

      expect(getOpts().modelHasVision).toBe(false);
    });

    it("spreads execOverrides and bashElevated into the exec field (PI parity)", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();
      const execOverrides = { security: "fast" } as never;
      const bashElevated = { allowed: true } as never;

      await createCopilotToolBridge({
        attemptParams: { execOverrides, bashElevated } as never,
        createOpenClawCodingTools,
      });

      const exec = getOpts().exec as Record<string, unknown>;
      expect(exec).toMatchObject({ security: "fast", elevated: { allowed: true } });
    });

    it("forwards run-trace and scheduled policy context", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();

      await createCopilotToolBridge({
        attemptParams: {
          trigger: "cron",
          jobId: "job-1",
          memoryFlushWritePath: ".memory/append.md",
          toolsAllow: ["read", "edit"],
          scheduledToolPolicy: {
            version: 1,
            mode: "account",
            ownerSessionKey: "agent:main:discord:group:ops",
            ownerAccountId: "default",
          },
        } as never,
        createOpenClawCodingTools,
      });

      const opts = getOpts();
      expect(opts.trigger).toBe("cron");
      expect(opts.jobId).toBe("job-1");
      expect(opts.memoryFlushWritePath).toBe(".memory/append.md");
      // buildEmbeddedAttemptToolRunContext renames toolsAllow ->
      // runtimeToolAllowlist; consumers (PI plugin tools) read the
      // renamed key, so the bridge must surface the renamed shape too.
      expect(opts.runtimeToolAllowlist).toEqual(["read", "edit"]);
      expect(opts.scheduledToolPolicy).toEqual({
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:main:discord:group:ops",
        ownerAccountId: "default",
      });
    });

    it("forwards the native conversation identity from attemptParams", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();

      await createCopilotToolBridge({
        attemptParams: {
          chatId: "oc_native_chat",
          chatType: "direct",
        } as never,
        createOpenClawCodingTools,
      });

      expect(getOpts()).toMatchObject({
        chatType: "direct",
        nativeChannelId: "oc_native_chat",
      });
    });

    it("onYield routes to sessionRef.current.abort() and invokes onYieldDetected when the live session is bound", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();
      const abort = vi.fn();
      const sessionRef: { current: { abort?: () => unknown } | undefined } = {
        current: undefined,
      };
      const onYieldDetected = vi.fn();

      await createCopilotToolBridge({
        createOpenClawCodingTools,
        onYieldDetected,
        sessionRef,
      });

      const onYield = getOpts().onYield as (message?: string, acknowledgment?: string) => void;
      // No session bound yet: onYield must no-op the abort path
      // without throwing, but the onYieldDetected notification fires
      // regardless so a yield before session-bind is still surfaced
      // to the final attempt result.
      expect(() => onYield("early yield", "Starting research.")).not.toThrow();
      expect(abort).toHaveBeenCalledTimes(0);
      expect(onYieldDetected).toHaveBeenCalledTimes(1);
      expect(onYieldDetected).toHaveBeenCalledWith("early yield", "Starting research.");

      // Bind the session after the fact (attempt.ts does this after
      // createSession/resumeSession resolves) and verify subsequent
      // yields abort it and continue to notify.
      sessionRef.current = { abort };
      onYield("now yield");
      expect(abort).toHaveBeenCalledTimes(1);
      expect(onYieldDetected).toHaveBeenCalledTimes(2);
      expect(onYieldDetected).toHaveBeenLastCalledWith("now yield", undefined);
    });

    it("onYield still aborts the live session when onYieldDetected throws (defense in depth)", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();
      const abort = vi.fn();
      const sessionRef: { current: { abort?: () => unknown } | undefined } = {
        current: { abort },
      };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      await createCopilotToolBridge({
        createOpenClawCodingTools,
        onYieldDetected: () => {
          throw new Error("handler boom");
        },
        sessionRef,
      });

      const onYield = getOpts().onYield as (message?: string, acknowledgment?: string) => void;
      expect(() => onYield("handler-fails-but-abort-must-fire")).not.toThrow();
      expect(abort).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it("requireExplicitMessageTarget defaults to isSubagentSessionKey(sessionKey) when undefined", async () => {
      const { createOpenClawCodingTools, getOpts } = captureCall();

      await createCopilotToolBridge({
        // No requireExplicitMessageTarget; sessionKey looks like a
        // subagent key so the default must be true. Mirrors PI
        // attempt.ts:1097-1098.
        attemptParams: { sessionKey: "subagent:envelope:abc" } as never,
        createOpenClawCodingTools,
      });

      const opts = getOpts();
      // We don't assert the exact boolean (subagent detection is owned
      // by isSubagentSessionKey) — only that the bridge consulted the
      // helper rather than emitting `undefined`.
      expect(typeof opts.requireExplicitMessageTarget).toBe("boolean");
    });
  });

  describe("sandbox forwarding (PR #86155 [P1])", () => {
    function makeSandboxStub(overrides: Partial<SandboxContext> = {}): SandboxContext {
      return {
        enabled: true,
        workspaceAccess: "ro",
        workspaceDir: "/sandbox/copy",
        agentWorkspaceDir: "/sandbox/agent",
        scopeKey: "agent-1:session-1",
        sessionKey: "session-1",
        backend: { kind: "local" } as never,
        cfg: {} as never,
        ...overrides,
      } as unknown as SandboxContext;
    }

    it("defaults sandbox to undefined and derives spawnWorkspaceDir from workspaceDir when no sandbox is passed (back-compat)", async () => {
      const createOpenClawCodingTools = vi.fn(async () => [makeTool()]);
      await createCopilotToolBridge({
        createOpenClawCodingTools,
        sessionKey: "session-1",
        workspaceDir: "/workspace",
      });
      const opts = (createOpenClawCodingTools.mock.calls[0] as unknown[] | undefined)?.[0] as {
        sandbox?: unknown;
        spawnWorkspaceDir?: unknown;
        workspaceDir?: unknown;
      };
      expect(opts.sandbox).toBeUndefined();
      expect(opts.workspaceDir).toBe("/workspace");
      // resolveAttemptSpawnWorkspaceDir returns undefined for the
      // no-sandbox path; the back-compat fallback emits that.
      expect(opts.spawnWorkspaceDir).toBeUndefined();
    });

    it("forwards an explicit sandbox and spawnWorkspaceDir verbatim to createOpenClawCodingTools", async () => {
      const sandbox = makeSandboxStub();
      const createOpenClawCodingTools = vi.fn(async () => [makeTool()]);
      await createCopilotToolBridge({
        createOpenClawCodingTools,
        sandbox,
        sessionKey: "session-1",
        spawnWorkspaceDir: "/original-workspace",
        workspaceDir: "/sandbox/copy",
      });
      const opts = (createOpenClawCodingTools.mock.calls[0] as unknown[] | undefined)?.[0] as {
        sandbox?: unknown;
        spawnWorkspaceDir?: unknown;
        workspaceDir?: unknown;
      };
      expect(opts.sandbox).toBe(sandbox);
      expect(opts.workspaceDir).toBe("/sandbox/copy");
      expect(opts.spawnWorkspaceDir).toBe("/original-workspace");
    });

    it("derives spawnWorkspaceDir from sandbox when caller omits it (fallback path)", async () => {
      const sandbox = makeSandboxStub({ workspaceAccess: "ro" });
      const createOpenClawCodingTools = vi.fn(async () => [makeTool()]);
      await createCopilotToolBridge({
        createOpenClawCodingTools,
        sandbox,
        sessionKey: "session-1",
        workspaceDir: "/sandbox/copy",
      });
      const opts = (createOpenClawCodingTools.mock.calls[0] as unknown[] | undefined)?.[0] as {
        spawnWorkspaceDir?: unknown;
      };
      // Fallback derives spawnWorkspaceDir from (effective) workspaceDir
      // since the caller didn't pre-compute one. For a ro/none sandbox
      // this yields the effective dir (= sandbox copy). Production
      // callers (attempt.ts) always pre-compute spawnWorkspaceDir from
      // the original workspace; the fallback is for test fixtures.
      expect(opts.spawnWorkspaceDir).toBe("/sandbox/copy");
    });
  });

  // The Copilot bridge mirrors the PI runner's disable/raw/allowlist
  // gates locally (codex-precedent at
  // extensions/codex/src/app-server/run-attempt.ts:3813,3906-3939,4220-4234)
  // so a Copilot run cannot expose the SDK any tool that the same
  // OpenClaw attempt would suppress. These tests pin the contract.
  describe("tool-surface gating (PR #86155 [P1] round-6)", () => {
    it.each([
      { toolsAllow: undefined, codeMode: false },
      { toolsAllow: ["read"], codeMode: false },
      { toolsAllow: [], codeMode: false },
      { toolsAllow: undefined, codeMode: true },
    ])("preserves the collector handoff and SDK result %j", async ({ toolsAllow, codeMode }) => {
      const schema = {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      };
      const output = makeTool({ name: "structured_output", catalogMode: "direct-only" });
      // The host contract is checked below, not recreated inside this factory.
      const createTools = vi.fn(async () => [makeTool({ name: "read" }), output]);
      const bridge = await createCopilotToolBridge({
        attemptParams: {
          config: { tools: { codeMode } },
          runId: "copilot-collector-contract",
          toolsAllow,
          swarmCollector: true,
          swarmOutputSchema: schema,
        },
        createOpenClawCodingTools: createTools,
      });
      try {
        expect(createTools).toHaveBeenCalledWith(
          expect.objectContaining({
            swarmCollector: true,
            swarmOutputSchema: schema,
            ...(toolsAllow ? { runtimeToolAllowlist: [...toolsAllow, "structured_output"] } : {}),
          }),
        );
        const initial = bridge.promptToolPolicy.apply();
        expect(initial.callableToolNames).toContain("structured_output");
        if (toolsAllow) {
          expect(initial.tools.map((tool) => tool.name).toSorted()).toEqual(
            [...toolsAllow, "structured_output"].toSorted(),
          );
        }
        // Prompt hooks narrow the already-compacted surface a second time.
        const narrowed = bridge.promptToolPolicy.apply({ toolsAllow: ["read"] });
        expect(narrowed.callableToolNames).toContain("structured_output");
        const sdkOutput = expectDefined(
          narrowed.tools.find((tool) => tool.name === "structured_output"),
          "collector structured output tool",
        );
        expect(sdkOutput.defer).toBe("never");
        const args = { result: { answer: "ok" } };
        await expect(runSdkTool(sdkOutput, args)).resolves.toEqual({
          resultType: "success",
          textResultForLlm: "done",
        });
        expect(output.execute).toHaveBeenCalledWith("call-1", args, undefined, undefined);
      } finally {
        bridge.cleanup?.();
      }
    });

    it("submits the exact conversation-policy-filtered catalog to the SDK", async () => {
      await withTempDir("openclaw-copilot-policy-", async (workspaceDir) => {
        const result = await createCopilotToolBridge({
          attemptParams: {
            conversationToolPolicy: {
              deny: ["exec", "process", "write", "edit", "ask_user"],
            },
            runId: "policy-run",
            sessionKey: "agent:agent-1:policy-session",
            workspaceDir,
          } as never,
          createOpenClawCodingTools: createRealOpenClawCodingTools,
          sessionId: "policy-session",
          sessionKey: "agent:agent-1:policy-session",
          workspaceDir,
        });
        const names = result.promptToolPolicy.apply().tools.map((tool) => tool.name);

        expect(names).toContain("read");
        expect(names).toContain("apply_patch");
        expect(names).not.toContain("exec");
        expect(names).not.toContain("process");
        expect(names).not.toContain("write");
        expect(names).not.toContain("edit");
        expect(names).not.toContain("ask_user");
      });
    });

    it("enforces the retained sandbox owner's write deny before SDK tool execution", async () => {
      await withTempDir("openclaw-copilot-policy-owner-", async (workspaceDir) => {
        for (const sandboxAgentId of ["marketing", "main"]) {
          const sessionKey = "agent:marketing:policy-owner-test";
          const bridge = await createCopilotToolBridge({
            agentId: "marketing",
            attemptParams: {
              config: {
                agents: { entries: { main: { tools: { deny: ["write"] } }, marketing: {} } },
                tools: { codeMode: false, toolSearch: false },
              },
              sandboxAgentId,
              sandboxSessionKey: "global",
              sessionKey,
              runId: `policy-owner-${sandboxAgentId}`,
              workspaceDir,
            },
            createOpenClawCodingTools: createRealOpenClawCodingTools,
            sessionKey,
            workspaceDir,
          });
          try {
            const write = bridge.promptToolPolicy
              .apply()
              .tools.find((tool) => tool.name === "write");
            if (write) {
              const outputPath = path.join(workspaceDir, `${sandboxAgentId}.txt`);
              await expect(
                runSdkTool(write, { path: outputPath, content: "retained policy proof" }),
              ).resolves.toMatchObject({ resultType: "success" });
              await expect(fs.readFile(outputPath, "utf8")).resolves.toBe("retained policy proof");
            }
            expect(await fs.readdir(workspaceDir)).toEqual(["marketing.txt"]);
            expect(write === undefined).toBe(sandboxAgentId === "main");
          } finally {
            bridge.cleanup?.();
          }
        }
      });
    });

    it.each([{ disableTools: true }, { promptMode: "none" }, { modelRun: true }] as const)(
      "skips tool construction for %j",
      async (attemptParams) => {
        const createOpenClawCodingTools = vi.fn(async () => [makeTool()]);
        const result = await createCopilotToolBridge({
          attemptParams,
          createOpenClawCodingTools,
        });
        expect(result.codeModeEngaged).toBe(false);
        expect(result.promptToolPolicy.apply()).toEqual({ tools: [], callableToolNames: [] });
        expect(result.sourceTools).toEqual([]);
        expect(createOpenClawCodingTools).toHaveBeenCalledTimes(0);
      },
    );

    it("filters constructed tools to exactly the allowlist when toolsAllow is narrow", async () => {
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "read" }),
        makeTool({ name: "edit" }),
        makeTool({ name: "message" }),
      ]);
      const result = await createCopilotToolBridge({
        attemptParams: { toolsAllow: ["read"] } as never,
        createOpenClawCodingTools,
      });
      expect(result.sourceTools.map((tool) => tool.name)).toEqual(["read"]);
      expect(result.promptToolPolicy.apply().tools.map((tool) => tool.name)).toEqual(["read"]);
    });

    it("returns no tools when toolsAllow is an empty list and nothing is forced", async () => {
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "read" }),
        makeTool({ name: "edit" }),
      ]);
      const result = await createCopilotToolBridge({
        attemptParams: { toolsAllow: [] } as never,
        createOpenClawCodingTools,
      });
      expect(result.sourceTools).toEqual([]);
      expect(result.promptToolPolicy.apply().tools).toEqual([]);
    });

    it('merges "message" into an empty allowlist when forceMessageTool is true', async () => {
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "read" }),
        makeTool({ name: "message" }),
      ]);
      const result = await createCopilotToolBridge({
        attemptParams: { toolsAllow: [], forceMessageTool: true } as never,
        createOpenClawCodingTools,
      });
      expect(result.sourceTools.map((tool) => tool.name)).toEqual(["message"]);
    });

    it('merges "message" into an empty allowlist when sourceReplyDeliveryMode is message_tool_only', async () => {
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "read" }),
        makeTool({ name: "message" }),
      ]);
      const result = await createCopilotToolBridge({
        attemptParams: {
          toolsAllow: [],
          sourceReplyDeliveryMode: "message_tool_only",
        } as never,
        createOpenClawCodingTools,
      });
      expect(result.sourceTools.map((tool) => tool.name)).toEqual(["message"]);
    });

    it('appends "message" to a narrow allowlist when forceMessageTool is true', async () => {
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "read" }),
        makeTool({ name: "edit" }),
        makeTool({ name: "message" }),
      ]);
      const result = await createCopilotToolBridge({
        attemptParams: {
          toolsAllow: ["read"],
          forceMessageTool: true,
        } as never,
        createOpenClawCodingTools,
      });
      expect(result.sourceTools.map((tool) => tool.name).toSorted()).toEqual(["message", "read"]);
    });

    it("does NOT force a message tool when disableMessageTool is true (disable wins over force)", async () => {
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "read" }),
        makeTool({ name: "message" }),
      ]);
      const result = await createCopilotToolBridge({
        attemptParams: {
          toolsAllow: ["read"],
          forceMessageTool: true,
          disableMessageTool: true,
        } as never,
        createOpenClawCodingTools,
      });
      expect(result.sourceTools.map((tool) => tool.name)).toEqual(["read"]);
    });

    it("leaves the tool list unchanged when toolsAllow is undefined", async () => {
      const tools = [makeTool({ name: "read" }), makeTool({ name: "edit" })];
      const createOpenClawCodingTools = vi.fn(async () => tools);
      const result = await createCopilotToolBridge({
        attemptParams: {} as never,
        createOpenClawCodingTools,
      });
      expect(result.sourceTools.map((tool) => tool.name)).toEqual(["read", "edit"]);
    });

    it("leaves the tool list unchanged when toolsAllow contains a wildcard", async () => {
      const tools = [makeTool({ name: "read" }), makeTool({ name: "edit" })];
      const createOpenClawCodingTools = vi.fn(async () => tools);
      const result = await createCopilotToolBridge({
        attemptParams: { toolsAllow: ["*"] } as never,
        createOpenClawCodingTools,
      });
      expect(result.sourceTools.map((tool) => tool.name)).toEqual(["read", "edit"]);
    });

    it("runs duplicate detection AFTER allowlist filtering so a suppressed duplicate does not fail a narrow run", async () => {
      // The raw construction returns duplicate "edit" entries, but the
      // allowlist excludes "edit" entirely. PI parity: the duplicate
      // never reaches the SDK, so the bridge must not throw.
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "read" }),
        makeTool({ name: "edit" }),
        makeTool({ name: "edit" }),
      ]);
      const result = await createCopilotToolBridge({
        attemptParams: { toolsAllow: ["read"] } as never,
        createOpenClawCodingTools,
      });
      expect(result.sourceTools.map((tool) => tool.name)).toEqual(["read"]);
    });

    it("still throws when the filtered tool set itself contains duplicates", async () => {
      // Both copies of "read" survive the allowlist, so the duplicate
      // truly reaches the SDK and the bridge must fail loudly.
      await expect(
        createCopilotToolBridge({
          agentId: "agent-1",
          attemptParams: { toolsAllow: ["read"] } as never,
          createOpenClawCodingTools: async () => [
            makeTool({ name: "read" }),
            makeTool({ name: "read" }),
          ],
          modelId: "gpt-4o",
          modelProvider: "github-copilot",
          sessionId: "session-1",
        }),
      ).rejects.toThrow("duplicate tool names: read");
    });
  });

  // Codex extension already normalises a small set of tool-name aliases
  // before allowlist matching
  // (extensions/codex/src/app-server/dynamic-tool-profile.ts:17-30
  // + extensions/codex/src/app-server/run-attempt.test.ts:2062). The
  // Copilot bridge mirrors the same two aliases so a `toolsAllow: ["bash"]`
  // or `toolsAllow: ["apply-patch"]` resolves to the underlying tool.
  describe("tool-name aliases (PR #86155 [P1] round-7)", () => {
    it('matches the "exec" tool when toolsAllow contains "bash"', async () => {
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "exec" }),
        makeTool({ name: "read" }),
      ]);
      const result = await createCopilotToolBridge({
        attemptParams: { toolsAllow: ["bash"] } as never,
        createOpenClawCodingTools,
      });
      expect(result.sourceTools.map((tool) => tool.name)).toEqual(["exec"]);
    });

    it('matches the "apply_patch" tool when toolsAllow contains "apply-patch"', async () => {
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "apply_patch" }),
        makeTool({ name: "read" }),
      ]);
      const result = await createCopilotToolBridge({
        attemptParams: { toolsAllow: ["apply-patch"] } as never,
        createOpenClawCodingTools,
      });
      expect(result.sourceTools.map((tool) => tool.name)).toEqual(["apply_patch"]);
    });

    it("normalises case so uppercase/whitespace aliases still resolve", async () => {
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "exec" }),
        makeTool({ name: "apply_patch" }),
        makeTool({ name: "read" }),
      ]);
      const result = await createCopilotToolBridge({
        attemptParams: { toolsAllow: [" BASH ", "Apply-Patch", "READ"] } as never,
        createOpenClawCodingTools,
      });
      expect(result.sourceTools.map((tool) => tool.name).toSorted()).toEqual([
        "apply_patch",
        "exec",
        "read",
      ]);
    });

    it("continues to match canonical names directly (no double-aliasing)", async () => {
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "exec" }),
        makeTool({ name: "apply_patch" }),
      ]);
      const result = await createCopilotToolBridge({
        attemptParams: { toolsAllow: ["exec", "apply_patch"] } as never,
        createOpenClawCodingTools,
      });
      expect(result.sourceTools.map((tool) => tool.name).toSorted()).toEqual([
        "apply_patch",
        "exec",
      ]);
    });

    it("honors core group allowlists through the shared embedded-runner filter", async () => {
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "read" }),
        makeTool({ name: "edit" }),
      ]);
      const result = await createCopilotToolBridge({
        attemptParams: { toolsAllow: ["group:fs"] } as never,
        createOpenClawCodingTools,
      });
      expect(result.sourceTools.map((tool) => tool.name).toSorted()).toEqual(["edit", "read"]);
    });

    it("does not discard lean-mode overrides after tool construction", async () => {
      const result = await createCopilotToolBridge({
        attemptParams: {
          config: {
            agents: { defaults: { experimental: { localModelLean: true } } },
            tools: { alsoAllow: ["image_generate"] },
          },
        } as never,
        createOpenClawCodingTools: async () => [makeTool({ name: "image_generate" })],
      });

      expect(result.sourceTools.map((tool) => tool.name)).toEqual(["image_generate"]);
    });

    it("keeps plugin tools for plugin group allowlists", async () => {
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "memory_search", pluginId: "active-memory" } as never),
        makeTool({ name: "read" }),
      ]);
      const result = await createCopilotToolBridge({
        attemptParams: { toolsAllow: ["group:plugins"] } as never,
        createOpenClawCodingTools,
      });
      expect(result.sourceTools.map((tool) => tool.name)).toEqual(["memory_search"]);
    });

    it("keeps core tools available for glob allowlists", async () => {
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "web_fetch" }),
        makeTool({ name: "read" }),
      ]);
      const result = await createCopilotToolBridge({
        attemptParams: { toolsAllow: ["web_*"] } as never,
        createOpenClawCodingTools,
      });
      expect(result.sourceTools.map((tool) => tool.name)).toEqual(["web_fetch"]);
      const options = (createOpenClawCodingTools.mock.calls[0] as unknown[] | undefined)?.[0] as {
        toolConstructionPlan?: { includeOpenClawTools?: boolean };
      };
      expect(options?.toolConstructionPlan?.includeOpenClawTools).toBe(true);
    });

    it("constructs shell tools through the shared glob-aware plan", async () => {
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "exec" }),
        makeTool({ name: "read" }),
      ]);
      const result = await createCopilotToolBridge({
        attemptParams: { toolsAllow: ["exec*"] } as never,
        createOpenClawCodingTools,
      });
      expect(result.sourceTools.map((tool) => tool.name)).toEqual(["exec"]);
      const options = (createOpenClawCodingTools.mock.calls[0] as unknown[] | undefined)?.[0] as {
        toolConstructionPlan?: {
          includeBaseCodingTools?: boolean;
          includeShellTools?: boolean;
        };
      };
      expect(options?.toolConstructionPlan).toMatchObject({
        includeBaseCodingTools: false,
        includeShellTools: true,
      });
    });

    it("does not keep apply_patch for a write-only allowlist", async () => {
      const createOpenClawCodingTools = vi.fn(async () => [
        makeTool({ name: "write" }),
        makeTool({ name: "apply_patch" }),
      ]);
      const result = await createCopilotToolBridge({
        attemptParams: { toolsAllow: ["write"] } as never,
        createOpenClawCodingTools,
      });
      expect(result.sourceTools.map((tool) => tool.name)).toEqual(["write"]);
      const options = (createOpenClawCodingTools.mock.calls[0] as unknown[] | undefined)?.[0] as {
        toolConstructionPlan?: { includeShellTools?: boolean };
      };
      expect(options?.toolConstructionPlan?.includeShellTools).toBe(false);
    });
  });
});

describe("createCopilotToolBridge tool conversion", () => {
  it("throws on empty and non-string names", async () => {
    await expect(
      convertOpenClawToolToSdkToolForTest(makeTool({ name: "" as never }), {}),
    ).rejects.toThrow("tool name must be a non-empty string");
    await expect(
      convertOpenClawToolToSdkToolForTest(makeTool({ name: 42 as never }), {}),
    ).rejects.toThrow("tool name must be a non-empty string");
  });

  it("throws on non-function execute", async () => {
    await expect(
      convertOpenClawToolToSdkToolForTest(makeTool({ execute: "nope" as never }), {}),
    ).rejects.toThrow("must define an execute function");
  });

  it("preserves name, description, and parameters exactly", async () => {
    const parameters = {
      properties: { path: { type: "string" } },
      type: "object",
    };
    const sourceTool = makeTool({
      description: "Read a file",
      name: "read_file",
      parameters: parameters as never,
    });

    const result = await convertOpenClawToolToSdkToolForTest(sourceTool, {});

    expect(result.name).toBe("read_file");
    expect(result.description).toBe("Read a file");
    expect(result.parameters).toBe(parameters);
  });

  it("sets skipPermission: true so OpenClaw's wrapped-tool internal enforcement handles permission decisions (PI-parity model)", async () => {
    // Per the harness docs: every bridged OpenClaw tool comes from
    // `createOpenClawCodingTools`, which already wraps each tool with
    // `wrapToolWithBeforeToolCallHook` (loop detection, trusted plugin
    // policies, before-tool-call hooks, two-phase plugin approvals via
    // the gateway). Asking the SDK to run its own `onPermissionRequest`
    // for kind: "custom-tool" would either short-circuit OpenClaw's
    // richer enforcement (allow-all) or block every call (reject-all).
    // Setting `skipPermission: true` lets the wrapped execute() run
    // OpenClaw's hook with the right context — mirrors codex
    // (`extensions/codex/src/app-server/dynamic-tools.ts`).
    const result = (await convertOpenClawToolToSdkToolForTest(makeTool(), {})) as SdkTool & {
      skipPermission?: boolean;
    };

    expect(result.skipPermission).toBe(true);
  });

  it("marks every bridged tool as overridesBuiltInTool so OpenClaw owns names that collide with Copilot CLI built-ins (edit/read/write/bash/...)", async () => {
    // Real-world dogfood found that openclaw's createOpenClawCodingTools
    // returns a tool named `edit`, which the bundled Copilot CLI also ships
    // as a built-in. The SDK rejects the registration unless the external
    // tool is explicitly marked as an override.
    for (const name of ["edit", "read", "write", "bash", "live_echo"]) {
      const result = (await convertOpenClawToolToSdkToolForTest(
        makeTool({ name }),
        {},
      )) as SdkTool & { overridesBuiltInTool?: boolean };
      expect(result.overridesBuiltInTool).toBe(true);
    }
  });

  it("returns a failure result when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const sourceTool = makeTool();
    const sdkTool = await convertOpenClawToolToSdkToolForTest(sourceTool, {
      abortSignal: controller.signal,
    });

    const result = await runSdkTool(sdkTool, {});

    expect(sourceTool.execute).toHaveBeenCalledTimes(0);
    expect(result).toMatchObject({
      resultType: "failure",
      textResultForLlm: "[copilot-tool-bridge] aborted before execution",
    });
    expect(getError(result as ToolResultObject)).toBe(
      "[copilot-tool-bridge] aborted before execution",
    );
  });

  it("calls beforeExecute with the invocation context before execute", async () => {
    const beforeExecute = vi.fn(async () => undefined);
    const sourceTool = makeTool();
    const sdkTool = await convertOpenClawToolToSdkToolForTest(sourceTool, { beforeExecute });
    const invocation = makeInvocation({ toolCallId: "call-42" });
    const args = { value: "input" };

    await runSdkTool(sdkTool, args, invocation);

    expect(beforeExecute).toHaveBeenCalledTimes(1);
    expect(beforeExecute).toHaveBeenCalledWith({
      args,
      invocation,
      sourceTool,
      toolCallId: "call-42",
      toolName: "tool-a",
    });
    expect(
      expectDefined(beforeExecute.mock.invocationCallOrder[0], "Copilot before-execute invocation"),
    ).toBeLessThan(
      expectDefined(sourceTool.execute.mock.invocationCallOrder[0], "Copilot tool invocation"),
    );
  });

  it("returns a failure result when beforeExecute throws", async () => {
    const error = new Error("permission denied");
    const sourceTool = makeTool();
    const sdkTool = await convertOpenClawToolToSdkToolForTest(sourceTool, {
      beforeExecute: vi.fn(async () => {
        throw error;
      }),
    });

    const result = await runSdkTool(sdkTool, {});

    expect(sourceTool.execute).toHaveBeenCalledTimes(0);
    expect(result).toMatchObject({
      resultType: "failure",
      textResultForLlm:
        "[copilot-tool-bridge] beforeExecute failed for tool 'tool-a': permission denied",
    });
    expect(getError(result as ToolResultObject)).toBe(error.message);
  });

  it("calls prepareArguments and passes the prepared args and toolCallId to execute", async () => {
    const preparedArgs = { value: "prepared" };
    const onToolCompleted = vi.fn();
    const prepareArguments = vi.fn(() => preparedArgs);
    const sourceTool = makeTool({ prepareArguments });
    const sdkTool = await convertOpenClawToolToSdkToolForTest(sourceTool, { onToolCompleted });

    await runSdkTool(sdkTool, { value: "raw" }, makeInvocation({ toolCallId: "call-99" }));

    expect(prepareArguments).toHaveBeenCalledTimes(1);
    expect(prepareArguments).toHaveBeenCalledWith({ value: "raw" });
    expect(sourceTool.execute).toHaveBeenCalledWith("call-99", preparedArgs, undefined, undefined);
    expect(onToolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ args: preparedArgs, toolCallId: "call-99" }),
    );
  });

  it("returns a failure result when prepareArguments throws", async () => {
    const error = new Error("bad args");
    const sourceTool = makeTool({
      prepareArguments: vi.fn(() => {
        throw error;
      }),
    });
    const sdkTool = await convertOpenClawToolToSdkToolForTest(sourceTool, {});

    const result = await runSdkTool(sdkTool, {});

    expect(sourceTool.execute).toHaveBeenCalledTimes(0);
    expect(result).toMatchObject({
      resultType: "failure",
      textResultForLlm: "[copilot-tool-bridge] prepareArguments failed for tool 'tool-a': bad args",
    });
    expect(getError(result as ToolResultObject)).toBe(error.message);
  });

  it("converts single text content to an exact textResultForLlm", async () => {
    const onAgentToolResult = vi.fn();
    const sourceResult = {
      content: [{ text: "hello", type: "text" }],
      details: { results: [{ text: "hello" }] },
    };
    const sdkTool = await convertOpenClawToolToSdkToolForTest(makeTool({}, sourceResult), {
      onAgentToolResult,
    });

    const result = await runSdkTool(sdkTool, {});

    expect(result).toEqual({ resultType: "success", textResultForLlm: "hello" });
    expect(onAgentToolResult).toHaveBeenCalledWith({
      toolName: "tool-a",
      result: sourceResult,
      isError: false,
    });
  });

  it("reports terminal tool results to the harness lifecycle bridge", async () => {
    const onToolCompleted = vi.fn();
    const sourceResult = {
      content: [{ text: "hello", type: "text" }],
      details: { results: [{ text: "hello" }] },
    };
    const sdkTool = await convertOpenClawToolToSdkToolForTest(makeTool({}, sourceResult), {
      onToolCompleted,
    });

    await runSdkTool(sdkTool, { value: "input" }, makeInvocation({ toolCallId: "call-9" }));
    await flushAsync();

    expect(onToolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        args: { value: "input" },
        result: sourceResult,
        toolCallId: "call-9",
        toolName: "tool-a",
      }),
    );
  });

  it("reports thrown tool failures to the private result observer", async () => {
    const error = new Error("backend unavailable");
    const onAgentToolResult = vi.fn();
    const sdkTool = await convertOpenClawToolToSdkToolForTest(
      makeTool({
        execute: vi.fn(async () => {
          throw error;
        }),
      }),
      { onAgentToolResult },
    );

    await runSdkTool(sdkTool, {});

    expect(onAgentToolResult).toHaveBeenCalledWith({
      toolName: "tool-a",
      result: {
        content: [
          {
            type: "text",
            text: "[copilot-tool-bridge] tool 'tool-a' failed: backend unavailable",
          },
        ],
        details: { status: "failed", error: "backend unavailable" },
      },
      isError: true,
    });
  });

  it("reports terminal tool failures to the harness lifecycle bridge", async () => {
    const onToolCompleted = vi.fn();
    const preparedArgs = { value: "prepared" };
    const sdkTool = await convertOpenClawToolToSdkToolForTest(
      makeTool({
        prepareArguments: vi.fn(() => preparedArgs),
        execute: vi.fn(async () => {
          throw new Error("backend unavailable");
        }),
      }),
      { onToolCompleted },
    );

    await runSdkTool(sdkTool, { value: "input" }, makeInvocation({ toolCallId: "call-10" }));
    await flushAsync();

    expect(onToolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        args: preparedArgs,
        error: "backend unavailable",
        toolCallId: "call-10",
        toolName: "tool-a",
      }),
    );
  });

  it("reports direct tool failures and matching recovery to the host terminal observer", async () => {
    const error = new Error("delivery failed");
    const execute = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({
        content: [{ text: "delivered", type: "text" }],
        details: { status: "ok" },
      });
    const observeToolTerminal = vi.fn(() => ({
      executionStarted: true,
      sideEffectEvidence: true,
      effectReceipt: { state: "uncertain" as const },
    }));
    const sdkTool = await convertOpenClawToolToSdkToolForTest(
      makeTool({ execute, name: "message" }),
      { observeToolTerminal },
    );
    const args = { action: "send", message: "hello", target: "room-1" };

    await runSdkTool(sdkTool, args, makeInvocation({ toolCallId: "send-1" }));
    await runSdkTool(sdkTool, args, makeInvocation({ toolCallId: "send-2" }));

    expect(observeToolTerminal).toHaveBeenNthCalledWith(1, {
      toolCallId: "send-1",
      toolName: "message",
      arguments: args,
      executionStarted: true,
      outcome: "failure",
      failure: { error: "delivery failed" },
    });
    expect(observeToolTerminal).toHaveBeenNthCalledWith(2, {
      toolCallId: "send-2",
      toolName: "message",
      arguments: args,
      executionStarted: true,
      outcome: "success",
    });
  });

  it("surfaces an owner-backed memory delete failure before a false final claim", async () => {
    const tool = createOwnerBackedContractTool({
      pluginId: "memory-lancedb",
      name: "memory_forget",
      result: textToolResult("unused"),
    });
    tool.execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("memory delete failed"))
      .mockResolvedValueOnce(textToolResult("Memory forgotten.", { action: "deleted" }));
    const terminalObserver = createContractToolTerminalObserver("run-copilot-forget");
    let lastToolError: ReturnType<typeof terminalObserver>["lastToolError"];
    const observeToolTerminal: typeof terminalObserver = (observation) => {
      const resolution = terminalObserver(observation);
      lastToolError = resolution.lastToolError;
      return resolution;
    };
    const sdkTool = await convertOpenClawToolToSdkToolForTest(tool, { observeToolTerminal });
    const result = await runSdkTool(
      sdkTool,
      { memoryId: "9e107d9d-3729-4ff5-a8c0-01d29c61f49d" },
      makeInvocation({ toolCallId: "forget-1", toolName: "memory_forget" }),
    );
    const payloads = buildContractReplyPayloads({
      assistantText: "Done - I forgot that memory.",
      lastToolError,
    });

    expect(lastToolError).toMatchObject({
      mutatingAction: true,
    });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toContain("I forgot");
    expect(JSON.stringify(result)).not.toContain("memory-lancedb");
    expect(JSON.stringify(payloads)).not.toContain("memory-lancedb");

    await runSdkTool(
      sdkTool,
      { memoryId: "9e107d9d-3729-4ff5-a8c0-01d29c61f49d" },
      makeInvocation({ toolCallId: "forget-2", toolName: "memory_forget" }),
    );
    expect(lastToolError).toBeUndefined();
  });

  it("keeps owner-backed failures before execution non-mutating", async () => {
    const controller = new AbortController();
    controller.abort();
    const tool = createOwnerBackedContractTool({
      pluginId: "memory-lancedb",
      name: "memory_forget",
      result: textToolResult("unused"),
    });
    const terminalObserver = createContractToolTerminalObserver("run-copilot-pre-execution");
    let lastToolError: ReturnType<typeof terminalObserver>["lastToolError"];
    const observeToolTerminal: typeof terminalObserver = (observation) => {
      const resolution = terminalObserver(observation);
      lastToolError = resolution.lastToolError;
      return resolution;
    };
    const sdkTool = await convertOpenClawToolToSdkToolForTest(tool, {
      abortSignal: controller.signal,
      observeToolTerminal,
    });

    await runSdkTool(sdkTool, { memoryId: "9e107d9d-3729-4ff5-a8c0-01d29c61f49d" });

    expect(lastToolError).toMatchObject({
      mutatingAction: false,
    });
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("does not classify an unowned same-name Copilot tool as mutating", async () => {
    const terminalObserver = createContractToolTerminalObserver("run-copilot-unowned-forget");
    let lastToolError: ReturnType<typeof terminalObserver>["lastToolError"];
    const observeToolTerminal: typeof terminalObserver = (observation) => {
      const resolution = terminalObserver(observation);
      lastToolError = resolution.lastToolError;
      return resolution;
    };
    const sdkTool = await convertOpenClawToolToSdkToolForTest(
      makeTool({
        name: "memory_forget",
        execute: vi.fn(async () => {
          throw new Error("third-party failure");
        }),
      }),
      { observeToolTerminal },
    );

    await runSdkTool(sdkTool, { memoryId: "9e107d9d-3729-4ff5-a8c0-01d29c61f49d" });

    expect(lastToolError).toMatchObject({ mutatingAction: false });
    expect(lastToolError).not.toHaveProperty("ownerKey");
    expect(
      buildContractReplyPayloads({
        assistantText: "Done - I forgot that memory.",
        lastToolError,
      }),
    ).toHaveLength(1);
  });

  it("reports returned OpenClaw error results to both tool observers", async () => {
    const onAgentToolResult = vi.fn();
    const onToolCompleted = vi.fn();
    const sourceResult = {
      content: [{ text: '{"status":"error","error":"backend unavailable"}', type: "text" }],
      details: { status: "error", error: "backend unavailable" },
    };
    const sdkTool = await convertOpenClawToolToSdkToolForTest(makeTool({}, sourceResult), {
      onAgentToolResult,
      onToolCompleted,
    });

    const result = await runSdkTool(sdkTool, {});
    await flushAsync();

    expect(result).toMatchObject({ resultType: "failure" });
    expect(onAgentToolResult).toHaveBeenCalledWith({
      toolName: "tool-a",
      result: sourceResult,
      isError: true,
    });
    expect(onToolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "backend unavailable",
        result: sourceResult,
      }),
    );
  });

  it("reports owner-backed catalog tool failures to the host terminal observer", async () => {
    type CatalogExecutor = (params: {
      tool: AnyAgentTool;
      toolName: string;
      source: "openclaw";
      sourceName: string;
      toolCallId: string;
      parentToolCallId: string;
      input: unknown;
    }) => Promise<unknown>;
    let catalogExecutor: CatalogExecutor | undefined;
    const observeToolTerminal = vi.fn(() => ({
      executionStarted: true,
      sideEffectEvidence: true,
    }));
    await createCopilotToolBridge({
      attemptParams: {
        config: { tools: { toolSearch: true } },
        observeToolTerminal,
        runId: "run-tool-search",
        sessionKey: "agent:agent-1:main",
      } as never,
      createOpenClawCodingTools: async (options: unknown) => {
        catalogExecutor = (options as { toolSearchCatalogExecutor?: CatalogExecutor })
          .toolSearchCatalogExecutor;
        return [makeTool({ name: "tool_search_code" })];
      },
    });
    const target = createOwnerBackedContractTool({
      pluginId: "memory-lancedb",
      name: "memory_forget",
      result: textToolResult("unused"),
    });
    target.execute = vi.fn(async () => {
      throw new Error("catalog delete failed");
    });
    const args = { memoryId: "9e107d9d-3729-4ff5-a8c0-01d29c61f49d" };

    await expect(
      expectDefined(
        catalogExecutor,
        "Copilot catalog executor",
      )({
        tool: target,
        toolName: "memory_forget",
        source: "openclaw",
        sourceName: "memory-lancedb",
        toolCallId: "catalog-forget-1",
        parentToolCallId: "tool-search-1",
        input: args,
      }),
    ).rejects.toThrow("catalog delete failed");

    expect(observeToolTerminal).toHaveBeenCalledWith({
      toolCallId: "catalog-forget-1",
      toolName: "memory_forget",
      arguments: args,
      executionStarted: true,
      outcome: "failure",
      failure: { error: "catalog delete failed" },
      ownerMutation: { ownerKey: '["memory-lancedb","memory_forget"]' },
    });
  });

  it("joins multiple text blocks with newlines", async () => {
    const sdkTool = await convertOpenClawToolToSdkToolForTest(
      makeTool(
        {},
        {
          content: [
            { text: "first", type: "text" },
            { text: "second", type: "text" },
            { text: "third", type: "text" },
          ],
          details: null,
        },
      ),
      {},
    );

    const result = await runSdkTool(sdkTool, {});

    expect(result).toEqual({ resultType: "success", textResultForLlm: "first\nsecond\nthird" });
  });

  it("converts image content into binaryResultsForLlm while preserving text", async () => {
    const sdkTool = await convertOpenClawToolToSdkToolForTest(
      makeTool(
        {},
        {
          content: [
            { text: "preview", type: "text" },
            { data: "base64-data", mimeType: "image/png", type: "image" },
          ],
          details: null,
        },
      ),
      {},
    );

    const result = await runSdkTool(sdkTool, {});

    expect(result).toEqual({
      binaryResultsForLlm: [
        {
          data: "base64-data",
          mimeType: "image/png",
          type: "image",
        },
      ],
      resultType: "success",
      textResultForLlm: "preview",
    });
  });

  it("returns a failure result when execute throws and preserves the error", async () => {
    const error = new Error("tool exploded");
    const sourceTool = makeTool({
      execute: vi.fn(async () => {
        throw error;
      }),
    });
    const sdkTool = await convertOpenClawToolToSdkToolForTest(sourceTool, {});

    const result = await runSdkTool(sdkTool, {});

    expect(result).toMatchObject({
      resultType: "failure",
      textResultForLlm: "[copilot-tool-bridge] tool 'tool-a' failed: tool exploded",
    });
    expect(getError(result as ToolResultObject)).toBe(error.message);
  });

  it("runs default tools in parallel", async () => {
    const first = createDeferred<{
      content: Array<{ text: string; type: string }>;
      details: null;
    }>();
    const second = createDeferred<{
      content: Array<{ text: string; type: string }>;
      details: null;
    }>();
    const execute = vi
      .fn()
      .mockImplementationOnce(async () => first.promise)
      .mockImplementationOnce(async () => second.promise);
    const sourceTool = makeTool({ execute });
    const sdkTool = await convertOpenClawToolToSdkToolForTest(sourceTool, {});

    const firstRun = runSdkTool(sdkTool, {}, makeInvocation({ toolCallId: "call-1" }));
    const secondRun = runSdkTool(sdkTool, {}, makeInvocation({ toolCallId: "call-2" }));
    await flushAsync();

    expect(execute).toHaveBeenCalledTimes(2);
    first.resolve({ content: [{ text: "one", type: "text" }], details: null });
    second.resolve({ content: [{ text: "two", type: "text" }], details: null });

    await expect(Promise.all([firstRun, secondRun])).resolves.toEqual([
      { resultType: "success", textResultForLlm: "one" },
      { resultType: "success", textResultForLlm: "two" },
    ]);
  });

  it("serializes sequential tools so the second call waits for the first", async () => {
    const first = createDeferred<{
      content: Array<{ text: string; type: string }>;
      details: null;
    }>();
    const second = createDeferred<{
      content: Array<{ text: string; type: string }>;
      details: null;
    }>();
    const execute = vi
      .fn()
      .mockImplementationOnce(async () => first.promise)
      .mockImplementationOnce(async () => second.promise);
    const sourceTool = makeTool({ execute, executionMode: "sequential" });
    const sdkTool = await convertOpenClawToolToSdkToolForTest(sourceTool, {});

    const firstRun = runSdkTool(sdkTool, {}, makeInvocation({ toolCallId: "call-1" }));
    const secondRun = runSdkTool(sdkTool, {}, makeInvocation({ toolCallId: "call-2" }));
    await flushAsync();

    expect(execute).toHaveBeenCalledTimes(1);
    first.resolve({ content: [{ text: "one", type: "text" }], details: null });
    await firstRun;
    await flushAsync();
    expect(execute).toHaveBeenCalledTimes(2);
    second.resolve({ content: [{ text: "two", type: "text" }], details: null });

    await expect(Promise.all([firstRun, secondRun])).resolves.toEqual([
      { resultType: "success", textResultForLlm: "one" },
      { resultType: "success", textResultForLlm: "two" },
    ]);
  });

  it("returns a failure result when execute observes an abort after start", async () => {
    const controller = new AbortController();
    const sourceTool = makeTool({
      execute: vi.fn(
        (_toolCallId: string, _args: unknown, signal?: AbortSignal) =>
          new Promise<never>((_, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                reject(new Error("aborted during execute"));
              },
              { once: true },
            );
          }),
      ),
    });
    const sdkTool = await convertOpenClawToolToSdkToolForTest(sourceTool, {
      abortSignal: controller.signal,
    });

    const resultPromise = runSdkTool(sdkTool, {});
    await flushAsync();
    controller.abort();
    const result = await resultPromise;

    expect(sourceTool.execute).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      resultType: "failure",
      textResultForLlm: "[copilot-tool-bridge] tool 'tool-a' failed: aborted during execute",
    });
    expect(getError(result as ToolResultObject)).toBe("aborted during execute");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
