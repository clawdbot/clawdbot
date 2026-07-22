// Control Ui Mock Dev script supports OpenClaw repository automation.
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import type { UserProfile } from "../packages/gateway-protocol/src/index.js";
import { expectDefined } from "../packages/normalization-core/src/expect.js";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../src/gateway/control-ui-contract.js";
import {
  createControlUiMockBootstrapConfig,
  createControlUiMockGatewayInitScript,
  type ControlUiMockGatewayScenario,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import {
  resolveExternalPackageAliasesForVite,
  resolveSourcePackageAliasesForVite,
  resolveTsconfigPathAliasesForVite,
} from "../ui/vite.config.ts";
import { buildBackgroundTasksMock } from "./control-ui-mock-background-tasks.ts";
import { buildChannelsStatusMock, buildChannelWizardMocks } from "./control-ui-mock-channels.ts";
import { buildPluginCatalogMock } from "./control-ui-mock-plugins.ts";
import { buildSkillWorkshopMocks } from "./control-ui-mock-skill-workshop.js";

type CliOptions = {
  allowedHosts: string[];
  fixture?: "board";
  host: string;
  port: number;
};

type SessionListOptions = {
  hasMore: boolean;
  nextOffset: number | null;
  offset?: number;
  totalCount: number;
};

const SESSION_PAGE_SIZE = 50;
const TOTAL_MOCK_SESSIONS = 650;
const TOTAL_TELEGRAM_SESSIONS = 180;
const ATTENTION_FIXTURE_EXPIRES_AT = Date.parse("2099-01-01T00:00:00.000Z");
const NARRATION_DEMO_SESSION_KEY = "agent:main:sidebar-narration-demo";
const NARRATION_DEMO_RUN_ID = "mock-sidebar-narration-run";
const OBSERVER_DEMO_SESSION_KEY = "agent:main:session-observer-demo";
const OBSERVER_DEMO_RUN_ID = "mock-session-observer-run";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiRoot = path.join(repoRoot, "ui");
const boardFixturePath = "/__fixtures/board/";
const boardFixtureHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="dark light" />
    <title>OpenClaw Board Fixture</title>
    <script>
      // This standalone fixture bypasses app bootstrap, so mirror its root theme contract.
      const mediaQuery = matchMedia("(prefers-color-scheme: light)");
      const applyTheme = () => {
        const mode = mediaQuery.matches ? "light" : "dark";
        document.documentElement.dataset.theme = mode;
        document.documentElement.dataset.themeMode = mode;
        document.documentElement.classList.toggle("wa-light", mode === "light");
        document.documentElement.classList.toggle("wa-dark", mode === "dark");
        document.documentElement.style.colorScheme = mode;
      };
      applyTheme();
      if (typeof mediaQuery.addEventListener === "function") {
        mediaQuery.addEventListener("change", applyTheme);
      } else {
        mediaQuery.addListener(applyTheme);
      }
    </script>
    <link rel="stylesheet" href="/src/styles.css" />
    <style>
      body { margin: 0; min-width: 320px; min-height: 100vh; background: var(--bg); }
      .board-fixture-shell { box-sizing: border-box; margin: 0 auto; max-width: 1440px; padding: 36px; }
      .board-fixture-header { align-items: end; display: flex; justify-content: space-between; margin-bottom: 24px; }
      .board-fixture-header span { color: var(--muted); font: 10px ui-monospace, monospace; letter-spacing: .15em; }
      .board-fixture-header h1 { color: var(--text-strong); font-size: 24px; letter-spacing: -.03em; margin: 5px 0 0; }
      .board-fixture-status { color: var(--muted); font: 11px ui-monospace, monospace; }
      .board-fixture-status i { background: var(--accent-2); border-radius: 50%; display: inline-block; height: 7px; margin-right: 6px; width: 7px; }
      @media (max-width: 700px) { .board-fixture-shell { padding: 18px; } }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/test-helpers/board-fixture.ts"></script>
  </body>
</html>`;

function mockFileHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { allowedHosts: [], host: "127.0.0.1", port: 5187 };
  for (let i = 0; i < args.length; i += 1) {
    const arg = expectDefined(args[i], `control UI mock argument at index ${i}`);
    if (arg === "--allowed-host") {
      const allowedHost = args[++i]?.trim();
      if (allowedHost) {
        options.allowedHosts.push(allowedHost);
      }
    } else if (arg.startsWith("--allowed-host=")) {
      const allowedHost = arg.slice("--allowed-host=".length).trim();
      if (allowedHost) {
        options.allowedHosts.push(allowedHost);
      }
    } else if (arg === "--host") {
      options.host = args[++i] ?? options.host;
    } else if (arg.startsWith("--host=")) {
      options.host = arg.slice("--host=".length) || options.host;
    } else if (arg === "--fixture") {
      options.fixture = parseFixture(args[++i]);
    } else if (arg.startsWith("--fixture=")) {
      options.fixture = parseFixture(arg.slice("--fixture=".length));
    } else if (arg === "--port") {
      options.port = parsePort(args[++i], options.port);
    } else if (arg.startsWith("--port=")) {
      options.port = parsePort(arg.slice("--port=".length), options.port);
    }
  }
  return options;
}

function parseFixture(value: string | undefined): "board" | undefined {
  if (!value) {
    return undefined;
  }
  if (value !== "board") {
    throw new Error(`Unknown Control UI mock fixture: ${value}`);
  }
  return value;
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : fallback;
}

function sessionRow(
  key: string,
  label: string,
  updatedAt: number,
  options: { model?: string; modelProvider?: string } & Record<string, unknown> = {},
) {
  const { model, modelProvider, ...extra } = options;
  return {
    contextTokens: 200_000,
    displayName: label,
    hasActiveRun: false,
    key,
    kind: "direct",
    label,
    model: (model as string | undefined) ?? "gpt-5.6-luna",
    modelProvider: (modelProvider as string | undefined) ?? "openai",
    status: "done",
    totalTokens: 0,
    updatedAt,
    ...extra,
  };
}

function sessionsListResponse(sessions: unknown[], options: SessionListOptions) {
  return {
    count: sessions.length,
    defaults: {
      contextTokens: 200_000,
      model: "gpt-5.6-luna",
      modelProvider: "openai",
    },
    hasMore: options.hasMore,
    limitApplied: 50,
    nextOffset: options.nextOffset,
    offset: options.offset ?? 0,
    path: "",
    sessions,
    totalCount: options.totalCount,
    ts: Date.now(),
  };
}

function pagedSessionsListResponse(sessions: unknown[], offset: number) {
  const normalizedOffset = Math.max(0, Math.floor(offset));
  const page = sessions.slice(normalizedOffset, normalizedOffset + SESSION_PAGE_SIZE);
  const nextOffset = normalizedOffset + SESSION_PAGE_SIZE;
  return sessionsListResponse(page, {
    hasMore: nextOffset < sessions.length,
    nextOffset: nextOffset < sessions.length ? nextOffset : null,
    offset: normalizedOffset,
    totalCount: sessions.length,
  });
}

function buildSessionRows(params: {
  baseTime: number;
  count: number;
  keyPrefix: string;
  labelPrefix: string;
  model?: string;
  modelProvider?: string;
}) {
  return Array.from({ length: params.count }, (_value, index) => {
    const ordinal = index + 1;
    const padded = String(ordinal).padStart(3, "0");
    return sessionRow(
      `agent:${params.keyPrefix}-${padded}`,
      `${params.labelPrefix} ${padded}`,
      params.baseTime - ordinal * 60_000,
      { model: params.model, modelProvider: params.modelProvider },
    );
  });
}

function buildSessionListCases(
  sessions: unknown[],
  matchBase: Record<string, unknown> = {},
): Array<{ match: Record<string, unknown>; response: unknown }> {
  const cases: Array<{ match: Record<string, unknown>; response: unknown }> = [];
  for (let offset = SESSION_PAGE_SIZE; offset < sessions.length; offset += SESSION_PAGE_SIZE) {
    cases.push({
      match: { ...matchBase, offset },
      response: pagedSessionsListResponse(sessions, offset),
    });
  }
  cases.push({
    match: matchBase,
    response: pagedSessionsListResponse(sessions, 0),
  });
  return cases;
}

function buildSearchSessionListCases(
  sessions: unknown[],
  searchTerms: string[],
): Array<{ match: Record<string, unknown>; response: unknown }> {
  return searchTerms.flatMap((search) => buildSessionListCases(sessions, { search }));
}

function usageCostTotals(totalTokens: number, totalCost = 0) {
  return {
    input: Math.round(totalTokens * 0.2),
    output: Math.round(totalTokens * 0.1),
    cacheRead: Math.round(totalTokens * 0.6),
    cacheWrite: Math.round(totalTokens * 0.1),
    totalTokens,
    totalCost,
    inputCost: totalCost,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
  };
}

// Model Providers settings fixtures: auth state plus live plan/quota/billing
// snapshots so the /settings/model-providers page renders fully in the mock.
function buildSessionDiffMock() {
  const appPatch = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 1111111..2222222 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -12,4 +12,5 @@ export function bootstrap() {",
    "   const config = readSettings();",
    "-  const client = createClient(config);",
    "+  const client = createClient(config, { retries: 3 });",
    '+  client.on("error", reportError);',
    "   return client;",
    "@@ -181,3 +182,3 @@ export function shutdown() {",
    "   flushQueues();",
    '-  logger.info("bye");',
    '+  logger.info("shutdown complete");',
    "",
  ].join("\n");
  const readmePatch = [
    "diff --git a/README.md b/README.md",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/README.md",
    "@@ -0,0 +1,3 @@",
    "+# Demo",
    "+",
    "+Mock harness session diff fixture.",
    "",
  ].join("\n");
  return {
    sessionKey: "main",
    root: "/tmp/openclaw-mock-checkout",
    branch: "feature/session-diff-panel",
    baseRef: "main",
    files: [
      {
        path: "src/app.ts",
        status: "modified",
        additions: 3,
        deletions: 2,
        patch: appPatch,
      },
      {
        path: "README.md",
        status: "added",
        additions: 3,
        deletions: 0,
        untracked: true,
        patch: readmePatch,
      },
      {
        path: "assets/logo.png",
        status: "modified",
        additions: 0,
        deletions: 0,
        binary: true,
      },
    ],
    additions: 6,
    deletions: 2,
  };
}

function buildModelProviderMocks(baseTime: number) {
  const hour = 60 * 60 * 1000;
  const expiry = (remainingMs: number, label: string) => ({
    at: baseTime + remainingMs,
    remainingMs,
    label,
  });
  const costDaily = Array.from({ length: 14 }, (_, index) => {
    const date = new Date(baseTime - (13 - index) * 24 * hour);
    const iso = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
    const amount = 4 + Math.round(Math.abs(Math.sin(index)) * 900) / 100;
    return {
      date: iso,
      amount,
      requests: 120 + index * 7,
      inputTokens: 2_400_000 + index * 90_000,
      cacheReadTokens: 9_000_000,
      cacheWriteTokens: 400_000,
      outputTokens: 310_000,
      totalTokens: 12_110_000 + index * 90_000,
    };
  });
  const anthropicUsage = {
    provider: "anthropic",
    displayName: "Claude",
    plan: "Max 20x",
    windows: [
      { label: "5h", usedPercent: 38, resetAt: baseTime + 2.4 * hour },
      { label: "Week", usedPercent: 61, resetAt: baseTime + 68 * hour },
      { label: "Opus", usedPercent: 24, resetAt: baseTime + 68 * hour },
    ],
    costHistory: {
      unit: "USD",
      periodDays: 14,
      daily: costDaily,
      models: [
        {
          name: "claude-sonnet-4-6",
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          totalTokens: 96_000_000,
        },
        {
          name: "claude-opus-4-8",
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          totalTokens: 31_000_000,
        },
      ],
      categories: [
        { name: "Sessions", amount: 61.13 },
        { name: "Code Assist", amount: 18.4 },
      ],
    },
  };
  const openaiUsage = {
    provider: "openai",
    displayName: "OpenAI",
    plan: "Pro",
    windows: [
      { label: "5h", usedPercent: 12, resetAt: baseTime + 3.1 * hour },
      { label: "Week", usedPercent: 44, resetAt: baseTime + 100 * hour },
    ],
    billing: [{ type: "balance", label: "Credits", amount: 341, unit: "credits" }],
  };
  const openrouterUsage = {
    provider: "openrouter",
    displayName: "OpenRouter",
    windows: [],
    billing: [{ type: "balance", amount: 12.34, unit: "USD" }],
  };
  const copilotUsage = {
    provider: "github-copilot",
    displayName: "GitHub Copilot",
    plan: "Business",
    windows: [{ label: "Premium requests", usedPercent: 71, resetAt: baseTime + 21 * 24 * hour }],
  };
  return {
    authStatus: {
      ts: baseTime,
      providers: [
        {
          provider: "anthropic",
          displayName: "Claude",
          status: "ok",
          expiry: expiry(11 * 24 * hour, "11d"),
          profiles: [
            {
              profileId: "anthropic:default",
              type: "oauth",
              status: "ok",
              expiry: expiry(11 * 24 * hour, "11d"),
            },
          ],
          usage: {
            providerId: "anthropic",
            plan: anthropicUsage.plan,
            windows: anthropicUsage.windows,
          },
        },
        {
          provider: "openai",
          displayName: "OpenAI",
          status: "ok",
          expiry: expiry(6 * 24 * hour, "6d"),
          profiles: [
            {
              profileId: "openai:codex",
              type: "oauth",
              status: "ok",
              expiry: expiry(6 * 24 * hour, "6d"),
            },
          ],
          usage: {
            providerId: "openai",
            plan: openaiUsage.plan,
            windows: openaiUsage.windows,
            billing: openaiUsage.billing,
          },
        },
        {
          provider: "github-copilot",
          displayName: "GitHub Copilot",
          status: "expiring",
          expiry: expiry(26 * 60 * 1000, "26m"),
          profiles: [
            {
              profileId: "github-copilot:default",
              type: "token",
              status: "expiring",
              expiry: expiry(26 * 60 * 1000, "26m"),
            },
          ],
          usage: {
            providerId: "github-copilot",
            plan: copilotUsage.plan,
            windows: copilotUsage.windows,
          },
        },
        {
          provider: "openrouter",
          displayName: "OpenRouter",
          status: "static",
          profiles: [{ profileId: "openrouter:default", type: "api_key", status: "static" }],
        },
        {
          provider: "google",
          displayName: "Gemini",
          status: "missing",
          profiles: [],
        },
      ],
    },
    usageStatus: {
      updatedAt: baseTime,
      providers: [anthropicUsage, openaiUsage, openrouterUsage, copilotUsage],
    },
    models: [
      { id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic", available: true },
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        provider: "anthropic",
        available: true,
      },
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai", available: true },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai", available: true },
      { id: "gemini-3-pro", name: "Gemini 3 Pro", provider: "google", available: false },
      { id: "openrouter/auto", name: "OpenRouter Auto", provider: "openrouter", available: true },
    ],
  };
}

// Deterministic year of daily activity so the settings profile heatmap,
// streaks, and stat strip render with a lively fixture in the mock harness.
function buildProfileUsageMocks(baseTime: number) {
  const daily: Array<Record<string, unknown>> = [];
  let lifetimeTokens = 0;
  for (let daysAgo = 364; daysAgo >= 0; daysAgo -= 1) {
    const date = new Date(baseTime - daysAgo * 24 * 60 * 60 * 1000);
    const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const weekendDamper = date.getDay() === 0 || date.getDay() === 6 ? 0.3 : 1;
    const quietDay = daysAgo % 19 === 4 ? 0 : 1;
    const wave = (Math.sin(daysAgo / 6) + 1.4) * 1_400_000_000;
    const spike = daysAgo % 47 === 0 ? 6_000_000_000 : 0;
    const tokens = Math.round((wave + spike) * weekendDamper * quietDay);
    lifetimeTokens += tokens;
    daily.push({ date: iso, ...usageCostTotals(tokens, tokens / 1e9) });
  }
  return {
    cost: {
      updatedAt: baseTime,
      days: daily.length,
      daily,
      totals: usageCostTotals(lifetimeTokens, lifetimeTokens / 1e9),
    },
    sessions: {
      updatedAt: baseTime,
      startDate: daily[0]?.date,
      endDate: daily[daily.length - 1]?.date,
      sessions: [
        {
          key: "agent:openclaw-mock:marathon",
          label: "Release night marathon",
          usage: { ...usageCostTotals(4_000_000_000), durationMs: (59 * 60 + 4) * 60 * 1000 },
        },
        {
          key: "agent:openclaw-mock:daily",
          label: "Daily driver",
          usage: { ...usageCostTotals(900_000_000), durationMs: 3 * 60 * 60 * 1000 },
        },
      ],
      totals: usageCostTotals(lifetimeTokens, lifetimeTokens / 1e9),
      aggregates: {
        sessionCount: 48_212,
        longestSessionDurationMs: (59 * 60 + 4) * 60 * 1000,
        messages: {
          total: 2_787_815,
          user: 1_400_000,
          assistant: 1_387_815,
          toolCalls: 42_380,
          toolResults: 42_380,
          errors: 128,
        },
        tools: {
          totalCalls: 42_380,
          uniqueTools: 205,
          tools: [
            { name: "exec", count: 6_418 },
            { name: "browser", count: 5_256 },
            { name: "message", count: 4_708 },
            { name: "read", count: 4_489 },
            { name: "sessions_list", count: 3_066 },
          ],
        },
        byModel: [
          {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            count: 9_000,
            totals: usageCostTotals(Math.round(lifetimeTokens * 0.7)),
          },
          {
            provider: "openai",
            model: "gpt-5.6-luna",
            count: 4_000,
            totals: usageCostTotals(Math.round(lifetimeTokens * 0.3)),
          },
        ],
        byProvider: [
          {
            provider: "anthropic",
            count: 9_000,
            totals: usageCostTotals(Math.round(lifetimeTokens * 0.7), 184.2),
          },
          {
            provider: "openai",
            count: 4_000,
            totals: usageCostTotals(Math.round(lifetimeTokens * 0.3), 96.4),
          },
        ],
        byAgent: [
          { agentId: "openclaw-mock", totals: usageCostTotals(Math.round(lifetimeTokens * 0.8)) },
          { agentId: "alpha", totals: usageCostTotals(Math.round(lifetimeTokens * 0.2)) },
        ],
        byChannel: [
          { channel: "whatsapp", totals: usageCostTotals(Math.round(lifetimeTokens * 0.5)) },
          { channel: "telegram", totals: usageCostTotals(Math.round(lifetimeTokens * 0.3)) },
          { channel: "discord", totals: usageCostTotals(Math.round(lifetimeTokens * 0.2)) },
        ],
        daily: [],
      },
    },
  };
}

/**
 * Small but coherent config fixture so the schema-driven settings pages are
 * demoable: `config.schema` covers a boolean, an enum, numbers, and strings
 * across a few real section keys, and `config.get` returns a matching
 * snapshot with the hash `config.set`/`config.apply` are guarded by.
 */
function buildConfigMocks() {
  const config = {
    logging: { level: "info", consoleTimestamps: true },
    messages: { queueLimit: 5, responsePrefix: "" },
    gateway: { port: 18789, bind: "127.0.0.1" },
    agents: { defaults: { thinkingDefault: "medium" } },
    models: { mode: "merge" },
    mcp: {
      servers: {
        context7: { url: "https://mcp.context7.com/mcp", transport: "streamable-http" },
        github: {
          url: "https://api.githubcopilot.com/mcp/",
          transport: "streamable-http",
          auth: "oauth",
        },
        "local-tools": { command: "npx", args: ["some-mcp-server", "--stdio"], enabled: false },
      },
    },
  };
  const schema = {
    type: "object",
    title: "OpenClaw config",
    properties: {
      logging: {
        type: "object",
        title: "Logging",
        properties: {
          level: {
            type: "string",
            title: "Log level",
            description: "Minimum severity written to the gateway log.",
            enum: ["silent", "error", "warn", "info", "debug"],
          },
          consoleTimestamps: {
            type: "boolean",
            title: "Console timestamps",
            description: "Prefix console log lines with a timestamp.",
          },
        },
      },
      messages: {
        type: "object",
        title: "Messages",
        properties: {
          queueLimit: {
            type: "integer",
            title: "Queue limit",
            description: "Maximum queued inbound messages per session.",
            minimum: 0,
          },
          responsePrefix: {
            type: "string",
            title: "Response prefix",
            description: "Optional text prepended to outbound replies.",
          },
        },
      },
      gateway: {
        type: "object",
        title: "Gateway",
        properties: {
          port: { type: "integer", title: "Port", minimum: 1, maximum: 65535 },
          bind: { type: "string", title: "Bind address" },
        },
      },
      agents: {
        type: "object",
        title: "Agents",
        properties: {
          defaults: {
            type: "object",
            title: "Defaults",
            properties: {
              thinkingDefault: {
                type: "string",
                title: "Default thinking level",
                enum: ["off", "low", "medium", "high"],
              },
            },
          },
        },
      },
      models: {
        type: "object",
        title: "Models",
        properties: {
          mode: {
            type: "string",
            title: "Catalog mode",
            enum: ["merge", "replace"],
          },
        },
      },
    },
  };
  return {
    get: {
      path: "~/.openclaw/openclaw.json",
      exists: true,
      raw: `${JSON.stringify(config, null, 2)}\n`,
      hash: "mock-config-hash",
      appliedConfigHash: "mock-config-hash",
      valid: true,
      config,
      issues: [],
    },
    schema: {
      schema,
      uiHints: {},
      version: "mock-config-schema",
      generatedAt: new Date(0).toISOString(),
    },
  };
}

function chatHistoryMessage(role: "assistant" | "user", text: string, timestamp: number) {
  return {
    content: [{ text, type: "text" }],
    role,
    timestamp,
  };
}

function buildScrollableChatHistory(baseTime: number): unknown[] {
  const messages: unknown[] = [
    chatHistoryMessage(
      "assistant",
      `Mock Control UI is running with ${TOTAL_MOCK_SESSIONS} sessions. Open the chat picker, search for "telegram" or "claude", then use Load more repeatedly.`,
      baseTime,
    ),
  ];

  for (let index = 1; index <= 36; index += 1) {
    const timestamp = baseTime + index * 60_000;
    messages.push(
      chatHistoryMessage(
        "user",
        `Mock scroll request ${index}: add enough transcript content to exercise the chat scroll container in focused mode.`,
        timestamp,
      ),
      chatHistoryMessage(
        "assistant",
        `Mock scroll response ${index}: this deterministic history keeps the mock chat long enough to scroll while testing focus mode, header collapse, and composer anchoring. `.repeat(
          2,
        ),
        timestamp + 30_000,
      ),
    );
  }

  // Completed work turn: commentary + tool results ahead of the final reply
  // exercise the collapsed "Worked for X" rollup at the end of the thread.
  const workTurnBase = baseTime + 37 * 60_000;
  messages.push(
    chatHistoryMessage(
      "user",
      "Mock work request: refactor the render guard and rerun the suite.",
      workTurnBase,
    ),
    chatHistoryMessage(
      "assistant",
      "Checking the guard implementation before editing.",
      workTurnBase + 5_000,
    ),
    {
      role: "toolResult",
      toolCallId: "mock-work-read",
      toolName: "read",
      content: [{ type: "text", text: "Read ui/src/pages/chat/chat-thread.ts (120 lines)." }],
      timestamp: workTurnBase + 12_000,
    },
    {
      role: "toolResult",
      toolCallId: "mock-work-exec",
      toolName: "exec",
      content: [{ type: "text", text: "pnpm test chat-thread — 12 passed." }],
      timestamp: workTurnBase + 95_000,
    },
    chatHistoryMessage(
      "assistant",
      "Refactored the render guard and reran the suite; all 12 tests pass.",
      workTurnBase + 172_000,
    ),
  );

  return messages;
}

function searchPrefixes(term: string): string[] {
  return Array.from({ length: term.length }, (_value, index) => term.slice(0, index + 1));
}

async function createChatPickerScenario(): Promise<ControlUiMockGatewayScenario> {
  const baseTime = Date.parse("2026-05-22T09:00:00.000Z");
  const selfProfile: UserProfile = {
    id: "presence-riley",
    displayName: "Riley",
    avatarMime: null,
    mergedInto: null,
    createdAt: baseTime,
    updatedAt: baseTime,
    emails: ["riley@example.com"],
    hasAvatar: false,
  };
  const devicePairSetupCode = Buffer.from(
    JSON.stringify({
      url: "wss://gateway.example.test",
      bootstrapToken: "mock-bootstrap-token",
    }),
    "utf8",
  ).toString("base64url");
  const devicePairQrDataUrl = await qrcode.toDataURL(devicePairSetupCode, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 360,
  });
  const workspaceFiles = [
    {
      missing: false,
      name: "AGENTS.md",
      path: "/mock/workspace/AGENTS.md",
      size: 2148,
      updatedAtMs: baseTime - 120_000,
    },
    {
      missing: false,
      name: "plan.md",
      path: "/mock/workspace/plan.md",
      size: 912,
      updatedAtMs: baseTime - 90_000,
    },
    {
      missing: false,
      name: "notes/context.md",
      path: "/mock/workspace/notes/context.md",
      size: 1620,
      updatedAtMs: baseTime - 30_000,
    },
  ];
  const workspaceListCases = ["main", "alpha", "openclaw-mock"].map((agentId) => ({
    match: { agentId },
    response: {
      agentId,
      files: workspaceFiles,
      workspace: "/mock/workspace",
    },
  }));
  const workspaceFileContentByName = new Map([
    [
      "AGENTS.md",
      "# AGENTS.md\n\nMock workspace instructions for the composer rail.\n\n- Keep tool output compact.\n- Prefer right-rail context over modal previews.\n",
    ],
    [
      "plan.md",
      "# Composer polish plan\n\n1. Keep the composer controls calm.\n2. Move session selection into the sidebar.\n3. Keep model, reasoning, and speed choices discoverable without taking over the page.\n",
    ],
    [
      "notes/context.md",
      "# Context notes\n\nThe right rail should feel like workspace context, not a modal pasted beside the chat.\n\n## Current focus\n\n- Markdown previews need readable dark-mode chrome.\n- Empty or unavailable content should show a quiet state instead of an empty card.\n- File previews should load from the same mock scenario as the file list.\n",
    ],
  ]);
  const workspaceFileCases = ["main", "alpha", "openclaw-mock"].flatMap((agentId) =>
    workspaceFiles.map((file) => ({
      match: { agentId, name: file.name },
      response: {
        agentId,
        file: {
          ...file,
          content: workspaceFileContentByName.get(file.name) ?? "",
        },
        workspace: "/mock/workspace",
      },
    })),
  );
  const sessionFiles = [
    {
      kind: "modified",
      missing: false,
      name: "chat.ts",
      path: "ui/src/ui/views/chat.ts",
      size: 48320,
      updatedAtMs: baseTime - 20_000,
    },
    {
      kind: "modified",
      missing: false,
      name: "sidebar.css",
      path: "ui/src/styles/chat/sidebar.css",
      size: 18840,
      updatedAtMs: baseTime - 18_000,
    },
    {
      kind: "read",
      missing: false,
      name: "artifacts.ts",
      path: "src/gateway/server-methods/artifacts.ts",
      size: 21876,
      updatedAtMs: baseTime - 300_000,
    },
    {
      kind: "read",
      missing: false,
      name: "sessions.ts",
      path: "packages/gateway-protocol/src/schema/sessions.ts",
      size: 16542,
      updatedAtMs: baseTime - 420_000,
    },
  ];
  const sessionWorkspaceRoot = repoRoot;
  const sessionFileContentByPath = new Map([
    [
      "ui/src/ui/views/chat.ts",
      'function renderSessionWorkspaceRail() {\n  return html`<aside class="chat-workspace-rail">...</aside>`;\n}\n',
    ],
    [
      "ui/src/styles/chat/sidebar.css",
      ".chat-workspace-rail__section-title {\n  color: var(--muted);\n  text-transform: uppercase;\n}\n",
    ],
    [
      "src/gateway/server-methods/artifacts.ts",
      "// Artifact gateway methods collect generated artifacts from session transcripts.\n",
    ],
    [
      "packages/gateway-protocol/src/schema/sessions.ts",
      "export const SessionsFilesListParamsSchema = Type.Object({ sessionKey: NonEmptyString });\n",
    ],
    [
      "package.json",
      '{\n  "name": "openclaw",\n  "scripts": { "dev:ui:mock": "tsx scripts/control-ui-mock-dev.ts" }\n}\n',
    ],
    [
      "ui/vite.config.ts",
      "export default function controlUiViteConfig() {\n  return { server: { strictPort: true } };\n}\n",
    ],
    [
      "ui/src/e2e/chat-flow.e2e.test.ts",
      "it('keeps the session workspace useful while browsing files', async () => {\n  await page.getByText('Project files').waitFor();\n});\n",
    ],
  ]);
  const sessionFileCases = [
    {
      match: { sessionKey: "agent:alpha" },
      response: {
        browser: {
          entries: [
            {
              kind: "directory",
              name: "packages",
              path: "packages",
              sessionKind: "read",
              updatedAtMs: baseTime - 420_000,
            },
            {
              kind: "directory",
              name: "src",
              path: "src",
              sessionKind: "read",
              updatedAtMs: baseTime - 300_000,
            },
            {
              kind: "directory",
              name: "ui",
              path: "ui",
              sessionKind: "modified",
              updatedAtMs: baseTime - 20_000,
            },
            {
              kind: "file",
              name: "package.json",
              path: "package.json",
              size: 92750,
              updatedAtMs: baseTime - 800_000,
            },
          ],
          path: "",
        },
        files: sessionFiles,
        root: sessionWorkspaceRoot,
        sessionKey: "agent:main:main",
      },
    },
  ];
  const sessionFileGetCases = sessionFiles.map((file) => ({
    match: { sessionKey: "agent:alpha", path: file.path },
    response: {
      file: {
        ...file,
        content: sessionFileContentByPath.get(file.path) ?? "",
        // Fake CAS token so the file panel offers edit mode against the mock.
        hash: mockFileHash(sessionFileContentByPath.get(file.path) ?? ""),
      },
      root: sessionWorkspaceRoot,
      sessionKey: "agent:main:main",
    },
  }));
  const sessionFileSetCases = sessionFiles.map((file) => ({
    match: { sessionKey: "agent:alpha", path: file.path },
    response: {
      file: {
        ...file,
        kind: "modified",
        workspacePath: file.path,
        hash: mockFileHash(`${file.path}:saved`),
        updatedAtMs: baseTime,
      },
      root: sessionWorkspaceRoot,
      sessionKey: "agent:main:main",
    },
  }));
  const lobsterSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360">
  <rect width="640" height="360" fill="#10151d"/>
  <circle cx="320" cy="185" r="76" fill="#e23f3f"/>
  <ellipse cx="250" cy="178" rx="54" ry="38" fill="#f05a52"/>
  <ellipse cx="390" cy="178" rx="54" ry="38" fill="#f05a52"/>
  <circle cx="292" cy="145" r="10" fill="#0b0f14"/>
  <circle cx="348" cy="145" r="10" fill="#0b0f14"/>
  <path d="M232 114c-72-44-135-22-146 35 52 9 91-4 125-39" fill="none" stroke="#f06b5f" stroke-width="28" stroke-linecap="round"/>
  <path d="M408 114c72-44 135-22 146 35-52 9-91-4-125-39" fill="none" stroke="#f06b5f" stroke-width="28" stroke-linecap="round"/>
  <path d="M232 246c-45 28-91 35-142 23M408 246c45 28 91 35 142 23" fill="none" stroke="#e14b47" stroke-width="16" stroke-linecap="round"/>
  <text x="320" y="326" text-anchor="middle" font-family="ui-sans-serif, system-ui" font-size="24" fill="#f6f7f9">openclaw session artifact</text>
</svg>`;
  const lobsterArtifact = {
    id: "artifact-openclaw-lobster",
    type: "image",
    title: "openclaw-lobster-preview.svg",
    mimeType: "image/svg+xml",
    sizeBytes: Buffer.byteLength(lobsterSvg, "utf8"),
    source: "session-transcript",
    download: { mode: "bytes" },
  };
  // Five-zone sidebar fixture: main session (hidden behind the identity card,
  // its child promoted to Threads), threads with a running tree, group rows,
  // and a worktree row for the Coding zone.
  const mainChildRow = sessionRow(
    "agent:main:lisbon-trip",
    "Lisbon trip planning",
    baseTime - 120_000,
    {
      spawnedBy: "agent:main:main",
      unread: true,
    },
  );
  const taxChildRow = sessionRow(
    "agent:main:subagent:tax-receipts",
    "Reading receipts",
    baseTime - 30_000,
    {
      spawnedBy: "agent:main:tax-research",
      hasActiveRun: true,
      status: "running",
      startedAt: baseTime - 200_000,
      runtimeMs: 200_000,
    },
  );
  const sessions = [
    sessionRow("agent:main:main", "Molty", baseTime - 1_000, {
      childSessions: ["agent:main:lisbon-trip"],
    }),
    sessionRow(OBSERVER_DEMO_SESSION_KEY, "Session observer demo", baseTime - 3_000, {
      activeRunIds: [OBSERVER_DEMO_RUN_ID],
      hasActiveRun: true,
      observerDigest: {
        headline: "Third run of the same vitest file - two assertions still failing",
        health: "grinding",
        revision: 1,
        runId: OBSERVER_DEMO_RUN_ID,
        updatedAt: baseTime - 2_000,
      },
      startedAt: baseTime - 4_000,
      status: "running",
    }),
    sessionRow(NARRATION_DEMO_SESSION_KEY, "Sidebar narration demo", baseTime - 15_000, {
      hasActiveRun: true,
      startedAt: baseTime - 45_000,
      status: "running",
    }),
    sessionRow("agent:main:tax-research", "Tax filing research", baseTime - 60_000, {
      hasActiveRun: true,
      status: "running",
      childSessions: ["agent:main:subagent:tax-receipts"],
      pinned: true,
      icon: "name:spark",
    }),
    sessionRow("agent:main:production-export", "Production export", baseTime - 75_000, {
      execCwd: "/Users/peter/Projects/clawdbot",
    }),
    sessionRow("agent:main:model-budget", "Model budget review", baseTime - 80_000, {
      execCwd: "/Users/peter/Projects/openclaw",
      status: "failed",
      lastRunError: "Model out of credits: openai/gpt-5.6",
    }),
    sessionRow("agent:main:work-openclaw", "OpenClaw work checkout", baseTime - 85_000, {
      execCwd: "/Users/peter/Work/openclaw",
      lastReadAt: baseTime - 120_000,
      observerDigest: {
        headline: "Done: fixed the flaky retry-window test",
        health: "done",
        revision: 1,
        runId: "mock-idle-final-run",
        updatedAt: baseTime - 40_000,
      },
      unread: true,
    }),
    mainChildRow,
    sessionRow("agent:main:home-server", "Home server migration", baseTime - 240_000, {
      execCwd: "/Users/peter/Projects",
      execNode: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
      pinned: true,
      icon: "🛠️",
    }),
    sessionRow("agent:main:whatsapp:group:family", "Family", baseTime - 90_000, {
      kind: "group",
      channel: "whatsapp",
      unread: true,
    }),
    sessionRow("agent:main:discord:channel:openclaw-dev", "#openclaw-dev", baseTime - 300_000, {
      kind: "group",
      channel: "discord",
    }),
    sessionRow("agent:main:sidebar-zones", "sidebar zones", baseTime - 150_000, {
      worktree: {
        id: "wt-sidebar-zones",
        branch: "claude/sidebar-agent-zones",
        repoRoot: "~/Projects/openclaw",
      },
    }),
    ...buildSessionRows({
      baseTime: baseTime - 400_000,
      count: 3,
      keyPrefix: "main:history",
      labelPrefix: "Long running session",
    }),
  ];
  const archivedSessions = [
    sessionRow("agent:main:archived-launch-notes", "Archived launch notes", baseTime - 86_400_000, {
      archived: true,
      totalTokens: 42_000,
    }),
    sessionRow(
      "agent:main:discord:channel:archived-lounge",
      "#archived-lounge",
      baseTime - 172_800_000,
      {
        archived: true,
        channel: "discord",
        kind: "group",
        totalTokens: 18_000,
      },
    ),
  ];
  const telegramSessions = buildSessionRows({
    baseTime: baseTime - 30_000,
    count: TOTAL_TELEGRAM_SESSIONS,
    keyPrefix: "telegram",
    labelPrefix: "Telegram investigation",
  });
  const claudeSessions = buildSessionRows({
    baseTime: baseTime - 45_000,
    count: 75,
    keyPrefix: "model-claude",
    labelPrefix: "Model search result",
    model: "claude-sonnet-4-6",
    modelProvider: "anthropic",
  });
  // Profile fixtures track the real clock so streaks and the trailing-year
  // heatmap stay filled no matter when the mock harness runs.
  const profileUsage = buildProfileUsageMocks(Date.now());
  const modelProviders = buildModelProviderMocks(Date.now());
  const skillWorkshop = buildSkillWorkshopMocks(Date.now());
  const channelWizard = buildChannelWizardMocks();
  const configMocks = buildConfigMocks();
  return {
    assistantAgentId: "main",
    assistantName: "Molty",
    defaultAgentId: "main",
    featureMethods: [
      "chat.metadata",
      "chat.startup",
      "question.list",
      "sessions.diff",
      "sessions.files.set",
      "system.info",
    ],
    historyMessages: buildScrollableChatHistory(baseTime),
    // Lights up the footer facepile and who's-online roster; the email-only
    // entry keeps the roster's no-display-name row exercised.
    presenceUsers: [
      {
        self: true,
        id: selfProfile.id,
        name: selfProfile.displayName ?? undefined,
        email: selfProfile.emails[0],
      },
      { id: "presence-colin", name: "Colin", email: "colin@example.com" },
      { id: "presence-patricia", email: "patricia.erichsen@example.com" },
    ],
    methodResponses: {
      ...buildBackgroundTasksMock(baseTime),
      "users.self": { profile: selfProfile },
      "system.info": {
        machineName: "Peters-Mac-Studio",
        hostname: "peters-mac-studio.local",
        platform: "darwin",
        release: "25.0.0",
        arch: "arm64",
        osLabel: "macOS 26.5",
        nodeVersion: "24.15.0",
        pid: 4242,
        uptimeMs: 86_400_000,
        cpuCount: 16,
        memoryTotalBytes: 68_719_476_736,
        memoryFreeBytes: 34_359_738_368,
        defaultAgentUtilityModel: {
          status: "auto",
          model: "anthropic/claude-haiku-4-5",
        },
      },
      "fs.listDir": {
        cases: [
          {
            match: { path: "/Users/peter/Projects/openclaw" },
            response: {
              path: "/Users/peter/Projects/openclaw",
              parent: "/Users/peter/Projects",
              home: "/Users/peter",
              entries: [
                { name: "ui", path: "/Users/peter/Projects/openclaw/ui" },
                { name: "src", path: "/Users/peter/Projects/openclaw/src" },
                { name: "docs", path: "/Users/peter/Projects/openclaw/docs" },
                { name: "packages", path: "/Users/peter/Projects/openclaw/packages" },
              ],
            },
          },
          {
            match: { path: "/Users/peter/Projects" },
            response: {
              path: "/Users/peter/Projects",
              parent: "/Users/peter",
              home: "/Users/peter",
              entries: [
                { name: "openclaw", path: "/Users/peter/Projects/openclaw" },
                { name: "clawdbot", path: "/Users/peter/Projects/clawdbot" },
                { name: "sweetistics", path: "/Users/peter/Projects/sweetistics" },
                { name: "Peekaboo", path: "/Users/peter/Projects/Peekaboo" },
              ],
            },
          },
          {
            match: {},
            response: {
              path: "/Users/peter",
              parent: "/Users",
              home: "/Users/peter",
              entries: [
                { name: "Projects", path: "/Users/peter/Projects" },
                { name: "Downloads", path: "/Users/peter/Downloads" },
                { name: ".config", path: "/Users/peter/.config", hidden: true },
              ],
            },
          },
        ],
      },
      "worktrees.branches": {
        cases: [
          {
            match: { repoRoot: "/Users/peter/Projects/openclaw" },
            response: {
              repoRoot: "/Users/peter/Projects/openclaw",
              branches: [
                { kind: "local", name: "main" },
                { kind: "local", name: "steipete/place-picker" },
              ],
              defaultBranch: "main",
              headBranch: "main",
            },
          },
          {
            match: { repoRoot: "/Users/peter/Projects/clawdbot" },
            response: {
              repoRoot: "/Users/peter/Projects/clawdbot",
              branches: [
                { kind: "local", name: "main" },
                { kind: "local", name: "steipete/storage-selector-design" },
              ],
              defaultBranch: "main",
              headBranch: "main",
            },
          },
        ],
      },
      "environments.list": {
        profiles: [{ id: "aws", providerId: "aws" }],
      },
      // config.set/config.apply are served statefully by the mock gateway
      // (raw persists, hash advances) because config.get ships a raw fixture.
      "config.get": configMocks.get,
      "config.schema": configMocks.schema,
      // The sidebar recovers pending questions through question.list after the
      // hello handshake, so this remains visible after a mock-page refresh.
      "question.list": {
        questions: [
          {
            id: "mock_tax_question",
            agentId: "main",
            sessionKey: "agent:main:tax-research",
            questions: [
              {
                id: "filing_status",
                header: "Tax filing",
                question: "Should I submit the draft return?",
                options: [
                  { label: "Submit", description: "File the prepared return." },
                  { label: "Review", description: "Keep the draft open for review." },
                ],
              },
            ],
            createdAtMs: baseTime - 60_000,
            expiresAtMs: ATTENTION_FIXTURE_EXPIRES_AT,
            status: "pending",
          },
        ],
      },
      "exec.approval.list": [
        {
          id: "mock-production-export-approval",
          request: {
            command: "openclaw export --target production",
            sessionKey: "agent:main:production-export",
          },
          createdAtMs: baseTime - 75_000,
          expiresAtMs: ATTENTION_FIXTURE_EXPIRES_AT,
        },
      ],
      "plugin.approval.list": [],
      "openclaw.approval.list": [],
      "sessions.patch": { ok: true },
      "sessions.diff": buildSessionDiffMock(),
      // The worktrees page assumes the gateway contract shape; without this
      // fixture the mock's {} fallback surfaces as a TypeError banner.
      "worktrees.list": {
        worktrees: [
          {
            id: "wt-mock-1",
            name: "fix-session-icons",
            repoFingerprint: "a1b2c3d4e5f60718",
            repoRoot: "/Users/demo/Projects/openclaw",
            path: "/Users/demo/Projects/openclaw/.openclaw/worktrees/fix-session-icons",
            branch: "openclaw/fix-session-icons",
            baseRef: "origin/main",
            ownerKind: "session",
            createdAt: baseTime - 3 * 86_400_000,
            lastActiveAt: baseTime - 2 * 3_600_000,
          },
          {
            id: "wt-mock-2",
            name: "dashboard-polish",
            repoFingerprint: "a1b2c3d4e5f60718",
            repoRoot: "/Users/demo/Projects/openclaw",
            path: "/Users/demo/Projects/openclaw/.openclaw/worktrees/dashboard-polish",
            branch: "openclaw/dashboard-polish",
            baseRef: "origin/main",
            ownerKind: "manual",
            createdAt: baseTime - 9 * 86_400_000,
            lastActiveAt: baseTime - 26 * 3_600_000,
          },
        ],
      },
      "plugins.list": buildPluginCatalogMock(),
      "channels.status": buildChannelsStatusMock(baseTime),
      "wizard.start": channelWizard.start,
      "wizard.next": channelWizard.next,
      "wizard.cancel": { status: "cancelled" },
      "skills.proposals.list": skillWorkshop.list,
      "skills.proposals.inspect": skillWorkshop.inspect,
      "skills.proposals.historyStatus": skillWorkshop.historyStatus,
      "skills.proposals.historyScan": skillWorkshop.historyScan,
      "usage.cost": profileUsage.cost,
      "sessions.usage": profileUsage.sessions,
      "models.authStatus": modelProviders.authStatus,
      "usage.status": modelProviders.usageStatus,
      "device.pair.list": {
        paired: [
          {
            deviceId: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
            displayName: "Mac Studio",
            platform: "darwin",
            clientId: "node-host",
            clientMode: "node",
            roles: ["operator", "node"],
            scopes: ["operator.admin", "operator.read", "operator.write"],
            approvedVia: "trusted-cidr",
            approvedAtMs: baseTime - 3_600_000,
            lastSeenAtMs: baseTime - 60_000,
            tokens: [
              { role: "node", scopes: [], createdAtMs: baseTime - 3_600_000 },
              {
                role: "operator",
                scopes: ["operator.admin", "operator.read", "operator.write"],
                createdAtMs: baseTime - 3_600_000,
              },
            ],
          },
          {
            deviceId: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
            displayName: "Mac Studio",
            platform: "darwin",
            clientId: "node-host",
            clientMode: "node",
            roles: ["node"],
            approvedVia: "trusted-cidr",
            approvedAtMs: baseTime - 86_400_000,
            lastSeenAtMs: baseTime - 82_800_000,
            tokens: [{ role: "node", scopes: [], createdAtMs: baseTime - 86_400_000 }],
          },
          {
            deviceId: "9988776655443322119988776655443322119988776655443322119988776655",
            clientId: "cli",
            clientMode: "cli",
            platform: "darwin",
            roles: ["operator"],
            scopes: ["operator.admin", "operator.read", "operator.write"],
            approvedVia: "silent",
            approvedAtMs: baseTime - 7_200_000,
            lastSeenAtMs: baseTime - 7_100_000,
            tokens: [
              {
                role: "operator",
                scopes: ["operator.admin", "operator.read", "operator.write"],
                createdAtMs: baseTime - 7_200_000,
              },
            ],
          },
          {
            deviceId: "11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff",
            displayName: "iPhone",
            platform: "iOS 26.4",
            clientId: "openclaw-ios",
            clientMode: "ui",
            roles: ["operator", "node"],
            scopes: ["operator.approvals", "operator.read", "operator.write"],
            approvedVia: "bootstrap",
            approvedAtMs: baseTime - 172_800_000,
            lastSeenAtMs: baseTime - 3_600_000,
            tokens: [
              { role: "node", scopes: [], createdAtMs: baseTime - 172_800_000 },
              {
                role: "operator",
                scopes: ["operator.approvals", "operator.read", "operator.write"],
                createdAtMs: baseTime - 172_800_000,
              },
            ],
          },
        ],
        pending: [
          {
            requestId: "mock-pending-request",
            deviceId: "feedfacecafebeef0123456789abcdeffeedfacecafebeef0123456789abcdef",
            displayName: "MacBook Pro",
            role: "operator",
            roles: ["operator"],
            scopes: ["operator.read", "operator.write"],
            remoteIp: "192.168.1.20",
            ts: baseTime - 30_000,
          },
        ],
      },
      "device.pair.setupCode": {
        auth: "token",
        gatewayUrl: "wss://gateway.example.test",
        qrDataUrl: devicePairQrDataUrl,
        setupCode: devicePairSetupCode,
        urlSource: "mock",
      },
      "node.list": {
        nodes: [
          {
            nodeId: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
            displayName: "Mac Studio",
            platform: "darwin",
            deviceFamily: "Mac",
            modelIdentifier: "Mac14,12",
            remoteIp: "192.168.1.11",
            version: "2026.6.11",
            connected: true,
            paired: true,
            approvalState: "approved",
            connectedAtMs: baseTime - 60_000,
            caps: ["canvas", "screen"],
            commands: [
              "screen.snapshot",
              "system.execApprovals.get",
              "system.execApprovals.set",
              "system.notify",
              "system.run",
              "system.which",
            ],
          },
          {
            nodeId: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
            displayName: "Mac Studio",
            platform: "darwin",
            deviceFamily: "Mac",
            modelIdentifier: "Mac15,14",
            remoteIp: "192.168.1.12",
            version: "2026.6.10",
            connected: true,
            paired: true,
            approvalState: "approved",
            lastSeenAtMs: baseTime - 82_800_000,
            caps: ["canvas", "screen"],
            commands: ["screen.snapshot", "system.run"],
          },
          {
            nodeId: "11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff",
            displayName: "iPhone",
            platform: "iOS 26.4",
            deviceFamily: "iPhone",
            modelIdentifier: "iPhone17,2",
            remoteIp: "192.168.1.30",
            version: "2026.6.11",
            connected: true,
            paired: true,
            approvalState: "approved",
            lastSeenAtMs: baseTime - 3_600_000,
            caps: ["camera", "canvas", "contacts", "device", "location"],
            commands: [
              "camera.list",
              "contacts.search",
              "device.info",
              "location.get",
              "system.run",
            ],
          },
        ],
      },
      "system-presence": [
        {
          host: "gateway-mock.local",
          ip: "192.168.1.10",
          version: "2026.6.11",
          platform: "macos 26.5.2",
          deviceFamily: "Mac",
          modelIdentifier: "Mac14,12",
          lastInputSeconds: 42,
          mode: "gateway",
          reason: "self",
          instanceId: "mock-gateway-instance",
          text: "Gateway: gateway-mock.local (192.168.1.10) · app 2026.6.11 · mode gateway · reason self",
          ts: baseTime,
        },
        {
          host: "Mac Studio",
          ip: "192.168.1.11",
          version: "2026.6.11",
          platform: "macos 26.5.2",
          deviceFamily: "Mac",
          modelIdentifier: "Mac15,14",
          lastInputSeconds: 177,
          mode: "node",
          reason: "periodic",
          deviceId: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
          instanceId: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
          roles: ["node"],
          text: "Node: Mac Studio (192.168.1.11) · app 2026.6.11 · last input 177s ago · mode node · reason periodic",
          ts: baseTime - 30_000,
        },
        {
          host: "openclaw-control-ui",
          version: "2026.6.11",
          platform: "macos 26.5.2",
          mode: "webchat",
          reason: "connect",
          roles: ["operator"],
          instanceId: "mock-unpaired-webchat",
          text: "Node: openclaw-control-ui · mode webchat",
          ts: baseTime - 10_000,
        },
      ],
      "agents.files.get": {
        cases: workspaceFileCases,
      },
      "agents.files.list": {
        cases: workspaceListCases,
      },
      "sessions.files.get": {
        cases: sessionFileGetCases,
      },
      "sessions.files.set": {
        cases: sessionFileSetCases,
      },
      "sessions.files.list": {
        cases: [
          {
            match: { sessionKey: "agent:alpha", path: "ui" },
            response: {
              browser: {
                entries: [
                  {
                    kind: "directory",
                    name: "src",
                    path: "ui/src",
                    sessionKind: "modified",
                    updatedAtMs: baseTime - 20_000,
                  },
                  {
                    kind: "file",
                    name: "vite.config.ts",
                    path: "ui/vite.config.ts",
                    size: 9860,
                    updatedAtMs: baseTime - 900_000,
                  },
                ],
                parentPath: "",
                path: "ui",
              },
              files: sessionFiles,
              root: sessionWorkspaceRoot,
              sessionKey: "agent:main:main",
            },
          },
          {
            match: { sessionKey: "agent:alpha", search: "chat" },
            response: {
              browser: {
                entries: [
                  {
                    kind: "file",
                    name: "chat.ts",
                    path: "ui/src/ui/views/chat.ts",
                    sessionKind: "modified",
                    size: 48320,
                    updatedAtMs: baseTime - 20_000,
                  },
                  {
                    kind: "file",
                    name: "chat-flow.e2e.test.ts",
                    path: "ui/src/e2e/chat-flow.e2e.test.ts",
                    size: 24950,
                    updatedAtMs: baseTime - 25_000,
                  },
                ],
                path: "",
                search: "chat",
              },
              files: sessionFiles,
              root: sessionWorkspaceRoot,
              sessionKey: "agent:main:main",
            },
          },
          ...sessionFileCases,
        ],
      },
      "artifacts.list": {
        cases: [
          {
            match: { sessionKey: "agent:alpha" },
            response: { artifacts: [lobsterArtifact] },
          },
        ],
      },
      "artifacts.download": {
        cases: [
          {
            match: { sessionKey: "agent:alpha", artifactId: lobsterArtifact.id },
            response: {
              artifact: lobsterArtifact,
              data: Buffer.from(lobsterSvg, "utf8").toString("base64"),
              encoding: "base64",
            },
          },
        ],
      },
      "sessions.list": {
        cases: [
          // Child fetches must precede the catch-all page case (subset match).
          {
            match: { spawnedBy: "agent:main:main" },
            response: pagedSessionsListResponse([mainChildRow], 0),
          },
          {
            match: { spawnedBy: "agent:main:tax-research" },
            response: pagedSessionsListResponse([taxChildRow], 0),
          },
          ...buildSearchSessionListCases(telegramSessions, searchPrefixes("telegram")),
          ...buildSearchSessionListCases(claudeSessions, [
            ...searchPrefixes("claude"),
            ...searchPrefixes("claude-sonnet-4-6"),
            ...searchPrefixes("anthropic"),
          ]),
          ...buildSessionListCases([...sessions, ...archivedSessions]),
        ],
      },
    },
    models: modelProviders.models,
    repeatingSessionEvents: {
      intervalMs: 3_000,
      events: [
        {
          event: "session.observer",
          payload: {
            headline: "Reading the failing test",
            health: "on-track",
            revision: 2,
            runId: OBSERVER_DEMO_RUN_ID,
            sessionKey: OBSERVER_DEMO_SESSION_KEY,
            updatedAt: baseTime + 1_000,
          },
        },
        {
          event: "session.observer",
          payload: {
            headline: "Third run of the same vitest file - two assertions still failing",
            health: "grinding",
            revision: 3,
            runId: OBSERVER_DEMO_RUN_ID,
            sessionKey: OBSERVER_DEMO_SESSION_KEY,
            updatedAt: baseTime + 4_000,
          },
        },
        {
          event: "session.observer",
          payload: {
            headline: "Same failure five runs in a row - it may be circling",
            health: "stuck",
            revision: 4,
            runId: OBSERVER_DEMO_RUN_ID,
            sessionKey: OBSERVER_DEMO_SESSION_KEY,
            updatedAt: baseTime + 7_000,
          },
        },
        {
          event: "agent",
          payload: {
            // replace: the demo replays the same snapshot each cycle; without
            // it the controller's cumulative-length dedupe drops the repeats.
            data: { replace: true, text: "Rebasing onto main and rerunning the sidebar suite." },
            runId: NARRATION_DEMO_RUN_ID,
            sessionKey: NARRATION_DEMO_SESSION_KEY,
            stream: "assistant",
          },
        },
        {
          event: "session.tool",
          payload: {
            data: { name: "exec" },
            runId: NARRATION_DEMO_RUN_ID,
            sessionKey: NARRATION_DEMO_SESSION_KEY,
            stream: "tool",
          },
        },
      ],
    },
    sessionArchiveFiltering: true,
    sessionKey: "agent:main:main",
    workspace: "/Users/peter/Projects/openclaw",
    workspaceGit: true,
  };
}

function escapeScriptContent(script: string): string {
  return script.replaceAll("</script", "<\\/script");
}

function createMockGatewayPlugin(scenario: ControlUiMockGatewayScenario): Plugin {
  const initScript = escapeScriptContent(createControlUiMockGatewayInitScript(scenario));
  const bootstrapBody = JSON.stringify(createControlUiMockBootstrapConfig(scenario));
  return {
    configureServer(server) {
      server.middlewares.use(CONTROL_UI_BOOTSTRAP_CONFIG_PATH, (_req, res) => {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(bootstrapBody);
      });
    },
    name: "openclaw-control-ui-mock-gateway",
    transformIndexHtml(html) {
      return html.replace(
        "</head>",
        `    <script data-openclaw-control-ui-mock-gateway>\n${initScript}\n    </script>\n  </head>`,
      );
    },
  };
}

function createBoardFixturePlugin(): Plugin {
  return {
    name: "openclaw-control-ui-board-fixture",
    configureServer(server) {
      server.middlewares.use(boardFixturePath, (_req, res, next) => {
        void server
          .transformIndexHtml(boardFixturePath, boardFixtureHtml)
          .then((html) => {
            res.statusCode = 200;
            res.setHeader("content-type", "text/html; charset=utf-8");
            res.end(html);
          })
          .catch((error: unknown) => {
            next(error as Error);
          });
      });
    },
  };
}

function hostForUrl(boundAddress: string, requestedHost: string): string {
  const host = boundAddress === "0.0.0.0" || boundAddress === "::" ? requestedHost : boundAddress;
  const reachableHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return reachableHost.includes(":") ? `[${reachableHost}]` : reachableHost;
}

function resolveServerUrl(
  server: ViteDevServer,
  requestedHost: string,
  pathname = "/chat",
): string {
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("Control UI mock server did not expose a TCP port");
  }
  return `http://${hostForUrl(address.address, requestedHost)}:${address.port}${pathname}`;
}

async function waitForShutdown(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

const options = parseArgs(process.argv.slice(2));
const scenario = await createChatPickerScenario();
const server = await createServer({
  base: "/",
  cacheDir: path.join(repoRoot, ".artifacts", "control-ui-mock-vite"),
  clearScreen: false,
  configFile: path.join(uiRoot, "vite.config.ts"),
  define: {
    "globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO": JSON.stringify({
      version: "2026.7.10",
      commit: "0123456789abcdef0123456789abcdef01234567",
      commitAt: "2026-07-10T11:22:33.000Z",
      builtAt: "2026-07-10T12:34:56.000Z",
      buildId: "mock",
    }),
  },
  logLevel: "error",
  optimizeDeps: {
    ...(options.fixture === "board"
      ? { entries: [path.join(uiRoot, "src", "test-helpers", "board-fixture.ts")] }
      : {}),
    include: ["lit/directives/repeat.js"],
  },
  plugins: [createMockGatewayPlugin(scenario), createBoardFixturePlugin()],
  publicDir: path.join(uiRoot, "public"),
  resolve: {
    alias: [
      ...resolveExternalPackageAliasesForVite(),
      ...resolveSourcePackageAliasesForVite(),
      ...resolveTsconfigPathAliasesForVite(),
    ],
  },
  root: uiRoot,
  server: {
    allowedHosts: options.allowedHosts,
    host: options.host,
    port: options.port,
    strictPort: true,
  },
});

await server.listen();
console.log(`[control-ui-mock] ${resolveServerUrl(server, options.host)}`);
console.log(
  `[control-ui-mock] board fixture: ${resolveServerUrl(server, options.host, boardFixturePath)}`,
);
await waitForShutdown();
await server.close();
