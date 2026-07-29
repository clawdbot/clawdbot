// Lobster tests cover lobster tool plugin behavior.
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../runtime-api.js";
import { createLobsterTool } from "./lobster-tool.js";
import { createFakeTaskFlow } from "./taskflow-test-helpers.js";

function fakeApi(overrides: Partial<OpenClawPluginApi> = {}): OpenClawPluginApi {
  return createTestPluginApi({
    id: "lobster",
    name: "lobster",
    source: "test",
    runtime: { version: "test" } as OpenClawPluginApi["runtime"],
    resolvePath: (p) => p,
    ...overrides,
  });
}

function fakeCtx(overrides: Partial<OpenClawPluginToolContext> = {}): OpenClawPluginToolContext {
  return {
    config: {},
    workspaceDir: "/tmp",
    agentDir: "/tmp",
    agentId: "main",
    sessionKey: "main",
    messageChannel: undefined,
    agentAccountId: undefined,
    sandboxed: false,
    ...overrides,
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
}

describe("lobster plugin tool", () => {
  it("returns the Lobster envelope in details", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "ok",
        output: [{ hello: "world" }],
        requiresApproval: null,
      }),
    };

    const tool = createLobsterTool(fakeApi(), { runner });
    const res = await tool.execute("call1", {
      action: "run",
      pipeline: "noop",
      timeoutMs: 1000,
    });

    expect(runner.run).toHaveBeenCalledWith({
      action: "run",
      pipeline: "noop",
      cwd: process.cwd(),
      timeoutMs: 1000,
      maxStdoutBytes: 512_000,
    });
    const details = requireRecord(res.details, "lobster tool details");
    expect(details.ok).toBe(true);
    expect(details.status).toBe("ok");
    expect(details.output).toEqual([{ hello: "world" }]);
    expect(details.requiresApproval).toBeNull();
  });

  it("supports approval envelopes without changing the tool contract", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "needs_approval",
        output: [],
        requiresApproval: {
          type: "approval_request",
          prompt: "Send these alerts?",
          items: [{ id: "alert-1" }],
          resumeToken: "resume-token-1",
        },
      }),
    };

    const tool = createLobsterTool(fakeApi(), { runner });
    const res = await tool.execute("call-injected-runner", {
      action: "run",
      pipeline: "noop",
      argsJson: '{"since_hours":1}',
      timeoutMs: 1500,
      maxStdoutBytes: 4096,
    });

    expect(runner.run).toHaveBeenCalledWith({
      action: "run",
      pipeline: "noop",
      argsJson: '{"since_hours":1}',
      cwd: process.cwd(),
      timeoutMs: 1500,
      maxStdoutBytes: 4096,
    });
    const details = requireRecord(res.details, "approval lobster tool details");
    expect(details.ok).toBe(true);
    expect(details.status).toBe("needs_approval");
    const approval = requireRecord(details.requiresApproval, "approval request");
    expect(approval.type).toBe("approval_request");
    expect(approval.prompt).toBe("Send these alerts?");
    expect(approval.resumeToken).toBe("resume-token-1");
  });

  it("keeps ordinary run on the embedded runner when flow defaults are injected", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "needs_approval",
        output: [],
        requiresApproval: {
          type: "approval_request",
          prompt: "Continue?",
          items: [],
          resumeToken: "resume-token-1",
        },
      }),
    };
    const taskFlow = createFakeTaskFlow();

    const tool = createLobsterTool(fakeApi(), { runner, taskFlow });
    const res = await tool.execute("call-default-flow-run", {
      action: "run",
      pipeline: "noop",
      flowStateJson: "{}",
      flowExpectedRevision: 0,
    });

    expect(taskFlow.createManaged).not.toHaveBeenCalled();
    expect(runner.run).toHaveBeenCalledWith({
      action: "run",
      pipeline: "noop",
      cwd: process.cwd(),
      timeoutMs: 20_000,
      maxStdoutBytes: 512_000,
    });
    const details = requireRecord(res.details, "ordinary run with flow defaults details");
    expect(details.status).toBe("needs_approval");
  });

  it.each([{ flowId: "flow-1" }, { flowExpectedRevision: 1 }])(
    "rejects resume-only fields on run before the ordinary fallback",
    async (resumeFields) => {
      const runner = { run: vi.fn() };
      const tool = createLobsterTool(fakeApi(), {
        runner,
        taskFlow: createFakeTaskFlow(),
      });

      await expect(
        tool.execute("call-run-with-resume-fields", {
          action: "run",
          pipeline: "noop",
          flowStateJson: "{}",
          flowExpectedRevision: 0,
          ...resumeFields,
        }),
      ).rejects.toThrow(/run action does not accept flowId or flowExpectedRevision/);
      expect(runner.run).not.toHaveBeenCalled();
    },
  );

  it("keeps ordinary resume on the embedded runner when flow defaults are injected", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "ok",
        output: [{ approved: true }],
        requiresApproval: null,
      }),
    };
    const taskFlow = createFakeTaskFlow();

    const tool = createLobsterTool(fakeApi(), { runner, taskFlow });
    const res = await tool.execute("call-default-flow-resume", {
      action: "resume",
      token: "resume-token-1",
      approve: true,
      flowStateJson: "{}",
      flowExpectedRevision: 0,
    });

    expect(taskFlow.resume).not.toHaveBeenCalled();
    expect(runner.run).toHaveBeenCalledWith({
      action: "resume",
      token: "resume-token-1",
      approve: true,
      cwd: process.cwd(),
      timeoutMs: 20_000,
      maxStdoutBytes: 512_000,
    });
    const details = requireRecord(res.details, "ordinary resume with flow defaults details");
    expect(details.ok).toBe(true);
    expect(details.status).toBe("ok");
  });

  it.each([
    { flowControllerId: "tests/lobster" },
    { flowGoal: "Run Lobster workflow" },
    { flowStateJson: '{"lane":"email"}' },
  ])("rejects run-only fields on resume before the ordinary fallback", async (runFields) => {
    const runner = { run: vi.fn() };
    const tool = createLobsterTool(fakeApi(), {
      runner,
      taskFlow: createFakeTaskFlow(),
    });

    await expect(
      tool.execute("call-resume-with-run-fields", {
        action: "resume",
        token: "resume-token-1",
        approve: true,
        flowExpectedRevision: 0,
        ...runFields,
      }),
    ).rejects.toThrow(/resume action does not accept flowControllerId, flowGoal, or flowStateJson/);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("rejects resume with a non-default flow revision but no flowId", async () => {
    const runner = { run: vi.fn() };
    const tool = createLobsterTool(fakeApi(), {
      runner,
      taskFlow: createFakeTaskFlow(),
    });

    await expect(
      tool.execute("call-revision-without-flow-id", {
        action: "resume",
        token: "resume-token-1",
        approve: true,
        flowExpectedRevision: 1,
      }),
    ).rejects.toThrow(/flowId required when using managed TaskFlow resume mode/);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("normalizes numeric string run limits before invoking the runner", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "ok",
        output: [],
        requiresApproval: null,
      }),
    };

    const tool = createLobsterTool(fakeApi(), { runner });
    await tool.execute("call-string-limits", {
      action: "run",
      pipeline: "noop",
      timeoutMs: "1500",
      maxStdoutBytes: "4096",
    });

    expect(runner.run).toHaveBeenCalledWith({
      action: "run",
      pipeline: "noop",
      cwd: process.cwd(),
      timeoutMs: 1500,
      maxStdoutBytes: 4096,
    });
  });

  it("rejects malformed numeric run limits before invoking the runner", async () => {
    const runner = { run: vi.fn() };
    const tool = createLobsterTool(fakeApi(), { runner });

    await expect(
      tool.execute("call-bad-timeout", {
        action: "run",
        pipeline: "noop",
        timeoutMs: "1500.5",
      }),
    ).rejects.toThrow("timeoutMs must be a positive integer");
    await expect(
      tool.execute("call-bad-stdout", {
        action: "run",
        pipeline: "noop",
        maxStdoutBytes: 0,
      }),
    ).rejects.toThrow("maxStdoutBytes must be a positive integer");
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("throws when the runner returns an error envelope", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: {
        run: vi.fn().mockResolvedValue({
          ok: false,
          error: {
            type: "runtime_error",
            message: "boom",
          },
        }),
      },
    });

    await expect(
      tool.execute("call-runner-error", {
        action: "run",
        pipeline: "noop",
      }),
    ).rejects.toThrow("boom");
  });

  it("can run through managed TaskFlow mode", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "needs_approval",
        output: [],
        requiresApproval: {
          type: "approval_request",
          prompt: "Approve this?",
          items: [{ id: "item-1" }],
          resumeToken: "resume-1",
          approvalId: "approval-1",
        },
      }),
    };
    const taskFlow = createFakeTaskFlow();

    const tool = createLobsterTool(fakeApi(), { runner, taskFlow });
    const res = await tool.execute("call-managed-run", {
      action: "run",
      pipeline: "noop",
      flowControllerId: "tests/lobster",
      flowGoal: "Run Lobster workflow",
      flowStateJson: '{"lane":"email"}',
      flowExpectedRevision: 0,
      flowCurrentStep: "run_lobster",
      flowWaitingStep: "await_review",
    });

    expect(taskFlow.createManaged).toHaveBeenCalledWith({
      controllerId: "tests/lobster",
      goal: "Run Lobster workflow",
      currentStep: "run_lobster",
      stateJson: { lane: "email" },
    });
    expect(taskFlow.setWaiting).toHaveBeenCalledWith({
      flowId: "flow-1",
      expectedRevision: 1,
      currentStep: "await_review",
      waitJson: {
        kind: "lobster_approval",
        prompt: "Approve this?",
        items: [{ id: "item-1" }],
        resumeToken: "resume-1",
        approvalId: "approval-1",
      },
    });
    const details = requireRecord(res.details, "managed run lobster tool details");
    expect(details.ok).toBe(true);
    expect(details.status).toBe("needs_approval");
    const flow = requireRecord(details.flow, "managed run flow details");
    expect(flow.flowId).toBe("flow-1");
    const mutation = requireRecord(details.mutation, "managed run mutation details");
    expect(mutation.applied).toBe(true);
  });

  it("preserves explicit empty flow state in managed TaskFlow run mode", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "ok",
        output: [],
        requiresApproval: null,
      }),
    };
    const taskFlow = createFakeTaskFlow();

    const tool = createLobsterTool(fakeApi(), { runner, taskFlow });
    await tool.execute("call-managed-run-empty-state", {
      action: "run",
      pipeline: "noop",
      flowControllerId: "tests/lobster",
      flowGoal: "Run Lobster workflow",
      flowStateJson: "{}",
    });

    expect(taskFlow.createManaged).toHaveBeenCalledWith({
      controllerId: "tests/lobster",
      goal: "Run Lobster workflow",
      currentStep: "run_lobster",
      stateJson: {},
    });
    expect(runner.run).toHaveBeenCalledWith({
      action: "run",
      pipeline: "noop",
      cwd: process.cwd(),
      timeoutMs: 20_000,
      maxStdoutBytes: 512_000,
    });
  });

  it("rejects managed TaskFlow params when no bound taskFlow runtime is available", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
    });

    await expect(
      tool.execute("call-missing-taskflow", {
        action: "run",
        pipeline: "noop",
        flowControllerId: "tests/lobster",
        flowGoal: "Run Lobster workflow",
      }),
    ).rejects.toThrow(/Managed TaskFlow run mode requires a bound taskFlow runtime/);
  });

  it("rejects invalid flowStateJson in managed TaskFlow mode", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
      taskFlow: createFakeTaskFlow(),
    });

    await expect(
      tool.execute("call-invalid-flow-json", {
        action: "run",
        pipeline: "noop",
        flowControllerId: "tests/lobster",
        flowGoal: "Run Lobster workflow",
        flowStateJson: "{bad",
      }),
    ).rejects.toThrow(/flowStateJson must be valid JSON/);
  });

  it("can resume managed TaskFlow mode with only approvalId", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "ok",
        output: [],
        requiresApproval: null,
      }),
    };
    const taskFlow = createFakeTaskFlow();
    const tool = createLobsterTool(fakeApi(), { runner, taskFlow });

    const res = await tool.execute("call-managed-resume-approval-id", {
      action: "resume",
      approvalId: "approval-1",
      approve: true,
      flowId: "flow-1",
      flowExpectedRevision: 1,
      flowStateJson: "{}",
      flowCurrentStep: "resume_lobster",
    });

    expect(taskFlow.resume).toHaveBeenCalledWith({
      flowId: "flow-1",
      expectedRevision: 1,
      status: "running",
      currentStep: "resume_lobster",
    });
    expect(runner.run).toHaveBeenCalledWith({
      action: "resume",
      approvalId: "approval-1",
      approve: true,
      cwd: process.cwd(),
      timeoutMs: 20_000,
      maxStdoutBytes: 512_000,
    });
    const details = requireRecord(res.details, "managed resume lobster tool details");
    expect(details.ok).toBe(true);
    expect(details.status).toBe("ok");
    const mutation = requireRecord(details.mutation, "managed resume mutation details");
    expect(mutation.applied).toBe(true);
  });

  it("normalizes numeric string flowExpectedRevision before managed resume", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "ok",
        output: [],
        requiresApproval: null,
      }),
    };
    const taskFlow = createFakeTaskFlow();
    const tool = createLobsterTool(fakeApi(), { runner, taskFlow });

    await tool.execute("call-managed-resume-string-revision", {
      action: "resume",
      approvalId: "approval-1",
      approve: true,
      flowId: "flow-1",
      flowExpectedRevision: "1",
      flowCurrentStep: "resume_lobster",
    });

    expect(taskFlow.resume).toHaveBeenCalledWith({
      flowId: "flow-1",
      expectedRevision: 1,
      status: "running",
      currentStep: "resume_lobster",
    });
  });

  it("rejects managed TaskFlow resume mode without a token or approvalId", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
      taskFlow: createFakeTaskFlow(),
    });

    await expect(
      tool.execute("call-missing-resume-token", {
        action: "resume",
        flowId: "flow-1",
        flowExpectedRevision: 1,
        approve: true,
      }),
    ).rejects.toThrow(/token or approvalId required when using managed TaskFlow resume mode/);
  });

  it("rejects managed TaskFlow resume mode without approve", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
      taskFlow: createFakeTaskFlow(),
    });

    await expect(
      tool.execute("call-missing-resume-approve", {
        action: "resume",
        token: "resume-token",
        flowId: "flow-1",
        flowExpectedRevision: 1,
      }),
    ).rejects.toThrow(/approve required when using managed TaskFlow resume mode/);
  });

  it("requires action", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
    });
    await expect(tool.execute("call-action-missing", {})).rejects.toThrow(/action required/);
  });

  it("rejects unknown action", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
    });
    await expect(
      tool.execute("call-action-unknown", {
        action: "explode",
      }),
    ).rejects.toThrow(/Unknown action/);
  });

  it("rejects absolute cwd", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
    });
    await expect(
      tool.execute("call-absolute-cwd", {
        action: "run",
        pipeline: "noop",
        cwd: "/tmp",
      }),
    ).rejects.toThrow(/cwd must be a relative path/);
  });

  it("rejects cwd that escapes the gateway working directory", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
    });
    await expect(
      tool.execute("call-escape-cwd", {
        action: "run",
        pipeline: "noop",
        cwd: "../../etc",
      }),
    ).rejects.toThrow(/must stay within/);
  });

  it("can be gated off in sandboxed contexts", () => {
    const api = fakeApi();
    const factoryTool = (ctx: OpenClawPluginToolContext) => {
      if (ctx.sandboxed) {
        return null;
      }
      return createLobsterTool(api, {
        runner: { run: vi.fn() },
      });
    };

    expect(factoryTool(fakeCtx({ sandboxed: true }))).toBeNull();
    expect(factoryTool(fakeCtx({ sandboxed: false }))?.name).toBe("lobster");
  });
});
