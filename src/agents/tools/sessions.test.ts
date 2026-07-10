// Sessions tool tests cover list/send helpers, transcript path reporting,
// announce-target resolution, and assistant-visible text sanitization.
import os from "node:os";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelMessagingAdapter } from "../../channels/plugins/types.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import { parseSessionThreadInfo } from "../../config/sessions/thread-info.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { extractAssistantText, sanitizeTextContent } from "./chat-history-text.js";

const callGatewayMock = vi.fn();
const facadeRuntimeMock = vi.hoisted(() => ({
  sessionKeyResolvers: new Map<
    string,
    (params: { kind: "group" | "channel"; rawId: string }) => {
      id: string;
      threadId?: string | null;
      baseConversationId?: string | null;
      parentConversationCandidates?: string[];
    } | null
  >(),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));
vi.mock("../../plugin-sdk/facade-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../plugin-sdk/facade-runtime.js")>(
    "../../plugin-sdk/facade-runtime.js",
  );
  return {
    ...actual,
    tryLoadActivatedBundledPluginPublicSurfaceModuleSync: (params: {
      dirName: string;
      artifactBasename: string;
    }) => {
      if (params.artifactBasename === "session-key-api.js") {
        const resolveSessionConversation = facadeRuntimeMock.sessionKeyResolvers.get(
          params.dirName,
        );
        if (resolveSessionConversation) {
          return { resolveSessionConversation };
        }
      }
      return actual.tryLoadActivatedBundledPluginPublicSurfaceModuleSync(params);
    },
  };
});

type SessionsToolTestConfig = {
  session: { scope: "per-sender"; mainKey: string; agentToAgent?: { maxPingPongTurns: number } };
  tools: {
    agentToAgent: { enabled: boolean };
    sessions?: { visibility: "self" | "tree" | "agent" | "all" };
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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireDetails(result: { details?: unknown }, label = "result details") {
  return requireRecord(result.details, label);
}

function requireSessions(details: Record<string, unknown>) {
  const sessions = details.sessions;
  if (!Array.isArray(sessions)) {
    throw new Error("expected details.sessions");
  }
  return sessions.map((session, index) => requireRecord(session, `session ${index}`));
}

function requireGatewayRequest(index = 0) {
  return requireRecord(callGatewayMock.mock.calls[index]?.[0], `gateway request ${index}`);
}

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
        pluginId: "feishu",
        source: "test",
        plugin: {
          id: "feishu",
          meta: {
            id: "feishu",
            label: "Feishu",
            selectionLabel: "Feishu",
            docsPath: "/channels/feishu",
            blurb: "Feishu test stub.",
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

async function executeFireAndForgetA2AFrom(requesterSessionKey: string) {
  const { runSessionsSendA2AFlow } = await import("./sessions-send-tool.a2a.js");
  vi.mocked(runSessionsSendA2AFlow).mockClear();
  const targetSessionKey = "agent:other:discord:group:ops";
  loadConfigMock.mockReturnValue({
    session: { scope: "per-sender", mainKey: "main", agentToAgent: { maxPingPongTurns: 5 } },
    tools: {
      agentToAgent: { enabled: true },
      sessions: { visibility: "all" },
    },
  });
  callGatewayMock.mockImplementation(async (opts: unknown) => {
    const request = opts as { method?: string };
    if (request.method === "sessions.list") {
      return {
        path: "/tmp/sessions.json",
        sessions: [{ key: targetSessionKey, kind: "group" }],
      };
    }
    if (request.method === "chat.history") {
      return { messages: [] };
    }
    if (request.method === "agent") {
      return { runId: "run-fire-and-forget", acceptedAt: 123 };
    }
    return {};
  });
  const tool = createSessionsSendTool({
    agentSessionKey: requesterSessionKey,
    agentChannel: "telegram",
  });

  const result = await tool.execute("call-fire-and-forget", {
    sessionKey: targetSessionKey,
    message: "ping",
    timeoutSeconds: 0,
  });

  expect(requireDetails(result).status).toBe("accepted");
  const flowParams = vi.mocked(runSessionsSendA2AFlow).mock.calls[0]?.[0];
  if (!flowParams) {
    throw new Error("expected A2A flow");
  }
  return flowParams;
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
  expect(session?.key).toBe("agent:worker:main");
  const transcriptPath = session?.transcriptPath ?? "";
  expect(path.normalize(transcriptPath)).toContain(path.normalize(params.containsPath));
  expect(transcriptPath).toMatch(new RegExp(`${params.sessionId}\\.jsonl$`));
}

async function withStubbedStateDir<T>(
  name: string,
  run: (stateDir: string) => Promise<T>,
): Promise<T> {
  const stateDir = path.join(os.tmpdir(), name);
  return await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => await run(stateDir));
}

describe("sanitizeTextContent", () => {
  it("strips minimax tool call XML and downgraded markers", () => {
    // Session recall should not replay provider/tool markup as assistant text.
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
  facadeRuntimeMock.sessionKeyResolvers.clear();
  loadConfigMock.mockReset();
  loadConfigMock.mockReturnValue({
    session: { scope: "per-sender", mainKey: "main" },
    tools: { agentToAgent: { enabled: false } },
  });
  setActivePluginRegistry(createTestRegistry([]));
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
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
    expect(requireGatewayRequest().method).toBe("sessions.list");
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

  it("hydrates announce delivery from explicit external context over stale webchat session fields", async () => {
    callGatewayMock.mockResolvedValueOnce({
      sessions: [
        {
          key: "agent:main:feishu:direct:ou_user",
          channel: "webchat",
          lastChannel: "webchat",
          lastTo: "session:dashboard",
          route: {
            channel: "webchat",
            target: { to: "session:dashboard" },
          },
          deliveryContext: {
            channel: "feishu",
            to: "user:ou_user",
          },
          origin: {
            provider: "feishu",
            accountId: "work",
            threadId: "thread-77",
          },
        },
      ],
    });

    const target = await resolveAnnounceTarget({
      sessionKey: "agent:main:feishu:direct:ou_user",
      displayKey: "agent:main:feishu:direct:ou_user",
    });
    expect(target).toEqual({
      channel: "feishu",
      to: "user:ou_user",
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
    callGatewayMock.mockImplementation(
      (request: { method?: string; params?: { spawnedBy?: string } }) => {
        if (request.method === "sessions.list" && request.params?.spawnedBy) {
          return Promise.resolve({ path: "/tmp/sessions.json", sessions: [] });
        }
        return Promise.resolve({
          path: "/tmp/sessions.json",
          sessions: [
            { key: "agent:main:main", kind: "direct" },
            { key: "agent:other:main", kind: "direct" },
          ],
        });
      },
    );
  });

  it("filters out other agents when tools.agentToAgent.enabled is false", async () => {
    const tool = createMainSessionsListTool();
    const result = await tool.execute("call1", {});
    const details = requireDetails(result);
    expect(details.count).toBe(1);
    expect(requireSessions(details)[0]?.key).toBe(MAIN_AGENT_SESSION_KEY);
  });

  it("keeps requester-owned cross-agent rows with tree visibility without a spawned lookup", async () => {
    loadConfigMock.mockReturnValue({
      session: { scope: "per-sender", mainKey: "main" },
      tools: {
        agentToAgent: { enabled: false },
        sessions: { visibility: "tree" },
      },
    });
    callGatewayMock.mockResolvedValueOnce({
      path: "/tmp/sessions.json",
      sessions: [
        {
          key: "agent:codex:acp:child-1",
          kind: "direct",
          spawnedBy: MAIN_AGENT_SESSION_KEY,
        },
      ],
    });

    const result = await createMainSessionsListTool().execute("call1", {});

    const details = requireDetails(result);
    expect(details.count).toBe(1);
    const session = requireSessions(details)[0];
    expect(session?.key).toBe("agent:codex:acp:child-1");
    expect(session?.spawnedBy).toBe(MAIN_AGENT_SESSION_KEY);
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("keeps requester-owned cross-agent rows with all visibility when a2a is disabled", async () => {
    loadConfigMock.mockReturnValue({
      session: { scope: "per-sender", mainKey: "main" },
      tools: {
        agentToAgent: { enabled: false },
        sessions: { visibility: "all" },
      },
    });
    callGatewayMock.mockResolvedValueOnce({
      path: "/tmp/sessions.json",
      sessions: [
        {
          key: "agent:codex:acp:child-1",
          kind: "direct",
          parentSessionKey: MAIN_AGENT_SESSION_KEY,
        },
      ],
    });

    const result = await createMainSessionsListTool().execute("call1", {});

    const details = requireDetails(result);
    expect(details.count).toBe(1);
    expect(details.visibility).toBeUndefined();
    const session = requireSessions(details)[0];
    expect(session?.key).toBe("agent:codex:acp:child-1");
    expect(session?.parentSessionKey).toBe(MAIN_AGENT_SESSION_KEY);
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("includes visibility metadata when session visibility is restricted", async () => {
    loadConfigMock.mockReturnValue({
      session: { scope: "per-sender", mainKey: "main" },
      tools: {
        agentToAgent: { enabled: true },
        sessions: { visibility: "tree" },
      },
    });

    const result = await createMainSessionsListTool().execute("call1", {});

    const details = requireDetails(result);
    expect(details.count).toBe(1);
    expect(details.visibility).toMatchObject({
      mode: "tree",
      restricted: true,
      warning:
        "Session visibility is restricted (effective tools.sessions.visibility=tree). Results may omit sessions outside the current scope. The count field reflects only sessions within the current scope.",
    });
  });

  it("keeps literal current keys for message previews", async () => {
    callGatewayMock.mockReset();
    callGatewayMock
      .mockResolvedValueOnce({
        path: "/tmp/sessions.json",
        sessions: [{ key: "current", kind: "direct" }],
      })
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

    const details = requireDetails(result);
    const session = requireSessions(details)[0];
    expect(session?.key).toBe("agent:main:discord:group:ops");
    expect(session?.channel).toBe("discord");
  });
});

describe("sessions_send gating", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  it("returns an error when neither sessionKey nor label is provided", async () => {
    const tool = createMainSessionsSendTool();

    const result = await tool.execute("call-missing-target", {
      message: "hi",
      timeoutSeconds: 5,
    });

    const details = requireDetails(result);
    expect(details.status).toBe("error");
    expect(details.error).toBe("Either sessionKey or label is required");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it.each([1.5, -1, "1sec"])("rejects invalid timeoutSeconds value %s", async (timeoutSeconds) => {
    const tool = createMainSessionsSendTool();

    await expect(
      tool.execute("call-invalid-timeout", {
        sessionKey: MAIN_AGENT_SESSION_KEY,
        message: "hi",
        timeoutSeconds,
      }),
    ).rejects.toThrow("timeoutSeconds must be a non-negative integer");
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

    const details = requireDetails(result);
    expect(details.status).toBe("error");
    expect((result.details as { error?: string } | undefined)?.error ?? "").toContain(
      "No session found with label",
    );
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(requireGatewayRequest().method).toBe("sessions.resolve");
  });

  it("prefers sessionKey over a redundant label", async () => {
    const tool = createMainSessionsSendTool();

    const result = await tool.execute("call-session-key-label", {
      sessionKey: MAIN_AGENT_SESSION_KEY,
      label: "stale-label",
      message: "hi",
      timeoutSeconds: 0,
    });

    const details = requireDetails(result);
    expect(details).toMatchObject({
      status: "accepted",
      sessionKey: MAIN_AGENT_SESSION_KEY,
    });
    expect(callGatewayMock.mock.calls[0]?.[0]).toMatchObject({ method: "sessions.list" });
    expect(callGatewayMock.mock.calls).toContainEqual([
      expect.objectContaining({
        method: "agent",
        params: expect.objectContaining({ sessionKey: MAIN_AGENT_SESSION_KEY }),
      }),
    ]);
    expect(callGatewayMock.mock.calls).not.toContainEqual([
      expect.objectContaining({
        method: "sessions.resolve",
        params: expect.objectContaining({ label: "stale-label" }),
      }),
    ]);
  });

  it("does not disclose a resolved session key when sessionId access is denied", async () => {
    const tool = createSessionsSendTool({
      agentSessionKey: MAIN_AGENT_SESSION_KEY,
      callGateway: callGatewayMock,
      config: {
        session: { scope: "per-sender", mainKey: "main" },
        tools: {
          agentToAgent: { enabled: false },
          sessions: { visibility: "tree" },
        },
      } as never,
    });
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "sessions.resolve") {
        if (request.params?.key === "session-id-only") {
          throw new Error("not a session key");
        }
        return { key: "agent:other:main" };
      }
      if (request.method === "sessions.list") {
        if (request.params?.spawnedBy === MAIN_AGENT_SESSION_KEY) {
          return {
            path: "/tmp/sessions.json",
            sessions: [],
          };
        }
        return {
          path: "/tmp/sessions.json",
          sessions: [{ key: "agent:other:main", kind: "direct" }],
        };
      }
      return {};
    });

    const result = await tool.execute("call-denied-session-id", {
      sessionKey: "session-id-only",
      message: "hi",
      timeoutSeconds: 0,
    });

    const details = requireDetails(result);
    expect(details.status).toBe("forbidden");
    expect(details.sessionKey).toBe("session-id-only");
  });

  it("blocks cross-agent sends when tools.agentToAgent.enabled is false", async () => {
    const tool = createMainSessionsSendTool();

    const result = await tool.execute("call1", {
      sessionKey: "agent:other:main",
      message: "hi",
      timeoutSeconds: 0,
    });

    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(requireGatewayRequest().method).toBe("sessions.list");
    expect(requireDetails(result).status).toBe("forbidden");
  });

  it("rejects direct thread session targets before dispatching an agent run", async () => {
    loadConfigMock.mockReturnValue({
      session: { scope: "per-sender", mainKey: "main" },
      tools: {
        agentToAgent: { enabled: false },
        sessions: { visibility: "all" },
      },
    });
    const threadSessionKey = "agent:main:slack:channel:C123:thread:1710000000.000100";
    const tool = createMainSessionsSendTool();

    const result = await tool.execute("call-thread-target", {
      sessionKey: threadSessionKey,
      message: "hi",
      timeoutSeconds: 0,
    });

    const details = requireDetails(result);
    expect(details.status).toBe("error");
    expect(details.sessionKey).toBe(threadSessionKey);
    expect((result.details as { error?: string } | undefined)?.error ?? "").toContain(
      "cannot target a thread session",
    );
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("rejects Telegram topic session targets before dispatching an agent run", async () => {
    loadConfigMock.mockReturnValue({
      session: { scope: "per-sender", mainKey: "main" },
      tools: {
        agentToAgent: { enabled: false },
        sessions: { visibility: "all" },
      },
    });
    const topicSessionKey = "agent:main:telegram:group:-100123:topic:77";
    facadeRuntimeMock.sessionKeyResolvers.set("telegram", ({ kind, rawId }) => {
      if (kind !== "group") {
        return null;
      }
      const [id, threadId] = rawId.split(":topic:");
      return threadId ? { id, threadId, baseConversationId: id } : null;
    });
    setRuntimeConfigSnapshot({ plugins: { entries: { telegram: { enabled: true } } } });
    expect(parseSessionThreadInfo(topicSessionKey).threadId).toBe("77");
    const tool = createMainSessionsSendTool();

    const result = await tool.execute("call-telegram-topic-target", {
      sessionKey: topicSessionKey,
      message: "hi",
      timeoutSeconds: 0,
    });

    const details = requireDetails(result);
    expect(details.status).toBe("error");
    expect(details.sessionKey).toBe(topicSessionKey);
    expect((result.details as { error?: string } | undefined)?.error ?? "").toContain(
      "cannot target a thread session",
    );
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("rejects label targets that resolve to canonical thread sessions", async () => {
    loadConfigMock.mockReturnValue({
      session: { scope: "per-sender", mainKey: "main" },
      tools: {
        agentToAgent: { enabled: false },
        sessions: { visibility: "all" },
      },
    });
    const threadSessionKey = "agent:main:discord:channel:123456:thread:987654";
    callGatewayMock.mockResolvedValueOnce({ key: threadSessionKey });
    const tool = createMainSessionsSendTool();

    const result = await tool.execute("call-thread-label", {
      label: "active thread",
      message: "hi",
      timeoutSeconds: 0,
    });

    const details = requireDetails(result);
    expect(details.status).toBe("error");
    expect(details.sessionKey).toBe(threadSessionKey);
    expect((result.details as { error?: string } | undefined)?.error ?? "").toContain(
      "cannot target a thread session",
    );
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(requireGatewayRequest().method).toBe("sessions.resolve");
  });

  it("does not disclose a resolved thread session key from a sessionId target", async () => {
    loadConfigMock.mockReturnValue({
      session: { scope: "per-sender", mainKey: "main" },
      tools: {
        agentToAgent: { enabled: false },
        sessions: { visibility: "all" },
      },
    });
    const threadSessionKey = "agent:other:discord:channel:123456:thread:987654";
    callGatewayMock.mockResolvedValueOnce({ key: threadSessionKey });
    const tool = createMainSessionsSendTool();

    const result = await tool.execute("call-thread-session-id", {
      sessionKey: "thread-session-id",
      message: "hi",
      timeoutSeconds: 0,
    });

    const details = requireDetails(result);
    expect(details.status).toBe("error");
    expect(details.sessionKey).toBe("thread-session-id");
    expect((result.details as { error?: string } | undefined)?.error ?? "").toContain(
      "cannot target a thread session",
    );
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(requireGatewayRequest().method).toBe("sessions.resolve");
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
    const details = requireDetails(result);
    expect(details.status).toBe("ok");
    expect(details.reply).toBeUndefined();
    expect(details.sessionKey).toBe(MAIN_AGENT_SESSION_KEY);
  });

  it("passes a baseline into fire-and-forget same-session A2A delivery", async () => {
    const { runSessionsSendA2AFlow } = await import("./sessions-send-tool.a2a.js");
    vi.mocked(runSessionsSendA2AFlow).mockClear();
    const tool = createMainSessionsSendTool();
    const staleAssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "older reply from a previous run" }],
      timestamp: 20,
    };

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [{ key: MAIN_AGENT_SESSION_KEY, kind: "direct" }],
        };
      }
      if (request.method === "chat.history") {
        return { messages: [staleAssistantMessage] };
      }
      if (request.method === "agent") {
        return { runId: "run-fire-and-forget", acceptedAt: 123 };
      }
      return {};
    });

    const result = await tool.execute("call-fire-and-forget-same-session", {
      sessionKey: MAIN_AGENT_SESSION_KEY,
      message: "ping",
      timeoutSeconds: 0,
    });

    const details = requireDetails(result);
    expect(details.status).toBe("accepted");
    expect(details.sessionKey).toBe(MAIN_AGENT_SESSION_KEY);
    const flowParams = vi.mocked(runSessionsSendA2AFlow).mock.calls[0]?.[0];
    expect(flowParams?.waitRunId).toBe("run-fire-and-forget");
    expect(flowParams?.baseline?.text).toBe("older reply from a previous run");
  });

  it("canonicalizes aliased requester keys for same-session A2A delivery", async () => {
    const { runSessionsSendA2AFlow } = await import("./sessions-send-tool.a2a.js");
    vi.mocked(runSessionsSendA2AFlow).mockClear();
    const tool = createSessionsSendTool({
      agentSessionKey: "main",
      agentChannel: MAIN_AGENT_CHANNEL,
      config: {
        session: { scope: "per-sender", mainKey: MAIN_AGENT_SESSION_KEY },
        tools: { agentToAgent: { enabled: false } },
      } as never,
    });
    const staleAssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "older reply from a previous run" }],
      timestamp: 20,
    };

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [{ key: MAIN_AGENT_SESSION_KEY, kind: "direct" }],
        };
      }
      if (request.method === "chat.history") {
        return { messages: [staleAssistantMessage] };
      }
      if (request.method === "agent") {
        return { runId: "run-alias-fire-and-forget", acceptedAt: 123 };
      }
      return {};
    });

    const result = await tool.execute("call-aliased-fire-and-forget-same-session", {
      sessionKey: MAIN_AGENT_SESSION_KEY,
      message: "ping",
      timeoutSeconds: 0,
    });

    const details = requireDetails(result);
    expect(details.status).toBe("accepted");
    expect(details.sessionKey).toBe("main");
    const flowParams = vi.mocked(runSessionsSendA2AFlow).mock.calls[0]?.[0];
    expect(flowParams?.requesterSessionKey).toBe(MAIN_AGENT_SESSION_KEY);
    expect(flowParams?.targetSessionKey).toBe(MAIN_AGENT_SESSION_KEY);
    expect(flowParams?.baseline?.text).toBe("older reply from a previous run");
  });

  it("accepts fire-and-forget same-session sends when baseline history is unavailable", async () => {
    const { runSessionsSendA2AFlow } = await import("./sessions-send-tool.a2a.js");
    vi.mocked(runSessionsSendA2AFlow).mockClear();
    const tool = createMainSessionsSendTool();

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [{ key: MAIN_AGENT_SESSION_KEY, kind: "direct" }],
        };
      }
      if (request.method === "chat.history") {
        throw new Error("history unavailable");
      }
      if (request.method === "agent") {
        return { runId: "run-fire-and-forget", acceptedAt: 123 };
      }
      return {};
    });

    const result = await tool.execute("call-fire-and-forget-history-fail", {
      sessionKey: MAIN_AGENT_SESSION_KEY,
      message: "ping",
      timeoutSeconds: 0,
    });

    const details = requireDetails(result);
    expect(details.status).toBe("accepted");
    expect(details.sessionKey).toBe(MAIN_AGENT_SESSION_KEY);
    const flowParams = vi.mocked(runSessionsSendA2AFlow).mock.calls[0]?.[0];
    expect(flowParams?.waitRunId).toBe("run-fire-and-forget");
    expect(flowParams?.baseline).toBeUndefined();
  });

  it.each([
    {
      label: "canonical cron run",
      requesterSessionKey: "agent:main:cron:job:run:abc",
      expected: 0,
    },
    {
      label: "normal requester",
      requesterSessionKey: "agent:main:telegram:direct:user",
      expected: 5,
    },
    {
      label: "non-canonical cron-like requester",
      requesterSessionKey: "agent:main:slack:cron:job:run:uuid",
      expected: 5,
    },
  ] as const)(
    "uses the expected ping-pong turns for a $label",
    async ({ requesterSessionKey, expected }) => {
      const flowParams = await executeFireAndForgetA2AFrom(requesterSessionKey);

      expect(flowParams.maxPingPongTurns).toBe(expected);
      expect(flowParams.requesterSessionKey).toBe(requesterSessionKey);
    },
  );

  it("caps oversized timeoutSeconds before waiting for the target run", async () => {
    const tool = createMainSessionsSendTool();
    const waitTimeouts: unknown[] = [];

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; timeoutMs?: unknown };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [{ key: MAIN_AGENT_SESSION_KEY, kind: "direct" }],
        };
      }
      if (request.method === "agent") {
        return { runId: "run-huge-timeout", acceptedAt: 123 };
      }
      if (request.method === "agent.wait") {
        waitTimeouts.push(request.timeoutMs);
        return { runId: "run-huge-timeout", status: "ok" };
      }
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      return {};
    });

    const result = await tool.execute("call-huge-timeout", {
      sessionKey: MAIN_AGENT_SESSION_KEY,
      message: "ping",
      timeoutSeconds: Number.MAX_SAFE_INTEGER,
    });

    expect(requireDetails(result).status).toBe("ok");
    expect(waitTimeouts).toEqual([MAX_TIMER_TIMEOUT_MS]);
  });
});
