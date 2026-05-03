import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelMessagingAdapter } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));
const loadSessionEntryByKeyMock = vi.fn();
vi.mock("./subagent-announce-delivery.js", () => ({
  loadSessionEntryByKey: (sessionKey: string) => loadSessionEntryByKeyMock(sessionKey),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({
    session: {
      mainKey: "main",
      scope: "per-sender",
      agentToAgent: { maxPingPongTurns: 2 },
    },
    tools: {
      // Keep sessions tools permissive in this suite; dedicated visibility tests cover defaults.
      sessions: { visibility: "all" },
      agentToAgent: { enabled: true },
    },
  }),
  resolveGatewayPort: () => 18789,
}));

import "./test-helpers/fast-openclaw-tools-sessions.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { __testing as agentStepTesting } from "./tools/agent-step.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import { __testing as sessionsResolutionTesting } from "./tools/sessions-resolution.js";
import { __testing as sessionsSendA2ATesting } from "./tools/sessions-send-tool.a2a.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";

const TEST_CONFIG = {
  session: {
    mainKey: "main",
    scope: "per-sender",
    agentToAgent: { maxPingPongTurns: 2 },
  },
  tools: {
    sessions: { visibility: "all" },
    agentToAgent: { enabled: true },
  },
} as OpenClawConfig;

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

function installMessagingTestRegistry() {
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
    ]),
  );
}

function createOpenClawTools(options?: {
  agentSessionKey?: string;
  agentChannel?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
}) {
  const config = options?.config ?? TEST_CONFIG;
  const gatewayCall = (opts: unknown) => callGatewayMock(opts);
  return [
    createSessionsListTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
      config,
      callGateway: gatewayCall,
    }),
    createSessionsHistoryTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
      config,
      callGateway: gatewayCall,
    }),
    createSessionsSendTool({
      agentSessionKey: options?.agentSessionKey,
      agentChannel: options?.agentChannel as never,
      sandboxed: options?.sandboxed,
      config,
      callGateway: gatewayCall,
    }),
  ];
}

const waitForCalls = async (getCount: () => number, count: number, timeoutMs = 2000) => {
  await vi.waitFor(
    () => {
      expect(getCount()).toBeGreaterThanOrEqual(count);
    },
    { timeout: timeoutMs, interval: 5 },
  );
};

describe("sessions tools", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
    loadSessionEntryByKeyMock.mockReset();
    loadSessionEntryByKeyMock.mockReturnValue(undefined);
    installMessagingTestRegistry();
    agentStepTesting.setDepsForTest({
      agentCommandFromIngress: async () => ({
        payloads: [{ text: "ANNOUNCE_SKIP", mediaUrl: null }],
        meta: { durationMs: 1 },
      }),
      callGateway: (opts: unknown) => callGatewayMock(opts),
    });
    sessionsResolutionTesting.setDepsForTest({
      callGateway: (opts: unknown) => callGatewayMock(opts),
    });
    sessionsSendA2ATesting.setDepsForTest({
      callGateway: (opts: unknown) => callGatewayMock(opts),
    });
  });

  it("uses number (not integer) in tool schemas for Gemini compatibility", () => {
    const tools = createOpenClawTools();
    const byName = (name: string) => {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool).toBeDefined();
      if (!tool) {
        throw new Error(`missing ${name} tool`);
      }
      return tool;
    };

    const schemaProp = (toolName: string, prop: string) => {
      const tool = byName(toolName);
      const schema = tool.parameters as {
        anyOf?: unknown;
        oneOf?: unknown;
        properties?: Record<string, unknown>;
      };
      expect(schema.anyOf).toBeUndefined();
      expect(schema.oneOf).toBeUndefined();

      const properties = schema.properties ?? {};
      const value = properties[prop] as { type?: unknown } | undefined;
      expect(value).toBeDefined();
      if (!value) {
        throw new Error(`missing ${toolName} schema prop: ${prop}`);
      }
      return value;
    };

    expect(schemaProp("sessions_history", "limit").type).toBe("number");
    expect(schemaProp("sessions_list", "limit").type).toBe("number");
    expect(schemaProp("sessions_list", "activeMinutes").type).toBe("number");
    expect(schemaProp("sessions_list", "messageLimit").type).toBe("number");
    expect(schemaProp("sessions_list", "label").type).toBe("string");
    expect(schemaProp("sessions_list", "agentId").type).toBe("string");
    expect(schemaProp("sessions_list", "search").type).toBe("string");
    expect(schemaProp("sessions_list", "includeDerivedTitles").type).toBe("boolean");
    expect(schemaProp("sessions_list", "includeLastMessage").type).toBe("boolean");
    expect(schemaProp("sessions_send", "timeoutSeconds").type).toBe("number");
  });

  it("sessions_list forwards mailbox filters and includes messages", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "main",
              kind: "direct",
              sessionId: "s-main",
              updatedAt: 10,
              lastChannel: "whatsapp",
              derivedTitle: "Main mailbox",
              lastMessagePreview: "Latest assistant update",
            },
            {
              key: "discord:group:dev",
              kind: "group",
              sessionId: "s-group",
              updatedAt: 11,
              channel: "discord",
              displayName: "discord:g-dev",
              status: "running",
              startedAt: 100,
              runtimeMs: 42,
              estimatedCostUsd: 0.0042,
              childSessions: ["agent:main:subagent:worker"],
              derivedTitle: "Dev room",
              lastMessagePreview: "Need review on the patch",
            },
            {
              key: "agent:main:dashboard:child",
              kind: "direct",
              sessionId: "s-dashboard-child",
              updatedAt: 12,
              parentSessionKey: "agent:main:main",
            },
            {
              key: "agent:main:subagent:worker",
              kind: "direct",
              sessionId: "s-subagent-worker",
              updatedAt: 13,
              spawnedBy: "agent:main:main",
            },
            {
              key: "cron:job-1",
              kind: "direct",
              sessionId: "s-cron",
              updatedAt: 9,
            },
            { key: "global", kind: "global" },
            { key: "unknown", kind: "unknown" },
          ],
        };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            { role: "toolResult", content: [] },
            {
              role: "assistant",
              content: [{ type: "text", text: "hi" }],
            },
          ],
        };
      }
      return {};
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_list");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_list tool");
    }

    const result = await tool.execute("call1", {
      agentId: "main",
      label: "mailbox",
      search: "review",
      includeDerivedTitles: true,
      includeLastMessage: true,
      messageLimit: 1,
    });
    expect(callGatewayMock).toHaveBeenNthCalledWith(1, {
      method: "sessions.list",
      params: {
        activeMinutes: undefined,
        agentId: "main",
        includeDerivedTitles: false,
        includeLastMessage: false,
        includeGlobal: true,
        includeUnknown: true,
        label: "mailbox",
        limit: undefined,
        search: "review",
        spawnedBy: undefined,
      },
    });
    const details = result.details as {
      sessions?: Array<{
        key?: string;
        agentId?: string;
        channel?: string;
        derivedTitle?: string;
        lastMessagePreview?: string;
        spawnedBy?: string;
        status?: string;
        startedAt?: number;
        runtimeMs?: number;
        estimatedCostUsd?: number;
        childSessions?: string[];
        parentSessionKey?: string;
        messages?: Array<{ role?: string }>;
      }>;
    };
    expect(details.sessions).toHaveLength(5);
    const main = details.sessions?.find((s) => s.key === "main");
    expect(main?.agentId).toBe("main");
    expect(main?.channel).toBe("whatsapp");
    expect(main?.derivedTitle).toBe("Main mailbox");
    expect(main?.lastMessagePreview).toBe("Latest assistant update");
    expect(main?.messages?.length).toBe(1);
    expect(main?.messages?.[0]?.role).toBe("assistant");

    const group = details.sessions?.find((s) => s.key === "discord:group:dev");
    expect(group?.status).toBe("running");
    expect(group?.startedAt).toBe(100);
    expect(group?.runtimeMs).toBe(42);
    expect(group?.estimatedCostUsd).toBe(0.0042);
    expect(group?.childSessions).toEqual(["agent:main:subagent:worker"]);
    expect(group?.derivedTitle).toBe("Dev room");
    expect(group?.lastMessagePreview).toBe("Need review on the patch");

    const dashboardChild = details.sessions?.find((s) => s.key === "agent:main:dashboard:child");
    expect(dashboardChild?.parentSessionKey).toBe("agent:main:main");

    const subagentWorker = details.sessions?.find((s) => s.key === "agent:main:subagent:worker");
    expect(subagentWorker?.spawnedBy).toBe("agent:main:main");

    const cronOnly = await tool.execute("call2", { kinds: ["cron"] });
    const cronDetails = cronOnly.details as {
      sessions?: Array<Record<string, unknown>>;
    };
    expect(cronDetails.sessions).toHaveLength(1);
    expect(cronDetails.sessions?.[0]?.kind).toBe("cron");
  });

  it("derives mailbox previews only after agent visibility filtering", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-list-preview-"));
    const storePath = path.join(tmpDir, "sessions.json");
    try {
      fs.writeFileSync(
        path.join(tmpDir, "visible.jsonl"),
        [
          JSON.stringify({ type: "session", id: "visible" }),
          JSON.stringify({ message: { role: "user", content: "Visible project kickoff" } }),
          JSON.stringify({ message: { role: "assistant", content: "Visible latest reply" } }),
        ].join("\n"),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(tmpDir, "hidden.jsonl"),
        [
          JSON.stringify({ type: "session", id: "hidden" }),
          JSON.stringify({ message: { role: "user", content: "Hidden cross-agent topic" } }),
          JSON.stringify({ message: { role: "assistant", content: "Hidden latest reply" } }),
        ].join("\n"),
        "utf-8",
      );

      callGatewayMock.mockImplementation(async (opts: unknown) => {
        const request = opts as { method?: string; params?: Record<string, unknown> };
        if (request.method === "sessions.list") {
          expect(request.params?.includeDerivedTitles).toBe(false);
          expect(request.params?.includeLastMessage).toBe(false);
          return {
            path: storePath,
            sessions: [
              {
                key: "agent:main:main",
                kind: "direct",
                sessionId: "visible",
                updatedAt: 20,
              },
              {
                key: "agent:other:main",
                kind: "direct",
                sessionId: "hidden",
                updatedAt: 21,
              },
            ],
          };
        }
        return {};
      });

      const tool = createOpenClawTools({
        agentSessionKey: "agent:main:main",
        config: {
          ...TEST_CONFIG,
          tools: {
            sessions: { visibility: "agent" },
            agentToAgent: { enabled: false },
          },
        } as OpenClawConfig,
      }).find((candidate) => candidate.name === "sessions_list");
      expect(tool).toBeDefined();
      if (!tool) {
        throw new Error("missing sessions_list tool");
      }

      const result = await tool.execute("call-preview", {
        includeDerivedTitles: true,
        includeLastMessage: true,
      });
      const details = result.details as {
        sessions?: Array<{
          key?: string;
          derivedTitle?: string;
          lastMessagePreview?: string;
        }>;
      };
      expect(details.sessions).toHaveLength(1);
      expect(details.sessions?.[0]).toMatchObject({
        key: "agent:main:main",
        derivedTitle: "Visible project kickoff",
        lastMessagePreview: "Visible latest reply",
      });
      expect(JSON.stringify(details.sessions)).not.toContain("Hidden");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("sessions_list resolves transcriptPath from agent state dir for multi-store listings", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "(multiple)",
          sessions: [
            {
              key: "main",
              kind: "direct",
              sessionId: "sess-main",
              updatedAt: 12,
            },
          ],
        };
      }
      return {};
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_list");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_list tool");
    }

    const result = await tool.execute("call2b", {});
    const details = result.details as {
      sessions?: Array<{
        key?: string;
        transcriptPath?: string;
      }>;
    };
    const main = details.sessions?.find((session) => session.key === "main");
    expect(typeof main?.transcriptPath).toBe("string");
    expect(main?.transcriptPath).not.toContain("(multiple)");
    expect(main?.transcriptPath).toContain(
      path.join("agents", "main", "sessions", "sess-main.jsonl"),
    );
  });

  it("sessions_history filters tool messages by default", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "chat.history") {
        return {
          messages: [
            { role: "toolResult", content: [] },
            { role: "assistant", content: [{ type: "text", text: "ok" }] },
          ],
        };
      }
      return {};
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_history");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_history tool");
    }

    const result = await tool.execute("call3", { sessionKey: "main" });
    const details = result.details as { messages?: Array<{ role?: string }> };
    expect(details.messages).toHaveLength(1);
    expect(details.messages?.[0]?.role).toBe("assistant");

    const withTools = await tool.execute("call4", {
      sessionKey: "main",
      includeTools: true,
    });
    const withToolsDetails = withTools.details as { messages?: unknown[] };
    expect(withToolsDetails.messages).toHaveLength(2);
  });

  it("sessions_history caps oversized payloads and strips heavy fields", async () => {
    const oversized = Array.from({ length: 80 }, (_, idx) => ({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `${String(idx)}:${"x".repeat(5000)}`,
        },
        {
          type: "thinking",
          thinking: "y".repeat(7000),
          thinkingSignature: "sig".repeat(4000),
        },
      ],
      details: {
        giant: "z".repeat(12000),
      },
      usage: {
        input: 1,
        output: 1,
      },
    }));
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "chat.history") {
        return { messages: oversized };
      }
      return {};
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_history");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_history tool");
    }

    const result = await tool.execute("call4b", {
      sessionKey: "main",
      includeTools: true,
    });
    const details = result.details as {
      messages?: Array<Record<string, unknown>>;
      truncated?: boolean;
      droppedMessages?: boolean;
      contentTruncated?: boolean;
      contentRedacted?: boolean;
      bytes?: number;
    };
    expect(details.truncated).toBe(true);
    expect(details.droppedMessages).toBe(true);
    expect(details.contentTruncated).toBe(true);
    expect(details.contentRedacted).toBe(false);
    expect(typeof details.bytes).toBe("number");
    expect((details.bytes ?? 0) <= 80 * 1024).toBe(true);
    expect(details.messages && details.messages.length > 0).toBe(true);

    const first = details.messages?.[0] as
      | {
          details?: unknown;
          usage?: unknown;
          content?: Array<{
            type?: string;
            text?: string;
            thinking?: string;
            thinkingSignature?: string;
          }>;
        }
      | undefined;
    expect(first?.details).toBeUndefined();
    expect(first?.usage).toBeUndefined();
    const textBlock = first?.content?.find((block) => block.type === "text");
    expect(typeof textBlock?.text).toBe("string");
    expect((textBlock?.text ?? "").length <= 4015).toBe(true);
    const thinkingBlock = first?.content?.find((block) => block.type === "thinking");
    expect(thinkingBlock?.thinkingSignature).toBeUndefined();
  });

  it("sessions_history enforces a hard byte cap even when a single message is huge", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
              extra: "x".repeat(200_000),
            },
          ],
        };
      }
      return {};
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_history");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_history tool");
    }

    const result = await tool.execute("call4c", {
      sessionKey: "main",
      includeTools: true,
    });
    const details = result.details as {
      messages?: Array<Record<string, unknown>>;
      truncated?: boolean;
      droppedMessages?: boolean;
      contentTruncated?: boolean;
      contentRedacted?: boolean;
      bytes?: number;
    };
    expect(details.truncated).toBe(true);
    expect(details.droppedMessages).toBe(true);
    expect(details.contentTruncated).toBe(false);
    expect(details.contentRedacted).toBe(false);
    expect(typeof details.bytes).toBe("number");
    expect((details.bytes ?? 0) <= 80 * 1024).toBe(true);
    expect(details.messages).toHaveLength(1);
    expect(details.messages?.[0]?.content).toContain(
      "[sessions_history omitted: message too large]",
    );
  });

  it("sessions_history sets contentRedacted when sensitive data is redacted", async () => {
    callGatewayMock.mockReset();
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                { type: "text", text: "Use sk-1234567890abcdef1234 to authenticate with the API." },
              ],
            },
          ],
        };
      }
      return {};
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_history");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_history tool");
    }

    const result = await tool.execute("call-redact-1", { sessionKey: "main" });
    const details = result.details as {
      messages?: Array<Record<string, unknown>>;
      truncated?: boolean;
      contentTruncated?: boolean;
      contentRedacted?: boolean;
    };
    expect(details.contentRedacted).toBe(true);
    expect(details.contentTruncated).toBe(false);
    expect(details.truncated).toBe(false);
    const msg = details.messages?.[0] as { content?: Array<{ type?: string; text?: string }> };
    const textBlock = msg?.content?.find((b) => b.type === "text");
    expect(typeof textBlock?.text).toBe("string");
    expect(textBlock?.text).not.toContain("sk-1234567890abcdef1234");
  });

  it("sessions_history sets both contentRedacted and contentTruncated independently", async () => {
    callGatewayMock.mockReset();
    const longPrefix = "safe text ".repeat(420);
    const sensitiveText = `${longPrefix} sk-9876543210fedcba9876 end`;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: sensitiveText }],
            },
          ],
        };
      }
      return {};
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_history");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_history tool");
    }

    const result = await tool.execute("call-redact-2", { sessionKey: "main" });
    const details = result.details as {
      truncated?: boolean;
      contentTruncated?: boolean;
      contentRedacted?: boolean;
    };
    expect(details.contentRedacted).toBe(true);
    expect(details.contentTruncated).toBe(true);
    expect(details.truncated).toBe(true);
  });

  it("sessions_history resolves sessionId inputs", async () => {
    const sessionId = "sess-group";
    const targetKey = "agent:main:discord:channel:1457165743010611293";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as {
        method?: string;
        params?: Record<string, unknown>;
      };
      if (request.method === "sessions.resolve") {
        return {
          key: targetKey,
        };
      }
      if (request.method === "chat.history") {
        return {
          messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
        };
      }
      return {};
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_history");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_history tool");
    }

    const result = await tool.execute("call5", { sessionKey: sessionId });
    const details = result.details as { messages?: unknown[] };
    expect(details.messages).toHaveLength(1);
    const historyCall = callGatewayMock.mock.calls.find(
      (call) => (call[0] as { method?: string }).method === "chat.history",
    );
    expect(historyCall?.[0]).toMatchObject({
      method: "chat.history",
      params: { sessionKey: targetKey },
    });
  });

  it("sessions_history errors on missing sessionId", async () => {
    const sessionId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.resolve") {
        throw new Error("No session found");
      }
      return {};
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_history");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_history tool");
    }

    const result = await tool.execute("call6", { sessionKey: sessionId });
    const details = result.details as { status?: string; error?: string };
    expect(details.status).toBe("error");
    expect(details.error).toMatch(/Session not found|No session found/);
  });

  it("sessions_send supports fire-and-forget and wait", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let _historyCallCount = 0;
    let sendCallCount = 0;
    let lastWaitedRunId: string | undefined;
    const replyByRunId = new Map<string, string>();
    const requesterKey = "discord:group:req";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const params = request.params as { message?: string; sessionKey?: string } | undefined;
        const message = params?.message ?? "";
        let reply = "REPLY_SKIP";
        if (message.includes("ping") || message.includes("wait")) {
          reply = "done";
        } else if (message.includes("Agent-to-agent announce step.")) {
          reply = "ANNOUNCE_SKIP";
        } else if (params?.sessionKey === requesterKey) {
          reply = "pong";
        }
        replyByRunId.set(runId, reply);
        return {
          runId,
          status: "accepted",
          acceptedAt: 1234 + agentCallCount,
        };
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string } | undefined;
        lastWaitedRunId = params?.runId;
        return { runId: params?.runId ?? "run-1", status: "ok" };
      }
      if (request.method === "chat.history") {
        _historyCallCount += 1;
        const text = (lastWaitedRunId && replyByRunId.get(lastWaitedRunId)) ?? "";
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text,
                },
              ],
              timestamp: 20,
            },
          ],
        };
      }
      if (request.method === "send") {
        sendCallCount += 1;
        return { messageId: "m1" };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const fire = await tool.execute("call5", {
      sessionKey: "main",
      message: "ping",
      timeoutSeconds: 0,
    });
    expect(fire.details).toMatchObject({
      status: "accepted",
      runId: "run-1",
      delivery: { status: "pending", mode: "announce" },
    });
    await waitForCalls(() => calls.filter((call) => call.method === "agent").length, 3);
    await waitForCalls(() => calls.filter((call) => call.method === "agent.wait").length, 3);
    await waitForCalls(() => calls.filter((call) => call.method === "chat.history").length, 3);

    const waitPromise = tool.execute("call6", {
      sessionKey: "main",
      message: "wait",
      timeoutSeconds: 1,
    });
    const waited = await waitPromise;
    expect(waited.details).toMatchObject({
      status: "ok",
      reply: "done",
      delivery: { status: "pending", mode: "announce" },
    });
    expect(typeof (waited.details as { runId?: string }).runId).toBe("string");
    await waitForCalls(() => calls.filter((call) => call.method === "agent").length, 6);
    await waitForCalls(() => calls.filter((call) => call.method === "agent.wait").length, 6);
    await waitForCalls(() => calls.filter((call) => call.method === "chat.history").length, 7);

    const agentCalls = calls.filter((call) => call.method === "agent");
    const waitCalls = calls.filter((call) => call.method === "agent.wait");
    const historyOnlyCalls = calls.filter((call) => call.method === "chat.history");
    expect(agentCalls).toHaveLength(6);
    for (const call of agentCalls) {
      expect(call.params).toMatchObject({
        message: expect.stringContaining("[Inter-session message"),
        lane: expect.stringMatching(/^nested(?::|$)/),
        channel: "webchat",
        inputProvenance: { kind: "inter_session" },
      });
      expect((call.params as { message?: string }).message).toContain("isUser=false");
    }
    expect(
      agentCalls.some(
        (call) =>
          typeof (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt === "string" &&
          (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt?.includes(
            "Agent-to-agent message context",
          ),
      ),
    ).toBe(true);
    expect(
      agentCalls.some(
        (call) =>
          typeof (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt === "string" &&
          (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt?.includes(
            "Agent-to-agent reply step",
          ),
      ),
    ).toBe(true);
    expect(waitCalls).toHaveLength(6);
    expect(historyOnlyCalls).toHaveLength(7);
    expect(sendCallCount).toBe(0);
  });

  it("sessions_send resolves sessionId inputs", async () => {
    const sessionId = "sess-send";
    const targetKey = "agent:main:discord:channel:123";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as {
        method?: string;
        params?: Record<string, unknown>;
      };
      if (request.method === "sessions.resolve") {
        return { key: targetKey };
      }
      if (request.method === "agent") {
        return { runId: "run-1", acceptedAt: 123 };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "main",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call7", {
      sessionKey: sessionId,
      message: "ping",
      timeoutSeconds: 0,
    });
    const details = result.details as { status?: string };
    expect(details.status).toBe("accepted");
    const agentCall = callGatewayMock.mock.calls.find(
      (call) => (call[0] as { method?: string }).method === "agent",
    );
    expect(agentCall?.[0]).toMatchObject({
      method: "agent",
      params: { sessionKey: targetKey },
    });
  });

  it("sessions_send runs ping-pong then announces", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let lastWaitedRunId: string | undefined;
    const replyByRunId = new Map<string, string>();
    const requesterKey = "discord:group:req";
    const targetKey = "discord:group:target";
    let sendParams: { to?: string; channel?: string; message?: string } = {};
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const params = request.params as
          | {
              message?: string;
              sessionKey?: string;
              extraSystemPrompt?: string;
            }
          | undefined;
        let reply = "initial";
        if (params?.extraSystemPrompt?.includes("Agent-to-agent reply step")) {
          reply = params.sessionKey === requesterKey ? "pong-1" : "pong-2";
        }
        if (params?.extraSystemPrompt?.includes("Agent-to-agent announce step")) {
          reply = "announce now";
        }
        replyByRunId.set(runId, reply);
        return {
          runId,
          status: "accepted",
          acceptedAt: 2000 + agentCallCount,
        };
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string } | undefined;
        lastWaitedRunId = params?.runId;
        return { runId: params?.runId ?? "run-1", status: "ok" };
      }
      if (request.method === "chat.history") {
        const text = (lastWaitedRunId && replyByRunId.get(lastWaitedRunId)) ?? "";
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text }],
              timestamp: 20,
            },
          ],
        };
      }
      if (request.method === "send") {
        const params = request.params as
          | { to?: string; channel?: string; message?: string }
          | undefined;
        sendParams = {
          to: params?.to,
          channel: params?.channel,
          message: params?.message,
        };
        return { messageId: "m-announce" };
      }
      return {};
    });
    agentStepTesting.setDepsForTest({
      agentCommandFromIngress: async () => ({
        payloads: [{ text: "announce now", mediaUrl: null }],
        meta: { durationMs: 1 },
      }),
      callGateway: (opts: unknown) => callGatewayMock(opts),
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const waited = await tool.execute("call7", {
      sessionKey: targetKey,
      message: "ping",
      timeoutSeconds: 1,
    });
    expect(waited.details).toMatchObject({
      status: "ok",
      reply: "initial",
    });
    await vi.waitFor(
      () => {
        expect(calls.filter((call) => call.method === "agent")).toHaveLength(3);
      },
      { timeout: 2_000, interval: 5 },
    );

    const agentCalls = calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(3);
    for (const call of agentCalls) {
      expect(call.params).toMatchObject({
        lane: expect.stringMatching(/^nested(?::|$)/),
        channel: "webchat",
        inputProvenance: { kind: "inter_session" },
      });
    }

    const replySteps = calls.filter(
      (call) =>
        call.method === "agent" &&
        typeof (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt === "string" &&
        (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt?.includes(
          "Agent-to-agent reply step",
        ),
    );
    expect(replySteps).toHaveLength(2);
    expect(sendParams).toMatchObject({
      to: "group:target",
      channel: "discord",
      message: "announce now",
    });
  });

  it("sessions_send keeps delayed requester replies alive after a wait timeout", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const requesterKey = "agent:main:main";
    const targetKey = "agent:director1:main";
    let targetWaitCount = 0;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        const params = request.params as { sessionKey?: string } | undefined;
        if (params?.sessionKey === targetKey) {
          return { runId: "run-target", status: "accepted", acceptedAt: 2000 };
        }
        if (params?.sessionKey === requesterKey) {
          return { runId: "run-requester", status: "accepted", acceptedAt: 2001 };
        }
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string } | undefined;
        if (params?.runId === "run-target") {
          targetWaitCount += 1;
          return targetWaitCount === 1
            ? { runId: "run-target", status: "timeout" }
            : { runId: "run-target", status: "ok" };
        }
        if (params?.runId === "run-requester") {
          return { runId: "run-requester", status: "ok" };
        }
      }
      if (request.method === "chat.history") {
        const params = request.params as { sessionKey?: string } | undefined;
        if (params?.sessionKey === targetKey && targetWaitCount > 1) {
          return {
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "late director reply" }],
                timestamp: 20,
              },
            ],
          };
        }
        if (params?.sessionKey === requesterKey) {
          return {
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "requester saw director" }],
                timestamp: 21,
              },
            ],
          };
        }
        return { messages: [] };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
      config: {
        ...TEST_CONFIG,
        session: {
          ...TEST_CONFIG.session,
          agentToAgent: { maxPingPongTurns: 1 },
        },
      },
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-delayed", {
      sessionKey: targetKey,
      message: "ping",
      timeoutSeconds: 1,
    });
    expect(result.details).toMatchObject({
      status: "accepted",
      sessionKey: targetKey,
      delivery: { status: "pending", mode: "announce" },
    });

    await vi.waitFor(
      () => {
        const requesterReplyCall = calls.find(
          (call) =>
            call.method === "agent" &&
            (call.params as { sessionKey?: string } | undefined)?.sessionKey === requesterKey,
        );
        expect(requesterReplyCall).toBeDefined();
      },
      { timeout: 2_000, interval: 5 },
    );

    const requesterReplyCall = calls.find(
      (call) =>
        call.method === "agent" &&
        (call.params as { sessionKey?: string } | undefined)?.sessionKey === requesterKey,
    );
    const replyParams = requesterReplyCall?.params as
      | {
          extraSystemPrompt?: string;
          inputProvenance?: { sourceSessionKey?: string };
          message?: string;
          sessionKey?: string;
        }
      | undefined;
    expect(replyParams).toMatchObject({
      sessionKey: requesterKey,
      inputProvenance: { sourceSessionKey: targetKey },
    });
    expect(replyParams?.message).toContain("late director reply");
    expect(replyParams?.extraSystemPrompt).toContain("Agent-to-agent reply step");
    expect(replyParams?.extraSystemPrompt).toContain("Current agent: Agent 1 (requester)");
    expect(calls.find((call) => call.method === "send")).toBeUndefined();
  });

  it("sessions_send preserves terminal timeouts without starting A2A", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const requesterKey = "agent:main:main";
    const targetKey = "agent:director1:main";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "run-terminal", status: "accepted", acceptedAt: 2000 };
      }
      if (request.method === "agent.wait") {
        return {
          runId: "run-terminal",
          status: "timeout",
          endedAt: 3000,
          stopReason: "timeout",
          error: "agent run timed out",
        };
      }
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-terminal", {
      sessionKey: targetKey,
      message: "ping",
      timeoutSeconds: 1,
    });
    expect(result.details).toMatchObject({
      status: "timeout",
      error: "agent run timed out",
      sessionKey: targetKey,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.filter((call) => call.method === "agent")).toHaveLength(1);
  });

  it("sessions_send skips duplicate A2A delivery for waited parent-owned native subagents", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const requesterKey = "agent:main:discord:direct:parent";
    const targetKey = "agent:main:subagent:child";
    let historyCallCount = 0;
    loadSessionEntryByKeyMock.mockImplementation((sessionKey: string) =>
      sessionKey === targetKey
        ? {
            sessionId: "child-session",
            updatedAt: 1,
            spawnedBy: requesterKey,
            deliveryContext: {
              channel: "discord",
              to: "direct:parent",
            },
          }
        : undefined,
    );
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "run-child", status: "accepted", acceptedAt: 2000 };
      }
      if (request.method === "agent.wait") {
        return { runId: "run-child", status: "ok" };
      }
      if (request.method === "chat.history") {
        historyCallCount += 1;
        return {
          messages:
            historyCallCount === 1
              ? []
              : [
                  {
                    role: "assistant",
                    content: [{ type: "text", text: "child reply" }],
                    timestamp: 20,
                  },
                ],
        };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const waited = await tool.execute("call-parent-owned-native-subagent", {
      sessionKey: targetKey,
      message: "ping",
      timeoutSeconds: 1,
    });

    expect(waited.details).toMatchObject({
      status: "ok",
      reply: "child reply",
      delivery: { status: "skipped", mode: "announce" },
    });
    expect(calls.filter((call) => call.method === "agent")).toHaveLength(1);
    expect(
      calls.some(
        (call) =>
          call.method === "agent" &&
          typeof (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt === "string" &&
          (call.params as { extraSystemPrompt?: string }).extraSystemPrompt?.includes(
            "Agent-to-agent reply step",
          ),
      ),
    ).toBe(false);
    expect(calls.some((call) => call.method === "send")).toBe(false);
  });

  it("sessions_send preserves threadId when announce target is hydrated via sessions.list", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let lastWaitedRunId: string | undefined;
    const replyByRunId = new Map<string, string>();
    const requesterKey = "discord:group:req";
    const targetKey = "agent:main:worker";
    let sendParams: {
      to?: string;
      channel?: string;
      accountId?: string;
      message?: string;
      threadId?: string;
    } = {};

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const params = request.params as
          | {
              sessionKey?: string;
              extraSystemPrompt?: string;
            }
          | undefined;
        let reply = "initial";
        if (params?.extraSystemPrompt?.includes("Agent-to-agent reply step")) {
          reply = params.sessionKey === requesterKey ? "pong-1" : "pong-2";
        }
        if (params?.extraSystemPrompt?.includes("Agent-to-agent announce step")) {
          reply = "announce now";
        }
        replyByRunId.set(runId, reply);
        return {
          runId,
          status: "accepted",
          acceptedAt: 3000 + agentCallCount,
        };
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string } | undefined;
        lastWaitedRunId = params?.runId;
        return { runId: params?.runId ?? "run-1", status: "ok" };
      }
      if (request.method === "chat.history") {
        const text = (lastWaitedRunId && replyByRunId.get(lastWaitedRunId)) ?? "";
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text }],
              timestamp: 20,
            },
          ],
        };
      }
      if (request.method === "sessions.list") {
        return {
          sessions: [
            {
              key: targetKey,
              deliveryContext: {
                channel: "whatsapp",
                to: "123@g.us",
                accountId: "work",
                threadId: 99,
              },
            },
          ],
        };
      }
      if (request.method === "send") {
        const params = request.params as
          | {
              to?: string;
              channel?: string;
              accountId?: string;
              message?: string;
              threadId?: string;
            }
          | undefined;
        sendParams = {
          to: params?.to,
          channel: params?.channel,
          accountId: params?.accountId,
          message: params?.message,
          threadId: params?.threadId,
        };
        return { messageId: "m-threaded-announce" };
      }
      return {};
    });
    agentStepTesting.setDepsForTest({
      agentCommandFromIngress: async () => ({
        payloads: [{ text: "announce now", mediaUrl: null }],
        meta: { durationMs: 1 },
      }),
      callGateway: (opts: unknown) => callGatewayMock(opts),
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const waited = await tool.execute("call-thread", {
      sessionKey: targetKey,
      message: "ping",
      timeoutSeconds: 1,
    });
    expect(waited.details).toMatchObject({
      status: "ok",
      reply: "initial",
    });
    await vi.waitFor(
      () => {
        expect(calls.filter((call) => call.method === "send")).toHaveLength(1);
      },
      { timeout: 2_000, interval: 5 },
    );

    expect(sendParams).toMatchObject({
      to: "123@g.us",
      channel: "whatsapp",
      accountId: "work",
      message: "announce now",
      threadId: "99",
    });
  });
});
