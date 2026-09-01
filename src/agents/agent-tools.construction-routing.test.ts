/**
 * Tests trigger and session routing during tool assembly.
 * Ensures cron runs scope cron tool behavior to self-removal of the current
 * job only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "./tools/common.js";

const mocks = vi.hoisted(() => {
  const onToolExecute = vi.fn(async () => ({ content: [], details: {} }));
  const stubTool = (name: string) =>
    ({
      name,
      label: name,
      displaySummary: name,
      description: name,
      parameters: { type: "object", properties: {} },
      execute: onToolExecute,
    }) satisfies AnyAgentTool;

  return {
    createOpenClawToolsOptions: vi.fn(),
    stubTool,
    onToolExecute,
  };
});

vi.mock("./openclaw-tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-tools.js")>();
  return {
    createOpenClawTools: (options: unknown) => {
      mocks.createOpenClawToolsOptions(options);
      return [mocks.stubTool(AUTOMATIONS_TOOL_NAME)];
    },
    filterToolsByClientCaps: actual.filterToolsByClientCaps,
  };
});

import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";
import { AUTOMATIONS_TOOL_NAME } from "./tools/automations-tool-name.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

function firstOpenClawToolsOptions(): { cronSelfRemoveOnlyJobId?: string } | undefined {
  return mocks.createOpenClawToolsOptions.mock.calls[0]?.[0] as
    | { cronSelfRemoveOnlyJobId?: string }
    | undefined;
}

describe("createOpenClawCodingTools cron scope", () => {
  beforeEach(() => {
    mocks.createOpenClawToolsOptions.mockClear();
  });

  it("scopes cron-triggered jobs to self-removal", () => {
    const tools = createOpenClawCodingTools({
      trigger: "cron",
      jobId: "job-current",
    });

    expect(tools.map((tool) => tool.name)).toContain(AUTOMATIONS_TOOL_NAME);
    expect(firstOpenClawToolsOptions()?.cronSelfRemoveOnlyJobId).toBe("job-current");
  });

  it("does not scope non-cron sessions", () => {
    createOpenClawCodingTools({
      trigger: "user",
      jobId: "job-current",
    });

    expect(firstOpenClawToolsOptions()?.cronSelfRemoveOnlyJobId).toBeUndefined();
  });
});

const createLazyExecToolMock = vi.hoisted(() => vi.fn());

vi.mock("./lazy-exec-tool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lazy-exec-tool.js")>();
  return {
    ...actual,
    createLazyExecTool: (defaults: unknown) => {
      createLazyExecToolMock(defaults);
      return {
        name: "exec",
        description: "exec stub",
        parameters: { type: "object", properties: {} },
        execute: vi.fn(),
      };
    },
  };
});

describe("createOpenClawCodingTools exec notification routing", () => {
  it("binds native tool approval requests to the constructed permission generation", async () => {
    const generation = new AbortController();
    let approvalScope: AbortSignal | undefined;
    mocks.onToolExecute.mockImplementationOnce(async () => {
      approvalScope = AbortSignal.any([...(getGatewayToolCallerIdentity()?.approvalSignals ?? [])]);
      return { content: [], details: {} };
    });
    const tools = createOpenClawCodingTools({
      agentId: "main",
      sessionKey: "agent:main:scope",
      abortSignal: generation.signal,
      wrapBeforeToolCallHook: false,
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: false,
      },
    });
    const tool = tools.find((candidate) => candidate.name === AUTOMATIONS_TOOL_NAME);
    if (!tool) {
      throw new Error("Expected automation tool");
    }
    await tool.execute("call", {});
    generation.abort();
    expect(approvalScope?.aborted).toBe(true);
  });

  it("routes detached completions to the live session without changing process scope", () => {
    const liveSessionKey = "agent:main:channel:group:example:thread:25";
    const policySessionKey = "agent:main:runtime-policy";

    createOpenClawCodingTools({
      sessionKey: policySessionKey,
      runSessionKey: liveSessionKey,
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: true,
        includeChannelTools: false,
        includeOpenClawTools: false,
        includePluginTools: false,
      },
    });

    expect(createLazyExecToolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeKey: policySessionKey,
        sessionKey: policySessionKey,
        notifySessionKey: liveSessionKey,
      }),
    );
  });
});

describe("createOpenClawCodingTools sandbox filesystem ownership", () => {
  const sandbox = createAgentToolsSandboxContext({ workspaceDir: "/managed/workspace" });

  it("keeps host-owned tools available when no sandbox filesystem family is requested", () => {
    mocks.createOpenClawToolsOptions.mockClear();

    const tools = createOpenClawCodingTools({
      sandbox,
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: true,
      },
    });

    expect(tools.map((tool) => tool.name)).toContain(AUTOMATIONS_TOOL_NAME);
    expect(mocks.createOpenClawToolsOptions).toHaveBeenCalledOnce();
  });

  it.each([
    { includeBaseCodingTools: true, includeShellTools: false },
    { includeBaseCodingTools: false, includeShellTools: true },
  ])("rejects sandbox filesystem families without their bridge: %o", (families) => {
    expect(() =>
      createOpenClawCodingTools({
        sandbox,
        toolConstructionPlan: {
          ...families,
          includeChannelTools: false,
          includeOpenClawTools: false,
          includePluginTools: false,
        },
      }),
    ).toThrow("Sandbox filesystem bridge is unavailable.");
  });
});
