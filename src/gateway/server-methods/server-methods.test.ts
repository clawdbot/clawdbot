import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { formatZonedTimestamp } from "../../infra/format-time/format-datetime.js";
import {
  buildSystemRunApprovalBinding,
  buildSystemRunApprovalEnvBinding,
} from "../../infra/system-run-approval-binding.js";
import { resetLogger, setLoggerOverride } from "../../logging.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { validateExecApprovalRequestParams } from "../protocol/index.js";
import { waitForAgentJob } from "./agent-job.js";
import { injectTimestamp, timestampOptsFromConfig } from "./agent-timestamp.js";
import { normalizeRpcAttachmentsToChatAttachments } from "./attachment-normalize.js";
import {
  DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  augmentChatHistoryWithCanvasBlocks,
  resolveEffectiveChatHistoryMaxChars,
  sanitizeChatHistoryMessages,
  sanitizeChatSendMessageInput,
} from "./chat.js";
import { createExecApprovalHandlers } from "./exec-approval.js";
import { logsHandlers } from "./logs.js";

vi.mock("../../commands/status.js", () => ({
  getStatusSummary: vi.fn().mockResolvedValue({ ok: true }),
}));

describe("waitForAgentJob", () => {
  async function runLifecycleScenario(params: {
    runIdPrefix: string;
    startedAt: number;
    endedAt: number;
    aborted?: boolean;
  }) {
    const runId = `${params.runIdPrefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const waitPromise = waitForAgentJob({ runId, timeoutMs: 1_000 });

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "start", startedAt: params.startedAt },
    });
    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "end", endedAt: params.endedAt, aborted: params.aborted },
    });

    return waitPromise;
  }

  it("maps lifecycle end events with aborted=true to timeout", async () => {
    const snapshot = await runLifecycleScenario({
      runIdPrefix: "run-timeout",
      startedAt: 100,
      endedAt: 200,
      aborted: true,
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.status).toBe("timeout");
    expect(snapshot?.startedAt).toBe(100);
    expect(snapshot?.endedAt).toBe(200);
  });

  it("keeps non-aborted lifecycle end events as ok", async () => {
    const snapshot = await runLifecycleScenario({
      runIdPrefix: "run-ok",
      startedAt: 300,
      endedAt: 400,
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.status).toBe("ok");
    expect(snapshot?.startedAt).toBe(300);
    expect(snapshot?.endedAt).toBe(400);
  });

  it("can ignore cached snapshots and wait for fresh lifecycle events", async () => {
    const runId = `run-ignore-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "end", startedAt: 100, endedAt: 110 },
    });

    const cached = await waitForAgentJob({ runId, timeoutMs: 1_000 });
    expect(cached?.status).toBe("ok");
    expect(cached?.startedAt).toBe(100);
    expect(cached?.endedAt).toBe(110);

    const freshWait = waitForAgentJob({
      runId,
      timeoutMs: 1_000,
      ignoreCachedSnapshot: true,
    });
    queueMicrotask(() => {
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "start", startedAt: 200 },
      });
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "end", startedAt: 200, endedAt: 210 },
      });
    });

    const fresh = await freshWait;
    expect(fresh?.status).toBe("ok");
    expect(fresh?.startedAt).toBe(200);
    expect(fresh?.endedAt).toBe(210);
  });
});

describe("augmentChatHistoryWithCanvasBlocks", () => {
  it("ignores user messages that merely contain canvas-shaped text", () => {
    const previewJson = JSON.stringify({
      kind: "canvas",
      view: {
        backend: "canvas",
        id: "cv_user_text",
        url: "/__openclaw__/canvas/documents/cv_user_text/index.html",
        title: "User pasted preview",
        preferred_height: 240,
      },
      presentation: {
        target: "assistant_message",
      },
    });

    const messages = [
      {
        role: "user",
        content: previewJson,
        timestamp: 1,
      },
      {
        role: "assistant",
        content: "Plain assistant reply",
        timestamp: 2,
      },
    ];

    expect(augmentChatHistoryWithCanvasBlocks(messages)).toEqual(messages);
  });
});

describe("injectTimestamp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-29T01:30:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("prepends a compact timestamp matching formatZonedTimestamp", () => {
    const result = injectTimestamp("Is it the weekend?", {
      timezone: "America/New_York",
    });

    expect(result).toMatch(/^\[Wed 2026-01-28 20:30 EST\] Is it the weekend\?$/);
  });

  it("uses channel envelope format with DOW prefix", () => {
    const now = new Date();
    const expected = formatZonedTimestamp(now, { timeZone: "America/New_York" });

    const result = injectTimestamp("hello", { timezone: "America/New_York" });

    expect(result).toBe(`[Wed ${expected}] hello`);
  });

  it("always uses 24-hour format", () => {
    const result = injectTimestamp("hello", { timezone: "America/New_York" });

    expect(result).toContain("20:30");
    expect(result).not.toContain("PM");
    expect(result).not.toContain("AM");
  });

  it("uses the configured timezone", () => {
    const result = injectTimestamp("hello", { timezone: "America/Chicago" });

    expect(result).toMatch(/^\[Wed 2026-01-28 19:30 CST\]/);
  });

  it("defaults to UTC when no timezone specified", () => {
    const result = injectTimestamp("hello", {});

    expect(result).toMatch(/^\[Thu 2026-01-29 01:30/);
  });

  it("returns empty/whitespace messages unchanged", () => {
    expect(injectTimestamp("", { timezone: "UTC" })).toBe("");
    expect(injectTimestamp("   ", { timezone: "UTC" })).toBe("   ");
  });

  it("does NOT double-stamp messages with channel envelope timestamps", () => {
    const enveloped = "[Discord user1 2026-01-28 20:30 EST] hello there";
    const result = injectTimestamp(enveloped, { timezone: "America/New_York" });

    expect(result).toBe(enveloped);
  });

  it("does NOT double-stamp messages already injected by us", () => {
    const alreadyStamped = "[Wed 2026-01-28 20:30 EST] hello there";
    const result = injectTimestamp(alreadyStamped, { timezone: "America/New_York" });

    expect(result).toBe(alreadyStamped);
  });

  it("does NOT double-stamp messages with cron-injected timestamps", () => {
    const cronMessage =
      "[cron:abc123 my-job] do the thing\nCurrent time: Wednesday, January 28th, 2026 — 8:30 PM (America/New_York)";
    const result = injectTimestamp(cronMessage, { timezone: "America/New_York" });

    expect(result).toBe(cronMessage);
  });

  it("handles midnight correctly", () => {
    vi.setSystemTime(new Date("2026-02-01T05:00:00.000Z"));

    const result = injectTimestamp("hello", { timezone: "America/New_York" });

    expect(result).toMatch(/^\[Sun 2026-02-01 00:00 EST\]/);
  });

  it("handles date boundaries (just before midnight)", () => {
    vi.setSystemTime(new Date("2026-02-01T04:59:00.000Z"));

    const result = injectTimestamp("hello", { timezone: "America/New_York" });

    expect(result).toMatch(/^\[Sat 2026-01-31 23:59 EST\]/);
  });

  it("handles DST correctly (same UTC hour, different local time)", () => {
    vi.setSystemTime(new Date("2026-01-15T05:00:00.000Z"));
    const winter = injectTimestamp("winter", { timezone: "America/New_York" });
    expect(winter).toMatch(/^\[Thu 2026-01-15 00:00 EST\]/);

    vi.setSystemTime(new Date("2026-07-15T04:00:00.000Z"));
    const summer = injectTimestamp("summer", { timezone: "America/New_York" });
    expect(summer).toMatch(/^\[Wed 2026-07-15 00:00 EDT\]/);
  });

  it("accepts a custom now date", () => {
    const customDate = new Date("2025-07-04T16:00:00.000Z");

    const result = injectTimestamp("fireworks?", {
      timezone: "America/New_York",
      now: customDate,
    });

    expect(result).toMatch(/^\[Fri 2025-07-04 12:00 EDT\]/);
  });
});

describe("sanitizeChatHistoryMessages", () => {
  it("drops commentary-only assistant entries when phase exists only in textSignature", () => {
    const result = sanitizeChatHistoryMessages([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "thinking like caveman",
            textSignature: JSON.stringify({ v: 1, id: "msg_commentary", phase: "commentary" }),
          },
        ],
        timestamp: 2,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "real reply" }],
        timestamp: 3,
      },
    ]);

    expect(result).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "real reply" }],
        timestamp: 3,
      },
    ]);
  });
});

describe("resolveEffectiveChatHistoryMaxChars", () => {
  it("uses gateway.webchat.chatHistoryMaxChars when RPC maxChars is absent", () => {
    expect(
      resolveEffectiveChatHistoryMaxChars(
        { gateway: { webchat: { chatHistoryMaxChars: 123 } } },
        undefined,
      ),
    ).toBe(123);
  });

  it("prefers RPC maxChars over config", () => {
    expect(
      resolveEffectiveChatHistoryMaxChars(
        { gateway: { webchat: { chatHistoryMaxChars: 123 } } },
        45,
      ),
    ).toBe(45);
  });

  it("falls back to the default hardcoded limit", () => {
    expect(resolveEffectiveChatHistoryMaxChars({}, undefined)).toBe(
      DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
    );
  });
});

describe("timestampOptsFromConfig", () => {
  it.each([
    {
      name: "extracts timezone from config",
      cfg: { agents: { defaults: { userTimezone: "America/Chicago" } } } as any,
      expected: "America/Chicago",
    },
    {
      name: "falls back gracefully with empty config",
      cfg: {} as any,
      expected: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    },
  ])("$name", ({ cfg, expected }) => {
    expect(timestampOptsFromConfig(cfg).timezone).toBe(expected);
  });
});

describe("normalizeRpcAttachmentsToChatAttachments", () => {
  it.each([
    {
      name: "passes through string content",
      attachments: [{ type: "file", mimeType: "image/png", fileName: "a.png", content: "Zm9v" }],
      expected: [{ type: "file", mimeType: "image/png", fileName: "a.png", content: "Zm9v" }],
    },
    {
      name: "converts Uint8Array content to base64",
      attachments: [{ content: new TextEncoder().encode("foo") }],
      expected: [{ type: undefined, mimeType: undefined, fileName: undefined, content: "Zm9v" }],
    },
    {
      name: "converts ArrayBuffer content to base64",
      attachments: [{ content: new TextEncoder().encode("bar").buffer }],
      expected: [{ type: undefined, mimeType: undefined, fileName: undefined, content: "YmFy" }],
    },
    {
      name: "drops attachments without usable content",
      attachments: [{ content: undefined }, { mimeType: "image/png" }],
      expected: [],
    },
  ])("$name", ({ attachments, expected }) => {
    expect(normalizeRpcAttachmentsToChatAttachments(attachments)).toEqual(expected);
  });

  it("accepts dashboard image attachments with nested base64 source", () => {
    const res = normalizeRpcAttachmentsToChatAttachments([
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "Zm9v",
        },
      },
    ]);
    expect(res).toEqual([
      {
        type: "image",
        mimeType: "image/png",
        fileName: undefined,
        content: "Zm9v",
      },
    ]);
  });
});

describe("sanitizeChatSendMessageInput", () => {
  it.each([
    {
      name: "rejects null bytes",
      input: "before\u0000after",
      expected: { ok: false as const, error: "message must not contain null bytes" },
    },
    {
      name: "strips unsafe control characters while preserving tab/newline/carriage return",
      input: "a\u0001b\tc\nd\re\u0007f\u007f",
      expected: { ok: true as const, message: "ab\tc\nd\ref" },
    },
    {
      name: "normalizes unicode to NFC",
      input: "Cafe\u0301",
      expected: { ok: true as const, message: "Café" },
    },
  ])("$name", ({ input, expected }) => {
    expect(sanitizeChatSendMessageInput(input)).toEqual(expected);
  });
});

describe("gateway chat transcript writes (guardrail)", () => {
  it("routes transcript writes through helper and SessionManager parentId append", () => {
    const chatTs = fileURLToPath(new URL("./chat.ts", import.meta.url));
    const chatSrc = fs.readFileSync(chatTs, "utf-8");
    const helperTs = fileURLToPath(new URL("./chat-transcript-inject.ts", import.meta.url));
    const helperSrc = fs.readFileSync(helperTs, "utf-8");

    expect(chatSrc.includes("fs.appendFileSync(transcriptPath")).toBe(false);
    expect(chatSrc).toContain("appendInjectedAssistantMessageToTranscript(");

    expect(helperSrc.includes("fs.appendFileSync(params.transcriptPath")).toBe(false);
    expect(helperSrc).toContain("SessionManager.open(params.transcriptPath)");
    expect(helperSrc).toContain("appendMessage(messageBody)");
  });
});

describe("exec approval handlers", () => {
  const execApprovalNoop = () => false;
  type ExecApprovalHandlers = ReturnType<typeof createExecApprovalHandlers>;
  type ExecApprovalGetArgs = Parameters<ExecApprovalHandlers["exec.approval.get"]>[0];
  type ExecApprovalRequestArgs = Parameters<ExecApprovalHandlers["exec.approval.request"]>[0];
  type ExecApprovalResolveArgs = Parameters<ExecApprovalHandlers["exec.approval.resolve"]>[0];

  const defaultExecApprovalRequestParams = {
    command: "echo ok",
    commandArgv: ["echo", "ok"],
    systemRunPlan: {
      argv: ["/usr/bin/echo", "ok"],
      cwd: "/tmp",
      commandText: "/usr/bin/echo ok",
      agentId: "main",
      sessionKey: "agent:main:main",
    },
    cwd: "/tmp",
    nodeId: "node-1",
    host: "node",
    timeoutMs: 2000,
  } as const;

  function toExecApprovalRequestContext(context: {
    broadcast: (event: string, payload: unknown) => void;
    hasExecApprovalClients?: () => boolean;
  }): ExecApprovalRequestArgs["context"] {
    return context as unknown as ExecApprovalRequestArgs["context"];
  }

  function toExecApprovalResolveContext(context: {
    broadcast: (event: string, payload: unknown) => void;
  }): ExecApprovalResolveArgs["context"] {
    return context as unknown as ExecApprovalResolveArgs["context"];
  }

  async function getExecApproval(params: {
    handlers: ExecApprovalHandlers;
    id: string;
    respond: ReturnType<typeof vi.fn>;
  }) {
    return params.handlers["exec.approval.get"]({
      params: { id: params.id } as ExecApprovalGetArgs["params"],
      respond: params.respond as unknown as ExecApprovalGetArgs["respond"],
      context: {} as ExecApprovalGetArgs["context"],
      client: null,
      req: { id: "req-get", type: "req", method: "exec.approval.get" },
      isWebchatConnect: execApprovalNoop,
    });
  }

  async function listExecApprovals(params: {
    handlers: ExecApprovalHandlers;
    respond: ReturnType<typeof vi.fn>;
  }) {
    return params.handlers["exec.approval.list"]({
      params: {} as never,
      respond: params.respond as never,
      context: {} as never,
      client: null,
      req: { id: "req-list", type: "req", method: "exec.approval.list" },
      isWebchatConnect: execApprovalNoop,
    });
  }

  async function requestExecApproval(params: {
    handlers: ExecApprovalHandlers;
    respond: ReturnType<typeof vi.fn>;
    context: { broadcast: (event: string, payload: unknown) => void };
    params?: Record<string, unknown>;
  }) {
    const requestParams = {
      ...defaultExecApprovalRequestParams,
      ...params.params,
    } as unknown as ExecApprovalRequestArgs["params"];
    const hasExplicitPlan = !!params.params && Object.hasOwn(params.params, "systemRunPlan");
    if (
      !hasExplicitPlan &&
      (requestParams as { host?: string }).host === "node" &&
      Array.isArray((requestParams as { commandArgv?: unknown }).commandArgv)
    ) {
      const commandArgv = (requestParams as { commandArgv: unknown[] }).commandArgv.map((entry) =>
        String(entry),
      );
      const cwdValue =
        typeof (requestParams as { cwd?: unknown }).cwd === "string"
          ? ((requestParams as { cwd: string }).cwd ?? null)
          : null;
      const commandText =
        typeof (requestParams as { command?: unknown }).command === "string"
          ? ((requestParams as { command: string }).command ?? null)
          : null;
      requestParams.systemRunPlan = {
        argv: commandArgv,
        cwd: cwdValue,
        commandText: commandText ?? commandArgv.join(" "),
        agentId:
          typeof (requestParams as { agentId?: unknown }).agentId === "string"
            ? ((requestParams as { agentId: string }).agentId ?? null)
            : null,
        sessionKey:
          typeof (requestParams as { sessionKey?: unknown }).sessionKey === "string"
            ? ((requestParams as { sessionKey: string }).sessionKey ?? null)
            : null,
      };
    }
    return params.handlers["exec.approval.request"]({
      params: requestParams,
      respond: params.respond as unknown as ExecApprovalRequestArgs["respond"],
      context: toExecApprovalRequestContext({
        hasExecApprovalClients: () => true,
        ...params.context,
      }),
      client: null,
      req: { id: "req-1", type: "req", method: "exec.approval.request" },
      isWebchatConnect: execApprovalNoop,
    });
  }

  async function resolveExecApproval(params: {
    handlers: ExecApprovalHandlers;
    id: string;
    decision?: "allow-once" | "allow-always" | "deny";
    respond: ReturnType<typeof vi.fn>;
    context: { broadcast: (event: string, payload: unknown) => void };
  }) {
    return params.handlers["exec.approval.resolve"]({
      params: {
        id: params.id,
        decision: params.decision ?? "allow-once",
      } as ExecApprovalResolveArgs["params"],
      respond: params.respond as unknown as ExecApprovalResolveArgs["respond"],
      context: toExecApprovalResolveContext(params.context),
      client: null,
      req: { id: "req-2", type: "req", method: "exec.approval.resolve" },
      isWebchatConnect: execApprovalNoop,
    });
  }

  function createExecApprovalFixture() {
    const manager = new ExecApprovalManager();
    const handlers = createExecApprovalHandlers(manager);
    const broadcasts: Array<{ event: string; payload: unknown }> = [];
    const respond = vi.fn();
    const context = {
      broadcast: (event: string, payload: unknown) => {
        broadcasts.push({ event, payload });
      },
      hasExecApprovalClients: () => true,
    };
    return { handlers, broadcasts, respond, context };
  }

  function createForwardingExecApprovalFixture(opts?: {
    iosPushDelivery?: {
      handleRequested: ReturnType<typeof vi.fn>;
      handleResolved: ReturnType<typeof vi.fn>;
      handleExpired: ReturnType<typeof vi.fn>;
    };
  }) {
    const manager = new ExecApprovalManager();
    const forwarder = {
      handleRequested: vi.fn(async () => false),
      handleResolved: vi.fn(async () => {}),
      stop: vi.fn(),
    };
    const handlers = createExecApprovalHandlers(manager, {
      forwarder,
      iosPushDelivery: opts?.iosPushDelivery as never,
    });
    const respond = vi.fn();
    const context = {
      broadcast: (_event: string, _payload: unknown) => {},
      hasExecApprovalClients: () => false,
    };
    return {
      manager,
      handlers,
      forwarder,
      iosPushDelivery: opts?.iosPushDelivery,
      respond,
      context,
    };
  }

  async function drainApprovalRequestTicks() {
    for (let idx = 0; idx < 20; idx += 1) {
      await Promise.resolve();
    }
  }

  describe("ExecApprovalRequestParams validation", () => {
    const baseParams = {
      command: "echo hi",
      cwd: "/tmp",
      nodeId: "node-1",
      host: "node",
    };

    it.each([
      { label: "omitted", extra: {} },
      { label: "string", extra: { resolvedPath: "/usr/bin/echo" } },
      { label: "undefined", extra: { resolvedPath: undefined } },
      { label: "null", extra: { resolvedPath: null } },
    ])("accepts request with resolvedPath $label", ({ extra }) => {
      const params = { ...baseParams, ...extra };
      expect(validateExecApprovalRequestParams(params)).toBe(true);
    });
  });

  it("rejects host=node approval requests without nodeId", async () => {
    const { handlers, respond, context } = createExecApprovalFixture();
    await requestExecApproval({
      handlers,
      respond,
      context,
      params: {
        nodeId: undefined,
      },
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "nodeId is required for host=node",
      }),
    );
  });

  it("rejects host=node approval requests without systemRunPlan", async () => {
    const { handlers, respond, context } = createExecApprovalFixture();
    await requestExecApproval({
      handlers,
      respond,
      context,
      params: {
        systemRunPlan: undefined,
      },
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "systemRunPlan is required for host=node",
      }),
    );
  });

  it("returns pending approval details for exec.approval.get", async () => {
    const { handlers, broadcasts, respond, context } = createExecApprovalFixture();

    const requestPromise = requestExecApproval({
      handlers,
      respond,
      context,
      params: {
        twoPhase: true,
        host: "gateway",
        command: "echo ok",
        commandArgv: ["echo", "ok"],
        systemRunPlan: undefined,
        nodeId: undefined,
      },
    });

    const requested = broadcasts.find((entry) => entry.event === "exec.approval.requested");
    const id = (requested?.payload as { id?: string })?.id ?? "";
    expect(id).not.toBe("");

    const getRespond = vi.fn();
    await getExecApproval({ handlers, id, respond: getRespond });

    expect(getRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        id,
        commandText: "echo ok",
        allowedDecisions: expect.arrayContaining(["allow-once", "allow-always", "deny"]),
        host: "gateway",
        nodeId: null,
        agentId: null,
      }),
      undefined,
    );

    const resolveRespond = vi.fn();
    await resolveExecApproval({
      handlers,
      id,
      respond: resolveRespond,
      context,
    });
    await requestPromise;
  });

  it("lists pending exec approvals", async () => {
    const { handlers, respond, context } = createExecApprovalFixture();
    const requestPromise = requestExecApproval({
      handlers,
      respond,
      context,
      params: {
        id: "approval-list-1",
        twoPhase: true,
        host: "gateway",
        systemRunPlan: undefined,
        nodeId: undefined,
      },
    });

    const listRespond = vi.fn();
    await listExecApprovals({ handlers, respond: listRespond });

    expect(listRespond).toHaveBeenCalledWith(
      true,
      expect.arrayContaining([
        expect.objectContaining({
          id: "approval-list-1",
          request: expect.objectContaining({
            command: "echo ok",
          }),
        }),
      ]),
      undefined,
    );

    const resolveRespond = vi.fn();
    await resolveExecApproval({
      handlers,
      id: "approval-list-1",
      respond: resolveRespond,
      context,
    });
    await requestPromise;
  });

  it("returns not found for stale exec.approval.get ids", async () => {
    const { handlers, respond, context } = createExecApprovalFixture();

    const requestPromise = requestExecApproval({
      handlers,
      respond,
      context,
      params: { twoPhase: true, host: "gateway", systemRunPlan: undefined, nodeId: undefined },
    });
    const acceptedId = respond.mock.calls.find((call) => call[1]?.status === "accepted")?.[1]?.id;
    expect(typeof acceptedId).toBe("string");

    const resolveRespond = vi.fn();
    await resolveExecApproval({
      handlers,
      id: acceptedId as string,
      respond: resolveRespond,
      context,
    });
    await requestPromise;

    const getRespond = vi.fn();
    await getExecApproval({ handlers, id: acceptedId as string, respond: getRespond });
    expect(getRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "unknown or expired approval id",
      }),
    );
  });

  it("broadcasts request + resolve", async () => {
    const { handlers, broadcasts, respond, context } = createExecApprovalFixture();

    const requestPromise = requestExecApproval({
      handlers,
      respond,
      context,
      params: { twoPhase: true },
    });

    const requested = broadcasts.find((entry) => entry.event === "exec.approval.requested");
    expect(requested).toBeTruthy();
    const id = (requested?.payload as { id?: string })?.id ?? "";
    expect(id).not.toBe("");

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "accepted", id }),
      undefined,
    );

    const resolveRespond = vi.fn();
    await resolveExecApproval({
      handlers,
      id,
      respond: resolveRespond,
      context,
    });

    await requestPromise;

    expect(resolveRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ id, decision: "allow-once" }),
      undefined,
    );
    expect(broadcasts.some((entry) => entry.event === "exec.approval.resolved")).toBe(true);
  });

  it("rejects allow-always when the request ask mode is always", async () => {
    const { handlers, broadcasts, respond, context } = createExecApprovalFixture();

    const requestPromise = requestExecApproval({
      handlers,
      respond,
      context,
      params: { twoPhase: true, ask: "always" },
    });

    const requested = broadcasts.find((entry) => entry.event === "exec.approval.requested");
    const id = (requested?.payload as { id?: string })?.id ?? "";
    expect(id).not.toBe("");

    const resolveRespond = vi.fn();
    await resolveExecApproval({
      handlers,
      id,
      decision: "allow-always",
      respond: resolveRespond,
      context,
    });

    expect(resolveRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message:
          "allow-always is unavailable because the effective policy requires approval every time",
      }),
    );

    const denyRespond = vi.fn();
    await resolveExecApproval({
      handlers,
      id,
      decision: "deny",
      respond: denyRespond,
      context,
    });

    await requestPromise;
    expect(denyRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);
  });

  it("does not reuse a resolved exact id as a prefix for another pending approval", () => {
    const manager = new ExecApprovalManager();
    const resolvedRecord = manager.create({ command: "echo old", host: "gateway" }, 2_000, "abc");
    void manager.register(resolvedRecord, 2_000);
    expect(manager.resolve("abc", "allow-once")).toBe(true);

    const pendingRecord = manager.create({ command: "echo new", host: "gateway" }, 2_000, "abcdef");
    void manager.register(pendingRecord, 2_000);

    expect(manager.lookupPendingId("abc")).toEqual({ kind: "none" });
    expect(manager.lookupPendingId("abcdef")).toEqual({ kind: "exact", id: "abcdef" });
  });

  it("stores versioned system.run binding and sorted env keys on approval request", async () => {
    const { handlers, broadcasts, respond, context } = createExecApprovalFixture();
    await requestExecApproval({
      handlers,
      respond,
      context,
      params: {
        timeoutMs: 10,
        commandArgv: ["echo", "ok"],
        env: {
          Z_VAR: "z",
          A_VAR: "a",
        },
      },
    });
    const requested = broadcasts.find((entry) => entry.event === "exec.approval.requested");
    expect(requested).toBeTruthy();
    const request = (requested?.payload as { request?: Record<string, unknown> })?.request ?? {};
    expect(request["envKeys"]).toEqual(["A_VAR", "Z_VAR"]);
    expect(request["systemRunBinding"]).toEqual(
      buildSystemRunApprovalBinding({
        argv: ["echo", "ok"],
        cwd: "/tmp",
        env: { A_VAR: "a", Z_VAR: "z" },
      }).binding,
    );
  });

  it("includes Windows-compatible env keys in approval env bindings", async () => {
    const { handlers, broadcasts, respond, context } = createExecApprovalFixture();
    await requestExecApproval({
      handlers,
      respond,
      context,
      params: {
        timeoutMs: 10,
        commandArgv: ["cmd.exe", "/c", "echo", "ok"],
        command: "cmd.exe /c echo ok",
        env: {
          "ProgramFiles(x86)": "C:\\Program Files (x86)",
        },
      },
    });
    const requested = broadcasts.find((entry) => entry.event === "exec.approval.requested");
    expect(requested).toBeTruthy();
    const request = (requested?.payload as { request?: Record<string, unknown> })?.request ?? {};
    const envBinding = buildSystemRunApprovalEnvBinding({
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
    });
    expect(request["envKeys"]).toEqual(envBinding.envKeys);
    expect(request["systemRunBinding"]).toEqual(
      buildSystemRunApprovalBinding({
        argv: ["cmd.exe", "/c", "echo", "ok"],
        cwd: "/tmp",
        env: { "ProgramFiles(x86)": "C:\\Program Files (x86)" },
      }).binding,
    );
  });

  it("stores sorted env keys for gateway approvals without node-only binding", async () => {
    const { handlers, broadcasts, respond, context } = createExecApprovalFixture();
    await requestExecApproval({
      handlers,
      respond,
      context,
      params: {
        host: "gateway",
        nodeId: undefined,
        systemRunPlan: undefined,
        env: {
          Z_VAR: "z",
          A_VAR: "a",
        },
      },
    });
    const requested = broadcasts.find((entry) => entry.event === "exec.approval.requested");
    expect(requested).toBeTruthy();
    const request = (requested?.payload as { request?: Record<string, unknown> })?.request ?? {};
    expect(request["envKeys"]).toEqual(
      buildSystemRunApprovalEnvBinding({ A_VAR: "a", Z_VAR: "z" }).envKeys,
    );
    expect(request["systemRunBinding"]).toBeNull();
  });

  it("prefers systemRunPlan canonical command/cwd when present", async () => {
    const { handlers, broadcasts, respond, context } = createExecApprovalFixture();
    await requestExecApproval({
      handlers,
      respond,
      context,
      params: {
        timeoutMs: 10,
        command: "echo stale",
        commandArgv: ["echo", "stale"],
        cwd: "/tmp/link/sub",
        systemRunPlan: {
          argv: ["/usr/bin/echo", "ok"],
          cwd: "/real/cwd",
          commandText: "/usr/bin/echo ok",
          commandPreview: "echo ok",
          agentId: "main",
          sessionKey: "agent:main:main",
        },
      },
    });
    const requested = broadcasts.find((entry) => entry.event === "exec.approval.requested");
    expect(requested).toBeTruthy();
    const request = (requested?.payload as { request?: Record<string, unknown> })?.request ?? {};
    expect(request["command"]).toBe("/usr/bin/echo ok");
    expect(request["commandPreview"]).toBeUndefined();
    expect(request["commandArgv"]).toBeUndefined();
    expect(request["cwd"]).toBe("/real/cwd");
    expect(request["agentId"]).toBe("main");
    expect(request["sessionKey"]).toBe("agent:main:main");
    expect(request["systemRunPlan"]).toEqual({
      argv: ["/usr/bin/echo", "ok"],
      cwd: "/real/cwd",
      commandText: "/usr/bin/echo ok",
      commandPreview: "echo ok",
      agentId: "main",
      sessionKey: "agent:main:main",
    });
  });

  it("derives a command preview from the fallback command for older node plans", async () => {
    const { handlers, broadcasts, respond, context } = createExecApprovalFixture();
    await requestExecApproval({
      handlers,
      respond,
      context,
      params: {
        timeoutMs: 10,
        command: "jq --version",
        commandArgv: ["./env", "sh", "-c", "jq --version"],
        systemRunPlan: {
          argv: ["./env", "sh", "-c", "jq --version"],
          cwd: "/real/cwd",
          commandText: './env sh -c "jq --version"',
          agentId: "main",
          sessionKey: "agent:main:main",
        },
      },
    });
    const requested = broadcasts.find((entry) => entry.event === "exec.approval.requested");
    expect(requested).toBeTruthy();
    const request = (requested?.payload as { request?: Record<string, unknown> })?.request ?? {};
    expect(request["command"]).toBe('./env sh -c "jq --version"');
    expect(request["commandPreview"]).toBeUndefined();
    expect((request["systemRunPlan"] as { commandPreview?: string }).commandPreview).toBe(
      "jq --version",
    );
  });

  it("sanitizes invisible Unicode format chars in approval display text without changing node bindings", async () => {
    const { handlers, broadcasts, respond, context } = createExecApprovalFixture();
    await requestExecApproval({
      handlers,
      respond,
      context,
      params: {
        timeoutMs: 10,
        command: "bash safe\u200B.sh",
        commandArgv: ["bash", "safe\u200B.sh"],
        systemRunPlan: {
          argv: ["bash", "safe\u200B.sh"],
          cwd: "/real/cwd",
          commandText: "bash safe\u200B.sh",
          agentId: "main",
          sessionKey: "agent:main:main",
        },
      },
    });
    const requested = broadcasts.find((entry) => entry.event === "exec.approval.requested");
    expect(requested).toBeTruthy();
    const request = (requested?.payload as { request?: Record<string, unknown> })?.request ?? {};
    expect(request["command"]).toBe("bash safe\\u{200B}.sh");
    expect((request["systemRunPlan"] as { commandText?: string }).commandText).toBe(
      "bash safe\u200B.sh",
    );
  });

  it("accepts resolve during broadcast", async () => {
    const manager = new ExecApprovalManager();
    const handlers = createExecApprovalHandlers(manager);
    const respond = vi.fn();
    const resolveRespond = vi.fn();

    const resolveContext = {
      broadcast: () => {},
    };

    const context = {
      broadcast: (event: string, payload: unknown) => {
        if (event !== "exec.approval.requested") {
          return;
        }
        const id = (payload as { id?: string })?.id ?? "";
        void resolveExecApproval({
          handlers,
          id,
          respond: resolveRespond,
          context: resolveContext,
        });
      },
    };

    await requestExecApproval({
      handlers,
      respond,
      context,
    });

    expect(resolveRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ decision: "allow-once" }),
      undefined,
    );
  });

  it("accepts explicit approval ids", async () => {
    const { handlers, broadcasts, respond, context } = createExecApprovalFixture();

    const requestPromise = requestExecApproval({
      handlers,
      respond,
      context,
      params: { id: "approval-123", host: "gateway" },
    });

    const requested = broadcasts.find((entry) => entry.event === "exec.approval.requested");
    const id = (requested?.payload as { id?: string })?.id ?? "";
    expect(id).toBe("approval-123");

    const resolveRespond = vi.fn();
    await resolveExecApproval({
      handlers,
      id,
      respond: resolveRespond,
      context,
    });

    await requestPromise;
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ id: "approval-123", decision: "allow-once" }),
      undefined,
    );
    expect(resolveRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);
  });

  it("rejects explicit approval ids with the reserved plugin prefix", async () => {
    const { handlers, respond, context } = createExecApprovalFixture();

    await requestExecApproval({
      handlers,
      respond,
      context,
      params: { id: "plugin:approval-123", host: "gateway" },
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "approval ids starting with plugin: are reserved",
      }),
    );
  });

  it("accepts unique short approval id prefixes", async () => {
    const manager = new ExecApprovalManager();
    const handlers = createExecApprovalHandlers(manager);
    const respond = vi.fn();
    const context = {
      broadcast: (_event: string, _payload: unknown) => {},
    };

    const record = manager.create({ command: "echo ok" }, 60_000, "approval-12345678-aaaa");
    void manager.register(record, 60_000);

    await resolveExecApproval({
      handlers,
      id: "approval-1234",
      respond,
      context,
    });

    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(manager.getSnapshot(record.id)?.decision).toBe("allow-once");
  });

  it("rejects ambiguous short approval id prefixes without leaking candidate ids", async () => {
    const manager = new ExecApprovalManager();
    const handlers = createExecApprovalHandlers(manager);
    const respond = vi.fn();
    const context = {
      broadcast: (_event: string, _payload: unknown) => {},
    };

    void manager.register(
      manager.create({ command: "echo one" }, 60_000, "approval-abcd-1111"),
      60_000,
    );
    void manager.register(
      manager.create({ command: "echo two" }, 60_000, "approval-abcd-2222"),
      60_000,
    );

    await resolveExecApproval({
      handlers,
      id: "approval-abcd",
      respond,
      context,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "ambiguous approval id prefix; use the full id",
      }),
    );
  });

  it("returns deterministic unknown/expired message for missing approval ids", async () => {
    const { handlers, respond, context } = createExecApprovalFixture();

    await resolveExecApproval({
      handlers,
      id: "missing-approval-id",
      respond,
      context,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "unknown or expired approval id",
        details: expect.objectContaining({ reason: "APPROVAL_NOT_FOUND" }),
      }),
    );
  });

  it("resolves only the targeted approval id when multiple requests are pending", async () => {
    const manager = new ExecApprovalManager();
    const handlers = createExecApprovalHandlers(manager);
    const context = {
      broadcast: (_event: string, _payload: unknown) => {},
      hasExecApprovalClients: () => true,
    };
    const respondOne = vi.fn();
    const respondTwo = vi.fn();

    const requestOne = requestExecApproval({
      handlers,
      respond: respondOne,
      context,
      params: { id: "approval-one", host: "gateway", timeoutMs: 60_000 },
    });
    const requestTwo = requestExecApproval({
      handlers,
      respond: respondTwo,
      context,
      params: { id: "approval-two", host: "gateway", timeoutMs: 60_000 },
    });

    await drainApprovalRequestTicks();

    const resolveRespond = vi.fn();
    await resolveExecApproval({
      handlers,
      id: "approval-one",
      respond: resolveRespond,
      context,
    });

    expect(resolveRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(manager.getSnapshot("approval-one")?.decision).toBe("allow-once");
    expect(manager.getSnapshot("approval-two")?.decision).toBeUndefined();
    expect(manager.getSnapshot("approval-two")?.resolvedAtMs).toBeUndefined();

    expect(manager.expire("approval-two", "test-expire")).toBe(true);
    await requestOne;
    await requestTwo;

    expect(respondOne).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ id: "approval-one", decision: "allow-once" }),
      undefined,
    );
    expect(respondTwo).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ id: "approval-two", decision: null }),
      undefined,
    );
  });

  it("forwards turn-source metadata to exec approval forwarding", async () => {
    vi.useFakeTimers();
    try {
      const { handlers, forwarder, respond, context } = createForwardingExecApprovalFixture();

      const requestPromise = requestExecApproval({
        handlers,
        respond,
        context,
        params: {
          timeoutMs: 60_000,
          turnSourceChannel: "whatsapp",
          turnSourceTo: "+15555550123",
          turnSourceAccountId: "work",
          turnSourceThreadId: "1739201675.123",
        },
      });
      await drainApprovalRequestTicks();
      expect(forwarder.handleRequested).toHaveBeenCalledTimes(1);
      expect(forwarder.handleRequested).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            turnSourceChannel: "whatsapp",
            turnSourceTo: "+15555550123",
            turnSourceAccountId: "work",
            turnSourceThreadId: "1739201675.123",
          }),
        }),
      );

      await vi.runOnlyPendingTimersAsync();
      await requestPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("fast-fails approvals when no approver clients and no forwarding targets", async () => {
    const { manager, handlers, forwarder, respond, context } =
      createForwardingExecApprovalFixture();
    const expireSpy = vi.spyOn(manager, "expire");

    await requestExecApproval({
      handlers,
      respond,
      context,
      params: { timeoutMs: 60_000, id: "approval-no-approver", host: "gateway" },
    });

    expect(forwarder.handleRequested).toHaveBeenCalledTimes(1);
    expect(expireSpy).toHaveBeenCalledWith("approval-no-approver", "no-approval-route");
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ id: "approval-no-approver", decision: null }),
      undefined,
    );
  });

  it("keeps approvals pending when iOS push delivery accepted the request", async () => {
    const iosPushDelivery = {
      handleRequested: vi.fn(async () => true),
      handleResolved: vi.fn(async () => {}),
      handleExpired: vi.fn(async () => {}),
    };
    const { manager, handlers, forwarder, respond, context } = createForwardingExecApprovalFixture({
      iosPushDelivery,
    });
    const expireSpy = vi.spyOn(manager, "expire");

    const requestPromise = requestExecApproval({
      handlers,
      respond,
      context,
      params: {
        twoPhase: true,
        timeoutMs: 60_000,
        id: "approval-ios-push",
        host: "gateway",
      },
    });

    await vi.waitFor(() => {
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "accepted", id: "approval-ios-push" }),
        undefined,
      );
    });

    expect(forwarder.handleRequested).toHaveBeenCalledTimes(1);
    expect(iosPushDelivery.handleRequested).toHaveBeenCalledWith(
      expect.objectContaining({ id: "approval-ios-push" }),
    );
    expect(expireSpy).not.toHaveBeenCalled();

    manager.resolve("approval-ios-push", "allow-once");
    await requestPromise;
  });

  it("sends iOS cleanup delivery on resolve", async () => {
    const iosPushDelivery = {
      handleRequested: vi.fn(async () => true),
      handleResolved: vi.fn(async () => {}),
      handleExpired: vi.fn(async () => {}),
    };
    const { handlers, respond, context } = createForwardingExecApprovalFixture({ iosPushDelivery });
    const resolveRespond = vi.fn();

    const requestPromise = requestExecApproval({
      handlers,
      respond,
      context,
      params: { timeoutMs: 60_000, id: "approval-ios-cleanup", host: "gateway" },
    });
    await drainApprovalRequestTicks();

    await resolveExecApproval({
      handlers,
      id: "approval-ios-cleanup",
      respond: resolveRespond,
      context,
    });
    await requestPromise;

    await vi.waitFor(() => {
      expect(iosPushDelivery.handleResolved).toHaveBeenCalledWith(
        expect.objectContaining({ id: "approval-ios-cleanup", decision: "allow-once" }),
      );
    });
  });

  it("sends iOS cleanup delivery on expiration", async () => {
    vi.useFakeTimers();
    try {
      const iosPushDelivery = {
        handleRequested: vi.fn(async () => true),
        handleResolved: vi.fn(async () => {}),
        handleExpired: vi.fn(async () => {}),
      };
      const { handlers, respond, context } = createForwardingExecApprovalFixture({
        iosPushDelivery,
      });

      const requestPromise = requestExecApproval({
        handlers,
        respond,
        context,
        params: {
          twoPhase: true,
          timeoutMs: 250,
          id: "approval-ios-expire",
          host: "gateway",
        },
      });
      await drainApprovalRequestTicks();
      await vi.advanceTimersByTimeAsync(250);
      await requestPromise;

      await vi.waitFor(() => {
        expect(iosPushDelivery.handleExpired).toHaveBeenCalledWith(
          expect.objectContaining({ id: "approval-ios-expire" }),
        );
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps approvals pending when the originating chat can handle /approve directly", async () => {
    vi.useFakeTimers();
    try {
      const { manager, handlers, forwarder, respond, context } =
        createForwardingExecApprovalFixture();
      const expireSpy = vi.spyOn(manager, "expire");

      const requestPromise = requestExecApproval({
        handlers,
        respond,
        context,
        params: {
          twoPhase: true,
          timeoutMs: 60_000,
          id: "approval-chat-route",
          host: "gateway",
          turnSourceChannel: "slack",
          turnSourceTo: "D123",
        },
      });

      await vi.waitFor(() => {
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ status: "accepted", id: "approval-chat-route" }),
          undefined,
        );
      });

      expect(forwarder.handleRequested).toHaveBeenCalledTimes(1);
      expect(expireSpy).not.toHaveBeenCalled();

      manager.resolve("approval-chat-route", "allow-once");
      await requestPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps approvals pending when no approver clients but forwarding accepted the request", async () => {
    const { manager, handlers, forwarder, respond, context } =
      createForwardingExecApprovalFixture();
    const expireSpy = vi.spyOn(manager, "expire");
    const resolveRespond = vi.fn();
    forwarder.handleRequested.mockResolvedValueOnce(true);

    const requestPromise = requestExecApproval({
      handlers,
      respond,
      context,
      params: { timeoutMs: 60_000, id: "approval-forwarded", host: "gateway" },
    });
    await drainApprovalRequestTicks();

    expect(forwarder.handleRequested).toHaveBeenCalledTimes(1);
    expect(expireSpy).not.toHaveBeenCalled();

    await resolveExecApproval({
      handlers,
      id: "approval-forwarded",
      respond: resolveRespond,
      context,
    });
    await requestPromise;

    expect(resolveRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ id: "approval-forwarded", decision: "allow-once" }),
      undefined,
    );
  });
});

describe("gateway healthHandlers.status scope handling", () => {
  let statusModule: typeof import("../../commands/status.js");
  let healthHandlers: typeof import("./health.js").healthHandlers;

  beforeAll(async () => {
    statusModule = await import("../../commands/status.js");
    ({ healthHandlers } = await import("./health.js"));
  });

  beforeEach(() => {
    vi.mocked(statusModule.getStatusSummary).mockClear();
  });

  async function runHealthStatus(scopes: string[]) {
    const respond = vi.fn();

    await healthHandlers.status({
      req: {} as never,
      params: {} as never,
      respond: respond as never,
      context: {} as never,
      client: { connect: { role: "operator", scopes } } as never,
      isWebchatConnect: () => false,
    });

    return respond;
  }

  it.each([
    { scopes: ["operator.read"], includeSensitive: false },
    { scopes: ["operator.admin"], includeSensitive: true },
  ])(
    "requests includeSensitive=$includeSensitive for scopes $scopes",
    async ({ scopes, includeSensitive }) => {
      const respond = await runHealthStatus(scopes);

      expect(vi.mocked(statusModule.getStatusSummary)).toHaveBeenCalledWith({ includeSensitive });
      expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    },
  );
});

describe("logs.tail", () => {
  const logsNoop = () => false;

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
  });

  it("falls back to latest rolling log file when today is missing", async () => {
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-logs-"));
    const older = path.join(tempDir, "openclaw-2026-01-20.log");
    const newer = path.join(tempDir, "openclaw-2026-01-21.log");

    await fsPromises.writeFile(older, '{"msg":"old"}\n');
    await fsPromises.writeFile(newer, '{"msg":"new"}\n');
    await fsPromises.utimes(older, new Date(0), new Date(0));
    await fsPromises.utimes(newer, new Date(), new Date());

    setLoggerOverride({ file: path.join(tempDir, "openclaw-2026-01-22.log") });

    const respond = vi.fn();
    await logsHandlers["logs.tail"]({
      params: {},
      respond,
      context: {} as unknown as Parameters<(typeof logsHandlers)["logs.tail"]>[0]["context"],
      client: null,
      req: { id: "req-1", type: "req", method: "logs.tail" },
      isWebchatConnect: logsNoop,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        file: newer,
        lines: ['{"msg":"new"}'],
      }),
      undefined,
    );

    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  it("redacts sensitive CLI tokens from returned lines", async () => {
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-logs-"));
    const file = path.join(tempDir, "openclaw-2026-01-22.log");

    await fsPromises.writeFile(
      file,
      "starting gog gmail watch serve --token push-token-bbbbbbbbbbbbbbbbbbbb --hook-token hook-token-aaaaaaaaaaaaaaaaaaaa\n",
    );

    setLoggerOverride({ file });

    const respond = vi.fn();
    await logsHandlers["logs.tail"]({
      params: {},
      respond,
      context: {} as unknown as Parameters<(typeof logsHandlers)["logs.tail"]>[0]["context"],
      client: null,
      req: { id: "req-1", type: "req", method: "logs.tail" },
      isWebchatConnect: logsNoop,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        file,
        lines: ["starting gog gmail watch serve --token push-t…bbbb --hook-token hook-t…aaaa"],
      }),
      undefined,
    );

    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });
});
