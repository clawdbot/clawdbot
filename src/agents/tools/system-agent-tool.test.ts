// OpenClaw ring-zero tool tests: approval gating, action mapping, verification.
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashSystemAgentOperation } from "../../system-agent/operator-approval.js";
import {
  createSystemAgentTool,
  resolveSystemAgentDirectiveTransition,
  resolveSystemAgentProposalTransition,
  type SystemAgentToolDirective,
  type SystemAgentToolOptions,
} from "./system-agent-tool.js";

const mocks = vi.hoisted(() => ({
  preparePluginArtifact: vi.fn(),
  executeSystemAgentOperation: vi.fn(
    async (_op: unknown, runtime: { log: (m: string) => void }) => {
      runtime.log("op-output");
      return { applied: false };
    },
  ),
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

vi.mock("../../system-agent/plugin-artifact.js", () => ({
  prepareSystemAgentPluginArtifact: mocks.preparePluginArtifact,
}));

vi.mock("../../system-agent/operations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../system-agent/operations.js")>()),
  executeSystemAgentOperation: mocks.executeSystemAgentOperation,
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

describe("openclaw tool", () => {
  it("stays directly callable instead of entering tool catalogs", () => {
    const tool = createSystemAgentTool({ surface: "cli" });
    expect(tool.catalogMode).toBe("direct-only");
    expect(tool.description).toContain("Direct chat: exact user approval, then approved=true.");
    expect(tool.description).toContain("host applies session permission policy");
  });

  it("runs read actions immediately", async () => {
    const tool = createSystemAgentTool({ surface: "cli" });
    const result = await tool.execute("t1", { action: "status" });
    expect(toolText(result)).toContain("op-output");
    expect(mocks.executeSystemAgentOperation).toHaveBeenCalledWith(
      { kind: "status" },
      expect.anything(),
      expect.objectContaining({ approved: false }),
    );

    await tool.execute("t1b", { action: "channel_info", channel: "Slack" });
    expect(mocks.executeSystemAgentOperation).toHaveBeenCalledWith(
      { kind: "channel-info", channel: "slack" },
      expect.anything(),
      expect.objectContaining({ approved: false }),
    );
  });

  it("advertises and lists installed plugins through the canonical read operation", async () => {
    const tool = createSystemAgentTool({ surface: "cli" });

    expect(tool.parameters).toMatchObject({
      properties: {
        action: { enum: expect.arrayContaining(["plugin_list"]) },
      },
    });

    const result = await tool.execute("plugins-list", { action: "plugin_list" });

    expect(toolText(result)).toContain("op-output");
    expect(mocks.executeSystemAgentOperation).toHaveBeenCalledWith(
      { kind: "plugin-list" },
      expect.anything(),
      expect.objectContaining({ approved: false }),
    );
  });

  it("refuses mutating actions without the approved assertion", async () => {
    const proposalRef: { current?: string } = {};
    const tool = createSystemAgentTool({ surface: "cli", approvalArmed: true, proposalRef });
    const result = await tool.execute("t2", {
      action: "config_set",
      path: "gateway.port",
      value: "18789",
    });
    // An armed turn can never mint its own proposal.
    expect(toolText(result)).toContain("approval-mismatch");
    expect(proposalRef.current).toBeUndefined();
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();
  });

  it("refuses model-asserted approval without host-verified consent", async () => {
    // approved=true from the model alone must never mutate: the host arms
    // approval only when the user's actual message was an explicit yes.
    const tool = createSystemAgentTool({ surface: "cli" });
    const result = await tool.execute("t2b", {
      action: "config_set",
      path: "gateway.port",
      value: "18789",
      approved: true,
    });
    expect(toolText(result)).toContain("needs-approval");
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();
  });

  it("registers delegated proposals but never instructs a chat 'yes'", async () => {
    const proposalRef: { current?: string } = {};
    const args = {
      action: "config_set" as const,
      path: "agents.defaults.subagents.thinking",
      value: "high",
      approved: true,
    };
    const tool = createSystemAgentTool({
      surface: "gateway",
      operatorApprovalOnly: true,
      proposalRef,
    });

    const result = await tool.execute("t-delegated", args);
    const text = toolText(result);

    expect(text).toContain("needs-approval:");
    expect(text).toContain("requesting session's permission policy");
    expect(text).toContain("returns the final outcome");
    expect(text).not.toContain("OpenClaw operator UI");
    expect(text).not.toContain("ask the user to reply yes");
    expect(proposalRef.current).toBe(
      hashSystemAgentOperation({
        kind: "config-set",
        path: "agents.defaults.subagents.thinking",
        value: "high",
      }),
    );
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();
    // Out-of-process CLI hosts still mirror the proposal from the marker line.
    expect(resolveSystemAgentProposalTransition({ args, resultText: text })).toEqual({
      proposal: proposalRef.current,
      operation: {
        kind: "config-set",
        path: "agents.defaults.subagents.thinking",
        value: "high",
      },
    });
  });

  it("preserves an allowed gateway credential reference as an exact proposal", async () => {
    const proposalRef: NonNullable<SystemAgentToolOptions["proposalRef"]> = {};
    const result = await createSystemAgentTool({ surface: "gateway", proposalRef }).execute(
      "gateway-reference",
      { action: "config_set_ref", path: "gateway.auth.token", envVar: "GATEWAY_TOKEN" },
    );
    expect(toolText(result)).toContain("needs-approval");
    expect(proposalRef.operation).toEqual({
      kind: "config-set-ref",
      path: "gateway.auth.token",
      source: "env",
      id: "GATEWAY_TOKEN",
    });
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();
  });

  it("does not stage a config proposal after its validation was cancelled", async () => {
    const proposalRef: NonNullable<SystemAgentToolOptions["proposalRef"]> = {};
    const controller = new AbortController();
    const pending = createSystemAgentTool({ surface: "gateway", proposalRef }).execute(
      "cancelled-proposal",
      { action: "config_set", path: "gateway.port", value: "19001" },
      controller.signal,
    );
    controller.abort(new Error("Setup cancelled"));
    await expect(pending).rejects.toThrow("Setup cancelled");
    expect(proposalRef).toEqual({});
  });

  it("preserves a different proposal staged while config validation yields", async () => {
    const proposalRef: NonNullable<SystemAgentToolOptions["proposalRef"]> = {};
    const pending = createSystemAgentTool({ surface: "gateway", proposalRef }).execute(
      "racing-proposal",
      { action: "config_set", path: "gateway.port", value: "19001" },
    );
    const prior = { kind: "gateway-restart" as const };
    proposalRef.operation = prior;
    proposalRef.current = hashSystemAgentOperation(prior);
    expect(toolText(await pending)).toContain("proposal-conflict");
    expect(proposalRef.operation).toEqual(prior);
  });

  it.each([false, true])(
    "preserves a proposal across rejected validation in-process and in the CLI mirror (approved=%s)",
    async (approved) => {
      const operation = {
        kind: "config-set" as const,
        path: "auth.profiles.invalid",
        value: "true",
      };
      const original = { current: hashSystemAgentOperation(operation), operation };
      const proposalRef = { ...original };
      const args = { action: "config_set", path: operation.path, value: operation.value, approved };
      let failure: unknown;
      try {
        await createSystemAgentTool({ surface: "cli", approvalArmed: true, proposalRef }).execute(
          "rejected-validation",
          args,
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(proposalRef).toEqual(original);
      expect(
        resolveSystemAgentProposalTransition({ args, resultText: String(failure) }),
      ).toBeNull();
    },
  );

  it("rejects arbitrary plugin installs before creating an approval proposal", async () => {
    const proposalRef: { current?: string } = {};
    const tool = createSystemAgentTool({ surface: "cli", proposalRef });

    await expect(
      tool.execute("plugin-install", {
        action: "plugin_install",
        spec: "npm:@example/plugin",
        approved: true,
      }),
    ).rejects.toThrow(/trusted shell/);
    expect(proposalRef.current).toBeUndefined();
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();
  });

  it("finishes the exact artifact review before proposing and hands approved bytes to the host", async () => {
    const args = {
      action: "plugin_activate_artifact",
      path: "/tmp/authored-plugin.tgz",
      sha256: "a".repeat(64),
    };
    const operation = {
      kind: "plugin-activate-artifact" as const,
      path: args.path,
      sha256: args.sha256,
    };
    const proposalRef: NonNullable<SystemAgentToolOptions["proposalRef"]> = {};
    let finishReview!: (value: unknown) => void;
    let beginReview!: () => void;
    const started = new Promise<void>((resolve) => {
      beginReview = resolve;
    });
    const review = new Promise<unknown>((resolve) => {
      finishReview = resolve;
    });
    mocks.preparePluginArtifact.mockImplementationOnce(async () => {
      beginReview();
      return await review;
    });
    const pending = createSystemAgentTool({
      surface: "gateway",
      operatorApprovalOnly: true,
      proposalRef,
    }).execute("artifact", args);
    await started;
    expect(proposalRef.current).toBeUndefined();
    finishReview({ pluginId: "authored-plugin", nativeControlUi: true, sha256: args.sha256 });
    const result = await pending;
    expect(toolText(result)).toContain("Reviewed plugin artifact");
    expect(toolText(result)).toContain("requesting session's permission policy");
    expect(resolveSystemAgentProposalTransition({ args, resultText: toolText(result) })).toEqual({
      proposal: hashSystemAgentOperation(operation),
      operation,
    });
    const directiveRef: NonNullable<SystemAgentToolOptions["directiveRef"]> = {};
    await createSystemAgentTool({
      surface: "gateway",
      approvalArmed: true,
      proposalRef,
      directiveRef,
    }).execute("approved-artifact", { ...args, approved: true });
    expect(directiveRef.current).toEqual({ kind: "approved-operation", operation });
    expect(proposalRef.current).toBeUndefined();
    expect(mocks.preparePluginArtifact).toHaveBeenCalledOnce();
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();
  });

  it("does not propose a failed artifact review or overwrite another proposal after review", async () => {
    const args = {
      action: "plugin_activate_artifact",
      path: "/tmp/authored-plugin.tgz",
      sha256: "b".repeat(64),
    };
    const proposalRef: NonNullable<SystemAgentToolOptions["proposalRef"]> = {};
    const tool = createSystemAgentTool({ surface: "gateway", proposalRef });
    mocks.preparePluginArtifact.mockRejectedValueOnce(new Error("SHA256 does not match"));
    await expect(tool.execute("invalid-artifact", args)).rejects.toThrow("SHA256 does not match");
    expect(proposalRef.current).toBeUndefined();
    const prior = hashSystemAgentOperation({ kind: "gateway-restart" });
    mocks.preparePluginArtifact.mockImplementationOnce(async () => {
      proposalRef.current = prior;
      proposalRef.operation = { kind: "gateway-restart" };
      return { pluginId: "authored-plugin" };
    });
    expect(toolText(await tool.execute("racing-artifact", args))).toContain(
      `proposal-conflict:${prior}`,
    );
    expect(proposalRef.operation).toEqual({ kind: "gateway-restart" });
  });

  it("defers an approved mutation to the host after the full proposal handshake", async () => {
    const proposalRef: { current?: string } = {};
    // Phase 1: unarmed proposal is denied and records the exact operation.
    const proposingTool = createSystemAgentTool({ surface: "gateway", proposalRef });
    const denied = await proposingTool.execute("t3a", {
      action: "set_default_model",
      model: "openai/gpt-5.5",
      approved: true,
    });
    expect(toolText(denied)).toContain("needs-approval");
    expect(proposalRef.current).toBeDefined();
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();

    // Phase 2: the user's yes arms the turn; the identical call becomes one
    // host-owned directive so the inference binding can be checked again.
    const directiveRef: { current?: SystemAgentToolDirective } = {};
    const armedTool = createSystemAgentTool({
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
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();
    await armedTool.execute("t3c", { action: "connect_channel", channel: "telegram" });
    expect(directiveRef.current).toEqual({
      kind: "approved-operation",
      operation: { kind: "set-default-model", model: "openai/gpt-5.5" },
    });
    // One approval, one mutation.
    expect(proposalRef.current).toBeUndefined();
  });

  it("keeps the first staged config_set proposal instead of overwriting it with a second", async () => {
    const proposalRef: NonNullable<SystemAgentToolOptions["proposalRef"]> = {};
    const tool = createSystemAgentTool({ surface: "gateway", proposalRef });

    const first = await tool.execute("multi-a", {
      action: "config_set",
      path: "tts.providers.fish-audio.model",
      value: "s2.1-pro",
    });
    expect(toolText(first)).toContain("needs-approval");
    const firstHash = proposalRef.current;
    expect(firstHash).toBeDefined();

    const second = await tool.execute("multi-b", {
      action: "config_set",
      path: "talk.providers.fish-audio.model",
      value: "s2.1-pro",
    });

    // The second, different path must not silently replace the first staged
    // operation: only one operation can ever be approved and applied.
    expect(toolText(second)).toContain("proposal-conflict");
    expect(proposalRef.current).toBe(firstHash);
    expect(proposalRef.operation).toEqual({
      kind: "config-set",
      path: "tts.providers.fish-audio.model",
      value: "s2.1-pro",
    });
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();
  });

  it("binds setup approval to the exact verified model and workspace", async () => {
    const proposalRef: { current?: string } = {};
    const args = {
      action: "setup",
      workspace: "/tmp/work",
      model: "openai/gpt-5.5",
    };
    const result = await createSystemAgentTool({ surface: "gateway", proposalRef }).execute(
      "setup-proposal",
      args,
    );

    expect(toolText(result)).toContain("needs-approval");
    expect(proposalRef.current).toBe(
      hashSystemAgentOperation({
        kind: "setup",
        workspace: "/tmp/work",
        model: "openai/gpt-5.5",
      }),
    );
    expect(
      resolveSystemAgentProposalTransition({
        args,
        resultText: toolText(result),
      }),
    ).toEqual({
      proposal: proposalRef.current,
      operation: {
        kind: "setup",
        workspace: "/tmp/work",
        model: "openai/gpt-5.5",
      },
    });
  });

  it("voids setup approval when the requested model changes", async () => {
    const proposalRef = {
      current: hashSystemAgentOperation({
        kind: "setup",
        model: "openai/gpt-5.5",
      }),
    };
    const tool = createSystemAgentTool({
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
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();
  });

  it("refuses an armed call that differs from the proposed operation", async () => {
    const proposalRef: { current?: string } = {};
    const proposingTool = createSystemAgentTool({ surface: "cli", proposalRef });
    await proposingTool.execute("t3c", {
      action: "set_default_model",
      model: "openai/gpt-5.5",
      approved: true,
    });
    const armedTool = createSystemAgentTool({ surface: "cli", approvalArmed: true, proposalRef });
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
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();
  });

  it("never performs an approved write inside the model tool process", async () => {
    const proposalRef: { current?: string } = {};
    await createSystemAgentTool({ surface: "cli", proposalRef }).execute("t4a", {
      action: "config_set",
      path: "gateway.port",
      value: "banana",
      approved: true,
    });
    const directiveRef: { current?: SystemAgentToolDirective } = {};
    const tool = createSystemAgentTool({
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
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();
    expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
  });

  it("maps create_agent with optional workspace and model", async () => {
    const proposalRef: { current?: string } = {};
    await createSystemAgentTool({ surface: "cli", proposalRef }).execute("t6a", {
      action: "create_agent",
      agentId: "work",
      workspace: "/tmp/work",
      approved: true,
    });
    const directiveRef: { current?: SystemAgentToolDirective } = {};
    const tool = createSystemAgentTool({
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
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();
  });

  it("rejects unknown or underspecified actions as input errors", async () => {
    const tool = createSystemAgentTool({ surface: "cli" });
    await expect(tool.execute("t5", { action: "config_get" })).rejects.toThrow(/path/);
  });

  it("records interactive directives for the host without executing operations", async () => {
    const directiveRef: { current?: SystemAgentToolDirective } = {};
    const tool = createSystemAgentTool({ surface: "cli", directiveRef });

    const connect = await tool.execute("t5", { action: "connect_channel", channel: "Telegram" });
    expect(toolText(connect)).toContain("directive:");
    expect(directiveRef.current).toEqual({ kind: "channel-setup", channel: "telegram" });

    const skills = await tool.execute("t5-skills", { action: "configure_skills" });
    expect(toolText(skills)).toContain("directive:");
    expect(directiveRef.current).toEqual({ kind: "skills-setup" });

    const search = await tool.execute("t5-search", { action: "configure_search" });
    expect(toolText(search)).toContain("directive:");
    expect(toolText(search)).toContain("never ask for or repeat a credential");
    expect(directiveRef.current).toEqual({ kind: "search-setup" });

    const gateway = await tool.execute("t5-gateway", { action: "configure_gateway" });
    expect(toolText(gateway)).toContain("directive:");
    expect(toolText(gateway)).toContain("local Gateway configuration");
    expect(toolText(gateway)).toContain("never ask for or repeat a credential");
    expect(directiveRef.current).toEqual({ kind: "gateway-config-setup" });

    const memory = await tool.execute("t5-memory", { action: "import_memory" });
    expect(toolText(memory)).toContain("directive:");
    expect(toolText(memory)).toContain("copy-only memory import");
    expect(directiveRef.current).toEqual({ kind: "memory-import" });

    const accounts = await tool.execute("t5-accounts", { action: "manage_model_accounts" });
    expect(toolText(accounts)).toContain("Nothing has changed yet");
    expect(toolText(accounts)).toContain("never request, repeat, or put credentials in chat");
    expect(directiveRef.current).toEqual({ kind: "model-accounts" });
    expect(
      resolveSystemAgentDirectiveTransition({
        args: { action: "manage_model_accounts" },
        resultText: toolText(accounts),
      }),
    ).toEqual({ kind: "model-accounts" });

    const configureModel = await tool.execute("t6", {
      action: "configure_model_provider",
      workspace: "/tmp/work",
    });
    expect(toolText(configureModel)).toContain("directive:");
    expect(toolText(configureModel)).toContain(
      "active inference route cannot be changed inside OpenClaw",
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
    expect(toolText(guidedSetup)).toContain("cannot run inside OpenClaw");
    expect(toolText(guidedSetup)).toContain("openclaw onboard");
    expect(directiveRef.current).toEqual({ kind: "open-setup", target: "guided" });

    const gatewaySetup = await tool.execute("t9", {
      action: "open_setup",
      target: "gateway",
    });
    expect(toolText(gatewaySetup)).toContain("masked terminal Gateway setup");
    expect(directiveRef.current).toEqual({ kind: "open-setup", target: "gateway" });

    // Directives are host handoffs, never operation executions.
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();
  });

  it.each([
    { action: "connect_channel", channel: "telegram" },
    { action: "configure_skills" },
    { action: "configure_search" },
    { action: "configure_gateway" },
    { action: "import_memory" },
    { action: "configure_model_provider" },
    { action: "manage_model_accounts" },
    { action: "open_agent" },
    { action: "open_setup", target: "channels" },
  ])("does not promise a delegated $action handoff", async (args) => {
    const directiveRef: { current?: SystemAgentToolDirective } = {};
    const tool = createSystemAgentTool({
      surface: "gateway",
      operatorApprovalOnly: true,
      directiveRef,
    });

    const text = toolText(await tool.execute("delegated-navigation", args));

    expect(text).toContain("cannot run from a delegated agent request");
    expect(directiveRef.current).toBeUndefined();
    expect(resolveSystemAgentDirectiveTransition({ args, resultText: text })).toBeNull();
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();
  });

  it("mirrors directive transitions for out-of-process (CLI MCP) hosts", () => {
    expect(
      resolveSystemAgentDirectiveTransition({
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
      resolveSystemAgentDirectiveTransition({
        args: { action: "connect_channel", channel: "telegram" },
        resultText: "directive: the host chat now starts the guided telegram setup.",
      }),
    ).toEqual({ kind: "channel-setup", channel: "telegram" });
    expect(
      resolveSystemAgentDirectiveTransition({
        args: { action: "configure_skills" },
        resultText: "directive: the host chat starts skills setup.",
      }),
    ).toEqual({ kind: "skills-setup" });
    expect(
      resolveSystemAgentDirectiveTransition({
        args: { action: "configure_search" },
        resultText: "directive: the host chat starts web search setup.",
      }),
    ).toEqual({ kind: "search-setup" });
    expect(
      resolveSystemAgentDirectiveTransition({
        args: { action: "configure_gateway" },
        resultText: "directive: the host chat starts local Gateway setup.",
      }),
    ).toEqual({ kind: "gateway-config-setup" });
    expect(
      resolveSystemAgentDirectiveTransition({
        args: { action: "import_memory" },
        resultText: "directive: the host chat starts memory import.",
      }),
    ).toEqual({ kind: "memory-import" });
    expect(
      resolveSystemAgentDirectiveTransition({
        args: { action: "open_agent" },
        resultText: "directive: the host now hands the user over.",
      }),
    ).toEqual({ kind: "open-tui" });
    expect(
      resolveSystemAgentDirectiveTransition({
        args: { action: "configure_model_provider", workspace: "/tmp/work" },
        resultText:
          "directive: the active inference route cannot be changed inside OpenClaw; run openclaw onboard.",
      }),
    ).toEqual({ kind: "model-setup", workspace: "/tmp/work" });
    expect(
      resolveSystemAgentDirectiveTransition({
        args: { action: "open_setup", target: "classic" },
        resultText: "directive: classic setup cannot run inside OpenClaw; run openclaw onboard.",
      }),
    ).toEqual({ kind: "open-setup", target: "classic" });
    expect(
      resolveSystemAgentDirectiveTransition({
        args: { action: "open_setup", target: "search" },
        resultText: "directive: the host opens masked search setup.",
      }),
    ).toEqual({ kind: "open-setup", target: "search" });
    expect(
      resolveSystemAgentDirectiveTransition({
        args: { action: "open_setup", target: "gateway" },
        resultText: "directive: the host opens masked Gateway setup.",
      }),
    ).toEqual({ kind: "open-setup", target: "gateway" });
    // Non-directive results and other actions never mirror.
    expect(
      resolveSystemAgentDirectiveTransition({ args: { action: "status" }, resultText: "ok" }),
    ).toBeNull();
    expect(
      resolveSystemAgentDirectiveTransition({
        args: { action: "connect_channel", channel: "telegram" },
        resultText: "error: boom",
      }),
    ).toBeNull();
  });

  it("mirrors proposal transitions for out-of-process (CLI MCP) hosts", () => {
    const args = { action: "set_default_model", model: "openai/gpt-5.5" };
    const hash = hashSystemAgentOperation({ kind: "set-default-model", model: "openai/gpt-5.5" });

    // Denial registers the exact-operation hash on the host.
    expect(
      resolveSystemAgentProposalTransition({
        args,
        resultText: "needs-approval: this action changes state.",
      }),
    ).toEqual({
      proposal: hash,
      operation: { kind: "set-default-model", model: "openai/gpt-5.5" },
    });
    expect(
      resolveSystemAgentProposalTransition({
        args,
        resultText: `needs-approval:${hash}\nThis action changes state.`,
      }),
    ).toEqual({
      proposal: hash,
      operation: { kind: "set-default-model", model: "openai/gpt-5.5" },
    });
    // A voided approval clears it.
    expect(
      resolveSystemAgentProposalTransition({
        args,
        resultText: "approval-mismatch: this call is not the operation the user approved.",
      }),
    ).toEqual({ proposal: undefined });
    // Only the admitted host directive consumes it; generic failures are not admission.
    expect(
      resolveSystemAgentProposalTransition({
        args: { ...args, approved: true },
        resultText: "directive:approved-operation: the host will apply this action.",
      }),
    ).toEqual({ proposal: undefined });
    // A rejected second proposal must not overwrite the mirrored first
    // operation: the host keeps proposalRef untouched on a null transition.
    expect(
      resolveSystemAgentProposalTransition({
        args: { action: "config_set", path: "talk.providers.fish-audio.model", value: "s2.1-pro" },
        resultText: `proposal-conflict:${hash}\nA different operation is already staged and awaiting the user's approval.`,
      }),
    ).toBeNull();
    // Read actions and unparsable calls never touch the proposal.
    expect(
      resolveSystemAgentProposalTransition({ args: { action: "status" }, resultText: "ok" }),
    ).toBeNull();
    expect(
      resolveSystemAgentProposalTransition({ args: { action: "bogus" }, resultText: "ok" }),
    ).toBeNull();
  });
});
