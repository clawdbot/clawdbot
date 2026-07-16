import { describe, expect, it, vi } from "vitest";
import { VoiceCallConfigSchema } from "./config.js";
import type { CoreAgentDeps, CoreConfig } from "./core-bridge.js";
import { generateVoiceResponse } from "./response-generator.js";

function createAgentRuntime(payloads: Array<Record<string, unknown>>) {
  const runEmbeddedPiAgent = vi.fn(async () => ({
    payloads,
    meta: { durationMs: 12, aborted: false },
  }));

  const runtime = {
    defaults: {
      provider: "together",
      model: "Qwen/Qwen2.5-7B-Instruct-Turbo",
    },
    resolveAgentDir: () => "/tmp/openclaw/agents/main",
    resolveAgentWorkspaceDir: () => "/tmp/openclaw/workspace/main",
    resolveAgentIdentity: () => ({ name: "tester" }),
    resolveThinkingDefault: () => "off",
    resolveAgentTimeoutMs: () => 30_000,
    ensureAgentWorkspace: async () => {},
    runEmbeddedPiAgent,
    session: {
      resolveStorePath: () => "/tmp/openclaw/sessions.json",
      loadSessionStore: () => ({}),
      saveSessionStore: async () => {},
      resolveSessionFilePath: () => "/tmp/openclaw/sessions/session.jsonl",
    },
  } as unknown as CoreAgentDeps;

  return { runtime, runEmbeddedPiAgent };
}

function requireEmbeddedAgentArgs(runEmbeddedPiAgent: ReturnType<typeof vi.fn>) {
  const calls = runEmbeddedPiAgent.mock.calls as unknown[][];
  const firstCall = calls[0];
  if (!firstCall) {
    throw new Error("voice response generator did not invoke the embedded agent");
  }
  const args = firstCall[0] as
    | {
        extraSystemPrompt?: string;
        provider?: string;
        model?: string;
      }
    | undefined;
  if (!args?.extraSystemPrompt) {
    throw new Error("voice response generator did not pass the spoken-output contract prompt");
  }
  return args;
}

async function runGenerateVoiceResponse(
  payloads: Array<Record<string, unknown>>,
  overrides?: {
    runtime?: CoreAgentDeps;
    transcript?: Array<{ speaker: "user" | "bot"; text: string }>;
  },
) {
  const voiceConfig = VoiceCallConfigSchema.parse({
    responseTimeoutMs: 5000,
  });
  const coreConfig = {} as CoreConfig;
  const runtime = overrides?.runtime ?? createAgentRuntime(payloads).runtime;

  const result = await generateVoiceResponse({
    voiceConfig,
    coreConfig,
    agentRuntime: runtime,
    callId: "call-123",
    from: "+15550001111",
    transcript: overrides?.transcript ?? [{ speaker: "user", text: "hello there" }],
    userMessage: "hello there",
  });

  return { result };
}

describe("generateVoiceResponse", () => {
  it("suppresses reasoning payloads and reads structured spoken output", async () => {
    const { runtime, runEmbeddedPiAgent } = createAgentRuntime([
      { text: "Reasoning: hidden", isReasoning: true },
      { text: '{"spoken":"Hello from JSON."}' },
    ]);
    const { result } = await runGenerateVoiceResponse([], { runtime });

    expect(result.text).toBe("Hello from JSON.");
    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
    const args = requireEmbeddedAgentArgs(runEmbeddedPiAgent);
    expect(args.extraSystemPrompt).toContain('{"spoken":"..."}');
    expect(args.provider).toBe("together");
    expect(args.model).toBe("Qwen/Qwen2.5-7B-Instruct-Turbo");
  });

  it("extracts spoken text from fenced JSON", async () => {
    const { result } = await runGenerateVoiceResponse([
      { text: '```json\n{"spoken":"Fenced JSON works."}\n```' },
    ]);

    expect(result.text).toBe("Fenced JSON works.");
  });

  it("returns silence for an explicit empty spoken contract response", async () => {
    const { result } = await runGenerateVoiceResponse([{ text: '{"spoken":""}' }]);

    expect(result.text).toBeNull();
  });

  it("strips leading planning text when model returns plain text", async () => {
    const { result } = await runGenerateVoiceResponse([
      {
        text:
          "The user responded with short text. I should keep the response concise.\n\n" +
          "Sounds good. I can help with the next step whenever you are ready.",
      },
    ]);

    expect(result.text).toBe("Sounds good. I can help with the next step whenever you are ready.");
  });

  it("keeps plain conversational output when no JSON contract is followed", async () => {
    const { result } = await runGenerateVoiceResponse([
      { text: "Absolutely. Tell me what you want to do next." },
    ]);

    expect(result.text).toBe("Absolutely. Tell me what you want to do next.");
  });
});
