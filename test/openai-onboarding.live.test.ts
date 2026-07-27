// Real-key onboarding must persist an env reference and complete the default first turn.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { extractAgentReplyTexts } from "../scripts/e2e/lib/agent-turn-output.mjs";
import { readPersistedAuthProfileStoreRaw } from "../src/agents/auth-profiles/sqlite.js";
import { isLiveTestEnabled } from "../src/agents/live-test-helpers.js";
import { createOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

const execFileAsync = promisify(execFile);
const openAiApiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
const describeLive = isLiveTestEnabled() && openAiApiKey.length > 0 ? describe : describe.skip;
const replyMarker = "OPENCLAW_OPENAI_ONBOARDING_OK";

async function runOpenClaw(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const result = await execFileAsync(process.execPath, ["scripts/run-node.mjs", ...args], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 180_000,
    });
    expect(result.stdout.includes(openAiApiKey)).toBe(false);
    expect(result.stderr.includes(openAiApiKey)).toBe(false);
    return result.stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replaceAll(openAiApiKey, "[REDACTED]"));
  }
}

function assertOpenAiEnvProfile(agentDir: string): void {
  const store = readPersistedAuthProfileStoreRaw(agentDir) as {
    profiles?: Record<string, Record<string, unknown>>;
  } | null;
  expect(store?.profiles).toBeDefined();
  // Assert on booleans before inspecting the profile so a broken inline-key
  // migration can never echo a real live credential in Vitest diagnostics.
  expect(JSON.stringify(store).includes(openAiApiKey)).toBe(false);
  const profile = Object.values(store?.profiles ?? {}).find(
    (candidate) => candidate.type === "api_key" && candidate.provider === "openai",
  );
  const keyRef = profile?.keyRef as
    | { source?: unknown; provider?: unknown; id?: unknown }
    | undefined;
  expect(profile !== undefined).toBe(true);
  expect(profile?.type === "api_key").toBe(true);
  expect(profile?.provider === "openai").toBe(true);
  expect(keyRef?.source === "env").toBe(true);
  expect(keyRef?.provider === "default").toBe(true);
  expect(keyRef?.id === "OPENAI_API_KEY").toBe(true);
  expect(Object.hasOwn(profile ?? {}, "key")).toBe(false);
}

function summarizeAgentOutput(stdout: string): string {
  const trimmed = stdout.trim();
  const jsonStart = trimmed.lastIndexOf("\n{");
  const rawJson = jsonStart >= 0 ? trimmed.slice(jsonStart + 1) : trimmed;
  try {
    const payload = JSON.parse(rawJson) as {
      status?: string;
      error?: unknown;
      payloads?: Array<{ isError?: boolean; text?: string }>;
      meta?: { provider?: string; model?: string; stopReason?: string; error?: unknown };
      result?: {
        status?: string;
        payloads?: Array<{ isError?: boolean; text?: string }>;
        meta?: { provider?: string; model?: string; stopReason?: string; error?: unknown };
      };
    };
    const meta = payload.result?.meta ?? payload.meta;
    const payloads = payload.result?.payloads ?? payload.payloads ?? [];
    return JSON.stringify({
      status: payload.result?.status ?? payload.status,
      provider: meta?.provider,
      model: meta?.model,
      stopReason: meta?.stopReason,
      hasError: payload.error !== undefined || meta?.error !== undefined,
      payloadCount: payloads.length,
      errorPayloadCount: payloads.filter((entry) => entry.isError === true).length,
      outputBytes: Buffer.byteLength(stdout),
    });
  } catch {
    return JSON.stringify({ outputBytes: Buffer.byteLength(stdout), validJson: false });
  }
}

describeLive("fresh OpenAI onboarding live", () => {
  it("keeps repeated onboarding secret-safe and runs the actual default model", async () => {
    const state = await createOpenClawTestState({
      label: "openai-onboarding-live",
      layout: "state-only",
      scenario: "empty",
      applyEnv: false,
      // CLI children must take the production path, not inherit Vitest-only
      // provider discovery and runtime shortcuts from the live-test worker.
      env: {
        NODE_ENV: undefined,
        VITEST: undefined,
        VITEST_POOL_ID: undefined,
        VITEST_WORKER_ID: undefined,
        OPENCLAW_TEST_FAST: undefined,
        OPENCLAW_TEST_HOME: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        OPENCLAW_PLUGIN_CATALOG_PATHS: undefined,
        OPENCLAW_PLUGINS_PATHS: undefined,
      },
    });

    try {
      await expect(fs.access(state.configPath)).rejects.toThrow();
      const onboardArgs = [
        "onboard",
        "--non-interactive",
        "--accept-risk",
        "--mode",
        "local",
        "--auth-choice",
        "openai-api-key",
        "--secret-input-mode",
        "ref",
        "--gateway-bind",
        "loopback",
        "--skip-daemon",
        "--skip-ui",
        "--skip-skills",
        "--skip-health",
        "--suppress-gateway-token-output",
        "--json",
      ];

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await runOpenClaw(onboardArgs, state.env);
        const rawConfig = await fs.readFile(state.configPath, "utf8");
        expect(rawConfig.includes(openAiApiKey)).toBe(false);
        const config = JSON.parse(rawConfig) as {
          agents?: { defaults?: { model?: { primary?: string } } };
          gateway?: { mode?: string };
        };
        expect(config.agents?.defaults?.model?.primary).toBe("openai/gpt-5.6");
        expect(config.gateway?.mode).toBe("local");
        assertOpenAiEnvProfile(state.agentDir());
      }

      await expect(fs.access(path.join(state.agentDir(), "auth-profiles.json"))).rejects.toThrow();

      const stdout = await runOpenClaw(
        [
          "agent",
          "--local",
          "--agent",
          "main",
          "--session-id",
          "openai-onboarding-live-default",
          "--message",
          `Return exactly ${replyMarker} and no other text.`,
          "--thinking",
          "off",
          "--json",
        ],
        state.env,
      );
      expect(
        extractAgentReplyTexts(stdout).some((reply) => reply.includes(replyMarker)),
        `default OpenAI agent turn returned ${summarizeAgentOutput(stdout)}`,
      ).toBe(true);
      assertOpenAiEnvProfile(state.agentDir());
    } finally {
      await state.cleanup();
    }
  }, 300_000);
});
