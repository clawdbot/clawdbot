import { describe, expect, test } from "vitest";
import {
  buildSystemRunApprovalBinding,
  buildSystemRunApprovalEnvBinding,
} from "../infra/system-run-approval-binding.js";
import { ExecApprovalManager, type ExecApprovalRecord } from "./exec-approval-manager.js";
import { sanitizeSystemRunParamsForForwarding } from "./node-invoke-system-run-approval.js";

describe("sanitizeSystemRunParamsForForwarding", () => {
  const now = Date.now();
  const client = {
    connId: "conn-1",
    connect: {
      scopes: ["operator.write", "operator.approvals"],
      client: { id: "cli-1", mode: "cli" },
      device: { id: "dev-1" },
    },
  };
  const trustedBackendClient = {
    connId: "backend-conn",
    connect: {
      scopes: ["operator.write", "operator.approvals"],
      client: { id: "gateway-client", mode: "backend" },
      device: null,
    },
  };

  function makeRecord(
    command: string,
    commandArgv?: string[],
    bindingArgv?: string[],
  ): ExecApprovalRecord {
    const effectiveBindingArgv = bindingArgv ?? commandArgv ?? [command];
    return {
      id: "approval-1",
      request: {
        host: "node",
        nodeId: "node-1",
        command,
        commandArgv,
        systemRunBinding: buildSystemRunApprovalBinding({
          argv: effectiveBindingArgv,
          cwd: null,
          agentId: null,
          sessionKey: null,
        }).binding,
        cwd: null,
        agentId: null,
        sessionKey: null,
      },
      createdAtMs: now - 1_000,
      expiresAtMs: now + 60_000,
      requestedByConnId: "conn-1",
      requestedByDeviceId: "dev-1",
      requestedByClientId: "cli-1",
      requestedByDeviceTokenAuth: false,
      resolvedAtMs: now - 500,
      decision: "allow-once",
      resolvedBy: "operator",
    };
  }

  function manager(record: ReturnType<typeof makeRecord>) {
    let consumed = false;
    return {
      getSnapshot: () => record,
      consumeAllowOnce: () => {
        if (consumed || record.decision !== "allow-once") {
          return false;
        }
        consumed = true;
        record.decision = undefined;
        return true;
      },
    };
  }

  function expectAllowOnceForwardingResult(
    result: ReturnType<typeof sanitizeSystemRunParamsForForwarding>,
  ) {
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    const params = result.params as Record<string, unknown>;
    expect(params.approved).toBe(true);
    expect(params.approvalDecision).toBe("allow-once");
  }

  function expectRejectedForwardingResult(
    result: ReturnType<typeof sanitizeSystemRunParamsForForwarding>,
    code: string,
    messageSubstring?: string,
  ) {
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    if (messageSubstring) {
      expect(result.message).toContain(messageSubstring);
    }
    expect(result.details?.code).toBe(code);
  }

  function makeChatRecord(overrides: Partial<ExecApprovalRecord["request"]> = {}) {
    const record = makeRecord("echo SAFE", ["echo", "SAFE"]);
    record.requestedByConnId = "chat-agent-conn";
    record.requestedByDeviceId = null;
    record.requestedByClientId = "gateway-client";
    record.requestedByDeviceTokenAuth = false;
    record.request = {
      ...record.request,
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:12345",
      turnSourceChannel: "telegram",
      turnSourceTo: "telegram:12345",
      turnSourceAccountId: "work",
      turnSourceThreadId: "42",
      systemRunPlan: {
        argv: ["echo", "SAFE"],
        cwd: null,
        commandText: "echo SAFE",
        agentId: "main",
        sessionKey: "agent:main:telegram:direct:12345",
      },
      systemRunBinding: buildSystemRunApprovalBinding({
        argv: ["echo", "SAFE"],
        cwd: null,
        agentId: "main",
        sessionKey: "agent:main:telegram:direct:12345",
      }).binding,
      ...overrides,
    };
    return record;
  }

  test("rejects cmd.exe /c trailing-arg mismatch against rawCommand", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["cmd.exe", "/d", "/s", "/c", "echo", "SAFE&&whoami"],
        rawCommand: "echo",
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client,
      execApprovalManager: manager(makeRecord("echo")),
      nowMs: now,
    });
    expectRejectedForwardingResult(
      result,
      "RAW_COMMAND_MISMATCH",
      "rawCommand does not match command",
    );
  });

  test("accepts matching cmd.exe /c command text for approval binding", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["cmd.exe", "/d", "/s", "/c", "echo", "SAFE&&whoami"],
        rawCommand: "echo SAFE&&whoami",
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client,
      execApprovalManager: manager(
        makeRecord("echo SAFE&&whoami", undefined, [
          "cmd.exe",
          "/d",
          "/s",
          "/c",
          "echo",
          "SAFE&&whoami",
        ]),
      ),
      nowMs: now,
    });
    expectAllowOnceForwardingResult(result);
  });

  test("rejects env-assignment shell wrapper when approval command omits env prelude", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["/usr/bin/env", "BASH_ENV=/tmp/payload.sh", "bash", "-lc", "echo SAFE"],
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client,
      execApprovalManager: manager(makeRecord("echo SAFE")),
      nowMs: now,
    });
    expectRejectedForwardingResult(
      result,
      "APPROVAL_REQUEST_MISMATCH",
      "approval id does not match request",
    );
  });

  test("accepts env-assignment shell wrapper only when approval command matches full argv text", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["/usr/bin/env", "BASH_ENV=/tmp/payload.sh", "bash", "-lc", "echo SAFE"],
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client,
      execApprovalManager: manager(
        makeRecord('/usr/bin/env BASH_ENV=/tmp/payload.sh bash -lc "echo SAFE"', undefined, [
          "/usr/bin/env",
          "BASH_ENV=/tmp/payload.sh",
          "bash",
          "-lc",
          "echo SAFE",
        ]),
      ),
      nowMs: now,
    });
    expectAllowOnceForwardingResult(result);
  });

  test("rejects trailing-space argv mismatch against legacy command-only approval", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["runner "],
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client,
      execApprovalManager: manager(makeRecord("runner")),
      nowMs: now,
    });
    expectRejectedForwardingResult(
      result,
      "APPROVAL_REQUEST_MISMATCH",
      "approval id does not match request",
    );
  });

  test("enforces commandArgv identity when approval includes argv binding", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["echo", "SAFE"],
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client,
      execApprovalManager: manager(makeRecord("echo SAFE", ["echo SAFE"])),
      nowMs: now,
    });
    expectRejectedForwardingResult(
      result,
      "APPROVAL_REQUEST_MISMATCH",
      "approval id does not match request",
    );
  });

  test("accepts matching commandArgv binding for trailing-space argv", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["runner "],
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client,
      execApprovalManager: manager(makeRecord('"runner "', ["runner "])),
      nowMs: now,
    });
    expectAllowOnceForwardingResult(result);
  });

  test("uses systemRunPlan for forwarded command context and ignores caller tampering", () => {
    const record = makeRecord("echo SAFE", ["echo", "SAFE"]);
    record.request.systemRunPlan = {
      argv: ["/usr/bin/echo", "SAFE"],
      cwd: "/real/cwd",
      commandText: "/usr/bin/echo SAFE",
      agentId: "main",
      sessionKey: "agent:main:main",
    };
    record.request.systemRunBinding = buildSystemRunApprovalBinding({
      argv: ["/usr/bin/echo", "SAFE"],
      cwd: "/real/cwd",
      agentId: "main",
      sessionKey: "agent:main:main",
    }).binding;
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["echo", "PWNED"],
        rawCommand: "echo PWNED",
        cwd: "/tmp/attacker-link/sub",
        agentId: "attacker",
        sessionKey: "agent:attacker:main",
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client,
      execApprovalManager: manager(record),
      nowMs: now,
    });
    expectAllowOnceForwardingResult(result);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    const forwarded = result.params as Record<string, unknown>;
    expect(forwarded.command).toEqual(["/usr/bin/echo", "SAFE"]);
    expect(forwarded.rawCommand).toBe("/usr/bin/echo SAFE");
    const systemRunPlan = forwarded.systemRunPlan as
      | {
          argv?: string[];
          cwd?: string;
          commandText?: string;
          agentId?: string;
          sessionKey?: string;
        }
      | undefined;
    expect(systemRunPlan?.argv).toEqual(["/usr/bin/echo", "SAFE"]);
    expect(systemRunPlan?.cwd).toBe("/real/cwd");
    expect(systemRunPlan?.commandText).toBe("/usr/bin/echo SAFE");
    expect(systemRunPlan?.agentId).toBe("main");
    expect(systemRunPlan?.sessionKey).toBe("agent:main:main");
    expect(forwarded.cwd).toBe("/real/cwd");
    expect(forwarded.agentId).toBe("main");
    expect(forwarded.sessionKey).toBe("agent:main:main");
  });

  test("rejects env overrides when approval record lacks env binding", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["git", "diff"],
        rawCommand: "git diff",
        env: { GIT_EXTERNAL_DIFF: "/tmp/pwn.sh" },
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client,
      execApprovalManager: manager(makeRecord("git diff", ["git", "diff"])),
      nowMs: now,
    });
    expectRejectedForwardingResult(result, "APPROVAL_ENV_BINDING_MISSING");
  });

  test("rejects env hash mismatch", () => {
    const record = makeRecord("git diff", ["git", "diff"]);
    record.request.systemRunBinding = {
      argv: ["git", "diff"],
      cwd: null,
      agentId: null,
      sessionKey: null,
      envHash: buildSystemRunApprovalEnvBinding({ SAFE: "1" }).envHash,
    };
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["git", "diff"],
        rawCommand: "git diff",
        env: { SAFE: "2" },
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client,
      execApprovalManager: manager(record),
      nowMs: now,
    });
    expectRejectedForwardingResult(result, "APPROVAL_ENV_MISMATCH");
  });

  test("consumes allow-once approvals and blocks same runId replay", async () => {
    const approvalManager = new ExecApprovalManager();
    const runId = "approval-replay-1";
    const record = approvalManager.create(
      {
        host: "node",
        nodeId: "node-1",
        command: "echo SAFE",
        commandArgv: ["echo", "SAFE"],
        systemRunBinding: buildSystemRunApprovalBinding({
          argv: ["echo", "SAFE"],
          cwd: null,
          agentId: null,
          sessionKey: null,
        }).binding,
        cwd: null,
        agentId: null,
        sessionKey: null,
      },
      60_000,
      runId,
    );
    record.requestedByConnId = "conn-1";
    record.requestedByDeviceId = "dev-1";
    record.requestedByClientId = "cli-1";
    record.requestedByDeviceTokenAuth = false;

    const decisionPromise = approvalManager.register(record, 60_000);
    approvalManager.resolve(runId, "allow-once", "operator");
    await expect(decisionPromise).resolves.toBe("allow-once");

    const params = {
      command: ["echo", "SAFE"],
      rawCommand: "echo SAFE",
      runId,
      approved: true,
      approvalDecision: "allow-once",
    };

    const first = sanitizeSystemRunParamsForForwarding({
      nodeId: "node-1",
      rawParams: params,
      client,
      execApprovalManager: approvalManager,
      nowMs: now,
    });
    expectAllowOnceForwardingResult(first);

    const second = sanitizeSystemRunParamsForForwarding({
      nodeId: "node-1",
      rawParams: params,
      client,
      execApprovalManager: approvalManager,
      nowMs: now,
    });
    expectRejectedForwardingResult(second, "APPROVAL_REQUIRED");
  });

  test("rejects approval ids that do not bind a nodeId", () => {
    const record = makeRecord("echo SAFE");
    record.request.nodeId = null;
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["echo", "SAFE"],
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client,
      execApprovalManager: manager(record),
      nowMs: now,
    });
    expectRejectedForwardingResult(result, "APPROVAL_NODE_BINDING_MISSING", "missing node binding");
  });

  test("rejects approval ids replayed against a different nodeId", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["echo", "SAFE"],
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-2",
      client,
      execApprovalManager: manager(makeRecord("echo SAFE")),
      nowMs: now,
    });
    expectRejectedForwardingResult(result, "APPROVAL_NODE_MISMATCH", "not valid for this node");
  });

  test("rejects approval ids replayed from a different device token binding", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["echo", "SAFE"],
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client: {
        ...client,
        connect: {
          ...client.connect,
          device: { id: "dev-2" },
        },
      },
      execApprovalManager: manager(makeRecord("echo SAFE")),
      nowMs: now,
    });

    expectRejectedForwardingResult(result, "APPROVAL_DEVICE_MISMATCH", "not valid for this device");
  });

  test("accepts trusted backend replay for no-device approval after the request connection changes", () => {
    const record = makeRecord("echo SAFE", ["echo", "SAFE"]);
    record.requestedByConnId = "control-ui-conn";
    record.requestedByDeviceId = null;
    record.requestedByClientId = "openclaw-control-ui";
    record.requestedByDeviceTokenAuth = false;

    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["echo", "SAFE"],
        rawCommand: "echo SAFE",
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client: trustedBackendClient,
      execApprovalManager: manager(record),
      nowMs: now,
    });

    expectAllowOnceForwardingResult(result);
  });

  test("rejects no-device approval replay from a backend client without approval scope", () => {
    const record = makeRecord("echo SAFE", ["echo", "SAFE"]);
    record.requestedByConnId = "control-ui-conn";
    record.requestedByDeviceId = null;
    record.requestedByClientId = "openclaw-control-ui";
    record.requestedByDeviceTokenAuth = false;

    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["echo", "SAFE"],
        rawCommand: "echo SAFE",
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client: {
        ...trustedBackendClient,
        connect: {
          ...trustedBackendClient.connect,
          scopes: ["operator.write"],
        },
      },
      execApprovalManager: manager(record),
      nowMs: now,
    });

    expectRejectedForwardingResult(result, "APPROVAL_CLIENT_MISMATCH", "not valid for this client");
  });

  test("rejects no-device approval replay from a non-backend client on a different connection", () => {
    const record = makeRecord("echo SAFE", ["echo", "SAFE"]);
    record.requestedByConnId = "control-ui-conn";
    record.requestedByDeviceId = null;
    record.requestedByClientId = "openclaw-control-ui";
    record.requestedByDeviceTokenAuth = false;

    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["echo", "SAFE"],
        rawCommand: "echo SAFE",
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client: {
        connId: "other-control-ui-conn",
        connect: {
          scopes: ["operator.write", "operator.approvals"],
          client: { id: "openclaw-control-ui", mode: "ui" },
          device: null,
        },
      },
      execApprovalManager: manager(record),
      nowMs: now,
    });

    expectRejectedForwardingResult(result, "APPROVAL_CLIENT_MISMATCH", "not valid for this client");
  });

  test("accepts trusted backend chat replay when stable requester metadata matches", () => {
    const record = makeChatRecord();

    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["echo", "SAFE"],
        rawCommand: "echo SAFE",
        agentId: "main",
        sessionKey: "agent:main:telegram:direct:12345",
        turnSourceChannel: "telegram",
        turnSourceTo: "telegram:12345",
        turnSourceAccountId: "work",
        turnSourceThreadId: "42",
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client: trustedBackendClient,
      execApprovalManager: manager(record),
      nowMs: now,
    });

    expectAllowOnceForwardingResult(result);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    const forwarded = result.params as Record<string, unknown>;
    expect(forwarded).not.toHaveProperty("turnSourceChannel");
    expect(forwarded).not.toHaveProperty("turnSourceTo");
    expect(forwarded).not.toHaveProperty("turnSourceAccountId");
    expect(forwarded).not.toHaveProperty("turnSourceThreadId");
  });

  test("accepts trusted backend chat replay from a non-bridgeable agent client when stable requester metadata matches", () => {
    const record = makeChatRecord();
    record.requestedByClientId = "chat-agent";

    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["echo", "SAFE"],
        rawCommand: "echo SAFE",
        agentId: "main",
        sessionKey: "agent:main:telegram:direct:12345",
        turnSourceChannel: "telegram",
        turnSourceTo: "telegram:12345",
        turnSourceAccountId: "work",
        turnSourceThreadId: "42",
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client: trustedBackendClient,
      execApprovalManager: manager(record),
      nowMs: now,
    });

    expectAllowOnceForwardingResult(result);
  });

  test("accepts trusted backend WeCom replay when the approved chat agent connection changes", () => {
    const sessionKey = "agent:main:wecom:conversation:corp-42";
    const record = makeChatRecord({
      sessionKey,
      turnSourceChannel: "wecom",
      turnSourceTo: "wecom:corp-42:conversation-7",
      turnSourceAccountId: "corp-42",
      turnSourceThreadId: "conversation-7",
      systemRunPlan: {
        argv: ["echo", "SAFE"],
        cwd: null,
        commandText: "echo SAFE",
        agentId: "main",
        sessionKey,
      },
      systemRunBinding: buildSystemRunApprovalBinding({
        argv: ["echo", "SAFE"],
        cwd: null,
        agentId: "main",
        sessionKey,
      }).binding,
    });

    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["echo", "SAFE"],
        rawCommand: "echo SAFE",
        agentId: "main",
        sessionKey,
        turnSourceChannel: "wecom",
        turnSourceTo: "wecom:corp-42:conversation-7",
        turnSourceAccountId: "corp-42",
        turnSourceThreadId: "conversation-7",
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client: trustedBackendClient,
      execApprovalManager: manager(record),
      nowMs: now,
    });

    expectAllowOnceForwardingResult(result);
  });

  test("accepts trusted backend webchat replay when turnSourceTo is null on both sides (regression #82132)", () => {
    const sessionKey = "agent:main:main";
    const record = makeChatRecord({
      sessionKey,
      turnSourceChannel: "webchat",
      turnSourceTo: null,
      turnSourceAccountId: null,
      turnSourceThreadId: null,
      systemRunPlan: {
        argv: ["echo", "SAFE"],
        cwd: null,
        commandText: "echo SAFE",
        agentId: "main",
        sessionKey,
      },
      systemRunBinding: buildSystemRunApprovalBinding({
        argv: ["echo", "SAFE"],
        cwd: null,
        agentId: "main",
        sessionKey,
      }).binding,
    });

    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["echo", "SAFE"],
        rawCommand: "echo SAFE",
        agentId: "main",
        sessionKey,
        turnSourceChannel: "webchat",
        turnSourceTo: null,
        turnSourceAccountId: null,
        turnSourceThreadId: null,
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client: trustedBackendClient,
      execApprovalManager: manager(record),
      nowMs: now,
    });

    expectAllowOnceForwardingResult(result);
  });

  test("rejects trusted backend chat replay when session binding changes", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["echo", "SAFE"],
        rawCommand: "echo SAFE",
        agentId: "main",
        sessionKey: "agent:main:telegram:direct:99999",
        turnSourceChannel: "telegram",
        turnSourceTo: "telegram:12345",
        turnSourceAccountId: "work",
        turnSourceThreadId: "42",
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client: trustedBackendClient,
      execApprovalManager: manager(makeChatRecord()),
      nowMs: now,
    });

    expectRejectedForwardingResult(result, "APPROVAL_CLIENT_MISMATCH", "not valid for this client");
  });

  test("rejects trusted backend chat replay when session binding casing changes", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["echo", "SAFE"],
        rawCommand: "echo SAFE",
        agentId: "main",
        sessionKey: "agent:MAIN:telegram:direct:12345",
        turnSourceChannel: "telegram",
        turnSourceTo: "telegram:12345",
        turnSourceAccountId: "work",
        turnSourceThreadId: "42",
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client: trustedBackendClient,
      execApprovalManager: manager(makeChatRecord()),
      nowMs: now,
    });

    expectRejectedForwardingResult(result, "APPROVAL_CLIENT_MISMATCH", "not valid for this client");
  });

  test("rejects trusted backend chat replay when agent binding casing changes", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["echo", "SAFE"],
        rawCommand: "echo SAFE",
        agentId: "Main",
        sessionKey: "agent:main:telegram:direct:12345",
        turnSourceChannel: "telegram",
        turnSourceTo: "telegram:12345",
        turnSourceAccountId: "work",
        turnSourceThreadId: "42",
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client: trustedBackendClient,
      execApprovalManager: manager(makeChatRecord()),
      nowMs: now,
    });

    expectRejectedForwardingResult(result, "APPROVAL_CLIENT_MISMATCH", "not valid for this client");
  });

  test("rejects trusted backend chat replay when channel target changes", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["echo", "SAFE"],
        rawCommand: "echo SAFE",
        agentId: "main",
        sessionKey: "agent:main:telegram:direct:12345",
        turnSourceChannel: "telegram",
        turnSourceTo: "telegram:67890",
        turnSourceAccountId: "work",
        turnSourceThreadId: "42",
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client: trustedBackendClient,
      execApprovalManager: manager(makeChatRecord()),
      nowMs: now,
    });

    expectRejectedForwardingResult(result, "APPROVAL_CLIENT_MISMATCH", "not valid for this client");
  });

  test("rejects trusted backend chat replay without matching approval scope", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["echo", "SAFE"],
        rawCommand: "echo SAFE",
        agentId: "main",
        sessionKey: "agent:main:telegram:direct:12345",
        turnSourceChannel: "telegram",
        turnSourceTo: "telegram:12345",
        turnSourceAccountId: "work",
        turnSourceThreadId: "42",
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client: {
        ...trustedBackendClient,
        connect: {
          ...trustedBackendClient.connect,
          scopes: ["operator.write"],
        },
      },
      execApprovalManager: manager(makeChatRecord()),
      nowMs: now,
    });

    expectRejectedForwardingResult(result, "APPROVAL_CLIENT_MISMATCH", "not valid for this client");
  });

  test("rejects no-device approval replay when the original request used device-token auth", () => {
    const record = makeRecord("echo SAFE", ["echo", "SAFE"]);
    record.requestedByConnId = "control-ui-conn";
    record.requestedByDeviceId = null;
    record.requestedByClientId = "openclaw-control-ui";
    record.requestedByDeviceTokenAuth = true;

    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["echo", "SAFE"],
        rawCommand: "echo SAFE",
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client: trustedBackendClient,
      execApprovalManager: manager(record),
      nowMs: now,
    });

    expectRejectedForwardingResult(result, "APPROVAL_CLIENT_MISMATCH", "not valid for this client");
  });
});
