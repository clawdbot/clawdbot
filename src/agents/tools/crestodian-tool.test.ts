// Crestodian ring-zero tool tests: approval gating, action mapping, verification.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCrestodianTool,
  hashCrestodianOperation,
  resolveCrestodianDirectiveTransition,
  resolveCrestodianProposalTransition,
  type CrestodianToolDirective,
} from "./crestodian-tool.js";

const mocks = vi.hoisted(() => ({
  executeCrestodianOperation: vi.fn(async (_op: unknown, runtime: { log: (m: string) => void }) => {
    runtime.log("op-output");
    return { applied: false };
  }),
  readConfigFileSnapshot: vi.fn(async () => ({
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "h",
    config: {},
    sourceConfig: {},
    issues: [],
  })),
}));

vi.mock("../../crestodian/operations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../crestodian/operations.js")>()),
  executeCrestodianOperation: mocks.executeCrestodianOperation,
}));

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

afterEach(() => {
  vi.clearAllMocks();
});

function toolText(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content
    .map((block) => block.text ?? "")
    .filter(Boolean)
    .join("\n");
}

describe("crestodian tool", () => {
  it("runs read actions immediately", async () => {
    const tool = createCrestodianTool({ surface: "cli" });
    const result = await tool.execute("t1", { action: "status" });
    expect(toolText(result)).toContain("op-output");
    expect(mocks.executeCrestodianOperation).toHaveBeenCalledWith(
      { kind: "status" },
      expect.anything(),
      expect.objectContaining({ approved: false }),
    );

    await tool.execute("t1b", { action: "channel_info", channel: "Slack" });
    expect(mocks.executeCrestodianOperation).toHaveBeenCalledWith(
      { kind: "channel-info", channel: "slack" },
      expect.anything(),
      expect.objectContaining({ approved: false }),
    );
  });

  it("refuses mutating actions without the approved assertion", async () => {
    const proposalRef: { current?: string } = {};
    const tool = createCrestodianTool({ surface: "cli", approvalArmed: true, proposalRef });
    const result = await tool.execute("t2", {
      action: "config_set",
      path: "gateway.port",
      value: "18789",
    });
    // An armed turn can never mint its own proposal.
    expect(toolText(result)).toContain("approval-mismatch");
    expect(proposalRef.current).toBeUndefined();
    expect(mocks.executeCrestodianOperation).not.toHaveBeenCalled();
  });

  it("refuses model-asserted approval without host-verified consent", async () => {
    // approved=true from the model alone must never mutate: the host arms
    // approval only when the user's actual message was an explicit yes.
    const tool = createCrestodianTool({ surface: "cli" });
    const result = await tool.execute("t2b", {
      action: "config_set",
      path: "gateway.port",
      value: "18789",
      approved: true,
    });
    expect(toolText(result)).toContain("needs-approval");
    expect(mocks.executeCrestodianOperation).not.toHaveBeenCalled();
  });

  it("executes an approved mutation only through the full proposal handshake", async () => {
    mocks.executeCrestodianOperation.mockImplementationOnce(
      async (_op: unknown, runtime: { log: (m: string) => void }) => {
        runtime.log("op-output");
        return { applied: true };
      },
    );
    const proposalRef: { current?: string } = {};
    // Phase 1: unarmed proposal is denied and records the exact operation.
    const proposingTool = createCrestodianTool({ surface: "gateway", proposalRef });
    const denied = await proposingTool.execute("t3a", {
      action: "set_default_model",
      model: "openai/gpt-5.5",
      approved: true,
    });
    expect(toolText(denied)).toContain("needs-approval");
    expect(proposalRef.current).toBeDefined();
    expect(mocks.executeCrestodianOperation).not.toHaveBeenCalled();

    // Phase 2: the user's yes arms the turn; the identical call executes.
    const armedTool = createCrestodianTool({
      surface: "gateway",
      approvalArmed: true,
      proposalRef,
    });
    const result = await armedTool.execute("t3b", {
      action: "set_default_model",
      model: "openai/gpt-5.5",
      approved: true,
    });
    expect(toolText(result)).toContain("op-output");
    expect(mocks.executeCrestodianOperation).toHaveBeenCalledWith(
      { kind: "set-default-model", model: "openai/gpt-5.5" },
      expect.anything(),
      expect.objectContaining({
        approved: true,
        deps: { setupSurface: "gateway" },
        auditDetails: { via: "crestodian-agent-tool" },
      }),
    );
    // One approval, one mutation.
    expect(proposalRef.current).toBeUndefined();
  });

  it("binds setup approval to the exact ordered inference routes", async () => {
    const proposalRef: { current?: string } = {};
    const args = {
      action: "setup",
      workspace: "/tmp/work",
      model: "openai/gpt-5.5",
      inferenceRoutes: [
        { kind: "codex-cli", model: "openai/gpt-5.5" },
        { kind: "claude-cli", model: "claude-cli/claude-opus-4-8" },
      ],
    };
    const result = await createCrestodianTool({ surface: "gateway", proposalRef }).execute(
      "setup-proposal",
      args,
    );

    expect(toolText(result)).toContain("needs-approval");
    expect(proposalRef.current).toBe(
      hashCrestodianOperation({
        kind: "setup",
        workspace: "/tmp/work",
        model: "openai/gpt-5.5",
        inferenceRoutes: [
          { kind: "codex-cli", model: "openai/gpt-5.5" },
          { kind: "claude-cli", model: "claude-cli/claude-opus-4-8" },
        ],
      }),
    );
    expect(
      resolveCrestodianProposalTransition({
        args: { action: "setup", workspace: "/tmp/work" },
        resultText: toolText(result),
      }),
    ).toEqual({ proposal: proposalRef.current });
  });

  it("prepares a route-less setup before registering its approval hash", async () => {
    mocks.executeCrestodianOperation.mockImplementationOnce(
      async (operation: unknown, runtime: { log: (message: string) => void }) => {
        Object.assign(operation as object, {
          model: "openai/gpt-5.5",
          inferenceRoutes: [{ kind: "codex-cli", model: "openai/gpt-5.5" }],
        });
        runtime.log("Model choice: openai/gpt-5.5 (Codex app-server).");
        return { applied: false };
      },
    );
    const proposalRef: { current?: string } = {};
    const result = await createCrestodianTool({ surface: "gateway", proposalRef }).execute(
      "setup-auto",
      { action: "setup", workspace: "/tmp/work" },
    );

    expect(toolText(result)).toContain(
      'After the user approves, retry with these exact tool arguments: {"action":"setup","workspace":"/tmp/work","model":"openai/gpt-5.5","inferenceRoutes":[{"kind":"codex-cli","model":"openai/gpt-5.5"}],"approved":true}',
    );
    expect(proposalRef.current).toBe(
      hashCrestodianOperation({
        kind: "setup",
        workspace: "/tmp/work",
        model: "openai/gpt-5.5",
        inferenceRoutes: [{ kind: "codex-cli", model: "openai/gpt-5.5" }],
      }),
    );

    const armedTool = createCrestodianTool({
      surface: "gateway",
      approvalArmed: true,
      proposalRef,
    });
    const approved = await armedTool.execute("setup-auto-approved", {
      action: "setup",
      workspace: "/tmp/work",
      model: "openai/gpt-5.5",
      inferenceRoutes: [{ kind: "codex-cli", model: "openai/gpt-5.5" }],
      approved: true,
    });

    expect(toolText(approved)).toContain("op-output");
    expect(mocks.executeCrestodianOperation).toHaveBeenLastCalledWith(
      {
        kind: "setup",
        workspace: "/tmp/work",
        model: "openai/gpt-5.5",
        inferenceRoutes: [{ kind: "codex-cli", model: "openai/gpt-5.5" }],
      },
      expect.anything(),
      expect.objectContaining({ approved: true }),
    );
    expect(proposalRef.current).toBeUndefined();
  });

  it.each([
    {
      label: "duplicate routes",
      args: {
        model: "openai/gpt-5.5",
        inferenceRoutes: [
          { kind: "codex-cli", model: "openai/gpt-5.5" },
          { kind: "codex-cli", model: "openai/gpt-5.5" },
        ],
      },
      error: /unique/,
    },
    {
      label: "unknown route",
      args: {
        model: "openai/gpt-5.5",
        inferenceRoutes: [{ kind: "mystery-cli", model: "openai/gpt-5.5" }],
      },
      error: /unknown inference route/i,
    },
    {
      label: "routes without a model",
      args: {
        inferenceRoutes: [{ kind: "codex-cli", model: "openai/gpt-5.5" }],
      },
      error: /require their captured model/,
    },
    {
      label: "provider mismatch",
      args: {
        model: "openai/gpt-5.5",
        inferenceRoutes: [{ kind: "claude-cli", model: "openai/gpt-5.5" }],
      },
      error: /not compatible/,
    },
  ])("rejects setup with $label", async ({ args, error }) => {
    const tool = createCrestodianTool({ surface: "gateway", proposalRef: {} });
    await expect(tool.execute("bad-setup", { action: "setup", ...args })).rejects.toThrow(error);
  });

  it("binds a captured no-inference result without re-running setup detection", async () => {
    const proposalRef: { current?: string } = {};
    const args = {
      action: "setup",
      workspace: "/tmp/work",
      inferenceRoutes: [],
    };
    const result = await createCrestodianTool({ surface: "gateway", proposalRef }).execute(
      "providerless-setup",
      args,
    );

    expect(toolText(result)).toContain("needs-approval");
    expect(toolText(result)).not.toContain("exact tool arguments");
    expect(proposalRef.current).toBe(
      hashCrestodianOperation({
        kind: "setup",
        workspace: "/tmp/work",
        inferenceRoutes: [],
      }),
    );
    expect(mocks.executeCrestodianOperation).not.toHaveBeenCalled();
  });

  it("voids approval when compatible routes are reordered", async () => {
    const originalRoutes = [
      { kind: "codex-cli", model: "openai/gpt-5.5" },
      { kind: "openai-api-key", model: "openai/gpt-5.5" },
    ] as const;
    const proposalRef = {
      current: hashCrestodianOperation({
        kind: "setup",
        model: "openai/gpt-5.5",
        inferenceRoutes: [...originalRoutes],
      }),
    };
    const tool = createCrestodianTool({
      surface: "gateway",
      approvalArmed: true,
      proposalRef,
    });

    const result = await tool.execute("reordered", {
      action: "setup",
      model: "openai/gpt-5.5",
      inferenceRoutes: originalRoutes.toReversed(),
      approved: true,
    });

    expect(toolText(result)).toContain("approval-mismatch");
    expect(proposalRef.current).toBeUndefined();
    expect(mocks.executeCrestodianOperation).not.toHaveBeenCalled();
  });

  it("refuses an armed call that differs from the proposed operation", async () => {
    const proposalRef: { current?: string } = {};
    const proposingTool = createCrestodianTool({ surface: "cli", proposalRef });
    await proposingTool.execute("t3c", {
      action: "set_default_model",
      model: "openai/gpt-5.5",
      approved: true,
    });
    const armedTool = createCrestodianTool({ surface: "cli", approvalArmed: true, proposalRef });
    const result = await armedTool.execute("t3d", {
      action: "config_set",
      path: "gateway.port",
      value: "1",
      approved: true,
    });
    // A different operation than the approved one voids the approval entirely;
    // even an identical retry in the same armed turn stays locked.
    expect(toolText(result)).toContain("approval-mismatch");
    expect(proposalRef.current).toBeUndefined();
    const retry = await armedTool.execute("t3e", {
      action: "config_set",
      path: "gateway.port",
      value: "1",
      approved: true,
    });
    expect(toolText(retry)).toContain("approval-mismatch");
    expect(mocks.executeCrestodianOperation).not.toHaveBeenCalled();
  });

  it("feeds config validation failures back into the tool result", async () => {
    mocks.executeCrestodianOperation.mockImplementationOnce(
      async (_op: unknown, runtime: { log: (m: string) => void }) => {
        runtime.log("op-output");
        return { applied: true };
      },
    );
    mocks.readConfigFileSnapshot.mockResolvedValueOnce({
      exists: true,
      valid: false,
      path: "/tmp/openclaw.json",
      hash: "h",
      config: {},
      sourceConfig: {},
      issues: [{ path: "gateway.port", message: "Expected number" }],
    } as never);
    const proposalRef: { current?: string } = {};
    await createCrestodianTool({ surface: "cli", proposalRef }).execute("t4a", {
      action: "config_set",
      path: "gateway.port",
      value: "banana",
      approved: true,
    });
    const tool = createCrestodianTool({ surface: "cli", approvalArmed: true, proposalRef });
    const result = await tool.execute("t4", {
      action: "config_set",
      path: "gateway.port",
      value: "banana",
      approved: true,
    });
    const text = toolText(result);
    expect(text).toContain("CONFIG INVALID");
    expect(text).toContain("gateway.port: Expected number");
  });

  it("maps create_agent with optional workspace and model", async () => {
    mocks.executeCrestodianOperation.mockImplementationOnce(
      async (_op: unknown, runtime: { log: (m: string) => void }) => {
        runtime.log("op-output");
        return { applied: true };
      },
    );
    const proposalRef: { current?: string } = {};
    await createCrestodianTool({ surface: "cli", proposalRef }).execute("t6a", {
      action: "create_agent",
      agentId: "work",
      workspace: "/tmp/work",
      approved: true,
    });
    const tool = createCrestodianTool({ surface: "cli", approvalArmed: true, proposalRef });
    await tool.execute("t6", {
      action: "create_agent",
      agentId: "work",
      workspace: "/tmp/work",
      approved: true,
    });
    expect(mocks.executeCrestodianOperation).toHaveBeenCalledWith(
      { kind: "create-agent", agentId: "work", workspace: "/tmp/work" },
      expect.anything(),
      expect.objectContaining({ approved: true }),
    );
  });

  it("rejects unknown or underspecified actions as input errors", async () => {
    const tool = createCrestodianTool({ surface: "cli" });
    await expect(tool.execute("t5", { action: "config_get" })).rejects.toThrow(/path/);
  });

  it("records interactive directives for the host without executing operations", async () => {
    const directiveRef: { current?: CrestodianToolDirective } = {};
    const tool = createCrestodianTool({ surface: "cli", directiveRef });

    const connect = await tool.execute("t5", { action: "connect_channel", channel: "Telegram" });
    expect(toolText(connect)).toContain("directive:");
    expect(directiveRef.current).toEqual({ kind: "channel-setup", channel: "telegram" });

    const configureModel = await tool.execute("t6", {
      action: "configure_model_provider",
      workspace: "/tmp/work",
    });
    expect(toolText(configureModel)).toContain("directive:");
    expect(directiveRef.current).toEqual({ kind: "model-setup", workspace: "/tmp/work" });

    const open = await tool.execute("t7", { action: "open_agent", agentId: "work" });
    expect(toolText(open)).toContain("directive:");
    expect(directiveRef.current).toEqual({ kind: "open-tui", agentId: "work" });

    const setup = await tool.execute("t7", {
      action: "open_setup",
      target: "channels",
      channel: "Slack",
    });
    expect(toolText(setup)).toContain("directive:");
    expect(directiveRef.current).toEqual({
      kind: "open-setup",
      target: "channels",
      channel: "slack",
    });

    // Directives are host handoffs, never operation executions.
    expect(mocks.executeCrestodianOperation).not.toHaveBeenCalled();
  });

  it("mirrors directive transitions for out-of-process (CLI MCP) hosts", () => {
    expect(
      resolveCrestodianDirectiveTransition({
        args: { action: "connect_channel", channel: "telegram" },
        resultText: "directive: the host chat now starts the guided telegram setup.",
      }),
    ).toEqual({ kind: "channel-setup", channel: "telegram" });
    expect(
      resolveCrestodianDirectiveTransition({
        args: { action: "open_agent" },
        resultText: "directive: the host now hands the user over.",
      }),
    ).toEqual({ kind: "open-tui" });
    expect(
      resolveCrestodianDirectiveTransition({
        args: { action: "configure_model_provider", workspace: "/tmp/work" },
        resultText: "directive: the host now starts masked model-provider setup.",
      }),
    ).toEqual({ kind: "model-setup", workspace: "/tmp/work" });
    expect(
      resolveCrestodianDirectiveTransition({
        args: { action: "open_setup", target: "classic" },
        resultText: "directive: the host now opens the classic setup wizard.",
      }),
    ).toEqual({ kind: "open-setup", target: "classic" });
    // Non-directive results and other actions never mirror.
    expect(
      resolveCrestodianDirectiveTransition({ args: { action: "status" }, resultText: "ok" }),
    ).toBeNull();
    expect(
      resolveCrestodianDirectiveTransition({
        args: { action: "connect_channel", channel: "telegram" },
        resultText: "error: boom",
      }),
    ).toBeNull();
  });

  it("mirrors proposal transitions for out-of-process (CLI MCP) hosts", () => {
    const args = { action: "set_default_model", model: "openai/gpt-5.5" };
    const hash = hashCrestodianOperation({ kind: "set-default-model", model: "openai/gpt-5.5" });

    // Denial registers the exact-operation hash on the host.
    expect(
      resolveCrestodianProposalTransition({
        args,
        resultText: "needs-approval: this action changes state.",
      }),
    ).toEqual({ proposal: hash });
    expect(
      resolveCrestodianProposalTransition({
        args,
        resultText: `needs-approval:${hash}\nThis action changes state.`,
      }),
    ).toEqual({ proposal: hash });
    // A voided approval clears it.
    expect(
      resolveCrestodianProposalTransition({
        args,
        resultText: "approval-mismatch: this call is not the operation the user approved.",
      }),
    ).toEqual({ proposal: undefined });
    // An executed mutation consumes it.
    expect(
      resolveCrestodianProposalTransition({ args, resultText: "Default model updated." }),
    ).toEqual({ proposal: undefined });
    // Read actions and unparsable calls never touch the proposal.
    expect(
      resolveCrestodianProposalTransition({ args: { action: "status" }, resultText: "ok" }),
    ).toBeNull();
    expect(
      resolveCrestodianProposalTransition({ args: { action: "bogus" }, resultText: "ok" }),
    ).toBeNull();
  });
});
