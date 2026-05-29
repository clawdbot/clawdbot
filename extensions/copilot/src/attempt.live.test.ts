import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { AgentHarnessAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { createCopilotAgentHarness, type CopilotClientPool } from "../harness.js";

const liveToolState = vi.hoisted(() => ({
  calls: [] as string[],
  expectedText: "phase-1-green",
  sentinelPrefix: "copilot-live-smoke:",
  toolName: "live_echo",
}));

vi.mock("openclaw/plugin-sdk/agent-harness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness")>();

  return {
    ...actual,
    createOpenClawCodingTools: vi.fn(() => [
      {
        name: liveToolState.toolName,
        label: liveToolState.toolName,
        description: "Echo the requested text for the copilot live smoke test.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: {
              type: "string",
              description: "Text to echo back to the model.",
            },
          },
          required: ["text"],
        },
        async execute(_toolCallId: string, params: unknown) {
          const textInput =
            params && typeof params === "object" && !Array.isArray(params)
              ? (params as { text?: unknown }).text
              : undefined;
          const text = typeof textInput === "string" ? textInput : "";
          const echoed = `${liveToolState.sentinelPrefix}${text}`;
          liveToolState.calls.push(text);
          console.info(
            `[copilot-live-smoke] ${liveToolState.toolName} ${JSON.stringify({ echoed, text })}`,
          );
          return {
            content: [{ type: "text", text: echoed }],
            details: { echoed },
          };
        },
      },
    ]),
  };
});

const LIVE = isLiveTestEnabled(["OPENCLAW_COPILOT_AGENT_LIVE_TEST"]);
const TOKEN =
  process.env.OPENCLAW_COPILOT_AGENT_LIVE_TOKEN ||
  process.env.GITHUB_TOKEN ||
  process.env.GH_TOKEN ||
  "";
const describeLive = LIVE && TOKEN ? describe : describe.skip;

function createApproveAllPool(): CopilotClientPool {
  const activeClients = new Set<CopilotClient>();

  return {
    async acquire(key, options) {
      const client = new CopilotClient(options);
      activeClients.add(client);
      return {
        key,
        client: {
          createSession: (config: Parameters<CopilotClient["createSession"]>[0]) =>
            client.createSession({ ...config, onPermissionRequest: approveAll }),
          resumeSession: (
            sessionId: Parameters<CopilotClient["resumeSession"]>[0],
            config: Parameters<CopilotClient["resumeSession"]>[1],
          ) => client.resumeSession(sessionId, { ...config, onPermissionRequest: approveAll }),
          stop: () => client.stop(),
        } as unknown as CopilotClient,
      };
    },
    async dispose() {
      const errors: Error[] = [];
      for (const client of activeClients) {
        try {
          errors.push(...(await client.stop()));
        } catch (error) {
          errors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
      activeClients.clear();
      return errors;
    },
    async release() {},
    size() {
      return activeClients.size;
    },
  };
}

function createAttemptParams(params: {
  copilotHome: string;
  onAssistantDelta: (payload: { text: string }) => void | Promise<void>;
  prompt: string;
}): AgentHarnessAttemptParams {
  const profileId = "live-smoke-profile";
  const profileVersion = "v1";
  const now = Date.now();

  return {
    agentDir: params.copilotHome,
    agentId: "copilot-live-smoke",
    auth: {
      gitHubToken: TOKEN,
      profileId,
      profileVersion,
    },
    authProfileId: profileId,
    copilotHome: params.copilotHome,
    cwd: process.cwd(),
    messages: [{ content: params.prompt, role: "user", timestamp: now }],
    model: {
      api: "openai-responses",
      id: "gpt-4.1",
      provider: "github-copilot",
    },
    modelId: "gpt-4.1",
    onAssistantDelta: params.onAssistantDelta,
    profileVersion,
    prompt: params.prompt,
    provider: "github-copilot",
    runId: `copilot-live-smoke-${now}`,
    sessionFile: join(params.copilotHome, "copilot-live-smoke.session.json"),
    sessionId: `copilot-live-smoke-session-${now}`,
    timeoutMs: 90_000,
    workspaceDir: process.cwd(),
  } as unknown as AgentHarnessAttemptParams;
}

describeLive("copilot agent runtime live smoke", () => {
  it("runs one turn on gpt-4.1 with one custom tool", async () => {
    liveToolState.calls.length = 0;
    const streamedTexts: string[] = [];
    const prompt = `Use the ${liveToolState.toolName} tool exactly once with text '${liveToolState.expectedText}', then reply with exactly two short sentences totaling at least twelve words.`;
    const copilotHome = await mkdtemp(join(tmpdir(), "openclaw-copilot-live-"));
    const harness = createCopilotAgentHarness({ pool: createApproveAllPool() });

    expect(
      harness.supports({
        provider: "github-copilot",
        modelId: "gpt-4.1",
        requestedRuntime: "copilot",
      }),
    ).toEqual({ supported: true, priority: 100 });

    try {
      const result = await harness.runAttempt(
        createAttemptParams({
          copilotHome,
          onAssistantDelta: ({ text }) => {
            if (text.trim()) {
              streamedTexts.push(text);
            }
          },
          prompt,
        }),
      );
      const assistantText = result.assistantTexts.join("\n").trim();
      const hasAssistantText = result.assistantTexts.some((text) => text.trim().length > 0);
      const matchingCalls = liveToolState.calls.filter(
        (text) => text === liveToolState.expectedText,
      );
      const usage = result.attemptUsage;

      console.info(
        "[copilot-live-smoke] summary",
        JSON.stringify(
          {
            assistantText,
            toolCalls: liveToolState.calls,
            streamedTexts,
            toolMetas: result.toolMetas,
            usage,
          },
          null,
          2,
        ),
      );

      expect(result.promptError).toBeUndefined();
      expect(result.timedOut).toBe(false);
      expect(matchingCalls.length).toBeGreaterThanOrEqual(1);
      expect(hasAssistantText).toBe(true);
      expect(assistantText.length).toBeGreaterThan(0);
      expect((usage?.input ?? 0) + (usage?.output ?? 0)).toBeGreaterThan(0);
      expect(
        result.toolMetas.some(
          (toolMeta) =>
            toolMeta.toolName === liveToolState.toolName &&
            toolMeta.meta?.includes(liveToolState.sentinelPrefix),
        ),
      ).toBe(true);
    } finally {
      await harness.dispose?.();
      await rm(copilotHome, { recursive: true, force: true });
    }
  }, 90_000);
});
