import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
// Sessions tool tests cover list/send helpers, announce-target resolution,
// and assistant-visible text sanitization.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelMessagingAdapter } from "../../channels/plugins/types.public.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import { retainLegacyDefaultAgentId } from "../../config/legacy.default-agent-owner.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { parseSessionThreadInfo } from "../../config/sessions/thread-info.js";
import {
  getOwnedSessionTranscriptWriterFence,
  withOwnedSessionTranscriptWrites,
} from "../../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { extractStoredAssistantText } from "./chat-history-text.js";

const callGatewayMock = vi.fn();
const inProcessGatewayRequestMock = vi.fn((opts: unknown) => callGatewayMock(opts));
const inProcessCreationMock = vi.fn(
  async (..._args: [unknown, unknown, unknown]): Promise<unknown> => ({}),
);
const recordParticipantMock = vi.fn();
// Default false mirrors running outside a gateway process; the trusted-creation
// regression test flips it on and restores it.
let inProcessGatewayContextAvailable = false;
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

vi.mock("../../gateway/call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../gateway/call.js")>();
  return {
    ...actual,
    callGateway: (opts: unknown) => callGatewayMock(opts),
  };
});
vi.mock("./in-process-gateway.js", () => ({
  callAgentToolGatewayRequest: (opts: unknown) => inProcessGatewayRequestMock(opts),
  callInProcessGatewayToolWithCreation: (method: unknown, params: unknown, creation: unknown) =>
    inProcessCreationMock(method, params, creation),
  hasInProcessGatewayToolContext: () => inProcessGatewayContextAvailable,
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
  agents?: OpenClawConfig["agents"];
  bindings?: OpenClawConfig["bindings"];
  session: {
    scope: "per-sender";
    mainKey: string;
    dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
    agentToAgent?: { maxPingPongTurns: number };
  };
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
vi.mock("../../sessions/session-participant-recording.js", () => ({
  recordSessionParticipantBestEffort: (...args: unknown[]) => recordParticipantMock(...args),
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

const requireRecord = createRequireRecord("record", "expected-label");

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

async function executeFireAndForgetA2AFrom(
  requesterSessionKey: string,
  options?: {
    mainKey?: string;
    dmScope?: NonNullable<SessionsToolTestConfig["session"]["dmScope"]>;
    bindingDmScope?: NonNullable<SessionsToolTestConfig["session"]["dmScope"]>;
    defaultBindingDmScope?: NonNullable<SessionsToolTestConfig["session"]["dmScope"]>;
    bindingAccountId?: string;
    bindingAgentId?: string;
    bindingPeerId?: string;
    bindingTeamId?: string;
  },
) {
  const { runSessionsSendA2AFlow } = await import("./sessions-send-tool.a2a.js");
  vi.mocked(runSessionsSendA2AFlow).mockClear();
  const targetSessionKey = "agent:other:discord:group:ops";
  loadConfigMock.mockReturnValue({
    ...(options?.bindingDmScope ||
    options?.defaultBindingDmScope ||
    options?.bindingAccountId ||
    options?.bindingAgentId
      ? {
          ...(options.bindingAgentId
            ? {
                agents: {
                  list: [{ id: "main", default: true }, { id: options.bindingAgentId }],
                },
              }
            : {}),
          bindings: [
            ...(options.defaultBindingDmScope
              ? [
                  {
                    type: "route" as const,
                    agentId: "main",
                    match: {
                      channel: requesterSessionKey.includes(":feishu:") ? "feishu" : "telegram",
                      accountId: "default",
                      peer: { kind: "direct" as const, id: "peer-1" },
                    },
                    session: { dmScope: options.defaultBindingDmScope },
                  },
                ]
              : []),
            {
              type: "route",
              agentId: options.bindingAgentId ?? "main",
              match: {
                channel: requesterSessionKey.includes(":feishu:") ? "feishu" : "telegram",
                accountId: options.bindingAccountId ?? "default",
                peer: { kind: "direct", id: options.bindingPeerId ?? "peer-1" },
                ...(options.bindingTeamId ? { teamId: options.bindingTeamId } : {}),
              },
              ...(options.bindingDmScope ? { session: { dmScope: options.bindingDmScope } } : {}),
            },
          ],
        }
      : {}),
    session: {
      scope: "per-sender",
      mainKey: options?.mainKey ?? "main",
      ...(options?.dmScope ? { dmScope: options.dmScope } : {}),
    },
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
  expect(recordParticipantMock).toHaveBeenCalledWith(
    expect.objectContaining({
      identity: { type: "agent", id: "main" },
      agentId: "other",
      sessionKey: targetSessionKey,
    }),
  );
  const flowParams = vi.mocked(runSessionsSendA2AFlow).mock.calls[0]?.[0];
  if (!flowParams) {
    throw new Error("expected A2A flow");
  }
  return flowParams;
}

describe("extractStoredAssistantText sanitization", () => {
  it("strips minimax tool call XML and downgraded markers", () => {
    // Session recall should not replay provider/tool markup as assistant text.
    const input =
      'Hello <invoke name="tool">payload</invoke></minimax:tool_call> ' +
      "[Tool Call: foo (ID: 1)] world";
    const result = extractStoredAssistantText({ role: "assistant", content: input })?.trim();
    expect(result).toBe("Hello  world");
    expect(result).not.toContain("invoke");
    expect(result).not.toContain("Tool Call");
  });

  it("strips tool_result XML via the shared assistant-visible sanitizer", () => {
    const input = 'Prefix\n<tool_result>{"output":"hidden"}</tool_result>\nSuffix';
    const result = extractStoredAssistantText({ role: "assistant", content: input })?.trim();
    expect(result).toBe("Prefix\n\nSuffix");
    expect(result).not.toContain("tool_result");
  });

  it("strips thinking tags", () => {
    const input = "Before <think>secret</think> after";
    const result = extractStoredAssistantText({ role: "assistant", content: input })?.trim();
    expect(result).toBe("Before  after");
  });
});

beforeEach(() => {
  recordParticipantMock.mockClear();
  facadeRuntimeMock.sessionKeyResolvers.clear();
  inProcessGatewayRequestMock.mockReset();
  inProcessGatewayRequestMock.mockImplementation((opts: unknown) => callGatewayMock(opts));
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

it("fails closed for cross-agent and resolution-derived bare keys", async () => {
  const bareKey = "b0d79b63-0f73-4bc9-a6b5-6d8e20f42c3c";
  const config = {
    agents: { ownership: "explicit" as const, entries: { main: {}, other: {} } },
    tools: { agentToAgent: { enabled: false }, sessions: { visibility: "all" as const } },
  };
  const send = async (retained: boolean) =>
    requireDetails(
      await createSessionsSendTool({
        agentId: "main",
        agentSessionKey: MAIN_AGENT_SESSION_KEY,
        config: retained ? retainLegacyDefaultAgentId(config, "main") : config,
      }).execute("authorization", {
        sessionKey: bareKey,
        message: "status?",
        timeoutSeconds: 0,
      }),
    );
  callGatewayMock
    .mockReset()
    .mockImplementation(async (request: { method?: string }) =>
      request.method === "sessions.resolve" ? { key: "incident-42", agentId: "other" } : {},
    );
  expect(await send(false)).toMatchObject({
    status: "forbidden",
    error: expect.stringContaining("Agent-to-agent messaging is disabled"),
  });
  callGatewayMock
    .mockReset()
    .mockImplementation(async (request: { method?: string; params?: Record<string, string> }) => {
      if (request.method !== "sessions.resolve") {
        return {};
      }
      if (request.params?.key) {
        throw new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: `No session found: ${request.params.key}`,
        });
      }
      return request.params?.sessionId ? { key: "incident-42" } : {};
    });
  expect(await send(true)).toMatchObject({
    status: "forbidden",
    error: expect.stringContaining("Upgrade the gateway"),
  });
});

it("authorizes literal sentinels against their persisted fixed-store owner", async () => {
  const config = {
    session: { store: "/tmp/shared-sessions.sqlite" },
    agents: {
      ownership: "explicit" as const,
      defaults: { sessionStore: { agentId: "ops" } },
      entries: { ops: {}, research: {} },
    },
    tools: { agentToAgent: { enabled: false }, sessions: { visibility: "all" as const } },
  };
  const createTool = (ownerAgentId: string) =>
    createSessionsSendTool({
      agentId: "research",
      agentSessionKey: "agent:research:main",
      config: {
        ...config,
        agents: {
          ...config.agents,
          defaults: { sessionStore: { agentId: ownerAgentId } },
        },
      },
    });

  const denied = requireDetails(
    await createTool("ops").execute("foreign-global", {
      sessionKey: "global",
      message: "status?",
      timeoutSeconds: 0,
    }),
  );
  expect(denied).toMatchObject({
    status: "forbidden",
    error: expect.stringContaining("Agent-to-agent messaging is disabled"),
  });
  expect(callGatewayMock.mock.calls).not.toContainEqual([
    expect.objectContaining({ method: "agent" }),
  ]);

  callGatewayMock.mockReset().mockResolvedValue({ runId: "self-global", acceptedAt: 1 });
  const allowed = requireDetails(
    await createTool("research").execute("self-global", {
      sessionKey: "global",
      message: "note",
      timeoutSeconds: 0,
    }),
  );
  expect(allowed.status).toBe("accepted");
});

it("authorizes a custom main alias against its persisted fixed-store owner", async () => {
  const config = {
    session: { mainKey: "work", store: "/tmp/custom-main-shared.sqlite" },
    agents: {
      ownership: "explicit" as const,
      defaults: { sessionStore: { agentId: "ops" } },
      entries: { ops: {}, research: {} },
    },
    tools: { agentToAgent: { enabled: false }, sessions: { visibility: "all" as const } },
  };
  const createTool = (ownerAgentId: string) =>
    createSessionsSendTool({
      agentId: "research",
      agentSessionKey: "agent:research:work",
      config: {
        ...config,
        agents: {
          ...config.agents,
          defaults: { sessionStore: { agentId: ownerAgentId } },
        },
      },
    });

  callGatewayMock.mockImplementation(async (request: { method?: string }) =>
    request.method === "sessions.resolve" ? { key: "work", agentId: "ops" } : {},
  );
  expect(
    requireDetails(
      await createTool("ops").execute("foreign-work", {
        sessionKey: "work",
        message: "status?",
        timeoutSeconds: 0,
      }),
    ),
  ).toMatchObject({
    status: "forbidden",
    error: expect.stringContaining("Agent-to-agent messaging is disabled"),
  });

  callGatewayMock
    .mockReset()
    .mockImplementation(async (request: { method?: string }) =>
      request.method === "sessions.resolve"
        ? { key: "work", agentId: "research" }
        : { runId: "self-work", acceptedAt: 1 },
    );
  expect(
    requireDetails(
      await createTool("research").execute("self-work", {
        sessionKey: "work",
        message: "note",
        timeoutSeconds: 0,
      }),
    ).status,
  ).toBe("accepted");
});

it("authorizes an arbitrary bare key against its persisted fixed-store owner", async () => {
  const config = {
    session: { store: "/tmp/arbitrary-shared.sqlite" },
    agents: {
      ownership: "explicit" as const,
      defaults: { sessionStore: { agentId: "ops" } },
      entries: { ops: {}, research: {} },
    },
    tools: { agentToAgent: { enabled: false }, sessions: { visibility: "all" as const } },
  };
  callGatewayMock
    .mockReset()
    .mockImplementation(async (request: { method?: string }) =>
      request.method === "sessions.resolve"
        ? { key: "incident-42" }
        : { runId: "arbitrary-bare", acceptedAt: 1 },
    );

  const result = requireDetails(
    await createSessionsSendTool({
      agentId: "research",
      agentSessionKey: "agent:research:main",
      config,
    }).execute("foreign-arbitrary", {
      sessionKey: "incident-42",
      message: "status?",
      timeoutSeconds: 0,
    }),
  );

  expect(result).toMatchObject({
    status: "forbidden",
    error: expect.stringContaining("Agent-to-agent messaging is disabled"),
  });
  expect(callGatewayMock.mock.calls).not.toContainEqual([
    expect.objectContaining({ method: "agent" }),
  ]);
});

describe("extractStoredAssistantText", () => {
  it("sanitizes blocks without injecting newlines", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "Hi " },
        { type: "text", text: "<think>secret</think>there" },
      ],
    };
    expect(extractStoredAssistantText(message)).toBe("Hi there");
  });

  it("rewrites error-ish assistant text only when the transcript marks it as an error", () => {
    const message = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "500 Internal Server Error",
      content: [{ type: "text", text: "500 Internal Server Error" }],
    };
    expect(extractStoredAssistantText(message)).toBe("HTTP 500: Internal Server Error");
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
    expect(extractStoredAssistantText(message)).toBe(
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
    expect(extractStoredAssistantText(message)).toBe("Handle payment required errors in your API.");
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
    expect(extractStoredAssistantText(message)).toBe("Done.");
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
      callGateway: callGatewayMock,
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
      callGateway: callGatewayMock,
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

  it("hydrates provider and accountId from the canonical delivery projection", async () => {
    callGatewayMock.mockResolvedValueOnce({
      sessions: [
        {
          key: "agent:main:whatsapp:group:123@g.us",
          deliveryContext: {
            channel: "whatsapp",
            to: "123@g.us",
            accountId: "work",
            threadId: 271,
          },
        },
      ],
    });

    const target = await resolveAnnounceTarget({
      sessionKey: "agent:main:whatsapp:group:123@g.us",
      displayKey: "agent:main:whatsapp:group:123@g.us",
      callGateway: callGatewayMock,
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
      callGateway: callGatewayMock,
    });
    expect(target).toEqual({
      channel: "whatsapp",
      to: "123@g.us",
      accountId: "work",
      threadId: "thread-77",
    });
  });

  it("hydrates announce delivery from the canonical external projection", async () => {
    callGatewayMock.mockResolvedValueOnce({
      sessions: [
        {
          key: "agent:main:feishu:direct:ou_user",
          deliveryContext: {
            channel: "feishu",
            to: "user:ou_user",
            accountId: "work",
            threadId: "thread-77",
          },
        },
      ],
    });

    const target = await resolveAnnounceTarget({
      sessionKey: "agent:main:feishu:direct:ou_user",
      displayKey: "agent:main:feishu:direct:ou_user",
      callGateway: callGatewayMock,
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
      callGateway: callGatewayMock,
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
    expect(session?.parentSessionKey).toBe(MAIN_AGENT_SESSION_KEY);
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
        "Session visibility is restricted (effective tools.sessions.visibility=tree: current session + own spawn subtree; the main session sees all sessions of its agent). Sessions outside that scope are omitted from results and count.",
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
      params: { sessionKey: "current", agentId: "main", limit: 1 },
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

  it("rejects a whitespace-only message body before forwarding it", async () => {
    // The message is read untrimmed (to preserve substantive leading whitespace),
    // so a whitespace-only body must be rejected explicitly rather than forwarded.
    const tool = createMainSessionsSendTool();

    await expect(
      tool.execute("call-blank-message", {
        sessionKey: MAIN_AGENT_SESSION_KEY,
        message: "    ",
        timeoutSeconds: 5,
      }),
    ).rejects.toThrow(/message required/i);
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

  it("rejects an unrepresentable agent id before resolving a main session", async () => {
    const tool = createMainSessionsSendTool();

    const result = await tool.execute("call-invalid-agent", {
      agentId: "агент✨",
      message: "hello",
      timeoutSeconds: 5,
    });

    expect(requireDetails(result)).toMatchObject({
      status: "error",
      error: 'Agent "агент✨" not found. Run openclaw agents list to see configured agents.',
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("conceals missing explicit keys denied by session visibility", async () => {
    callGatewayMock.mockRejectedValueOnce(new Error("No session found: agent:main:missing"));
    const tool = createSessionsSendTool({
      agentSessionKey: MAIN_AGENT_SESSION_KEY,
      callGateway: callGatewayMock,
      config: {
        session: { scope: "per-sender", mainKey: "main" },
        tools: {
          agentToAgent: { enabled: false },
          sessions: { visibility: "self" },
        },
      } as never,
    });

    const result = await tool.execute("call-hidden-missing-key", {
      sessionKey: "agent:main:missing",
      message: "hi",
      timeoutSeconds: 0,
    });

    expect(requireDetails(result).status).toBe("forbidden");
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

  it("keeps an exact-incarnation send synchronous to its scoped lifecycle grant", async () => {
    await withTestDir({ prefix: "openclaw-exact-session-send-" }, async (dir) => {
      const { runSessionsSendA2AFlow } = await import("./sessions-send-tool.a2a.js");
      vi.mocked(runSessionsSendA2AFlow).mockClear();
      const storePath = path.join(dir, "sessions.json");
      const targetSessionKey = "agent:main:dashboard:child";
      const targetSessionId = "child-incarnation";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: targetSessionKey, storePath },
        {
          sessionId: targetSessionId,
          updatedAt: 1,
          parentSessionKey: MAIN_AGENT_SESSION_KEY,
        },
      );
      callGatewayMock.mockImplementation(async (opts: unknown) => {
        const request = opts as { method?: string };
        if (request.method === "sessions.list") {
          return {
            path: storePath,
            sessions: [{ key: targetSessionKey, kind: "direct" }],
          };
        }
        if (request.method === "agent") {
          return { runId: "run-exact-send", acceptedAt: 123 };
        }
        return {};
      });
      const tool = createSessionsSendTool({
        agentSessionKey: MAIN_AGENT_SESSION_KEY,
        expectedTargetSessionId: targetSessionId,
        idempotencyKey: "worker-session-send:stable-operation",
        callGateway: callGatewayMock,
        config: {
          session: { scope: "per-sender", mainKey: "main", store: storePath },
          tools: {
            agentToAgent: { enabled: true },
            sessions: { visibility: "all" },
          },
        } as never,
      });

      const result = await tool.execute("call-exact-send", {
        sessionKey: targetSessionKey,
        message: "ping",
        timeoutSeconds: 0,
        watch: true,
      });

      expect(requireDetails(result)).toMatchObject({
        status: "accepted",
        sessionKey: targetSessionKey,
        delivery: { status: "skipped", mode: "announce" },
        watched: false,
      });
      expect(runSessionsSendA2AFlow).not.toHaveBeenCalled();
      expect(callGatewayMock).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "agent",
          params: expect.objectContaining({
            idempotencyKey: "worker-session-send:stable-operation",
          }),
        }),
      );
    });
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
          throw new GatewayClientRequestError({
            code: "INVALID_REQUEST",
            message: "No session found: session-id-only",
          });
        }
        if (request.params?.spawnedBy === MAIN_AGENT_SESSION_KEY) {
          return {};
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
    expect(requireGatewayRequest().method).toBe("sessions.resolve");
    expect(requireDetails(result).status).toBe("forbidden");
  });

  it("classifies a failed spawned-lookup as lookup-failed for sandboxed sends", async () => {
    loadConfigMock.mockReturnValue({
      session: { scope: "per-sender", mainKey: "main" },
      agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
      tools: { agentToAgent: { enabled: false }, sessions: { visibility: "all" } },
    });
    callGatewayMock.mockImplementation(async () => {
      // A retryable request-level failure preserves the PR's evidence semantics
      // (transient store read error) while exercising the retryable
      // classification path (review P1: classify before prescribing retry).
      throw new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "simulated transient store read error (evidence)",
        retryable: true,
      });
    });
    const tool = createSessionsSendTool({
      agentSessionKey: MAIN_AGENT_SESSION_KEY,
      agentChannel: MAIN_AGENT_CHANNEL,
      sandboxed: true,
    });

    const result = await tool.execute("call-lookup-failed", {
      sessionKey: "agent:main:subagent:worker-1",
      message: "hi",
      timeoutSeconds: 0,
    });

    // sessions_send hits the resolution preflight before the direct guard; the
    // failed lookup must surface the same retryable classification, not the
    // generic sandboxed-session denial.
    const details = requireDetails(result);
    expect(details.status).toBe("forbidden");
    expect(String(details.error)).toBe(
      "Session send denied because spawned-session ownership lookup failed (transient); retry once, then ask the operator to inspect OpenClaw logs.",
    );
    expect(String(details.error)).not.toContain(
      "Session not visible from this sandboxed agent session",
    );
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
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(requireGatewayRequest().method).toBe("sessions.resolve");
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
      const [rawConversationId, threadId] = rawId.split(":topic:");
      if (!threadId) {
        return null;
      }
      const id = expectDefined(rawConversationId, "Telegram conversation id");
      return { id, threadId, baseConversationId: id };
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
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(requireGatewayRequest().method).toBe("sessions.resolve");
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
    expect(callGatewayMock).toHaveBeenCalledTimes(2);
    expect(requireGatewayRequest().method).toBe("sessions.resolve");
    expect(requireGatewayRequest(1).method).toBe("sessions.resolve");
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

  it("rejects a synchronous target that resolves to the calling session", async () => {
    callGatewayMock.mockResolvedValueOnce({ key: MAIN_AGENT_SESSION_KEY });
    const tool = createMainSessionsSendTool();

    const result = await tool.execute("call-self-send", {
      sessionKey: "current",
      message: "use this as my reply",
    });

    expect(requireDetails(result)).toMatchObject({
      status: "error",
      error: "sessions_send cannot target the calling session; use your own reply instead",
      sessionKey: "current",
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(callGatewayMock.mock.calls).not.toContainEqual([
      expect.objectContaining({ method: "agent" }),
    ]);
  });

  it("rejects synchronous sends to the raw legacy direct-message caller", async () => {
    const requesterSessionKey = "agent:main:feishu:direct:peer-1";
    callGatewayMock.mockResolvedValueOnce({ key: requesterSessionKey });
    const tool = createSessionsSendTool({
      agentSessionKey: requesterSessionKey,
      agentChannel: "feishu",
    });

    const result = await tool.execute("call-legacy-direct-self-send", {
      sessionKey: "current",
      message: "use this as my reply",
    });

    expect(requireDetails(result)).toMatchObject({
      status: "error",
      error: "sessions_send cannot target the calling session; use your own reply instead",
      sessionKey: "current",
    });
    expect(callGatewayMock.mock.calls).not.toContainEqual([
      expect.objectContaining({ method: "agent" }),
    ]);
  });

  it.each(["silent", "empty"] as const)(
    "reports a terminal %s target without leaving an announcement pending",
    async (disposition) => {
      const { runSessionsSendA2AFlow } = await import("./sessions-send-tool.a2a.js");
      vi.mocked(runSessionsSendA2AFlow).mockClear();
      const targetSessionKey = "agent:main:other";
      const tool = createSessionsSendTool({
        agentSessionKey: MAIN_AGENT_SESSION_KEY,
        agentChannel: MAIN_AGENT_CHANNEL,
        config: {
          session: { scope: "per-sender", mainKey: "main" },
          tools: {
            agentToAgent: { enabled: false },
            sessions: { visibility: "all" },
          },
        } as never,
      });
      let historyCalls = 0;
      const staleAssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "older reply from a previous run" }],
        timestamp: 20,
      };
      const freshPrivateFinal = {
        role: "assistant",
        content: [{ type: "text", text: "private final that must stay private" }],
        timestamp: 21,
      };

      callGatewayMock.mockImplementation(async (opts: unknown) => {
        const request = opts as { method?: string; params?: Record<string, unknown> };
        if (request.method === "sessions.list") {
          return {
            path: "/tmp/sessions.json",
            sessions: [{ key: targetSessionKey, kind: "direct" }],
          };
        }
        if (request.method === "agent") {
          return { runId: "run-stale-send", acceptedAt: 123 };
        }
        if (request.method === "agent.wait") {
          return {
            runId: "run-stale-send",
            status: "ok",
            terminalReply: { disposition },
          };
        }
        if (request.method === "chat.history") {
          historyCalls += 1;
          return {
            messages:
              historyCalls === 1
                ? [staleAssistantMessage]
                : [staleAssistantMessage, freshPrivateFinal],
          };
        }
        return {};
      });

      const result = await tool.execute("call-stale-send", {
        sessionKey: targetSessionKey,
        message: "ping",
        timeoutSeconds: 1,
      });

      expect(historyCalls).toBe(1);
      const details = requireDetails(result);
      expect(details.status).toBe("no_reply");
      expect(details.reply).toBeUndefined();
      expect(details.delivery).toBeUndefined();
      expect(details.message).toContain("pending announcement");
      expect(details.sessionKey).toBe(targetSessionKey);
      expect(runSessionsSendA2AFlow).not.toHaveBeenCalled();
    },
  );

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

  it("detaches fire-and-forget A2A work from parent transcript ownership", async () => {
    const { runSessionsSendA2AFlow } = await import("./sessions-send-tool.a2a.js");
    let inheritedFence: ReturnType<typeof getOwnedSessionTranscriptWriterFence>;
    vi.mocked(runSessionsSendA2AFlow).mockImplementationOnce(async () => {
      inheritedFence = getOwnedSessionTranscriptWriterFence();
    });
    let parentTranscriptWriteCalls = 0;
    const parentTranscriptWrite = async <T>(run: () => Promise<T> | T): Promise<T> => {
      parentTranscriptWriteCalls += 1;
      return await run();
    };

    await withOwnedSessionTranscriptWrites(
      {
        sessionKey: MAIN_AGENT_SESSION_KEY,
        sessionTarget: {
          expectedWriterRunId: "disposed-parent-run",
          sessionKey: MAIN_AGENT_SESSION_KEY,
        },
        withTranscriptWrite: parentTranscriptWrite,
      },
      async () => {
        await executeFireAndForgetA2AFrom(MAIN_AGENT_SESSION_KEY);
      },
    );
    await vi.waitFor(() => expect(runSessionsSendA2AFlow).toHaveBeenCalledOnce());

    expect(inheritedFence).toBeUndefined();
    expect(parentTranscriptWriteCalls).toBe(0);
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
      expectedRequesterSessionKey: "agent:main:cron:job:run:abc",
    },
    {
      label: "normal requester",
      requesterSessionKey: "agent:main:telegram:direct:user",
      expected: 5,
      expectedRequesterSessionKey: "agent:main:main",
    },
    {
      label: "non-canonical cron-like requester",
      requesterSessionKey: "agent:main:slack:cron:job:run:uuid",
      expected: 5,
      expectedRequesterSessionKey: "agent:main:slack:cron:job:run:uuid",
    },
  ] as const)(
    "uses the expected ping-pong turns for a $label",
    async ({ requesterSessionKey, expected, expectedRequesterSessionKey }) => {
      const flowParams = await executeFireAndForgetA2AFrom(requesterSessionKey);

      expect(flowParams.maxPingPongTurns).toBe(expected);
      expect(flowParams.requesterSessionKey).toBe(expectedRequesterSessionKey);
    },
  );

  it.each([
    { label: "peer", key: "agent:main:direct:peer-1" },
    { label: "channel", key: "agent:main:feishu:direct:peer-1" },
    { label: "account", key: "agent:main:feishu:default:direct:peer-1" },
  ] as const)("preserves a $label DM owned by another routed agent", async ({ key }) => {
    const flowParams = await executeFireAndForgetA2AFrom(key, {
      bindingAgentId: "stranger",
    });

    expect(flowParams.requesterSessionKey).toBe(key);
  });

  it("fails closed when an erased named account belongs to another agent", async () => {
    const key = "agent:main:feishu:direct:peer-1";
    const flowParams = await executeFireAndForgetA2AFrom(key, {
      bindingAgentId: "stranger",
      bindingAccountId: "work",
    });

    expect(flowParams.requesterSessionKey).toBe(key);
  });

  it("preserves a named-account route that inherits isolated global DM scope", async () => {
    const key = "agent:main:feishu:direct:peer-1";
    const flowParams = await executeFireAndForgetA2AFrom(key, {
      dmScope: "per-peer",
      defaultBindingDmScope: "main",
      bindingAccountId: "work",
    });

    expect(flowParams.requesterSessionKey).toBe(key);
  });

  it("preserves account-isolated bindings with trimmed wildcard peers", async () => {
    const key = "agent:main:feishu:direct:peer-1";
    const flowParams = await executeFireAndForgetA2AFrom(key, {
      bindingDmScope: "per-peer",
      bindingAccountId: "work",
      bindingPeerId: " * ",
    });

    expect(flowParams.requesterSessionKey).toBe(key);
  });

  it("preserves isolated peers when the session key loses binding casing", async () => {
    const key = "agent:main:feishu:direct:peer-1";
    const flowParams = await executeFireAndForgetA2AFrom(key, {
      bindingDmScope: "per-peer",
      bindingPeerId: "PEER-1",
    });

    expect(flowParams.requesterSessionKey).toBe(key);
  });

  it("preserves isolated bindings whose team is absent from the session key", async () => {
    const key = "agent:main:feishu:direct:peer-1";
    const flowParams = await executeFireAndForgetA2AFrom(key, {
      bindingDmScope: "per-peer",
      bindingTeamId: "T123",
    });

    expect(flowParams.requesterSessionKey).toBe(key);
  });

  it.each([
    { label: "peer direct", key: "agent:main:direct:peer-1" },
    { label: "peer dm", key: "agent:main:dm:peer-1" },
    { label: "channel direct", key: "agent:main:feishu:direct:peer-1" },
    { label: "channel dm", key: "agent:main:feishu:dm:peer-1" },
    { label: "account direct", key: "agent:main:feishu:default:direct:peer-1" },
    { label: "account dm", key: "agent:main:feishu:default:dm:peer-1" },
  ] as const)(
    "routes a legacy $label requester back to its monitored main session",
    async ({ key }) => {
      const flowParams = await executeFireAndForgetA2AFrom(key);

      expect(flowParams.requesterSessionKey).toBe(MAIN_AGENT_SESSION_KEY);
      const agentCall = callGatewayMock.mock.calls.find(
        ([request]) => (request as { method?: string }).method === "agent",
      );
      expect(agentCall?.[0]).toMatchObject({
        method: "agent",
        params: {
          inputProvenance: {
            kind: "inter_session",
            sourceSessionKey: MAIN_AGENT_SESSION_KEY,
            sourceTool: "sessions_send",
          },
        },
      });
    },
  );

  it("routes a legacy direct requester to its configured main session key", async () => {
    const flowParams = await executeFireAndForgetA2AFrom("agent:main:feishu:direct:peer-1", {
      mainKey: "work",
    });

    expect(flowParams.requesterSessionKey).toBe("agent:main:work");
  });

  it.each([
    { label: "group", key: "agent:main:feishu:group:peer-1" },
    { label: "group with opaque direct token", key: "agent:main:feishu:group:direct:peer-1" },
    { label: "group with opaque dm token", key: "agent:main:feishu:group:dm:peer-1" },
    { label: "channel with opaque direct token", key: "agent:main:channel:direct:peer-1" },
    { label: "channel with opaque dm token", key: "agent:main:channel:dm:peer-1" },
    { label: "cron", key: "agent:main:cron:nightly:run:peer-1" },
    { label: "cron with direct token", key: "agent:main:cron:direct:peer-1" },
    { label: "hook with direct token", key: "agent:main:hook:direct:peer-1" },
    { label: "hook with dm token", key: "agent:main:hook:dm:peer-1" },
    { label: "subagent with direct token", key: "agent:main:subagent:direct:peer-1" },
    { label: "nested agent owner", key: "agent:main:agent:worker:feishu:direct:peer-1" },
    {
      label: "thread-scoped direct conversation",
      key: "agent:main:feishu:direct:peer-1:thread:reply-root",
    },
    {
      label: "thread-scoped account direct conversation",
      key: "agent:main:feishu:default:dm:peer-1:thread:reply-root",
    },
  ] as const)("preserves the exact $label requester under main DM scope", async ({ key }) => {
    const flowParams = await executeFireAndForgetA2AFrom(key);

    expect(flowParams.requesterSessionKey).toBe(key);
  });

  it.each([
    { dmScope: "per-peer", key: "agent:main:direct:peer-1" },
    { dmScope: "per-peer", key: "agent:main:dm:peer-1" },
    { dmScope: "per-channel-peer", key: "agent:main:feishu:direct:peer-1" },
    { dmScope: "per-channel-peer", key: "agent:main:feishu:dm:peer-1" },
    {
      dmScope: "per-account-channel-peer",
      key: "agent:main:feishu:default:direct:peer-1",
    },
    { dmScope: "per-account-channel-peer", key: "agent:main:feishu:default:dm:peer-1" },
  ] as const)("preserves privacy under $dmScope for $key", async ({ dmScope, key }) => {
    const flowParams = await executeFireAndForgetA2AFrom(key, { dmScope });

    expect(flowParams.requesterSessionKey).toBe(key);
  });

  it.each([
    { bindingDmScope: "per-peer", key: "agent:main:direct:peer-1" },
    { bindingDmScope: "per-channel-peer", key: "agent:main:feishu:direct:peer-1" },
    {
      bindingDmScope: "per-account-channel-peer",
      key: "agent:main:feishu:default:direct:peer-1",
    },
  ] as const)(
    "preserves a binding-isolated $bindingDmScope DM under global main scope",
    async ({ bindingDmScope, key }) => {
      const flowParams = await executeFireAndForgetA2AFrom(key, { bindingDmScope });

      expect(flowParams.requesterSessionKey).toBe(key);
    },
  );

  it.each([
    { dmScope: "per-peer", key: "agent:main:direct:peer-1" },
    { dmScope: "per-channel-peer", key: "agent:main:feishu:direct:peer-1" },
    {
      dmScope: "per-account-channel-peer",
      key: "agent:main:feishu:default:direct:peer-1",
    },
  ] as const)(
    "honors a main-scope binding overriding global $dmScope",
    async ({ dmScope, key }) => {
      const flowParams = await executeFireAndForgetA2AFrom(key, {
        dmScope,
        bindingDmScope: "main",
      });

      expect(flowParams.requesterSessionKey).toBe(MAIN_AGENT_SESSION_KEY);
    },
  );

  it.each([
    { bindingDmScope: "per-peer", key: "agent:main:direct:peer-1" },
    { bindingDmScope: "per-channel-peer", key: "agent:main:feishu:direct:peer-1" },
  ] as const)(
    "fails closed for an account-erased $bindingDmScope DM binding",
    async ({ bindingDmScope, key }) => {
      const flowParams = await executeFireAndForgetA2AFrom(key, {
        bindingDmScope,
        bindingAccountId: "work",
      });

      expect(flowParams.requesterSessionKey).toBe(key);
    },
  );

  it("caps oversized timeoutSeconds before waiting for the target run", async () => {
    const targetSessionKey = "agent:main:other";
    const tool = createSessionsSendTool({
      agentSessionKey: MAIN_AGENT_SESSION_KEY,
      agentChannel: MAIN_AGENT_CHANNEL,
      config: {
        session: { scope: "per-sender", mainKey: "main" },
        tools: {
          agentToAgent: { enabled: false },
          sessions: { visibility: "all" },
        },
      } as never,
    });
    const waitTimeouts: unknown[] = [];

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; timeoutMs?: unknown };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [{ key: targetSessionKey, kind: "direct" }],
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
      sessionKey: targetSessionKey,
      message: "ping",
      timeoutSeconds: Number.MAX_SAFE_INTEGER,
    });

    expect(requireDetails(result).status).toBe("no_reply");
    expect(waitTimeouts).toEqual([MAX_TIMER_TIMEOUT_MS]);
  });
});

describe("sessions_send agent-main materialization provenance", () => {
  it("uses the trusted in-process creation stamp in the production assembly (no injected caller)", async () => {
    inProcessGatewayContextAvailable = true;
    inProcessCreationMock.mockClear();
    loadConfigMock.mockReturnValue({
      session: { scope: "per-sender", mainKey: "main" },
      tools: {
        agentToAgent: { enabled: false },
        sessions: { visibility: "all" },
      },
    });
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.resolve") {
        return {};
      }
      if (request.method === "sessions.create") {
        throw new Error("plain sessions.create must not be used for trusted materialization");
      }
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      if (request.method === "agent") {
        return { runId: "run-ensure-main", acceptedAt: 1 };
      }
      return {};
    });
    // Mirror production assembly (openclaw-tools.ts): no callGateway override, so
    // ensureConfiguredAgentMainSession takes the trusted in-process branch.
    const tool = createSessionsSendTool({
      agentSessionKey: "agent:main:dashboard:req-provenance",
      agentChannel: MAIN_AGENT_CHANNEL,
    });

    try {
      const result = await tool.execute("call-ensure-main-provenance", {
        sessionKey: "agent:main:main",
        message: "wake up",
        timeoutSeconds: 0,
      });

      expect(requireDetails(result).status).toBe("accepted");
      expect(inProcessCreationMock).toHaveBeenCalledTimes(1);
      expect(inProcessCreationMock).toHaveBeenCalledWith(
        "sessions.create",
        { key: "agent:main:main", agentId: "main" },
        {
          via: "internal",
          actor: { type: "agent", id: "agent:main:dashboard:req-provenance" },
        },
      );
    } finally {
      inProcessGatewayContextAvailable = false;
      inProcessCreationMock.mockClear();
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
