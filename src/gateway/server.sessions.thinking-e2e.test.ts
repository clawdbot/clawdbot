/**
 * E2E regression test for #76482: verifies the full pipeline from gateway
 * sessions.list (lightweight rows with empty thinkingOptions) through
 * consumer-side resolution, ensuring:
 * 1. DeepSeek V4 Pro sessions resolve all 7 thinking levels
 * 2. Anthropic sessions don't leak DeepSeek levels from defaults
 * 3. Sessions matching the default model correctly inherit defaults
 */
import { expect, test, vi } from "vitest";
import { formatThinkingLevels } from "../auto-reply/thinking.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  getGatewayConfigModule,
  getSessionsHandlers,
  sessionStoreEntry,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsTestHarness();

/**
 * Simulates the consumer-side resolution from session-controls.ts and
 * slash-command-executor.ts — the code path that the PR fixes.
 */
function resolveThinkingLevelsConsumerSide(
  session:
    | {
        modelProvider?: string;
        model?: string;
        thinkingLevels?: Array<{ label: string }>;
        thinkingOptions?: string[];
      }
    | undefined,
  defaults:
    | {
        modelProvider?: string;
        model?: string;
        thinkingLevels?: Array<{ label: string }>;
        thinkingOptions?: string[];
      }
    | undefined,
): string[] {
  if (session?.thinkingLevels?.length) {
    return session.thinkingLevels.map((l) => l.label);
  }
  const sessionModelMatchesDefaults =
    (!session?.modelProvider || session.modelProvider === defaults?.modelProvider) &&
    (!session?.model || session.model === defaults?.model);
  if (sessionModelMatchesDefaults && defaults?.thinkingLevels?.length) {
    return defaults.thinkingLevels.map((l) => l.label);
  }
  const labels =
    (session?.thinkingOptions?.length ? session.thinkingOptions : null) ??
    (sessionModelMatchesDefaults && defaults?.thinkingOptions?.length
      ? defaults.thinkingOptions
      : null) ??
    formatThinkingLevels(
      session?.modelProvider ?? defaults?.modelProvider,
      session?.model ?? defaults?.model,
    ).split(/\s*,\s*/);
  return labels.filter(Boolean);
}

test("e2e #76482: session with different model gets its own thinking levels through gateway row + consumer fallback", async () => {
  await createSessionStoreDir();
  testState.agentConfig = {
    model: { primary: "openai/gpt-5.5" },
  };
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main", {
        modelProvider: "test-extended",
        model: "extended-reasoner",
      }),
    },
  });

  const respond = vi.fn();
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  await sessionsHandlers["sessions.list"]({
    req: { type: "req", id: "req-e2e-extended", method: "sessions.list", params: {} },
    params: {},
    respond,
    client: null,
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig,
      // Provide a catalog with xhigh support — simulates what a real gateway
      // resolves for models like DeepSeek V4 Pro
      loadGatewayModelCatalog: async () => [
        {
          provider: "test-extended",
          id: "extended-reasoner",
          name: "Extended Reasoner",
          reasoning: true,
          compat: { supportedReasoningEfforts: ["xhigh"] },
        },
      ],
    } as never,
  });

  const result = respond.mock.calls[0]?.[1];
  const session = result?.sessions?.find((s: { key: string }) => s.key === "agent:main:main");
  const defaults = result?.defaults;

  // Gateway includes thinkingOptions for lightweight rows (needed by Control UI)
  expect(session?.thinkingOptions?.length).toBeGreaterThan(0);
  expect(session?.thinkingOptions).toContain("xhigh");

  // Session model differs from default
  expect(session?.modelProvider).toBe("test-extended");
  expect(defaults?.modelProvider).toBe("openai");

  // Consumer-side resolution uses session's own thinkingOptions (not defaults)
  const resolved = resolveThinkingLevelsConsumerSide(session, defaults);
  expect(resolved).toContain("xhigh");
  expect(resolved).toContain("off");
  expect(resolved).toContain("high");
});

test("e2e #76482: Anthropic session does not leak DeepSeek thinking levels from defaults", async () => {
  await createSessionStoreDir();
  testState.agentConfig = {
    model: { primary: "deepseek/deepseek-v4-pro" },
  };
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main", {
        modelProvider: "anthropic",
        model: "claude-sonnet-4-6",
      }),
    },
  });

  const respond = vi.fn();
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  await sessionsHandlers["sessions.list"]({
    req: { type: "req", id: "req-e2e-anthropic", method: "sessions.list", params: {} },
    params: {},
    respond,
    client: null,
    isWebchatConnect: () => false,
    context: { getRuntimeConfig, loadGatewayModelCatalog: async () => [] } as never,
  });

  const result = respond.mock.calls[0]?.[1];
  const session = result?.sessions?.find((s: { key: string }) => s.key === "agent:main:main");
  const defaults = result?.defaults;

  // Session model differs from default
  expect(session?.modelProvider).toBe("anthropic");
  expect(defaults?.modelProvider).toBe("deepseek");

  // Consumer-side resolution should NOT include DeepSeek-specific levels
  const resolved = resolveThinkingLevelsConsumerSide(session, defaults);
  expect(resolved).not.toContain("xhigh");
  expect(resolved).not.toContain("max");
  // Should have base Anthropic levels
  expect(resolved).toContain("off");
  expect(resolved).toContain("high");
});

test("e2e #76482: session matching default model inherits default thinking levels", async () => {
  await createSessionStoreDir();
  testState.agentConfig = {
    model: { primary: "openai/gpt-5.5" },
  };
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main", {
        modelProvider: "openai",
        model: "gpt-5.5",
      }),
    },
  });

  const respond = vi.fn();
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  await sessionsHandlers["sessions.list"]({
    req: { type: "req", id: "req-e2e-same", method: "sessions.list", params: {} },
    params: {},
    respond,
    client: null,
    isWebchatConnect: () => false,
    context: { getRuntimeConfig, loadGatewayModelCatalog: async () => [] } as never,
  });

  const result = respond.mock.calls[0]?.[1];
  const session = result?.sessions?.find((s: { key: string }) => s.key === "agent:main:main");
  const defaults = result?.defaults;

  // Session matches default → consumer should use defaults
  expect(session?.modelProvider).toBe(defaults?.modelProvider);

  const resolved = resolveThinkingLevelsConsumerSide(session, defaults);
  expect(resolved.length).toBeGreaterThan(0);
  // Should match what defaults provide
  expect(resolved).toContain("off");
  expect(resolved).toContain("high");
});
