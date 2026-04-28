import { streamOpenAIResponses, type AssistantMessage, type Model } from "@mariozechner/pi-ai";
import { buildCopilotDynamicHeaders } from "openclaw/plugin-sdk/provider-stream-shared";
import { describe, expect, it } from "vitest";
import { resolveFirstGithubToken } from "./auth.js";
import { wrapCopilotOpenAIResponsesStream } from "./stream.js";
import { resolveCopilotApiToken } from "./token.js";

const LIVE =
  process.env.OPENCLAW_LIVE_TEST === "1" ||
  process.env.LIVE === "1" ||
  process.env.GITHUB_COPILOT_LIVE_TEST === "1";
const ENV_GITHUB_TOKEN =
  process.env.OPENCLAW_LIVE_GITHUB_COPILOT_TOKEN ??
  process.env.COPILOT_GITHUB_TOKEN ??
  process.env.GH_TOKEN ??
  process.env.GITHUB_TOKEN ??
  "";
const LIVE_MODEL_ID = process.env.OPENCLAW_LIVE_GITHUB_COPILOT_MODEL?.trim() || "gpt-5.4";
const describeLive = LIVE ? describe : describe.skip;

type CopilotApiToken = {
  token: string;
  expiresAt: number;
  source: string;
  baseUrl: string;
};

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

function logProgress(message: string): void {
  process.stderr.write(`[github-copilot-live] ${message}\n`);
}

async function withTimeout<T>(label: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

const fetchWithTimeout: typeof fetch = async (input, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  timer.unref?.();
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
};

function buildModel(baseUrl: string): Model<"openai-responses"> {
  return {
    id: LIVE_MODEL_ID,
    name: LIVE_MODEL_ID,
    provider: "github-copilot",
    api: "openai-responses",
    baseUrl,
    headers: {},
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 256,
  };
}

function buildReplayAssistantMessage(connectionBoundId: string): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "github-copilot",
    model: LIVE_MODEL_ID,
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp: Date.now() - 1,
    content: [
      {
        type: "text",
        text: "Earlier assistant text.",
        textSignature: JSON.stringify({ v: 1, id: connectionBoundId }),
      },
    ],
  };
}

async function resolveGithubTokenCandidates(): Promise<Array<{ source: string; token: string }>> {
  const candidates: Array<{ source: string; token: string }> = [];
  const envToken = ENV_GITHUB_TOKEN.trim();
  if (envToken) {
    candidates.push({ source: "env", token: envToken });
  }

  const profileEnv = {
    ...process.env,
    COPILOT_GITHUB_TOKEN: "",
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
  };
  const profile = await resolveFirstGithubToken({ env: profileEnv });
  const profileToken = profile.githubToken.trim();
  if (profileToken && !candidates.some((candidate) => candidate.token === profileToken)) {
    candidates.push({ source: "auth-profile", token: profileToken });
  }
  return candidates;
}

function extractText(response: unknown): string {
  const content = (response as { content?: Array<{ type?: string; text?: string }> }).content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text?.trim() ?? "")
    .filter(Boolean)
    .join(" ");
}

describeLive("github-copilot connection-bound Responses IDs live", () => {
  it("rewrites replayed connection-bound item IDs before sending to Copilot", async () => {
    logProgress("start");
    const candidates = await resolveGithubTokenCandidates();
    if (candidates.length === 0) {
      logProgress("skip (no GitHub Copilot token found in env or auth profile)");
      return;
    }

    let token: CopilotApiToken | undefined;
    const failures: string[] = [];
    for (const candidate of candidates) {
      try {
        logProgress(`exchanging ${candidate.source} GitHub token for Copilot token`);
        token = await withTimeout(
          "Copilot token exchange",
          resolveCopilotApiToken({
            githubToken: candidate.token,
            fetchImpl: fetchWithTimeout,
          }),
          15_000,
        );
        logProgress(
          `token ok via ${candidate.source} (${token.source.startsWith("cache:") ? "cache" : "fetched"})`,
        );
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${candidate.source}: ${message}`);
        logProgress(`token exchange failed via ${candidate.source} (${message})`);
      }
    }
    if (!token) {
      throw new Error(`Copilot token exchange failed for all candidates: ${failures.join("; ")}`);
    }

    const model = buildModel(token.baseUrl);
    const staleId = Buffer.from(`copilot-${"x".repeat(24)}`).toString("base64");
    const context = {
      messages: [
        buildReplayAssistantMessage(staleId),
        {
          role: "user" as const,
          content: "Reply with exactly: COPILOT_LIVE_OK",
          timestamp: Date.now(),
        },
      ],
    };
    let capturedPayload: Record<string, unknown> | undefined;

    const wrappedStream = wrapCopilotOpenAIResponsesStream(streamOpenAIResponses as never);
    if (!wrappedStream) {
      throw new Error("expected Copilot Responses stream wrapper");
    }
    const stream = wrappedStream(
      model as never,
      context as never,
      {
        apiKey: token.token,
        headers: buildCopilotDynamicHeaders({
          messages: context.messages,
          hasImages: false,
        }),
        maxTokens: 32,
        onPayload: (payload: unknown) => {
          capturedPayload = payload as Record<string, unknown>;
        },
      } as never,
    ) as { result(): Promise<unknown> };

    logProgress("sending Responses request");
    const result = await stream.result();
    logProgress("Responses request completed");
    const input = Array.isArray(capturedPayload?.input) ? capturedPayload.input : [];
    const replayedAssistant = input.find(
      (item): item is Record<string, unknown> =>
        !!item && typeof item === "object" && (item as Record<string, unknown>).type === "message",
    );

    expect(replayedAssistant?.id).toMatch(/^msg_[a-f0-9]{16}$/);
    expect(replayedAssistant?.id).not.toBe(staleId);
    expect(extractText(result)).toMatch(/^COPILOT_LIVE_OK[.!]?$/i);
  }, 60_000);
});
