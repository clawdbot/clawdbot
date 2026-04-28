import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelMessagingAdapter } from "../../channels/plugins/types.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { extractAssistantText, sanitizeTextContent } from "./sessions-helpers.js";

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

type SessionsToolTestConfig = {
  session: { scope: "per-sender"; mainKey: string };
  tools: {
    agentToAgent: { enabled: boolean };
    sessions?: { visibility: "all" | "own" };
  };
};

const loadConfigMock = vi.fn<() => SessionsToolTestConfig>(() => ({
  session: { scope: "per-sender", mainKey: "main" },
  tools: { agentToAgent: { enabled: false } },
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: () => loadConfigMock() as never,
  };
});
vi.mock("./sessions-send-tool.a2a.js", () => ({
  runSessionsSendA2AFlow: vi.fn(),
}));

let createSessionsListTool: typeof import("./sessions-list-tool.js").createSessionsListTool;
let createSessionsSendTool: typeof import("./sessions-send-tool.js").createSessionsSendTool;
let resolveAnnounceTarget: (typeof import("./sessions-announce-target.js"))["resolveAnnounceTarget"];
let setActivePluginRegistry: (typeof import("../../plugins/runtime.js"))["setActivePluginRegistry"];
const MAIN_AGENT_SESSION_KEY = "agent:main:main";
const MAIN_AGENT_CHANNEL = "whatsapp";
const resolveSessionConversationStub: NonNullable<
  ChannelMessagingAdapter["resolveSessionConversation"]
> = ({ rawId }) => ({
  id: rawId,
});
const resolveSessionTargetStub: NonNullable<ChannelMessagingAdapter["resolveSessionTarget"]> = ({
  kind,
  id,
  threadId,
}) => (threadId ? `${kind}:${id}:thread:${threadId}` : `${kind}:${id}`);

type SessionsListResult = Awaited<
  ReturnType<ReturnType<typeof import("./sessions-list-tool.js").createSessionsListTool>["execute"]>
>;

beforeAll(async () => {
  ({ createSessionsListTool } = await import("./sessions-list-tool.js"));
  ({ createSessionsSendTool } = await import("./sessions-send-tool.js"));
  ({ resolveAnnounceTarget } = await import("./sessions-announce-target.js"));
  ({ setActivePluginRegistry } = await import("../../plugins/runtime.js"));
});

const installRegistry = async () => {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        source: "test",
        plugin: {
          id: "discord",
          meta: {
            id: "discord",
            label: "Discord",
            selectionLabel: "Discord",
            docsPath: "/channels/discord",
            blurb: "Discord test stub.",
          },
          capabilities: { chatTypes: ["direct", "channel", "thread"] },
          messaging: {
            resolveSessionTarget: resolveSessionTargetStub,
          },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
          },
        },
      },
      {
        pluginId: "whatsapp",
        source: "test",
        plugin: {
          id: "whatsapp",
          meta: {
            id: "whatsapp",
            label: "WhatsApp",
            selectionLabel: "WhatsApp",
            docsPath: "/channels/whatsapp",
            blurb: "WhatsApp test stub.",
            preferSessionLookupForAnnounceTarget: true,
          },
          capabilities: { chatTypes: ["direct", "group"] },
          messaging: {
            resolveSessionConversation: resolveSessionConversationStub,
            resolveSessionTarget: resolveSessionTargetStub,
          },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
          },
        },
      },
      {
        pluginId: "slack",
        source: "test",
        plugin: {
          id: "slack",
          meta: {
            id: "slack",
            label: "Slack",
            selectionLabel: "Slack",
            docsPath: "/channels/slack",
            blurb: "Slack test stub.",
            preferSessionLookupForAnnounceTarget: true,
          },
          capabilities: { chatTypes: ["direct", "channel", "thread"] },
          messaging: {
            resolveSessionConversation: resolveSessionConversationStub,
            resolveSessionTarget: resolveSessionTargetStub,
          },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
          },
        },
      },
    ]),
  );
};

function createMainSessionsListTool() {
  return createSessionsListTool({ agentSessionKey: MAIN_AGENT_SESSION_KEY });
}

async function executeMainSessionsList() {
  return createMainSessionsListTool().execute("call1", {});
}

function createMainSessionsSendTool() {
  return createSessionsSendTool({
    agentSessionKey: MAIN_AGENT_SESSION_KEY,
    agentChannel: MAIN_AGENT_CHANNEL,
  });
}

function getFirstListedSession(result: SessionsListResult) {
  const details = result.details as
    | { sessions?: Array<{ key?: string; transcriptPath?: string }> }
    | undefined;
  return details?.sessions?.[0];
}

function expectWorkerTranscriptPath(
  result: SessionsListResult,
  params: { containsPath: string; sessionId: string },
) {
  const session = getFirstListedSession(result);
  expect(session).toMatchObject({ key: "agent:worker:main" });
  const transcriptPath = session?.transcriptPath ?? "";
  expect(path.normalize(transcriptPath)).toContain(path.normalize(params.containsPath));
  expect(transcriptPath).toMatch(new RegExp(`${params.sessionId}\\.jsonl$`));
}

async function withStubbedStateDir<T>(
  name: string,
  run: (stateDir: string) => Promise<T>,
): Promise<T> {
  const stateDir = path.join(os.tmpdir(), name);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  try {
    return await run(stateDir);
  } finally {
    vi.unstubAllEnvs();
  }
}

describe("sanitizeTextContent", () => {
  it("strips minimax tool call XML and downgraded markers", () => {
    const input =
      'Hello <invoke name="tool">payload</invoke></minimax:tool_call> ' +
      "[Tool Call: foo (ID: 1)] world";
    const result = sanitizeTextContent(input).trim();
    expect(result).toBe("Hello  world");
    expect(result).not.toContain("invoke");
    expect(result).not.toContain("Tool Call");
  });

  it("strips tool_result XML via the shared assistant-visible sanitizer", () => {
    const input = 'Prefix\n<tool_result>{"output":"hidden"}</tool_result>\nSuffix';
    const result = sanitizeTextContent(input).trim();
    expect(result).toBe("Prefix\n\nSuffix");
    expect(result).not.toContain("tool_result");
  });

  it("strips thinking tags", () => {
    const input = "Before <think>secret</think> after";
    const result = sanitizeTextContent(input).trim();
    expect(result).toBe("Before  after");
  });
});

beforeEach(() => {
  loadConfigMock.mockReset();
  loadConfigMock.mockReturnValue({
    session: { scope: "per-sender", mainKey: "main" },
    tools: { agentToAgent: { enabled: false } },
  });
  setActivePluginRegistry(createTestRegistry([]));
});

describe("extractAssistantText", () => {
  it("sanitizes blocks without injecting newlines", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "Hi " },
        { type: "text", text: "<think>secret</think>there" },
      ],
    };
    expect(extractAssistantText(message)).toBe("Hi there");
  });

  it("rewrites error-ish assistant text only when the transcript marks it as an error", () => {
    const message = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "500 Internal Server Error",
      content: [{ type: "text", text: "500 Internal Server Error" }],
    };
    expect(extractAssistantText(message)).toBe("HTTP 500: Internal Server Error");
  });

  it("keeps normal status text that mentions billing", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Firebase downgraded us to the free Spark plan. Check whether billing should be re-enabled.",
        },
      ],
    };
    expect(extractAssistantText(message)).toBe(
      "Firebase downgraded us to the free Spark plan. Check whether billing should be re-enabled.",
    );
  });

  it("preserves successful turns with stale background errorMessage", () => {
    const message = {
      role: "assistant",
      stopReason: "end_turn",
      errorMessage: "insufficient credits for embedding model",
      content: [{ type: "text", text: "Handle payment required errors in your API." }],
    };
    expect(extractAssistantText(message)).toBe("Handle payment required errors in your API.");
  });

  it("prefers final_answer text when phased assistant history is present", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "internal reasoning",
          textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
        },
        {
          type: "text",
          text: "Done.",
          textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
        },
      ],
    };
    expect(extractAssistantText(message)).toBe("Done.");
  });
});

describe("resolveAnnounceTarget", () => {
  beforeEach(async () => {
    callGatewayMock.mockClear();
    await installRegistry();
  });

  it("derives non-WhatsApp announce targets from the session key", async () => {
    const target = await resolveAnnounceTarget({
      sessionKey: "agent:main:discord:group:dev",
      displayKey: "agent:main:discord:group:dev",
    });
    expect(target).toEqual({ channel: "discord", to: "group:dev" });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("hydrates WhatsApp accountId from sessions.list when available", async () => {
    callGatewayMock.mockResolvedValueOnce({
      sessions: [
        {
          key: "agent:main:whatsapp:group:123@g.us",
          deliveryContext: {
            channel: "whatsapp",
            to: "123@g.us",
            accountId: "work",
            threadId: 99,
          },
        },
      ],
    });

    const target = await resolveAnnounceTarget({
      sessionKey: "agent:main:whatsapp:group:123@g.us",
      displayKey: "agent:main:whatsapp:group:123@g.us",
    });
    expect(target).toEqual({
      channel: "whatsapp",
      to: "123@g.us",
      accountId: "work",
      threadId: "99",
    });
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    const first = callGatewayMock.mock.calls[0]?.[0] as { method?: string } | undefined;
    expect(first).toBeDefined();
    expect(first?.method).toBe("sessions.list");
  });

  it("falls back to origin provider and accountId from sessions.list when legacy route fields are absent", async () => {
    callGatewayMock.mockResolvedValueOnce({
      sessions: [
        {
          key: "agent:main:whatsapp:group:123@g.us",
          origin: {
            provider: "whatsapp",
            accountId: "work",
          },
          lastTo: "123@g.us",
          lastThreadId: 271,
        },
      ],
    });

    const target = await resolveAnnounceTarget({
      sessionKey: "agent:main:whatsapp:group:123@g.us",
      displayKey: "agent:main:whatsapp:group:123@g.us",
    });
    expect(target).toEqual({
      channel: "whatsapp",
      to: "123@g.us",
      accountId: "work",
      threadId: "271",
    });
  });

  it("keeps threadId from sessions.list delivery context for announce delivery", async () => {
    callGatewayMock.mockResolvedValueOnce({
      sessions: [
        {
          key: "agent:main:whatsapp:group:123@g.us",
          deliveryContext: {
            channel: "whatsapp",
            to: "123@g.us",
            accountId: "work",
            threadId: "thread-77",
          },
        },
      ],
    });

    const target = await resolveAnnounceTarget({
      sessionKey: "agent:main:whatsapp:group:123@g.us",
      displayKey: "agent:main:whatsapp:group:123@g.us",
    });
    expect(target).toEqual({
      channel: "whatsapp",
      to: "123@g.us",
      accountId: "work",
      threadId: "thread-77",
    });
  });

  it("preserves threaded Slack session keys when sessions.list lacks stored thread metadata", async () => {
    callGatewayMock.mockResolvedValueOnce({
      sessions: [
        {
          key: "agent:main:slack:channel:C123:thread:1710000000.000100",
          deliveryContext: {
            channel: "slack",
            to: "channel:C123",
            accountId: "workspace",
          },
        },
      ],
    });

    const target = await resolveAnnounceTarget({
      sessionKey: "agent:main:slack:channel:C123:thread:1710000000.000100",
      displayKey: "agent:main:slack:channel:C123:thread:1710000000.000100",
    });
    expect(target).toEqual({
      channel: "slack",
      to: "channel:C123",
      accountId: "workspace",
      threadId: "1710000000.000100",
    });
  });
});

describe("sessions_list gating", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
    callGatewayMock.mockResolvedValue({
      path: "/tmp/sessions.json",
      sessions: [
        { key: "agent:main:main", kind: "direct" },
        { key: "agent:other:main", kind: "direct" },
      ],
    });
  });

  it("filters out other agents when tools.agentToAgent.enabled is false", async () => {
    const tool = createMainSessionsListTool();
    const result = await tool.execute("call1", {});
    expect(result.details).toMatchObject({
      count: 1,
      sessions: [{ key: MAIN_AGENT_SESSION_KEY }],
    });
  });

  it("keeps literal current keys for message previews", async () => {
    callGatewayMock.mockReset();
    callGatewayMock
      .mockResolvedValueOnce({
        path: "/tmp/sessions.json",
        sessions: [{ key: "current", kind: "direct" }],
      })
      .mockResolvedValueOnce({ sessions: [{ key: "current" }] })
      .mockResolvedValueOnce({ messages: [{ role: "assistant", content: [] }] });

    await createMainSessionsListTool().execute("call1", { messageLimit: 1 });

    expect(callGatewayMock).toHaveBeenLastCalledWith({
      method: "chat.history",
      params: { sessionKey: "current", limit: 1 },
    });
  });
});

describe("sessions_list transcriptPath resolution", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
    loadConfigMock.mockReturnValue({
      session: { scope: "per-sender", mainKey: "main" },
      tools: {
        agentToAgent: { enabled: true },
        sessions: { visibility: "all" },
      },
    });
  });

  it("resolves cross-agent transcript paths from agent defaults when gateway store path is relative", async () => {
    await withStubbedStateDir("openclaw-state-relative", async () => {
      callGatewayMock.mockResolvedValueOnce({
        path: "agents/main/sessions/sessions.json",
        sessions: [
          {
            key: "agent:worker:main",
            kind: "direct",
            sessionId: "sess-worker",
          },
        ],
      });

      const result = await executeMainSessionsList();
      expectWorkerTranscriptPath(result, {
        containsPath: path.join("agents", "worker", "sessions"),
        sessionId: "sess-worker",
      });
    });
  });

  it("resolves transcriptPath even when sessions.list does not return a store path", async () => {
    await withStubbedStateDir("openclaw-state-no-path", async () => {
      callGatewayMock.mockResolvedValueOnce({
        sessions: [
          {
            key: "agent:worker:main",
            kind: "direct",
            sessionId: "sess-worker-no-path",
          },
        ],
      });

      const result = await executeMainSessionsList();
      expectWorkerTranscriptPath(result, {
        containsPath: path.join("agents", "worker", "sessions"),
        sessionId: "sess-worker-no-path",
      });
    });
  });

  it("falls back to agent defaults when gateway path is non-string", async () => {
    await withStubbedStateDir("openclaw-state-non-string-path", async () => {
      callGatewayMock.mockResolvedValueOnce({
        path: { raw: "agents/main/sessions/sessions.json" },
        sessions: [
          {
            key: "agent:worker:main",
            kind: "direct",
            sessionId: "sess-worker-shape",
          },
        ],
      });

      const result = await executeMainSessionsList();
      expectWorkerTranscriptPath(result, {
        containsPath: path.join("agents", "worker", "sessions"),
        sessionId: "sess-worker-shape",
      });
    });
  });

  it("falls back to agent defaults when gateway path is '(multiple)'", async () => {
    await withStubbedStateDir("openclaw-state-multiple", async (stateDir) => {
      callGatewayMock.mockResolvedValueOnce({
        path: "(multiple)",
        sessions: [
          {
            key: "agent:worker:main",
            kind: "direct",
            sessionId: "sess-worker-multiple",
          },
        ],
      });

      const result = await executeMainSessionsList();
      expectWorkerTranscriptPath(result, {
        containsPath: path.join(stateDir, "agents", "worker", "sessions"),
        sessionId: "sess-worker-multiple",
      });
    });
  });

  it("resolves absolute {agentId} template paths per session agent", async () => {
    const templateStorePath = "/tmp/openclaw/agents/{agentId}/sessions/sessions.json";

    callGatewayMock.mockResolvedValueOnce({
      path: templateStorePath,
      sessions: [
        {
          key: "agent:worker:main",
          kind: "direct",
          sessionId: "sess-worker-template",
        },
      ],
    });

    const result = await executeMainSessionsList();
    const expectedSessionsDir = path.dirname(templateStorePath.replace("{agentId}", "worker"));
    expectWorkerTranscriptPath(result, {
      containsPath: expectedSessionsDir,
      sessionId: "sess-worker-template",
    });
  });
});

describe("sessions_list channel derivation", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
    loadConfigMock.mockReturnValue({
      session: { scope: "per-sender", mainKey: "main" },
      tools: {
        agentToAgent: { enabled: true },
        sessions: { visibility: "all" },
      },
    });
  });

  it("falls back to origin.provider when the legacy top-level channel field is missing", async () => {
    callGatewayMock.mockResolvedValueOnce({
      path: "/tmp/sessions.json",
      sessions: [
        {
          key: "agent:main:discord:group:ops",
          kind: "group",
          origin: { provider: "discord" },
        },
      ],
    });

    const result = await executeMainSessionsList();

    expect(result.details).toMatchObject({
      sessions: [{ key: "agent:main:discord:group:ops", channel: "discord" }],
    });
  });
});

describe("sessions_send gating", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
  });

  it("returns an error when neither sessionKey nor label is provided", async () => {
    const tool = createMainSessionsSendTool();

    const result = await tool.execute("call-missing-target", {
      message: "hi",
      timeoutSeconds: 5,
    });

    expect(result.details).toMatchObject({
      status: "error",
      error: "Either sessionKey or label is required",
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("returns an error when label resolution fails", async () => {
    callGatewayMock.mockRejectedValueOnce(new Error("No session found with label: nope"));
    const tool = createMainSessionsSendTool();

    const result = await tool.execute("call-missing-label", {
      label: "nope",
      message: "hello",
      timeoutSeconds: 5,
    });

    expect(result.details).toMatchObject({
      status: "error",
    });
    expect((result.details as { error?: string } | undefined)?.error ?? "").toContain(
      "No session found with label",
    );
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(callGatewayMock.mock.calls[0]?.[0]).toMatchObject({ method: "sessions.resolve" });
  });

  it("blocks cross-agent sends when tools.agentToAgent.enabled is false", async () => {
    const tool = createMainSessionsSendTool();

    const result = await tool.execute("call1", {
      sessionKey: "agent:other:main",
      message: "hi",
      timeoutSeconds: 0,
    });

    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(callGatewayMock.mock.calls[0]?.[0]).toMatchObject({ method: "sessions.list" });
    expect(result.details).toMatchObject({ status: "forbidden" });
  });

  it("does not reuse a stale assistant reply when no new reply appears", async () => {
    const tool = createMainSessionsSendTool();
    let historyCalls = 0;
    const staleAssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "older reply from a previous run" }],
      timestamp: 20,
    };

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [{ key: MAIN_AGENT_SESSION_KEY, kind: "direct" }],
        };
      }
      if (request.method === "agent") {
        return { runId: "run-stale-send", acceptedAt: 123 };
      }
      if (request.method === "agent.wait") {
        return { runId: "run-stale-send", status: "ok" };
      }
      if (request.method === "chat.history") {
        historyCalls += 1;
        return { messages: [staleAssistantMessage] };
      }
      return {};
    });

    const result = await tool.execute("call-stale-send", {
      sessionKey: MAIN_AGENT_SESSION_KEY,
      message: "ping",
      timeoutSeconds: 1,
    });

    expect(historyCalls).toBe(2);
    expect(result.details).toMatchObject({
      status: "ok",
      reply: undefined,
      sessionKey: MAIN_AGENT_SESSION_KEY,
    });
  });
});
