import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/io.js";
import { sendMessage } from "../infra/outbound/message.js";
import { buildSystemRunPreparePayload } from "../test-utils/system-run-prepare-payload.js";
import { createExecTool } from "./bash-tools.exec.js";
import { callGatewayTool } from "./tools/gateway.js";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

vi.mock("./tools/nodes-utils.js", () => ({
  listNodes: vi.fn(async () => [
    { nodeId: "node-1", commands: ["system.run"], platform: "darwin" },
  ]),
  resolveNodeIdFromList: vi.fn((nodes: Array<{ nodeId: string }>) => nodes[0]?.nodeId),
}));

vi.mock("../infra/outbound/message.js", () => ({
  sendMessage: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../infra/shell-env.js", async () => {
  const mod =
    await vi.importActual<typeof import("../infra/shell-env.js")>("../infra/shell-env.js");
  return {
    ...mod,
    getShellPathFromLoginShell: vi.fn(() => null),
    resolveShellEnvFallbackTimeoutMs: vi.fn(() => 0),
  };
});

function buildPreparedSystemRunPayload(rawInvokeParams: unknown) {
  const invoke = (rawInvokeParams ?? {}) as {
    params?: {
      command?: unknown;
      rawCommand?: unknown;
      cwd?: unknown;
      agentId?: unknown;
      sessionKey?: unknown;
    };
  };
  const params = invoke.params ?? {};
  return buildSystemRunPreparePayload(params);
}

async function writeExecApprovalsConfig(config: Record<string, unknown>) {
  const approvalsPath = path.join(process.env.HOME ?? "", ".openclaw", "exec-approvals.json");
  await fs.mkdir(path.dirname(approvalsPath), { recursive: true });
  await fs.writeFile(approvalsPath, JSON.stringify(config, null, 2));
}

function acceptedApprovalResponse(params: unknown) {
  return { status: "accepted", id: (params as { id?: string })?.id };
}

function getResultText(result: { content: Array<{ type?: string; text?: string }> }) {
  return result.content.find((part) => part.type === "text")?.text ?? "";
}

function expectPendingApprovalText(
  result: {
    details: { status?: string };
    content: Array<{ type?: string; text?: string }>;
  },
  options: {
    command: string;
    host: "gateway" | "node";
    nodeId?: string;
    interactive?: boolean;
    allowedDecisions?: string;
    cwdText?: string;
  },
) {
  expect(result.details.status).toBe("approval-pending");
  const details = result.details as { approvalId: string; approvalSlug: string };
  const pendingText = getResultText(result);
  expect(pendingText).toContain(
    `Reply with: /approve ${details.approvalSlug} ${options.allowedDecisions ?? "allow-once|allow-always|deny"}`,
  );
  expect(pendingText).toContain(`full ${details.approvalId}`);
  expect(pendingText).toContain(`Host: ${options.host}`);
  if (options.nodeId) {
    expect(pendingText).toContain(`Node: ${options.nodeId}`);
  }
  expect(pendingText).toContain(`CWD: ${options.cwdText ?? process.cwd()}`);
  expect(pendingText).toContain("Command:\n```sh\n");
  expect(pendingText).toContain(options.command);
  if (options.interactive) {
    expect(pendingText).toContain("Mode: foreground (interactive approvals available).");
    expect(pendingText).toContain(
      (options.allowedDecisions ?? "").includes("allow-always")
        ? "Background mode requires pre-approved policy"
        : "Background mode requires an effective policy that allows pre-approval",
    );
  }
  return details;
}

function expectPendingCommandText(
  result: {
    details: { status?: string };
    content: Array<{ type?: string; text?: string }>;
  },
  command: string,
) {
  expect(result.details.status).toBe("approval-pending");
  const text = getResultText(result);
  expect(text).toContain("Command:\n```sh\n");
  expect(text).toContain(command);
}

function mockGatewayOkCalls(calls: string[]) {
  vi.mocked(callGatewayTool).mockImplementation(async (method) => {
    calls.push(method);
    return { ok: true };
  });
}

function createElevatedAllowlistExecTool() {
  return createExecTool({
    ask: "on-miss",
    security: "allowlist",
    approvalRunningNoticeMs: 0,
    elevated: { enabled: true, allowed: true, defaultLevel: "ask" },
  });
}

async function expectGatewayExecWithoutApproval(options: {
  config: Record<string, unknown>;
  command: string;
  ask?: "always" | "on-miss" | "off";
  security?: "allowlist" | "full";
}) {
  await writeExecApprovalsConfig(options.config);
  const calls: string[] = [];
  mockGatewayOkCalls(calls);

  const tool = createExecTool({
    host: "gateway",
    ask: options.ask,
    security: options.security,
    approvalRunningNoticeMs: 0,
  });

  const result = await tool.execute("call-no-approval", { command: options.command });
  expect(result.details.status).toBe("completed");
  expect(calls).not.toContain("exec.approval.request");
  expect(calls).not.toContain("exec.approval.waitDecision");
}

async function expectGatewayAskAlwaysPrompt(options: {
  turnId: string;
  command?: string;
  allowlist?: Array<{ pattern: string; source?: "allow-always" }>;
}) {
  await writeExecApprovalsConfig({
    version: 1,
    defaults: { security: "full", ask: "always", askFallback: "full" },
    agents: {
      main: options.allowlist ? { allowlist: options.allowlist } : {},
    },
  });
  mockPendingApprovalRegistration();

  const tool = createExecTool({
    host: "gateway",
    ask: "always",
    security: "full",
    approvalRunningNoticeMs: 0,
  });

  return await tool.execute(options.turnId, {
    command: options.command ?? `${JSON.stringify(process.execPath)} --version`,
  });
}

function mockAcceptedApprovalFlow(options: {
  onAgent?: (params: Record<string, unknown>) => void;
  onNodeInvoke?: (params: unknown) => unknown;
}) {
  vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
    if (method === "exec.approval.request") {
      return acceptedApprovalResponse(params);
    }
    if (method === "exec.approval.waitDecision") {
      return { decision: "allow-once" };
    }
    if (method === "agent" && options.onAgent) {
      options.onAgent(params as Record<string, unknown>);
      return { status: "ok" };
    }
    if (method === "node.invoke" && options.onNodeInvoke) {
      return await options.onNodeInvoke(params);
    }
    return { ok: true };
  });
}

function mockPendingApprovalRegistration() {
  vi.mocked(callGatewayTool).mockImplementation(async (method) => {
    if (method === "exec.approval.request") {
      return { status: "accepted", id: "approval-id" };
    }
    if (method === "exec.approval.waitDecision") {
      return { decision: null };
    }
    return { ok: true };
  });
}

function mockNoApprovalRouteRegistration() {
  vi.mocked(callGatewayTool).mockImplementation(async (method) => {
    if (method === "exec.approval.request") {
      return { id: "approval-id", decision: null };
    }
    if (method === "exec.approval.waitDecision") {
      return { decision: null };
    }
    return { ok: true };
  });
}

describe("exec approvals", () => {
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;
  let previousBundledPluginsDir: string | undefined;
  let previousDisableBundledPlugins: string | undefined;
  let tempRoot = "";
  let tempCaseIndex = 0;

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-exec-approvals-"));
  });

  beforeEach(async () => {
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    previousBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    previousDisableBundledPlugins = process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
    const tempDir = path.join(tempRoot, `case-${++tempCaseIndex}`);
    await fs.mkdir(tempDir, { recursive: true });
    process.env.HOME = tempDir;
    // Windows uses USERPROFILE for os.homedir()
    process.env.USERPROFILE = tempDir;
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    vi.mocked(callGatewayTool).mockReset();
    vi.mocked(sendMessage).mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
    if (previousBundledPluginsDir === undefined) {
      delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    } else {
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = previousBundledPluginsDir;
    }
    if (previousDisableBundledPlugins === undefined) {
      delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
    } else {
      process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = previousDisableBundledPlugins;
    }
  });

  afterAll(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("reuses approval id as the node runId", async () => {
    let invokeParams: unknown;
    let agentParams: unknown;

    mockAcceptedApprovalFlow({
      onAgent: (params) => {
        agentParams = params;
      },
      onNodeInvoke: (params) => {
        const invoke = params as { command?: string };
        if (invoke.command === "system.run.prepare") {
          return buildPreparedSystemRunPayload(params);
        }
        if (invoke.command === "system.run") {
          invokeParams = params;
          return { payload: { success: true, stdout: "ok" } };
        }
        return undefined;
      },
    });

    const tool = createExecTool({
      host: "node",
      ask: "always",
      approvalRunningNoticeMs: 0,
      sessionKey: "agent:main:main",
    });

    const result = await tool.execute("call1", { command: "ls -la" });
    const details = expectPendingApprovalText(result, {
      command: "ls -la",
      host: "node",
      nodeId: "node-1",
      interactive: true,
      allowedDecisions: "allow-once|deny",
      cwdText: "(node default)",
    });
    const approvalId = details.approvalId;

    await expect
      .poll(() => (invokeParams as { params?: { runId?: string } } | undefined)?.params?.runId, {
        timeout: 2000,
        interval: 1,
      })
      .toBe(approvalId);
    expect(
      (invokeParams as { params?: { suppressNotifyOnExit?: boolean } } | undefined)?.params,
    ).toMatchObject({
      suppressNotifyOnExit: true,
    });
    await expect.poll(() => agentParams, { timeout: 2_000, interval: 1 }).toBeTruthy();
  });

  it("skips approval when node allowlist is satisfied", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-bin-"));
    const binDir = path.join(tempDir, "bin");
    await fs.mkdir(binDir, { recursive: true });
    const exeName = process.platform === "win32" ? "tool.cmd" : "tool";
    const exePath = path.join(binDir, exeName);
    await fs.writeFile(exePath, "");
    if (process.platform !== "win32") {
      await fs.chmod(exePath, 0o755);
    }
    const approvalsFile = {
      version: 1,
      defaults: { security: "allowlist", ask: "on-miss", askFallback: "deny" },
      agents: {
        main: {
          allowlist: [{ pattern: exePath }],
        },
      },
    };

    const calls: string[] = [];
    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      calls.push(method);
      if (method === "exec.approvals.node.get") {
        return { file: approvalsFile };
      }
      if (method === "node.invoke") {
        const invoke = params as { command?: string };
        if (invoke.command === "system.run.prepare") {
          return buildPreparedSystemRunPayload(params);
        }
        return { payload: { success: true, stdout: "ok" } };
      }
      // exec.approval.request should NOT be called when allowlist is satisfied
      return { ok: true };
    });

    const tool = createExecTool({
      host: "node",
      security: "allowlist",
      ask: "on-miss",
      approvalRunningNoticeMs: 0,
    });

    const result = await tool.execute("call2", {
      command: `"${exePath}" --help`,
    });
    expect(result.details.status).toBe("completed");
    expect(calls).toContain("exec.approvals.node.get");
    expect(calls).toContain("node.invoke");
    expect(calls).not.toContain("exec.approval.request");
  });

  it("preserves explicit workdir for node exec", async () => {
    const remoteWorkdir = "/Users/vv";
    let prepareCwd: string | undefined;

    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      if (method === "node.invoke") {
        const invoke = params as { command?: string; params?: { cwd?: string } };
        if (invoke.command === "system.run.prepare") {
          prepareCwd = invoke.params?.cwd;
          return buildPreparedSystemRunPayload(params);
        }
        if (invoke.command === "system.run") {
          return { payload: { success: true, stdout: "ok" } };
        }
      }
      return { ok: true };
    });

    const tool = createExecTool({
      host: "node",
      ask: "off",
      security: "full",
      approvalRunningNoticeMs: 0,
    });

    const result = await tool.execute("call-node-cwd", {
      command: "/bin/pwd",
      workdir: remoteWorkdir,
    });

    expect(result.details.status).toBe("completed");
    expect(prepareCwd).toBe(remoteWorkdir);
  });

  it("does not forward the gateway default cwd to node exec when workdir is omitted", async () => {
    const gatewayWorkspace = "/gateway/workspace";
    let prepareHasCwd = false;
    let prepareCwd: string | undefined;

    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      if (method === "node.invoke") {
        const invoke = params as { command?: string; params?: { cwd?: string } };
        if (invoke.command === "system.run.prepare") {
          prepareHasCwd = Object.hasOwn(invoke.params ?? {}, "cwd");
          prepareCwd = invoke.params?.cwd;
          return buildPreparedSystemRunPayload(params);
        }
        if (invoke.command === "system.run") {
          return { payload: { success: true, stdout: "ok" } };
        }
      }
      return { ok: true };
    });

    const tool = createExecTool({
      host: "node",
      ask: "off",
      security: "full",
      approvalRunningNoticeMs: 0,
      cwd: gatewayWorkspace,
    });

    const result = await tool.execute("call-node-default-cwd", {
      command: "/bin/pwd",
    });

    expect(result.details.status).toBe("completed");
    expect(prepareHasCwd).toBe(false);
    expect(prepareCwd).toBeUndefined();
  });

  it("routes explicit host=node to node invoke when elevated default is on under auto host", async () => {
    const calls: string[] = [];

    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      calls.push(method);
      if (method === "node.invoke") {
        const invoke = params as { command?: string };
        if (invoke.command === "system.run.prepare") {
          return buildPreparedSystemRunPayload(params);
        }
        if (invoke.command === "system.run") {
          return { payload: { success: true, stdout: "node-ok" } };
        }
      }
      return { ok: true };
    });

    const tool = createExecTool({
      host: "auto",
      ask: "off",
      security: "full",
      approvalRunningNoticeMs: 0,
      elevated: { enabled: true, allowed: true, defaultLevel: "on" },
    });

    const result = await tool.execute("call-auto-node-elevated-default", {
      command: "echo gateway-ok",
      host: "node",
    });

    expect(result.details.status).toBe("completed");
    expect(getResultText(result)).toContain("node-ok");
    expect(calls).toContain("node.invoke");
  });

  it("honors ask=off for elevated gateway exec without prompting", async () => {
    const calls: string[] = [];
    vi.mocked(callGatewayTool).mockImplementation(async (method) => {
      calls.push(method);
      return { ok: true };
    });

    const tool = createExecTool({
      ask: "off",
      security: "full",
      approvalRunningNoticeMs: 0,
      elevated: { enabled: true, allowed: true, defaultLevel: "ask" },
    });

    const result = await tool.execute("call3", { command: "echo ok", elevated: true });
    expect(result.details.status).toBe("completed");
    expect(calls).not.toContain("exec.approval.request");
  });

  it("uses exec-approvals defaults to suppress gateway prompts", async () => {
    const cases: Array<{
      config: Record<string, unknown>;
      ask?: "always" | "on-miss" | "off";
      security?: "allowlist" | "full";
    }> = [
      {
        config: {
          version: 1,
          defaults: { security: "full", ask: "off", askFallback: "full" },
          agents: {
            main: { security: "full", ask: "off", askFallback: "full" },
          },
        },
        ask: "on-miss",
      },
      {
        config: {
          version: 1,
          defaults: { security: "full", ask: "off", askFallback: "full" },
          agents: {},
        },
      },
      {
        config: {
          version: 1,
          defaults: { security: "full", ask: "off", askFallback: "full" },
          agents: {},
        },
        security: undefined,
      },
    ];

    for (const testCase of cases) {
      await expectGatewayExecWithoutApproval({
        ...testCase,
        command: "echo ok",
      });
    }
  });

  it("keeps ask=always prompts for durable and static allowlist entries", async () => {
    const durable = await expectGatewayAskAlwaysPrompt({
      turnId: "call-gateway-durable-still-prompts",
      allowlist: [{ pattern: process.execPath, source: "allow-always" }],
    });

    expect(durable.details.status).toBe("approval-pending");
    expect(durable.details).toMatchObject({
      allowedDecisions: ["allow-once", "deny"],
    });
    expect(getResultText(durable)).toContain("Reply with: /approve ");
    expect(getResultText(durable)).toContain("allow-once|deny");
    expect(getResultText(durable)).not.toContain("allow-once|allow-always|deny");
    expect(getResultText(durable)).toContain("Allow Always is unavailable");

    const staticAllowlist = await expectGatewayAskAlwaysPrompt({
      turnId: "call-static-allowlist-still-prompts",
      allowlist: [{ pattern: process.execPath }],
    });

    expect(staticAllowlist.details.status).toBe("approval-pending");
  });

  it("reuses gateway allow-always approvals for repeated exact commands", async () => {
    await writeExecApprovalsConfig({
      version: 1,
      defaults: { security: "allowlist", ask: "on-miss", askFallback: "deny" },
      agents: {},
    });
    const calls: string[] = [];
    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      calls.push(method);
      if (method === "exec.approval.request") {
        return acceptedApprovalResponse(params);
      }
      if (method === "exec.approval.waitDecision") {
        return { decision: "allow-always" };
      }
      return { ok: true };
    });

    const tool = createExecTool({
      host: "gateway",
      ask: "on-miss",
      security: "allowlist",
      approvalRunningNoticeMs: 0,
    });
    const command = "echo allow-always";

    const first = await tool.execute("call-gateway-allow-always-initial", {
      command,
    });

    expect(first.details.status).toBe("approval-pending");
    expect(calls).toContain("exec.approval.request");
    expect(calls).toContain("exec.approval.waitDecision");

    const approvalsPath = path.join(process.env.HOME ?? "", ".openclaw", "exec-approvals.json");
    await expect
      .poll(
        async () => {
          const raw = await fs.readFile(approvalsPath, "utf8");
          const parsed = JSON.parse(raw) as {
            agents?: { main?: { allowlist?: Array<{ source?: string }> } };
          };
          return parsed.agents?.main?.allowlist?.some((entry) => entry.source === "allow-always");
        },
        { timeout: 1_000, interval: 1 },
      )
      .toBe(true);

    calls.length = 0;

    const second = await tool.execute("call-gateway-allow-always-repeat", {
      command,
    });

    expect(second.details.status).toBe("completed");
    expect(calls).not.toContain("exec.approval.request");
    expect(calls).not.toContain("exec.approval.waitDecision");
  });

  it("keeps ask=always prompts for node-host runs even with durable trust", async () => {
    const calls: string[] = [];
    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      calls.push(method);
      if (method === "exec.approvals.node.get") {
        return {
          file: {
            version: 1,
            agents: {
              main: {
                allowlist: [{ pattern: process.execPath, source: "allow-always" }],
              },
            },
          },
        };
      }
      if (method === "node.invoke") {
        const invoke = params as { command?: string };
        if (invoke.command === "system.run.prepare") {
          return buildPreparedSystemRunPayload(params);
        }
        if (invoke.command === "system.run") {
          return { payload: { success: true, stdout: "node-ok" } };
        }
      }
      return { ok: true };
    });

    const tool = createExecTool({
      host: "node",
      ask: "always",
      security: "full",
      approvalRunningNoticeMs: 0,
    });

    const result = await tool.execute("call-node-durable-allow-always", {
      command: `${JSON.stringify(process.execPath)} --version`,
    });

    expect(result.details.status).toBe("approval-pending");
    expect(result.details).toMatchObject({
      allowedDecisions: ["allow-once", "deny"],
    });
    expect(calls).toContain("exec.approval.request");
  });

  it("reuses exact-command durable trust for node shell-wrapper reruns", async () => {
    const calls: string[] = [];
    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      calls.push(method);
      if (method === "exec.approvals.node.get") {
        const prepared = buildPreparedSystemRunPayload({
          params: { command: ["/bin/sh", "-lc", "cd ."], cwd: process.cwd() },
        }) as { payload?: { plan?: { commandText?: string } } };
        const commandText = prepared.payload?.plan?.commandText ?? "";
        return {
          file: {
            version: 1,
            agents: {
              main: {
                allowlist: [
                  {
                    pattern: `=command:${crypto
                      .createHash("sha256")
                      .update(commandText)
                      .digest("hex")
                      .slice(0, 16)}`,
                    source: "allow-always",
                  },
                ],
              },
            },
          },
        };
      }
      if (method === "node.invoke") {
        const invoke = params as { command?: string };
        if (invoke.command === "system.run.prepare") {
          return buildPreparedSystemRunPayload(params);
        }
        if (invoke.command === "system.run") {
          return { payload: { success: true, stdout: "node-shell-wrapper-ok" } };
        }
      }
      return { ok: true };
    });

    const tool = createExecTool({
      host: "node",
      ask: "on-miss",
      security: "allowlist",
      approvalRunningNoticeMs: 0,
    });

    const result = await tool.execute("call-node-shell-wrapper-durable-allow-always", {
      command: "cd .",
    });

    expect(result.details.status).toBe("completed");
    expect(getResultText(result)).toContain("node-shell-wrapper-ok");
    expect(calls).not.toContain("exec.approval.request");
    expect(calls).not.toContain("exec.approval.waitDecision");
  });

  it("requires approval for elevated ask when allowlist misses", async () => {
    const calls: string[] = [];
    let resolveApproval: (() => void) | undefined;
    const approvalSeen = new Promise<void>((resolve) => {
      resolveApproval = resolve;
    });

    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      calls.push(method);
      if (method === "exec.approval.request") {
        resolveApproval?.();
        // Return registration confirmation
        return acceptedApprovalResponse(params);
      }
      if (method === "exec.approval.waitDecision") {
        return { decision: "deny" };
      }
      return { ok: true };
    });

    const tool = createElevatedAllowlistExecTool();

    const result = await tool.execute("call4", { command: "echo ok", elevated: true });
    expectPendingApprovalText(result, { command: "echo ok", host: "gateway" });
    await approvalSeen;
    expect(calls).toContain("exec.approval.request");
    expect(calls).toContain("exec.approval.waitDecision");
  });

  it("starts an internal agent follow-up after approved gateway exec completes without an external route", async () => {
    const agentCalls: Array<Record<string, unknown>> = [];

    mockAcceptedApprovalFlow({
      onAgent: (params) => {
        agentCalls.push(params);
      },
    });

    const tool = createExecTool({
      host: "gateway",
      ask: "always",
      approvalRunningNoticeMs: 0,
      sessionKey: "agent:main:main",
      elevated: { enabled: true, allowed: true, defaultLevel: "ask" },
    });

    const result = await tool.execute("call-gw-followup", {
      command: "echo ok",
      workdir: process.cwd(),
    });

    expect(result.details.status).toBe("approval-pending");
    await expect.poll(() => agentCalls.length, { timeout: 3_000, interval: 1 }).toBe(1);
    expect(agentCalls[0]).toEqual(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        deliver: false,
        idempotencyKey: expect.stringContaining("exec-approval-followup:"),
      }),
    );
    expect(typeof agentCalls[0]?.message).toBe("string");
    expect(agentCalls[0]?.message).toContain(
      "An async command the user already approved has completed.",
    );
  });

  it("continues the original agent session after approved gateway exec completes with an external route", async () => {
    const agentCalls: Array<Record<string, unknown>> = [];

    mockAcceptedApprovalFlow({
      onAgent: (params) => {
        agentCalls.push(params);
      },
    });

    const tool = createExecTool({
      host: "gateway",
      ask: "always",
      approvalRunningNoticeMs: 0,
      sessionKey: "agent:main:discord:channel:123",
      elevated: { enabled: true, allowed: true, defaultLevel: "ask" },
      messageProvider: "discord",
      currentChannelId: "123",
      accountId: "default",
      currentThreadTs: "456",
    });

    const result = await tool.execute("call-gw-followup-discord", {
      command: "echo ok",
      workdir: process.cwd(),
    });

    expect(result.details.status).toBe("approval-pending");
    await expect.poll(() => agentCalls.length, { timeout: 3_000, interval: 1 }).toBe(1);
    expect(agentCalls[0]).toEqual(
      expect.objectContaining({
        sessionKey: "agent:main:discord:channel:123",
        deliver: true,
        bestEffortDeliver: true,
        channel: "discord",
        to: "123",
        accountId: "default",
        threadId: "456",
        idempotencyKey: expect.stringContaining("exec-approval-followup:"),
      }),
    );
    expect(typeof agentCalls[0]?.message).toBe("string");
    expect(agentCalls[0]?.message).toContain(
      "If the task requires more steps, continue from this result before replying to the user.",
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("auto-continues the same Discord session after approval resolves without a second user turn", async () => {
    const agentCalls: Array<Record<string, unknown>> = [];
    let resolveDecision: ((value: { decision: string }) => void) | undefined;
    const decisionPromise = new Promise<{ decision: string }>((resolve) => {
      resolveDecision = resolve;
    });

    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      if (method === "exec.approval.request") {
        return acceptedApprovalResponse(params);
      }
      if (method === "exec.approval.waitDecision") {
        return await decisionPromise;
      }
      if (method === "agent") {
        agentCalls.push(params as Record<string, unknown>);
        return { status: "ok" };
      }
      return { ok: true };
    });

    const tool = createExecTool({
      host: "gateway",
      ask: "always",
      approvalRunningNoticeMs: 0,
      sessionKey: "agent:main:discord:channel:123",
      elevated: { enabled: true, allowed: true, defaultLevel: "ask" },
      messageProvider: "discord",
      currentChannelId: "123",
      accountId: "default",
      currentThreadTs: "456",
    });

    const result = await tool.execute("call-gw-followup-discord-delayed", {
      command: "printf delayed-ok",
      workdir: process.cwd(),
    });

    expect(result.details.status).toBe("approval-pending");
    expect(agentCalls).toHaveLength(0);

    resolveDecision?.({ decision: "allow-once" });

    await expect.poll(() => agentCalls.length, { timeout: 3_000, interval: 1 }).toBe(1);
    expect(agentCalls[0]).toEqual(
      expect.objectContaining({
        sessionKey: "agent:main:discord:channel:123",
        deliver: true,
        bestEffortDeliver: true,
        channel: "discord",
        to: "123",
        accountId: "default",
        threadId: "456",
      }),
    );
    expect(typeof agentCalls[0]?.message).toBe("string");
    expect(agentCalls[0]?.message).toContain(
      "If the task requires more steps, continue from this result before replying to the user.",
    );
    expect(agentCalls[0]?.message).toContain("delayed-ok");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("executes approved commands and emits a session-only followup in webchat-only mode", async () => {
    const agentCalls: Array<Record<string, unknown>> = [];

    mockAcceptedApprovalFlow({
      onAgent: (params) => {
        agentCalls.push(params);
      },
    });

    const tool = createExecTool({
      host: "gateway",
      ask: "always",
      approvalRunningNoticeMs: 0,
      sessionKey: "agent:main:main",
      elevated: { enabled: true, allowed: true, defaultLevel: "ask" },
    });

    const result = await tool.execute("call-gw-followup-webchat", {
      command: "printf webchat-ok",
      workdir: process.cwd(),
    });

    expect(result.details.status).toBe("approval-pending");

    await expect.poll(() => agentCalls.length, { timeout: 3_000, interval: 1 }).toBe(1);
    expect(agentCalls[0]).toEqual(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        deliver: false,
      }),
    );
    expect(agentCalls[0]?.message).toContain("webchat-ok");
  });

  it("uses a deny-specific followup prompt so prior output is not reused", async () => {
    const agentCalls: Array<Record<string, unknown>> = [];

    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      if (method === "exec.approval.request") {
        return acceptedApprovalResponse(params);
      }
      if (method === "exec.approval.waitDecision") {
        return { decision: "deny" };
      }
      if (method === "agent") {
        agentCalls.push(params as Record<string, unknown>);
        return { status: "ok" };
      }
      return { ok: true };
    });

    const tool = createExecTool({
      host: "gateway",
      ask: "always",
      approvalRunningNoticeMs: 0,
      sessionKey: "agent:main:main",
      elevated: { enabled: true, allowed: true, defaultLevel: "ask" },
    });

    const result = await tool.execute("call-gw-followup-deny", {
      command: "echo ok",
      workdir: process.cwd(),
    });

    expect(result.details.status).toBe("approval-pending");
    await expect.poll(() => agentCalls.length, { timeout: 3_000, interval: 1 }).toBe(1);
    expect(typeof agentCalls[0]?.message).toBe("string");
    expect(agentCalls[0]?.message).toContain("An async command did not run.");
    expect(agentCalls[0]?.message).toContain(
      "Do not mention, summarize, or reuse output from any earlier run in this session.",
    );
    expect(agentCalls[0]?.message).not.toContain(
      "An async command the user already approved has completed.",
    );
  });

  it("requires a separate approval for each elevated command after allow-once", async () => {
    const requestCommands: string[] = [];
    const requestIds: string[] = [];
    const waitIds: string[] = [];

    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      if (method === "exec.approval.request") {
        const request = params as { id?: string; command?: string };
        if (typeof request.command === "string") {
          requestCommands.push(request.command);
        }
        if (typeof request.id === "string") {
          requestIds.push(request.id);
        }
        return acceptedApprovalResponse(request);
      }
      if (method === "exec.approval.waitDecision") {
        const wait = params as { id?: string };
        if (typeof wait.id === "string") {
          waitIds.push(wait.id);
        }
        return { decision: "allow-once" };
      }
      return { ok: true };
    });

    const tool = createElevatedAllowlistExecTool();

    const first = await tool.execute("call-seq-1", {
      command: "npm view diver --json",
      elevated: true,
    });
    const second = await tool.execute("call-seq-2", {
      command: "brew outdated",
      elevated: true,
    });

    expect(first.details.status).toBe("approval-pending");
    expect(second.details.status).toBe("approval-pending");
    expect(requestCommands).toEqual(["npm view diver --json", "brew outdated"]);
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).not.toBe(requestIds[1]);
    expect(waitIds).toEqual(requestIds);
  });

  it("shows full chained gateway commands in approval-pending message", async () => {
    const calls: string[] = [];
    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      calls.push(method);
      if (method === "exec.approval.request") {
        return acceptedApprovalResponse(params);
      }
      if (method === "exec.approval.waitDecision") {
        return { decision: "deny" };
      }
      return { ok: true };
    });

    const tool = createExecTool({
      host: "gateway",
      ask: "on-miss",
      security: "allowlist",
      approvalRunningNoticeMs: 0,
    });

    const result = await tool.execute("call-chain-gateway", {
      command: "npm view diver --json | jq .name && brew outdated",
    });

    expectPendingCommandText(result, "npm view diver --json | jq .name && brew outdated");
    expect(calls).toContain("exec.approval.request");
  });

  it("runs a skill wrapper chain without prompting when the wrapper is allowlisted", async () => {
    if (process.platform === "win32") {
      return;
    }
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-wrapper-"));
    try {
      const skillDir = path.join(tempDir, ".openclaw", "skills", "gog");
      const skillPath = path.join(skillDir, "SKILL.md");
      const binDir = path.join(tempDir, "bin");
      const wrapperPath = path.join(binDir, "gog-wrapper");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(skillPath, "# gog skill\n");
      await fs.writeFile(wrapperPath, "#!/bin/sh\necho '{\"events\":[]}'\n");
      await fs.chmod(wrapperPath, 0o755);

      await writeExecApprovalsConfig({
        version: 1,
        defaults: { security: "allowlist", ask: "off", askFallback: "deny" },
        agents: {
          main: {
            allowlist: [{ pattern: wrapperPath }],
          },
        },
      });

      const calls: string[] = [];
      mockGatewayOkCalls(calls);

      const tool = createExecTool({
        host: "gateway",
        ask: "off",
        security: "allowlist",
        approvalRunningNoticeMs: 0,
      });

      const result = await tool.execute("call-skill-wrapper", {
        command: `cat ${JSON.stringify(skillPath)} && printf '\\n---CMD---\\n' && ${JSON.stringify(wrapperPath)} calendar events primary --today --json`,
        workdir: tempDir,
      });

      expect(result.details.status).toBe("completed");
      expect(getResultText(result)).toContain('{"events":[]}');
      expect(calls).not.toContain("exec.approval.request");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("shows full chained node commands in approval-pending message", async () => {
    const calls: string[] = [];
    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      calls.push(method);
      if (method === "node.invoke") {
        const invoke = params as { command?: string };
        if (invoke.command === "system.run.prepare") {
          return buildPreparedSystemRunPayload(params);
        }
      }
      return { ok: true };
    });

    const tool = createExecTool({
      host: "node",
      ask: "always",
      security: "full",
      approvalRunningNoticeMs: 0,
    });

    const result = await tool.execute("call-chain-node", {
      command: "npm view diver --json | jq .name && brew outdated",
    });

    expectPendingCommandText(result, "npm view diver --json | jq .name && brew outdated");
    expect(calls).toContain("exec.approval.request");
  });

  it("waits for approval registration before returning approval-pending", async () => {
    const calls: string[] = [];
    let resolveRegistration: ((value: unknown) => void) | undefined;
    const registrationPromise = new Promise<unknown>((resolve) => {
      resolveRegistration = resolve;
    });

    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      calls.push(method);
      if (method === "exec.approval.request") {
        return await registrationPromise;
      }
      if (method === "exec.approval.waitDecision") {
        return { decision: "deny" };
      }
      return { ok: true, id: (params as { id?: string })?.id };
    });

    const tool = createExecTool({
      host: "gateway",
      ask: "on-miss",
      security: "allowlist",
      approvalRunningNoticeMs: 0,
    });

    let settled = false;
    const executePromise = tool.execute("call-registration-gate", { command: "echo register" });
    void executePromise.finally(() => {
      settled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveRegistration?.({ status: "accepted", id: "approval-id" });
    const result = await executePromise;
    expect(result.details.status).toBe("approval-pending");
    expect(calls[0]).toBe("exec.approval.request");
    expect(calls).toContain("exec.approval.waitDecision");
  });

  it("fails fast when approval registration fails", async () => {
    vi.mocked(callGatewayTool).mockImplementation(async (method) => {
      if (method === "exec.approval.request") {
        throw new Error("gateway offline");
      }
      return { ok: true };
    });

    const tool = createExecTool({
      host: "gateway",
      ask: "on-miss",
      security: "allowlist",
      approvalRunningNoticeMs: 0,
    });

    await expect(tool.execute("call-registration-fail", { command: "echo fail" })).rejects.toThrow(
      "Exec approval registration failed",
    );
  });

  it("resolves cron no-route approvals inline when askFallback permits trusted automation", async () => {
    await writeExecApprovalsConfig({
      version: 1,
      defaults: { security: "full", ask: "always", askFallback: "full" },
      agents: {},
    });
    mockNoApprovalRouteRegistration();

    const tool = createExecTool({
      host: "gateway",
      ask: "always",
      security: "full",
      trigger: "cron",
      approvalRunningNoticeMs: 0,
    });

    const result = await tool.execute("call-cron-inline-approval", {
      command: "echo cron-ok",
    });

    expect(result.details.status).toBe("completed");
    expect(getResultText(result)).toContain("cron-ok");

    expect(vi.mocked(callGatewayTool)).toHaveBeenCalledWith(
      "exec.approval.request",
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ expectFinal: false }),
    );
    expect(
      vi
        .mocked(callGatewayTool)
        .mock.calls.some(([method]) => method === "exec.approval.waitDecision"),
    ).toBe(false);
  });

  it("forwards inline cron approval state to node system.run", async () => {
    await writeExecApprovalsConfig({
      version: 1,
      defaults: { security: "full", ask: "always", askFallback: "full" },
      agents: {},
    });
    mockNoApprovalRouteRegistration();

    let systemRunInvoke: unknown;
    const preparedPlan = {
      argv: ["/bin/sh", "-lc", "echo cron-node-ok"],
      cwd: null,
      commandText: "/bin/sh -lc 'echo cron-node-ok'",
      commandPreview: "echo cron-node-ok",
      agentId: null,
      sessionKey: null,
      mutableFileOperand: {
        argvIndex: 2,
        path: "/tmp/cron-node-ok.sh",
        sha256: "deadbeef",
      },
    };
    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      if (method === "exec.approval.request") {
        return { id: "approval-id", decision: null };
      }
      if (method === "exec.approval.waitDecision") {
        return { decision: null };
      }
      if (method === "node.invoke") {
        const invoke = params as { command?: string };
        if (invoke.command === "system.run.prepare") {
          return {
            payload: {
              plan: preparedPlan,
            },
          };
        }
        if (invoke.command === "system.run") {
          systemRunInvoke = params;
          return { payload: { success: true, stdout: "cron-node-ok" } };
        }
      }
      return { ok: true };
    });

    const tool = createExecTool({
      host: "node",
      ask: "always",
      security: "full",
      trigger: "cron",
      approvalRunningNoticeMs: 0,
    });

    const result = await tool.execute("call-cron-inline-node-approval", {
      command: "echo cron-node-ok",
    });

    expect(result.details.status).toBe("completed");
    expect(getResultText(result)).toContain("cron-node-ok");
    expect(systemRunInvoke).toMatchObject({
      command: "system.run",
      params: {
        approved: true,
        approvalDecision: "allow-once",
        systemRunPlan: preparedPlan,
      },
    });
    expect((systemRunInvoke as { params?: { runId?: string } }).params?.runId).toEqual(
      expect.any(String),
    );
  });

  it("explains cron no-route denials with a host-policy fix hint", async () => {
    await writeExecApprovalsConfig({
      version: 1,
      defaults: { security: "full", ask: "always", askFallback: "deny" },
      agents: {},
    });
    mockNoApprovalRouteRegistration();

    const tool = createExecTool({
      host: "gateway",
      ask: "always",
      security: "full",
      trigger: "cron",
      approvalRunningNoticeMs: 0,
    });

    await expect(
      tool.execute("call-cron-denied", {
        command: "echo cron-denied",
      }),
    ).rejects.toThrow("Cron runs cannot wait for interactive exec approval");
  });
});
