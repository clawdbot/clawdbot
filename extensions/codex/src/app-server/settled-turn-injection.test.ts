import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it, vi } from "vitest";
import { runBoundedCodexAppServerTurn } from "./bounded-turn.js";
import {
  createFakeCodexAppServerClient,
  threadStartResult as createThreadStartResult,
  turnStartResult,
} from "./codex-app-server.test-fixtures.js";
import { setManagedCodexPluginRoot } from "./managed-binary.js";
import { projectSettledCodexMessages } from "./settled-turn-projection.js";
import type { CodexAppServerClientFactory } from "./shared-client.js";

function codexModel(model = "gpt-5.4", id = model) {
  return {
    id,
    model,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: id,
    description: "test model",
    hidden: false,
    isDefault: true,
    inputModalities: ["text"],
    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "fast" }],
    defaultReasoningEffort: "low",
    supportsPersonality: false,
    multiAgentVersion: null,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
  };
}

function threadStartResult(model: string) {
  const result = createThreadStartResult("thread-finalizer", "/tmp/finalizer");
  return {
    ...result,
    thread: { ...result.thread, sessionId: "session-finalizer", ephemeral: true },
    model,
    modelProvider: "openai",
    approvalPolicy: "on-request",
    sandbox: { type: "readOnly", networkAccess: false },
  };
}

function message(value: unknown): AgentMessage {
  return value as AgentMessage;
}

// Matches the 83-character identifier OpenAI rejected in issue #130965.
const OVERLENGTH_CALL_ID = `call_${"a".repeat(78)}`;

describe("settled-turn injection boundary", () => {
  it("puts only contract-length call ids on the thread/inject_items wire", async () => {
    expect(OVERLENGTH_CALL_ID).toHaveLength(83);
    setManagedCodexPluginRoot("/tmp/synthetic-codex-plugin-root");

    const historyItems = projectSettledCodexMessages([
      message({ role: "user", content: "Send the update." }),
      message({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: OVERLENGTH_CALL_ID,
            name: "message",
            arguments: { action: "send" },
          },
        ],
      }),
      message({
        role: "toolResult",
        toolCallId: OVERLENGTH_CALL_ID,
        toolName: "message",
        content: [{ type: "text", text: "Message sent." }],
      }),
    ]);

    const fixture = createFakeCodexAppServerClient(async (method: string, params?: unknown) => {
      if (method === "model/list") {
        return { data: [codexModel()], nextCursor: null };
      }
      if (method === "config/read") {
        return { config: {}, layers: [{ name: { type: "user" } }] };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "thread/start" && isRecord(params) && typeof params.model === "string") {
        return threadStartResult(params.model);
      }
      if (method === "mcpServerStatus/list") {
        return { data: [], nextCursor: null };
      }
      if (method === "turn/start") {
        return turnStartResult();
      }
      return {};
    });
    const client = Object.assign(fixture.client, { close: vi.fn() });
    const factory = vi.fn(async () => client) as unknown as CodexAppServerClientFactory;

    // The turn never completes here; the injected payload is the subject, and
    // bounded-turn sends it before turn/start.
    await runBoundedCodexAppServerTurn({
      model: { mode: "required", id: "gpt-5.4" },
      preparedAuth: { kind: "api-key", apiKey: "synthetic-not-a-real-key" },
      authRequirement: "api-key",
      timeoutMs: 200,
      options: { clientFactory: factory, pluginConfig: { appServer: { homeScope: "user" } } },
      taskLabel: "settled-turn finalization",
      developerInstructions: "Produce the final user-visible answer now.",
      input: [{ type: "text", text: "Finalize.", text_elements: [] }],
      requiredModalities: ["text"],
      isolation: "private-stdio",
      requireNoExternalCapabilities: true,
      historyItems,
    }).catch(() => undefined);

    const injected = (fixture.request.mock.calls as [string, unknown][]).find(
      ([method]) => method === "thread/inject_items",
    );
    expect(injected).toBeDefined();

    const items = (injected?.[1] as { items?: unknown[] })?.items ?? [];
    const callIds = items.flatMap((item) =>
      isRecord(item) && typeof item.call_id === "string" ? [item.call_id] : [],
    );

    // Codex forwards these verbatim to the Responses API, which caps call_id at 64.
    expect(callIds).toHaveLength(2);
    for (const callId of callIds) {
      expect(callId.length).toBeLessThanOrEqual(64);
      expect(callId).toMatch(/^call_[A-Za-z0-9_-]{1,59}$/);
    }
    expect(new Set(callIds).size).toBe(1);
  });
});
