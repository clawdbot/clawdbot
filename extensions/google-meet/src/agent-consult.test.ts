import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import type {
  RealtimeVoiceBridgeSession,
  TalkEventInput,
} from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import { handleGoogleMeetRealtimeConsultToolCall } from "./agent-consult.js";
import { resolveGoogleMeetConfig } from "./config.js";

function makeSession(
  submitToolResult: RealtimeVoiceBridgeSession["submitToolResult"],
  supportsToolResultContinuation = false,
): RealtimeVoiceBridgeSession {
  return {
    bridge: { supportsToolResultContinuation },
    submitToolResult,
  } as unknown as RealtimeVoiceBridgeSession;
}

function makeRuntime() {
  const sessions: Record<string, Record<string, unknown>> = {};
  const runEmbeddedAgent = vi.fn(async () => ({
    payloads: [{ text: "Use the launch summary." }],
    meta: {},
  }));
  const runtime = {
    agent: {
      resolveAgentDir: vi.fn(() => "/tmp/agent"),
      resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
      ensureAgentWorkspace: vi.fn(async () => {}),
      resolveAgentTimeoutMs: vi.fn(() => 1_000),
      session: {
        resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
        loadSessionStore: vi.fn(() => sessions),
        saveSessionStore: vi.fn(async () => {}),
        updateSessionStore: vi.fn(
          async (
            _storePath: string,
            update: (store: Record<string, Record<string, unknown>>) => unknown,
          ) => await update(sessions),
        ),
        getSessionEntry: vi.fn(({ sessionKey }: { sessionKey: string }) => sessions[sessionKey]),
        patchSessionEntry: vi.fn(
          async ({
            sessionKey,
            fallbackEntry,
            update,
          }: {
            sessionKey: string;
            fallbackEntry: Record<string, unknown>;
            update: (
              entry: Record<string, unknown>,
            ) => Promise<Record<string, unknown>> | Record<string, unknown>;
          }) => {
            const current = sessions[sessionKey] ?? fallbackEntry;
            const patch = await update(current);
            const next = { ...current, ...patch };
            sessions[sessionKey] = next;
            return next;
          },
        ),
        resolveSessionFilePath: vi.fn(() => "/tmp/session.json"),
      },
      runEmbeddedAgent,
    },
  } as unknown as PluginRuntime;
  return { runEmbeddedAgent, runtime };
}

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as RuntimeLogger;

describe("handleGoogleMeetRealtimeConsultToolCall", () => {
  it("emits a final tool event only after the bridge accepts the result", async () => {
    let acceptResult = () => {};
    const accepted = new Promise<void>((resolve) => {
      acceptResult = resolve;
    });
    const submitToolResult = vi.fn(() => accepted);
    const events: TalkEventInput[] = [];

    const handled = handleGoogleMeetRealtimeConsultToolCall({
      strategy: "agent",
      session: makeSession(submitToolResult),
      event: {
        itemId: "item-1",
        callId: "call-1",
        name: "openclaw_agent_consult",
        args: { question: "What should I say?" },
      },
      config: resolveGoogleMeetConfig({}),
      fullConfig: {},
      runtime: {} as PluginRuntime,
      logger,
      meetingSessionId: "meet-1",
      transcript: [],
      onTalkEvent: (event) => events.push(event),
    });

    expect(submitToolResult).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    acceptResult();
    await handled;
    expect(events).toEqual([
      expect.objectContaining({ type: "tool.error", callId: "call-1", final: true }),
    ]);
  });

  it("does not retry a rejected result submission as a second tool error", async () => {
    const deliveryError = new Error("result delivery failed");
    const submitToolResult = vi.fn(async () => {
      throw deliveryError;
    });
    const events: TalkEventInput[] = [];
    const { runEmbeddedAgent, runtime } = makeRuntime();

    await expect(
      handleGoogleMeetRealtimeConsultToolCall({
        strategy: "bidi",
        session: makeSession(submitToolResult),
        event: {
          itemId: "item-1",
          callId: "call-1",
          name: "openclaw_agent_consult",
          args: { question: "What should I say?" },
        },
        config: resolveGoogleMeetConfig({ realtime: { agentId: "jay" } }),
        fullConfig: {},
        runtime,
        logger,
        meetingSessionId: "meet-1",
        transcript: [],
        onTalkEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow("result delivery failed");

    expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
    expect(submitToolResult).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).toEqual(["tool.progress"]);
  });
});
