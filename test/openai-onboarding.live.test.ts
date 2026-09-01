// Real-key onboarding must persist an env reference and complete the default first turn.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { extractAgentReplyTexts } from "../scripts/e2e/lib/agent-turn-output.mjs";
import { terminateManagedChild } from "../scripts/lib/managed-child-process.mts";
import { readPersistedSharedAuthProfileStoreRaw } from "../src/agents/auth-profiles/sqlite.js";
import { isLiveTestEnabled } from "../src/agents/live-test-helpers.js";
import {
  loadTranscriptEvents,
  resolveTranscriptSessionKeyBySessionId,
} from "../src/config/sessions/session-accessor.js";
import { createOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";
import { getDeterministicFreePortBlock } from "../src/test-utils/ports.js";

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
    throw new Error(message.replaceAll(openAiApiKey, "[REDACTED]"), { cause: error });
  }
}

function assertOpenAiEnvProfile(env: NodeJS.ProcessEnv): void {
  const store = readPersistedSharedAuthProfileStoreRaw(env) as {
    profiles?: Record<string, Record<string, unknown>>;
  } | null;
  expect(store?.profiles).toBeDefined();
  // Assert on booleans before inspecting the profile so a broken inline-key
  // migration can never echo a real live credential in Vitest diagnostics.
  expect(JSON.stringify(store).includes(openAiApiKey)).toBe(false);
  const profile = store?.profiles?.["openai:api-key"];
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

function hasPersistedTranscriptMessage(
  events: unknown[],
  role: "user" | "assistant",
  expectedText: string,
): boolean {
  return events.some((event) => {
    if (typeof event !== "object" || event === null) {
      return false;
    }
    const record = event as { type?: unknown; message?: unknown };
    if (record.type !== "message" || typeof record.message !== "object" || !record.message) {
      return false;
    }
    const message = record.message as { role?: unknown; content?: unknown };
    if (message.role !== role) {
      return false;
    }
    if (typeof message.content === "string") {
      return message.content.includes(expectedText);
    }
    return (
      Array.isArray(message.content) &&
      message.content.some(
        (part: unknown) =>
          typeof part === "object" &&
          part !== null &&
          typeof (part as { text?: unknown }).text === "string" &&
          (part as { text: string }).text.includes(expectedText),
      )
    );
  });
}

async function waitForIsolatedGatewayReady(gateway: ChildProcess, port: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  let startupError = false;
  gateway.once("error", () => {
    startupError = true;
  });

  while (Date.now() < deadline) {
    if (startupError || gateway.exitCode !== null || gateway.signalCode !== null) {
      throw new Error("isolated onboarding gateway exited before becoming ready");
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const readiness = (await response.json()) as {
          ready?: boolean;
          failing?: unknown[];
        };
        if (readiness.ready === true && (readiness.failing?.length ?? 0) === 0) {
          return;
        }
      }
    } catch {
      // Startup is complete only when the owned gateway reports real readiness.
    }

    await delay(250);
  }

  throw new Error("isolated onboarding gateway did not report ready");
}

async function stopIsolatedGateway(gateway: ChildProcess | undefined): Promise<void> {
  if (!gateway || gateway.exitCode !== null || gateway.signalCode !== null) {
    return;
  }

  const exited = once(gateway, "exit").then(() => true);
  terminateManagedChild(gateway);
  if (!(await Promise.race([exited, delay(5_000, false)]))) {
    terminateManagedChild(gateway, "SIGKILL");
    await Promise.race([exited, delay(5_000)]);
  }
}

describeLive("fresh OpenAI onboarding live", () => {
  it("keeps repeated onboarding secret-safe and runs the actual default model", async () => {
    const state = await createOpenClawTestState({
      label: "openai-onboarding-live",
      layout: "home",
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
        OPENCLAW_WORKSPACE_DIR: undefined,
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_URL: undefined,
        OPENCLAW_GATEWAY_PORT: undefined,
      },
    });

    let gateway: ChildProcess | undefined;
    try {
      const gatewayPort = await getDeterministicFreePortBlock({ offsets: [0, 1, 2, 4] });
      expect(state.env.HOME).toBe(state.home);
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
        "--gateway-port",
        String(gatewayPort),
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
          agents?: { defaults?: { model?: { primary?: string }; workspace?: string } };
          gateway?: { mode?: string; auth?: { mode?: string; token?: unknown } };
        };
        expect(config.agents?.defaults?.model?.primary).toBe("openai/gpt-5.6-sol");
        expect(config.agents?.defaults?.workspace).toBe(
          path.join(state.home, ".openclaw", "workspace"),
        );
        expect(config.gateway?.mode).toBe("local");
        expect(config.gateway?.auth?.mode).toBe("token");
        expect(config.gateway?.auth?.token).toEqual({
          source: "store",
          provider: "default",
          id: "OPENCLAW_GATEWAY_TOKEN",
        });
        assertOpenAiEnvProfile(state.env);
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
      assertOpenAiEnvProfile(state.env);

      gateway = spawn(
        process.execPath,
        [
          "scripts/run-node.mjs",
          "gateway",
          "run",
          "--bind",
          "loopback",
          "--port",
          String(gatewayPort),
        ],
        {
          cwd: path.resolve(import.meta.dirname, ".."),
          detached: process.platform !== "win32",
          env: state.env,
          stdio: "ignore",
        },
      );
      await waitForIsolatedGatewayReady(gateway, gatewayPort);
      await runOpenClaw(["health", "--json"], state.env);

      const gatewaySessionId = "openai-onboarding-live-gateway";
      const gatewayPrompt = `Return exactly ${replyMarker} and no other text.`;
      const gatewayStdout = await runOpenClaw(
        [
          "agent",
          "--agent",
          "main",
          "--session-id",
          gatewaySessionId,
          "--message",
          gatewayPrompt,
          "--thinking",
          "off",
          "--json",
        ],
        state.env,
      );
      expect(
        extractAgentReplyTexts(gatewayStdout).some((reply) => reply.includes(replyMarker)),
        `gateway-backed OpenAI agent turn returned ${summarizeAgentOutput(gatewayStdout)}`,
      ).toBe(true);
      const transcriptScope = {
        agentId: "main",
        env: state.env,
        sessionId: gatewaySessionId,
      };
      const persistedSessionKey = resolveTranscriptSessionKeyBySessionId(transcriptScope);
      expect(typeof persistedSessionKey === "string" && persistedSessionKey.length > 0).toBe(true);
      const persistedEvents = await loadTranscriptEvents({
        ...transcriptScope,
        ...(persistedSessionKey ? { sessionKey: persistedSessionKey } : {}),
      });
      expect(hasPersistedTranscriptMessage(persistedEvents, "user", gatewayPrompt)).toBe(true);
      expect(hasPersistedTranscriptMessage(persistedEvents, "assistant", replyMarker)).toBe(true);
      assertOpenAiEnvProfile(state.env);
    } finally {
      await stopIsolatedGateway(gateway);
      await state.cleanup();
    }
  }, 300_000);
});
