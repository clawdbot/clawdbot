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
  it("stays directly callable instead of entering tool catalogs", () => {
    expect(createCrestodianTool({ surface: "cli" }).catalogMode).toBe("direct-only");
  });

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

  it("defers an approved mutation to the host after the full proposal handshake", async () => {
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

    // Phase 2: the user's yes arms the turn; the identical call becomes one
    // host-owned directive so the inference binding can be checked again.
    const directiveRef: { current?: CrestodianToolDirective } = {};
    const armedTool = createCrestodianTool({
      surface: "gateway",
      approvalArmed: true,
      proposalRef,
      directiveRef,
    });
    const result = await armedTool.execute("t3b", {
      action: "set_default_model",
      model: "openai/gpt-5.5",
      approved: true,
    });
    expect(toolText(result)).toContain("directive:approved-operation:");
    expect(directiveRef.current).toEqual({
      kind: "approved-operation",
      operation: { kind: "set-default-model", model: "openai/gpt-5.5" },
    });
    expect(mocks.executeCrestodianOperation).not.toHaveBeenCalled();
    await armedTool.execute("t3c", { action: "connect_channel", channel: "telegram" });
    expect(directiveRef.current).toEqual({
      kind: "approved-operation",
      operation: { kind: "set-default-model", model: "openai/gpt-5.5" },
    });
    // One approval, one mutation.
    expect(proposalRef.current).toBeUndefined();
  });

  it("binds setup approval to the exact verified model and workspace", async () => {
    const proposalRef: { current?: string } = {};
    const args = {
      action: "setup",
      workspace: "/tmp/work",
      model: "openai/gpt-5.5",
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
      }),
    );
    expect(
      resolveCrestodianProposalTransition({
        args: { action: "setup", workspace: "/tmp/work" },
        resultText: toolText(result),
      }),
    ).toEqual({ proposal: proposalRef.current });
  });

  it("voids setup approval when the requested model changes", async () => {
    const proposalRef = {
      current: hashCrestodianOperation({
        kind: "setup",
        model: "openai/gpt-5.5",
      }),
    };
    const tool = createCrestodianTool({
      surface: "gateway",
      approvalArmed: true,
      proposalRef,
    });

    const result = await tool.execute("changed-model", {
      action: "setup",
      model: "anthropic/claude-sonnet-4-6",
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

  it("never performs an approved write inside the model tool process", async () => {
    const proposalRef: { current?: string } = {};
    await createCrestodianTool({ surface: "cli", proposalRef }).execute("t4a", {
      action: "config_set",
      path: "gateway.port",
      value: "banana",
      approved: true,
    });
    const directiveRef: { current?: CrestodianToolDirective } = {};
    const tool = createCrestodianTool({
      surface: "cli",
      approvalArmed: true,
      proposalRef,
      directiveRef,
    });
    const result = await tool.execute("t4", {
      action: "config_set",
      path: "gateway.port",
      value: "banana",
      approved: true,
    });
    expect(toolText(result)).toContain("directive:approved-operation:");
    expect(directiveRef.current).toEqual({
      kind: "approved-operation",
      operation: { kind: "config-set", path: "gateway.port", value: "banana" },
    });
    expect(mocks.executeCrestodianOperation).not.toHaveBeenCalled();
    expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
  });

  it("maps create_agent with optional workspace and model", async () => {
    const proposalRef: { current?: string } = {};
    await createCrestodianTool({ surface: "cli", proposalRef }).execute("t6a", {
      action: "create_agent",
      agentId: "work",
      workspace: "/tmp/work",
      approved: true,
    });
    const directiveRef: { current?: CrestodianToolDirective } = {};
    const tool = createCrestodianTool({
      surface: "cli",
      approvalArmed: true,
      proposalRef,
      directiveRef,
    });
    await tool.execute("t6", {
      action: "create_agent",
      agentId: "work",
      workspace: "/tmp/work",
      approved: true,
    });
    expect(directiveRef.current).toEqual({
      kind: "approved-operation",
      operation: { kind: "create-agent", agentId: "work", workspace: "/tmp/work" },
    });
    expect(mocks.executeCrestodianOperation).not.toHaveBeenCalled();
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
    expect(toolText(configureModel)).toContain(
      "active inference route cannot be changed inside Crestodian",
    );
    expect(toolText(configureModel)).toContain("openclaw onboard");
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

    const guidedSetup = await tool.execute("t8", {
      action: "open_setup",
      target: "guided",
    });
    expect(toolText(guidedSetup)).toContain("cannot run inside Crestodian");
    expect(toolText(guidedSetup)).toContain("openclaw onboard");
    expect(directiveRef.current).toEqual({ kind: "open-setup", target: "guided" });

    // Directives are host handoffs, never operation executions.
    expect(mocks.executeCrestodianOperation).not.toHaveBeenCalled();
  });

  it("mirrors directive transitions for out-of-process (CLI MCP) hosts", () => {
    expect(
      resolveCrestodianDirectiveTransition({
        args: {
          action: "config_set",
          path: "gateway.port",
          value: "19001",
          approved: true,
        },
        resultText: "directive:approved-operation: the host will apply this action.",
      }),
    ).toEqual({
      kind: "approved-operation",
      operation: { kind: "config-set", path: "gateway.port", value: "19001" },
    });
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
        resultText:
          "directive: the active inference route cannot be changed inside Crestodian; run openclaw onboard.",
      }),
    ).toEqual({ kind: "model-setup", workspace: "/tmp/work" });
    expect(
      resolveCrestodianDirectiveTransition({
        args: { action: "open_setup", target: "classic" },
        resultText: "directive: classic setup cannot run inside Crestodian; run openclaw onboard.",
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
