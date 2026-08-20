/**
 * E2E regression test for #76482: verifies the full pipeline from gateway
 * sessions.list (lightweight rows with empty thinkingOptions) through
 * consumer-side resolution, ensuring:
 * 1. DeepSeek V4 Pro sessions resolve all 7 thinking levels
 * 2. Anthropic sessions don't leak DeepSeek levels from defaults
 * 3. Sessions matching the default model correctly inherit defaults
 */

import { expectDefined } from "@openclaw/normalization-core";
import { expect, test, vi } from "vitest";
import { formatThinkingLevels } from "../auto-reply/thinking.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
  getGatewayConfigModule,
  getSessionsHandlers,
  sessionStoreEntry,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

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
  const resolvedLabels: string[] = [];
  for (const label of labels) {
    if (label) {
      resolvedLabels.push(label);
    }
  }
  return resolvedLabels;
}

function firstResponseResult(respond: ReturnType<typeof vi.fn>) {
  return respond.mock.calls[0]?.[1];
}

type ThinkingSession = {
  key: string;
  modelProvider?: string;
  model?: string;
  agentRuntime?: { id?: string };
  thinkingLevel?: string;
  thinkingLevels?: Array<{ label: string }>;
  thinkingOptions?: string[];
};

type SessionsListResult = {
  sessions?: ThinkingSession[];
  defaults?: Parameters<typeof resolveThinkingLevelsConsumerSide>[1];
};

async function listMainSessionWithThinking(params: {
  reqId: string;
  primaryModel: string;
  sessionModelProvider: string;
  sessionModel: string;
  agentRuntime?: "codex" | "openclaw";
  selectedByOverride?: boolean;
  thinkingLevel?: string;
  readPreparedGatewayModelCatalog?: () => Promise<
    Array<{
      provider: string;
      id: string;
      name: string;
      reasoning: boolean;
      compat?: { supportedReasoningEfforts?: string[] };
    }>
  >;
}) {
  await createSessionStoreDir();
  testState.agentConfig = {
    model: { primary: params.primaryModel },
    ...(params.agentRuntime
      ? {
          models: {
            [params.primaryModel]: { agentRuntime: { id: params.agentRuntime } },
          },
        }
      : {}),
  };
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main", {
        modelProvider: params.sessionModelProvider,
        model: params.sessionModel,
        ...(params.thinkingLevel ? { thinkingLevel: params.thinkingLevel } : {}),
        ...(params.selectedByOverride === false
          ? {}
          : {
              providerOverride: params.sessionModelProvider,
              modelOverride: params.sessionModel,
            }),
      }),
    },
  });

  const respond = vi.fn();
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  await expectDefined(
    sessionsHandlers["sessions.list"],
    'sessionsHandlers["sessions.list"] test invariant',
  )({
    req: { type: "req", id: params.reqId, method: "sessions.list", params: {} },
    params: {},
    respond,
    client: null,
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig,
      readPreparedGatewayModelCatalog: params.readPreparedGatewayModelCatalog ?? (async () => []),
    } as never,
  });

  const result = firstResponseResult(respond) as SessionsListResult | undefined;
  return {
    session: result?.sessions?.find((s) => s.key === "agent:main:main"),
    defaults: result?.defaults,
  };
}

test("e2e #76482: session with different model gets its own thinking levels through gateway row + consumer fallback", async () => {
  const { session, defaults } = await listMainSessionWithThinking({
    reqId: "req-e2e-extended",
    primaryModel: "openai/gpt-5.5",
    sessionModelProvider: "test-extended",
    sessionModel: "extended-reasoner",
    readPreparedGatewayModelCatalog: async () => [
      // Provide a catalog with xhigh support — simulates what a real gateway
      // resolves for models like DeepSeek V4 Pro
      {
        provider: "test-extended",
        id: "extended-reasoner",
        name: "Extended Reasoner",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["xhigh"] },
      },
    ],
  });

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
  const { session, defaults } = await listMainSessionWithThinking({
    reqId: "req-e2e-anthropic",
    primaryModel: "deepseek/deepseek-v4-pro",
    sessionModelProvider: "anthropic",
    sessionModel: "claude-sonnet-4-6",
  });

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
  const { session, defaults } = await listMainSessionWithThinking({
    reqId: "req-e2e-same",
    primaryModel: "openai/gpt-5.5",
    sessionModelProvider: "openai",
    sessionModel: "gpt-5.5",
  });

  // Session matches default → consumer should use defaults
  expect(session?.modelProvider).toBe(defaults?.modelProvider);

  const resolved = resolveThinkingLevelsConsumerSide(session, defaults);
  expect(resolved.length).toBeGreaterThan(0);
  // Should match what defaults provide
  expect(resolved).toContain("off");
  expect(resolved).toContain("high");
});

test("session rows keep the selected Codex Sol model when runtime metadata contains a response family", async () => {
  const loadSolCatalog = async () => [
    {
      provider: "openai",
      id: "gpt-5.6-sol",
      name: "GPT-5.6-Sol",
      reasoning: true,
      compat: {
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      },
    },
  ];
  const { session } = await listMainSessionWithThinking({
    reqId: "req-e2e-codex-sol-family",
    primaryModel: "openai/gpt-5.6-sol",
    sessionModelProvider: "openai",
    sessionModel: "gpt-5.6",
    agentRuntime: "codex",
    selectedByOverride: false,
    readPreparedGatewayModelCatalog: loadSolCatalog,
  });

  expect(session).toMatchObject({
    modelProvider: "openai",
    model: "gpt-5.6-sol",
  });
  expect(session?.agentRuntime?.id).toBe("codex");
  expect(session?.thinkingOptions).toContain("max");

  const patchResponse = await directSessionReq(
    "sessions.patch",
    { key: "main", thinkingLevel: "max" },
    { context: { loadGatewayModelCatalog: loadSolCatalog } },
  );
  expect(patchResponse.ok, patchResponse.error?.message).toBe(true);
  expect(patchResponse.error).toBeUndefined();
  expect(patchResponse.payload).toMatchObject({
    ok: true,
    resolved: {
      modelProvider: "openai",
      model: "gpt-5.6-sol",
      thinkingLevel: "max",
    },
  });
});

test("unsupported generic stored levels clamp through the current profile", async () => {
  const { session } = await listMainSessionWithThinking({
    reqId: "req-e2e-generic-ultra",
    primaryModel: "test-generic/reasoner",
    sessionModelProvider: "test-generic",
    sessionModel: "reasoner",
    agentRuntime: "codex",
    thinkingLevel: "ultra",
    readPreparedGatewayModelCatalog: async () => [
      {
        provider: "test-generic",
        id: "reasoner",
        name: "Generic Reasoner",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["max"] },
      },
    ],
  });

  expect(session?.thinkingOptions).not.toContain("ultra");
  expect(session?.thinkingLevel).toBe("max");
});
