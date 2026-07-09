/**
 * Node invoke system-run approval tests.
 */
import { describe, expect, test } from "vitest";
import {
  buildSystemRunApprovalBinding,
  buildSystemRunApprovalEnvBinding,
} from "../infra/system-run-approval-binding.js";
import { ExecApprovalManager, type ExecApprovalRecord } from "./exec-approval-manager.js";
import { sanitizeSystemRunParamsForForwarding } from "./node-invoke-system-run-approval.js";

describe("sanitizeSystemRunParamsForForwarding", () => {
  const now = Date.now();
  const echoSafeArgv = ["echo", "SAFE"];
  const echoSafeCommand = "echo SAFE";
  const defaultChatContext = {
    agentId: "main",
    sessionKey: "agent:main:telegram:direct:12345",
    turnSourceChannel: "telegram",
    turnSourceTo: "telegram:12345",
    turnSourceAccountId: "work",
    turnSourceThreadId: "42",
  };
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
  type SanitizerOptions = Parameters<typeof sanitizeSystemRunParamsForForwarding>[0];
  type ApprovedRunParamOverrides = {
    command: string[];
    rawCommand?: string;
    env?: Record<string, string>;
    cwd?: string;
    agentId?: string;
    sessionKey?: string;
    turnSourceChannel?: string;
    turnSourceTo?: string | null;
    turnSourceAccountId?: string | null;
    turnSourceThreadId?: string | null;
    runId?: string;
  };

  function approvedRunParams(overrides: ApprovedRunParamOverrides): Record<string, unknown> {
    return {
      runId: "approval-1",
      approved: true,
      approvalDecision: "allow-once",
      ...overrides,
    };
  }

  function systemRunApprovalBinding(
    argv: string[],
    overrides: { cwd?: string | null; agentId?: string | null; sessionKey?: string | null } = {},
  ) {
    return buildSystemRunApprovalBinding({
      argv,
      cwd: overrides.cwd ?? null,
      agentId: overrides.agentId ?? null,
      sessionKey: overrides.sessionKey ?? null,
    }).binding;
  }

  function sanitizeApprovedRun(opts: {
    rawParams: ApprovedRunParamOverrides;
    record?: ExecApprovalRecord;
    execApprovalManager?: SanitizerOptions["execApprovalManager"];
    client?: SanitizerOptions["client"];
    nodeId?: string;
    nowMs?: number;
  }) {
    return sanitizeSystemRunParamsForForwarding({
      rawParams: approvedRunParams(opts.rawParams),
      nodeId: opts.nodeId ?? "node-1",
      client: opts.client ?? client,
      execApprovalManager:
        opts.execApprovalManager ??
        manager(opts.record ?? makeRecord(echoSafeCommand, echoSafeArgv)),
      nowMs: opts.nowMs ?? now,
    });
  }

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
        systemRunBinding: systemRunApprovalBinding(effectiveBindingArgv),
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
    return params;
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
    const agentId =
      typeof overrides.agentId === "string" ? overrides.agentId : defaultChatContext.agentId;
    const sessionKey =
      typeof overrides.sessionKey === "string"
        ? overrides.sessionKey
        : defaultChatContext.sessionKey;
    const record = makeRecord(echoSafeCommand, echoSafeArgv);
    record.requestedByConnId = "chat-agent-conn";
    record.requestedByDeviceId = null;
    record.requestedByClientId = "gateway-client";
    record.requestedByDeviceTokenAuth = false;
    record.request = {
      ...record.request,
      ...defaultChatContext,
      agentId,
      sessionKey,
      systemRunPlan: {
        argv: echoSafeArgv,
        cwd: null,
        commandText: echoSafeCommand,
        agentId,
        sessionKey,
      },
      systemRunBinding: systemRunApprovalBinding(echoSafeArgv, { agentId, sessionKey }),
      ...overrides,
    };
    return record;
  }

  function makeNoDeviceUiRecord(
    overrides: Partial<
      Pick<
        ExecApprovalRecord,
        | "requestedByConnId"
        | "requestedByDeviceId"
        | "requestedByClientId"
        | "requestedByDeviceTokenAuth"
      >
    > = {},
  ) {
    const record = makeRecord(echoSafeCommand, echoSafeArgv);
    record.requestedByConnId = overrides.requestedByConnId ?? "control-ui-conn";
    record.requestedByDeviceId = overrides.requestedByDeviceId ?? null;
    record.requestedByClientId = overrides.requestedByClientId ?? "openclaw-control-ui";
    record.requestedByDeviceTokenAuth = overrides.requestedByDeviceTokenAuth ?? false;
    return record;
  }

  function approvedChatReplayParams(
    overrides: Omit<Partial<ApprovedRunParamOverrides>, "command" | "rawCommand"> = {},
  ) {
    return approvedRunParams({
      command: echoSafeArgv,
      rawCommand: echoSafeCommand,
      ...defaultChatContext,
      ...overrides,
    });
  }

  function sanitizeApprovedChatReplay(
    opts: {
      rawParams?: Omit<Partial<ApprovedRunParamOverrides>, "command" | "rawCommand">;
      record?: ExecApprovalRecord;
      client?: SanitizerOptions["client"];
    } = {},
  ) {
    return sanitizeSystemRunParamsForForwarding({
      rawParams: approvedChatReplayParams(opts.rawParams),
      nodeId: "node-1",
      client: opts.client ?? trustedBackendClient,
      execApprovalManager: manager(opts.record ?? makeChatRecord()),
      nowMs: now,
    });
  }

  test("rejects cmd.exe /c trailing-arg mismatch against rawCommand", () => {
    const result = sanitizeApprovedRun({
      rawParams: {
        command: ["cmd.exe", "/d", "/s", "/c", "echo", "SAFE&&whoami"],
        rawCommand: "echo",
      },
      record: makeRecord("echo"),
    });
    expectRejectedForwardingResult(
      result,
      "RAW_COMMAND_MISMATCH",
      "rawCommand does not match command",
    );
  });

  test("accepts matching cmd.exe /c command text for approval binding", () => {
    const result = sanitizeApprovedRun({
      rawParams: {
        command: ["cmd.exe", "/d", "/s", "/c", "echo", "SAFE&&whoami"],
        rawCommand: "echo SAFE&&whoami",
      },
      record: makeRecord("echo SAFE&&whoami", undefined, [
        "cmd.exe",
        "/d",
        "/s",
        "/c",
        "echo",
        "SAFE&&whoami",
      ]),
    });
    expectAllowOnceForwardingResult(result);
  });

  test("rejects env-assignment shell wrapper when approval command omits env prelude", () => {
    const result = sanitizeApprovedRun({
      rawParams: {
        command: ["/usr/bin/env", "BASH_ENV=/tmp/payload.sh", "bash", "-lc", "echo SAFE"],
      },
      record: makeRecord(echoSafeCommand),
    });
    expectRejectedForwardingResult(
      result,
      "APPROVAL_REQUEST_MISMATCH",
      "approval id does not match request",
    );
  });

  test("accepts env-assignment shell wrapper only when approval command matches full argv text", () => {
    const result = sanitizeApprovedRun({
      rawParams: {
        command: ["/usr/bin/env", "BASH_ENV=/tmp/payload.sh", "bash", "-lc", "echo SAFE"],
      },
      record: makeRecord('/usr/bin/env BASH_ENV=/tmp/payload.sh bash -lc "echo SAFE"', undefined, [
        "/usr/bin/env",
        "BASH_ENV=/tmp/payload.sh",
        "bash",
        "-lc",
        "echo SAFE",
      ]),
    });
    expectAllowOnceForwardingResult(result);
  });

  test("rejects trailing-space argv mismatch against legacy command-only approval", () => {
    const result = sanitizeApprovedRun({
      rawParams: {
        command: ["runner "],
      },
      record: makeRecord("runner"),
    });
    expectRejectedForwardingResult(
      result,
      "APPROVAL_REQUEST_MISMATCH",
      "approval id does not match request",
    );
  });

  test("enforces commandArgv identity when approval includes argv binding", () => {
    const result = sanitizeApprovedRun({
      rawParams: {
        command: echoSafeArgv,
      },
      record: makeRecord(echoSafeCommand, [echoSafeCommand]),
    });
    expectRejectedForwardingResult(
      result,
      "APPROVAL_REQUEST_MISMATCH",
      "approval id does not match request",
    );
  });

  test("accepts matching commandArgv binding for trailing-space argv", () => {
    const result = sanitizeApprovedRun({
      rawParams: {
        command: ["runner "],
      },
      record: makeRecord('"runner "', ["runner "]),
    });
    expectAllowOnceForwardingResult(result);
  });

  test("uses systemRunPlan for forwarded command context and ignores caller tampering", () => {
    const record = makeRecord(echoSafeCommand, echoSafeArgv);
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
    const result = sanitizeApprovedRun({
      rawParams: {
        command: ["echo", "PWNED"],
        rawCommand: "echo PWNED",
        cwd: "/tmp/attacker-link/sub",
        agentId: "attacker",
        sessionKey: "agent:attacker:main",
      },
      record,
    });
    const forwarded = expectAllowOnceForwardingResult(result);
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

  test("forwards a validated shell preview for legacy node allowlist matching", () => {
    const argv = ["/bin/sh", "-lc", "/bin/hostname"];
    const record = makeRecord('/bin/sh -lc "/bin/hostname"', argv);
    record.request.systemRunPlan = {
      argv,
      cwd: null,
      commandText: '/bin/sh -lc "/bin/hostname"',
      commandPreview: "/bin/hostname",
      agentId: "main",
      sessionKey: "agent:main:main",
    };
    record.request.systemRunBinding = systemRunApprovalBinding(argv, {
      agentId: "main",
      sessionKey: "agent:main:main",
    });

    const result = sanitizeApprovedRun({
      rawParams: {
        command: argv,
        rawCommand: "/bin/hostname",
        agentId: "main",
        sessionKey: "agent:main:main",
      },
      record,
    });

    const forwarded = expectAllowOnceForwardingResult(result);
    expect(forwarded.command).toEqual(argv);
    expect(forwarded.rawCommand).toBe("/bin/hostname");
  });

  test("keeps canonical wrapper text when the plan preview does not match argv", () => {
    const argv = ["/bin/sh", "-lc", "/bin/hostname"];
    const commandText = '/bin/sh -lc "/bin/hostname"';
    const record = makeRecord(commandText, argv);
    record.request.systemRunPlan = {
      argv,
      cwd: null,
      commandText,
      commandPreview: "/usr/bin/whoami",
      agentId: null,
      sessionKey: null,
    };
    record.request.systemRunBinding = systemRunApprovalBinding(argv);

    const result = sanitizeApprovedRun({
      rawParams: { command: argv, rawCommand: commandText },
      record,
    });

    const forwarded = expectAllowOnceForwardingResult(result);
    expect(forwarded.rawCommand).toBe(commandText);
  });

  test("rejects env overrides when approval record lacks env binding", () => {
    const result = sanitizeApprovedRun({
      rawParams: {
        command: ["git", "diff"],
        rawCommand: "git diff",
        env: { GIT_EXTERNAL_DIFF: "/tmp/pwn.sh" },
      },
      record: makeRecord("git diff", ["git", "diff"]),
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
    const result = sanitizeApprovedRun({
      rawParams: {
        command: ["git", "diff"],
        rawCommand: "git diff",
        env: { SAFE: "2" },
      },
      record,
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
        command: echoSafeCommand,
        commandArgv: echoSafeArgv,
        systemRunBinding: systemRunApprovalBinding(echoSafeArgv),
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

    const params = approvedRunParams({
      command: echoSafeArgv,
      rawCommand: echoSafeCommand,
      runId,
    });

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
    const record = makeRecord(echoSafeCommand);
    record.request.nodeId = null;
    const result = sanitizeApprovedRun({
      rawParams: { command: echoSafeArgv },
      record,
    });
    expectRejectedForwardingResult(result, "APPROVAL_NODE_BINDING_MISSING", "missing node binding");
  });

  test("rejects approval ids replayed against a different nodeId", () => {
    const result = sanitizeApprovedRun({
      rawParams: { command: echoSafeArgv },
      nodeId: "node-2",
      record: makeRecord(echoSafeCommand),
    });
    expectRejectedForwardingResult(result, "APPROVAL_NODE_MISMATCH", "not valid for this node");
  });

  test("rejects approval ids replayed from a different device token binding", () => {
    const result = sanitizeApprovedRun({
      rawParams: { command: echoSafeArgv },
      client: {
        ...client,
        connect: {
          ...client.connect,
          device: { id: "dev-2" },
        },
      },
      record: makeRecord(echoSafeCommand),
    });

    expectRejectedForwardingResult(result, "APPROVAL_DEVICE_MISMATCH", "not valid for this device");
  });

  test("accepts trusted backend replay for no-device approval after the request connection changes", () => {
    const result = sanitizeApprovedRun({
      rawParams: { command: echoSafeArgv, rawCommand: echoSafeCommand },
      client: trustedBackendClient,
      record: makeNoDeviceUiRecord(),
    });

    expectAllowOnceForwardingResult(result);
  });

  test("rejects no-device approval replay from a backend client without approval scope", () => {
    const result = sanitizeApprovedRun({
      rawParams: { command: echoSafeArgv, rawCommand: echoSafeCommand },
      client: {
        ...trustedBackendClient,
        connect: {
          ...trustedBackendClient.connect,
          scopes: ["operator.write"],
        },
      },
      record: makeNoDeviceUiRecord(),
    });

    expectRejectedForwardingResult(result, "APPROVAL_CLIENT_MISMATCH", "not valid for this client");
  });

  test("rejects no-device approval replay from a non-backend client on a different connection", () => {
    const result = sanitizeApprovedRun({
      rawParams: { command: echoSafeArgv, rawCommand: echoSafeCommand },
      client: {
        connId: "other-control-ui-conn",
        connect: {
          scopes: ["operator.write", "operator.approvals"],
          client: { id: "openclaw-control-ui", mode: "ui" },
          device: null,
        },
      },
      record: makeNoDeviceUiRecord(),
    });

    expectRejectedForwardingResult(result, "APPROVAL_CLIENT_MISMATCH", "not valid for this client");
  });

  test("accepts trusted backend chat replay when stable requester metadata matches", () => {
    const forwarded = expectAllowOnceForwardingResult(sanitizeApprovedChatReplay());
    expect(forwarded).not.toHaveProperty("turnSourceChannel");
    expect(forwarded).not.toHaveProperty("turnSourceTo");
    expect(forwarded).not.toHaveProperty("turnSourceAccountId");
    expect(forwarded).not.toHaveProperty("turnSourceThreadId");
  });

  test("accepts trusted backend chat replay from a non-bridgeable agent client when stable requester metadata matches", () => {
    const record = makeChatRecord();
    record.requestedByClientId = "chat-agent";

    expectAllowOnceForwardingResult(sanitizeApprovedChatReplay({ record }));
  });

  test("accepts trusted backend WeCom replay when the approved chat agent connection changes", () => {
    const wecomContext = {
      sessionKey: "agent:main:wecom:conversation:corp-42",
      turnSourceChannel: "wecom",
      turnSourceTo: "wecom:corp-42:conversation-7",
      turnSourceAccountId: "corp-42",
      turnSourceThreadId: "conversation-7",
    } satisfies Omit<Partial<ApprovedRunParamOverrides>, "command" | "rawCommand">;
    const result = sanitizeApprovedChatReplay({
      record: makeChatRecord(wecomContext),
      rawParams: wecomContext,
    });

    expectAllowOnceForwardingResult(result);
  });

  test("accepts trusted backend webchat replay when turnSourceTo is null on both sides (regression #82132)", () => {
    const webchatContext = {
      sessionKey: "agent:main:main",
      turnSourceChannel: "webchat",
      turnSourceTo: null,
      turnSourceAccountId: null,
      turnSourceThreadId: null,
    } satisfies Omit<Partial<ApprovedRunParamOverrides>, "command" | "rawCommand">;
    const result = sanitizeApprovedChatReplay({
      record: makeChatRecord(webchatContext),
      rawParams: webchatContext,
    });

    expectAllowOnceForwardingResult(result);
  });

  test.each([
    ["session binding changes", { sessionKey: "agent:main:telegram:direct:99999" }],
    ["session binding casing changes", { sessionKey: "agent:MAIN:telegram:direct:12345" }],
    ["agent binding casing changes", { agentId: "Main" }],
    ["channel target changes", { turnSourceTo: "telegram:67890" }],
  ] satisfies Array<[string, Omit<Partial<ApprovedRunParamOverrides>, "command" | "rawCommand">]>)(
    "rejects trusted backend chat replay when %s",
    (_label, rawParams) => {
      const result = sanitizeApprovedChatReplay({ rawParams });
      expectRejectedForwardingResult(
        result,
        "APPROVAL_CLIENT_MISMATCH",
        "not valid for this client",
      );
    },
  );

  test("rejects trusted backend chat replay without matching approval scope", () => {
    const result = sanitizeApprovedChatReplay({
      client: {
        ...trustedBackendClient,
        connect: {
          ...trustedBackendClient.connect,
          scopes: ["operator.write"],
        },
      },
    });

    expectRejectedForwardingResult(result, "APPROVAL_CLIENT_MISMATCH", "not valid for this client");
  });

  test("rejects no-device approval replay when the original request used device-token auth", () => {
    const result = sanitizeApprovedRun({
      rawParams: { command: echoSafeArgv, rawCommand: echoSafeCommand },
      client: trustedBackendClient,
      record: makeNoDeviceUiRecord({ requestedByDeviceTokenAuth: true }),
    });

    expectRejectedForwardingResult(result, "APPROVAL_CLIENT_MISMATCH", "not valid for this client");
  });
});
