// Control Ui Mock Dev script supports OpenClaw repository automation.
import { createHash } from "node:crypto";
import fs, { rmSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import type {
  SystemAgentChatHistoryResult,
  SystemChangesListResult,
  UserProfile,
} from "../packages/gateway-protocol/src/index.js";
import { expectDefined } from "../packages/normalization-core/src/expect.js";
import { applySharedChannelFieldHelp } from "../src/config/schema.channel-field-help.js";
import { buildBaseHints } from "../src/config/schema.hints.js";
import { applyConfigTierHints, applyResolvedConfigTierHints } from "../src/config/schema.tiers.js";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../src/gateway/control-ui-contract.js";
import { buildUpdateRestartSentinelPayload } from "../src/infra/update-restart-sentinel-payload.js";
import type { UpdateRunResult } from "../src/infra/update-runner.js";
import type { UpdateAvailable, UpdateScheduleState } from "../ui/src/api/types.ts";
import {
  controlUiSessionPath,
  createControlUiMockBootstrapConfig,
  createControlUiMockGatewayInitScript,
  createControlUiMockSameOriginGatewayScript,
  type ControlUiMockGatewayScenario,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../ui/src/test-helpers/control-ui-session-fixtures.ts";
import {
  resolveExternalPackageAliasesForVite,
  resolveSourcePackageAliasesForVite,
  resolveTsconfigPathAliasesForVite,
} from "../ui/vite.config.ts";
import {
  buildChatAttachmentHistory,
  createChatAttachmentFixturePlugin,
} from "./control-ui-mock-attachments.ts";
import { buildBackgroundTasksMock } from "./control-ui-mock-background-tasks.ts";
import {
  buildChannelsPairingMock,
  buildChannelsStatusMock,
  buildChannelWizardMocks,
} from "./control-ui-mock-channels.ts";
import { buildCronMocks } from "./control-ui-mock-cron.ts";
import { createStandaloneMockIsolationPlugins } from "./control-ui-mock-isolation.ts";
import {
  buildPluginCatalogMock,
  buildPluginInspectMock,
  buildPluginSetEnabledMock,
} from "./control-ui-mock-plugins.ts";
import { createControlUiPreviewInitScript } from "./control-ui-mock-preview.ts";
import { skillLibraryMockInitScript } from "./control-ui-mock-skill-library.ts";
import { buildSkillWorkshopMocks } from "./control-ui-mock-skill-workshop.js";

type CliOptions = {
  allowedHosts: string[];
  fixture?:
    | "approval"
    | "attachments"
    | "board"
    | "code-fences"
    | "dashboards"
    | "goal"
    | "swarm"
    | "update-available"
    | "update-blocked"
    | "update-failed"
    | "workboard";
  host: string;
  operatorScopes?: string[];
  port: number;
};

type SessionListOptions = {
  owners?: readonly SessionActorFixture[];
  hasMore: boolean;
  nextOffset: number | null;
  offset?: number;
  totalCount: number;
};

type SessionActorFixture = { type: "human" | "agent"; id: string; label: string };

const MOCK_ACTOR_PETER: SessionActorFixture = {
  type: "human",
  id: "profile-peter",
  label: "Peter",
};
const MOCK_ACTOR_MIRA: SessionActorFixture = {
  type: "human",
  id: "profile-mira",
  label: "Mira",
};
// Rows carry explicit owners the way the gateway projects createdActor fallbacks.
const MOCK_SESSION_OWNERS: readonly SessionActorFixture[] = [MOCK_ACTOR_PETER, MOCK_ACTOR_MIRA];

const SESSION_PAGE_SIZE = 50;
const TOTAL_TELEGRAM_SESSIONS = 180;
const ATTENTION_FIXTURE_EXPIRES_AT = Date.parse("2099-01-01T00:00:00.000Z");
const NARRATION_DEMO_SESSION_KEY = "agent:main:sidebar-narration-demo";
const NARRATION_DEMO_RUN_ID = "mock-sidebar-narration-run";
const OBSERVER_DEMO_SESSION_KEY = "agent:main:session-observer-demo";
const OBSERVER_DEMO_RUN_ID = "mock-session-observer-run";
const PLAN_DEMO_RUN_ID = "mock-plan-run";
type UpdateFixture = {
  available: UpdateAvailable;
  runResponse: unknown;
  schedule: UpdateScheduleState;
  statusResponse: unknown;
};

function buildUpdateFixture(fixture: CliOptions["fixture"], nowMs: number): UpdateFixture | null {
  if (
    fixture !== "update-available" &&
    fixture !== "update-blocked" &&
    fixture !== "update-failed"
  ) {
    return null;
  }

  if (fixture === "update-available") {
    const available: UpdateAvailable = {
      currentVersion: "2026.8.1",
      latestVersion: "2026.8.2",
      channel: "latest",
    };
    const schedule: UpdateScheduleState = {
      channel: "stable",
      autoEnabled: false,
      install: { kind: "package" },
      target: { kind: "package", version: available.latestVersion },
    };
    return {
      available,
      schedule,
      statusResponse: {
        sentinel: null,
        updateAvailable: available,
        effectiveChannel: "stable",
        schedule,
      },
      runResponse: {
        ok: true,
        result: {
          status: "ok",
          mode: "global",
          before: { version: available.currentVersion },
          after: { version: available.latestVersion },
          steps: [],
          durationMs: 12_000,
        },
      },
    };
  }

  const currentSha = "83b321ba7d31c04cc6f7a38c87932ec0172b5461";
  const upstreamSha = "ea2ab707d3ab6f9351dcdb2f3c05054097fbfa62";
  const available: UpdateAvailable = {
    currentVersion: "2026.8.1",
    latestVersion: "2026.8.1",
    channel: "dev",
    currentSha,
    upstreamRef: "origin/main",
    upstreamSha,
    commitsBehind: 2,
    commits: [
      { sha: "f6c71c4", subject: "Keep update status authoritative" },
      { sha: "ea2ab70", subject: "Move update actions into Inbox" },
    ],
  };
  const baseSchedule: UpdateScheduleState = {
    channel: "dev",
    autoEnabled: true,
    install: {
      kind: "git",
      git: {
        status: "behind",
        currentSha,
        commitsBehind: 2,
        commitAtMs: nowMs - 2 * 86_400_000,
        installedAtMs: nowMs - 7 * 86_400_000,
      },
    },
    target: {
      kind: "git",
      upstreamRef: available.upstreamRef ?? "origin/main",
      upstreamSha,
      commitsBehind: 2,
    },
  };

  if (fixture === "update-blocked") {
    const schedule: UpdateScheduleState = {
      ...baseSchedule,
      campaign: {
        id: "mock-update-waiting-for-idle",
        state: "waiting-for-idle",
        announcedAtMs: nowMs - 2 * 60_000,
        forceAtMs: nowMs + 13 * 60_000,
        updatedAtMs: nowMs,
      },
    };
    return {
      available,
      schedule,
      statusResponse: {
        sentinel: null,
        updateAvailable: available,
        effectiveChannel: "dev",
        schedule,
      },
      runResponse: {
        ok: true,
        result: {
          status: "skipped",
          mode: "git",
          reason: "managed-service-handoff-started",
          before: { version: available.currentVersion, sha: currentSha },
          steps: [],
          durationMs: 0,
        },
        handoff: { status: "started" },
      },
    };
  }

  const schedule: UpdateScheduleState = {
    ...baseSchedule,
    campaign: {
      id: "mock-update-before-failure",
      state: "waiting-for-idle",
      announcedAtMs: nowMs - 2 * 60_000,
      forceAtMs: nowMs + 13 * 60_000,
      updatedAtMs: nowMs,
    },
  };
  const result: UpdateRunResult = {
    status: "error",
    mode: "git",
    root: "/mock/openclaw",
    reason: "build-failed",
    before: { version: available.currentVersion, sha: currentSha },
    after: { version: available.latestVersion, sha: upstreamSha },
    steps: [
      {
        name: "build",
        command: "pnpm build",
        cwd: "/mock/openclaw",
        durationMs: 8_420,
        stdoutTail: "",
        stderrTail: "tsc: error TS2345",
        exitCode: 1,
      },
    ],
    durationMs: 11_640,
  };
  return {
    available,
    schedule,
    runResponse: { ok: false, result },
    statusResponse: {
      sentinel: buildUpdateRestartSentinelPayload({ result, meta: {}, nowMs }),
      updateAvailable: available,
      effectiveChannel: "dev",
      schedule: baseSchedule,
    },
  };
}

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
    } else if (arg === "--operator-scopes") {
      options.operatorScopes = parseOperatorScopes(args[++i]);
    } else if (arg.startsWith("--operator-scopes=")) {
      options.operatorScopes = parseOperatorScopes(arg.slice("--operator-scopes=".length));
    }
  }
  return options;
}

function parseFixture(value: string | undefined): CliOptions["fixture"] {
  if (!value) {
    return undefined;
  }
  if (
    value !== "approval" &&
    value !== "attachments" &&
    value !== "board" &&
    value !== "code-fences" &&
    value !== "dashboards" &&
    value !== "goal" &&
    value !== "swarm" &&
    value !== "update-available" &&
    value !== "update-blocked" &&
    value !== "update-failed" &&
    value !== "workboard"
  ) {
    throw new Error(`Unknown Control UI mock fixture: ${value}`);
  }
  return value;
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : fallback;
}

function parseOperatorScopes(value: string | undefined): string[] | undefined {
  const scopes = (value ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  return scopes.length > 0 ? scopes : undefined;
}

function sessionRow(
  key: string,
  label: string,
  updatedAt: number,
  options: { model?: string; modelProvider?: string } & Record<string, unknown> = {},
) {
  const { model, modelProvider, ...extra } = options;
  return createControlUiSessionRow(key, label, updatedAt, {
    contextTokens: 200_000,
    model: model ?? "gpt-5.6-luna",
    modelProvider: modelProvider ?? "openai",
    ...extra,
  });
}

function sessionsListResponse(sessions: Array<{ key: string }>, options: SessionListOptions) {
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
    ...(options.owners ? { owners: options.owners } : {}),
    offset: options.offset ?? 0,
    path: "",
    // Cases select membership; canonical metadata comes from the scenario's rows.
    sessions: sessions.map(({ key }) => ({ key })),
    totalCount: options.totalCount,
    ts: Date.now(),
  };
}

function pagedSessionsListResponse(
  sessions: Array<{ key: string }>,
  offset: number,
  owners?: readonly SessionActorFixture[],
) {
  const normalizedOffset = Math.max(0, Math.floor(offset));
  const page = sessions.slice(normalizedOffset, normalizedOffset + SESSION_PAGE_SIZE);
  const nextOffset = normalizedOffset + SESSION_PAGE_SIZE;
  return sessionsListResponse(page, {
    owners,
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
  sessions: Array<{ key: string }>,
  matchBase: Record<string, unknown> = {},
  owners?: readonly SessionActorFixture[],
): Array<{ match: Record<string, unknown>; response: unknown }> {
  const cases: Array<{ match: Record<string, unknown>; response: unknown }> = [];
  for (let offset = SESSION_PAGE_SIZE; offset < sessions.length; offset += SESSION_PAGE_SIZE) {
    cases.push({
      match: { ...matchBase, offset },
      response: pagedSessionsListResponse(sessions, offset, owners),
    });
  }
  cases.push({
    match: matchBase,
    response: pagedSessionsListResponse(sessions, 0, owners),
  });
  return cases;
}

function buildSearchSessionListCases(
  sessions: Array<{ key: string }>,
  searchTerms: string[],
): Array<{ match: Record<string, unknown>; response: unknown }> {
  return searchTerms.flatMap((search) => buildSessionListCases(sessions, { search }));
}

function buildActivitySessionRows(baseTime: number) {
  const owners = {
    molty: { type: "agent", id: "profile-molty", label: "Molty" },
    riley: { type: "human", id: "presence-riley", label: "Riley" },
    colin: { type: "human", id: "presence-colin", label: "Colin" },
    patricia: {
      type: "human",
      id: "presence-patricia",
      label: "patricia.erichsen@example.com",
    },
    unresolved: { type: "human", id: "147591189530201337" },
  } as const;
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  const fixtures = [
    ["release-check", "Release readiness check", owners.riley, 5 * 60_000],
    ["api-notes", "Gateway API notes", owners.molty, 20 * 60_000],
    ["design-review", "Activity feed design review", owners.colin, hour],
    ["archive-audit", "Archive retention audit", owners.unresolved, 3 * hour],
    ["support-handoff", "Support handoff", owners.patricia, 6 * hour],
    ["mobile-smoke", "Mobile layout smoke test", owners.riley, 18 * hour],
    ["provider-matrix", "Provider matrix cleanup", owners.molty, 30 * hour],
    ["docs-pass", "Operator docs pass", owners.colin, 2 * day],
    ["queue-review", "Queue behavior review", owners.patricia, 2.5 * day],
    ["identity-trace", "Identity trace", owners.unresolved, 3 * day],
    ["channel-followup", "Channel delivery follow-up", owners.riley, 4 * day],
    ["tooling-refresh", "Tooling refresh", owners.molty, 5 * day],
    ["fixture-polish", "Mock fixture polish", owners.colin, 6 * day],
    ["weekly-summary", "Weekly activity summary", owners.patricia, 6.5 * day],
  ] as const;
  const automationKeys = new Set(["release-check", "api-notes", "design-review"]);
  return fixtures.map(([key, label, owner, age]) =>
    sessionRow(`agent:activity:${key}`, label, baseTime - age, {
      ...(key === "archive-audit"
        ? {
            activeRunIds: ["mock-activity-live-run"],
            hasActiveRun: true,
            observerDigest: {
              headline: "Waiting on a fictional mock approval",
              health: "waiting-on-user",
              revision: 1,
              runId: "mock-activity-live-run",
              updatedAt: baseTime - age,
            },
            status: "running",
          }
        : {}),
      createdActor: owner,
      hasAutomation: automationKeys.has(key),
      owner: { actor: owner },
    }),
  );
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
        id: "claude-fable-5",
        name: "Claude Fable 5",
        provider: "anthropic",
        available: true,
        contextWindow: 1_000_000,
        contextWindows: [
          { id: "200k", label: "200K", contextWindow: 200_000 },
          { id: "1m", label: "1M", contextWindow: 1_000_000 },
        ],
        contextWindowDefault: "1m",
      },
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
function buildConfigMocks(options: { swarmEnabled?: boolean; workboardEnabled?: boolean } = {}) {
  const config = {
    logging: { level: "info", consoleTimestamps: true },
    messages: { queueLimit: 5, responsePrefix: "" },
    gateway: { port: 18789, bind: "127.0.0.1", publicOrigin: "https://gateway.example" },
    agents: { defaults: { thinkingDefault: "medium" } },
    commands: { native: "auto", nativeSkills: "auto" },
    models: { mode: "merge" },
    ui: { prefs: { locale: "en" } },
    ...(options.swarmEnabled ? { tools: { swarm: true } } : {}),
    ...(options.workboardEnabled ? { plugins: { entries: { workboard: { enabled: true } } } } : {}),
    channels: {
      whatsapp: {
        enabled: true,
        allowFrom: ["+15551234567"],
        dmPolicy: "pairing",
        groupPolicy: "allowlist",
        selfChatMode: "off",
      },
    },
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
      talk: {
        type: "object",
        title: "Talk",
        properties: {
          interruptOnSpeech: {
            type: "boolean",
            title: "Talk Interrupt on Speech",
            description: "Stop speaking when the user talks over the assistant.",
          },
          realtime: {
            type: "object",
            title: "Talk Realtime",
            properties: {
              provider: {
                type: "string",
                title: "Talk Realtime Provider",
                description: "Active realtime voice provider id, such as openai or google.",
              },
              model: {
                type: "string",
                title: "Talk Realtime Model",
                description: "Realtime voice model for browser Talk sessions.",
              },
              speakerVoice: {
                type: "string",
                title: "Talk Realtime Speaker Voice",
                description: "Built-in realtime voice id.",
              },
            },
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
      commands: {
        type: "object",
        title: "Commands",
        properties: {
          native: {
            title: "Native Commands",
            default: "auto",
            anyOf: [{ type: "boolean" }, { type: "string", const: "auto" }],
          },
          nativeSkills: {
            title: "Native Skill Commands",
            default: "auto",
            anyOf: [{ type: "boolean" }, { type: "string", const: "auto" }],
          },
        },
      },
      gateway: {
        type: "object",
        title: "Gateway",
        properties: {
          port: { type: "integer", title: "Port", minimum: 1, maximum: 65535 },
          bind: { type: "string", title: "Bind address" },
          // Zod's .url() emits `format`; keep one such leaf in the fixture so the
          // form stays provably editable for plugin URL/email settings.
          publicOrigin: { type: "string", title: "Public origin", format: "uri" },
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
      // Channel settings are the one schema surface the channels page renders,
      // so the fixture keeps both tiers represented.
      channels: {
        type: "object",
        title: "Channels",
        properties: {
          whatsapp: {
            type: "object",
            title: "WhatsApp",
            properties: {
              enabled: { type: "boolean", title: "Enabled" },
              allowFrom: { type: "array", title: "Allow from", items: { type: "string" } },
              dmPolicy: { type: "string", title: "DM policy", enum: ["pairing", "open", "off"] },
              groupPolicy: {
                type: "string",
                title: "Group policy",
                enum: ["allowlist", "open", "off"],
              },
              // Channel-specific leaves carry their help from the plugin's own
              // uiHints in production; the fixture uses schema descriptions,
              // which resolve through the same field-meta fallback.
              selfChatMode: {
                type: "string",
                title: "Self chat mode",
                description: "Same-phone setup (bot uses your personal WhatsApp number).",
                enum: ["off", "notes"],
              },
              configWrites: { type: "boolean", title: "Config writes" },
              streaming: {
                type: "object",
                title: "Streaming",
                properties: {
                  progress: {
                    type: "object",
                    properties: {
                      maxLines: { type: "integer", title: "Progress max lines" },
                      toolProgress: { type: "boolean", title: "Progress tool lines" },
                    },
                  },
                },
              },
              healthMonitor: {
                type: "object",
                title: "Health monitor",
                properties: {
                  enabled: { type: "boolean", title: "Enabled" },
                },
              },
              mediaMaxMb: { type: "number", title: "Media max MB" },
            },
          },
        },
      },
    },
  };
  const get = {
    path: "~/.openclaw/openclaw.json",
    exists: true,
    raw: `${JSON.stringify(config, null, 2)}\n`,
    hash: "mock-config-hash",
    appliedConfigHash: "mock-config-hash",
    valid: true,
    config,
    issues: [],
  };
  const writeAck = { ok: true, path: get.path, hash: get.hash, config };
  return {
    get,
    set: writeAck,
    apply: {
      ...writeAck,
      sentinel: {
        persisted: true,
        payload: {
          kind: "config-apply",
          status: "ok",
          ts: 0,
          message: null,
          doctorHint: "openclaw doctor --non-interactive",
          stats: { mode: "config.apply", root: get.path, requiresRestart: false },
        },
      },
    },
    schema: {
      schema,
      // Resolve tiers and shared channel help the way the gateway does so the
      // mock reproduces the real split and subtext instead of bare labels.
      uiHints: applySharedChannelFieldHelp(
        applyResolvedConfigTierHints(
          schema,
          // Seed with base hints so the mock carries the gateway's labels,
          // help, and docsUrl metadata instead of bare tier scaffolding.
          applyConfigTierHints(buildBaseHints(), { includePluginOwnedChannels: true }),
        ),
      ),
      version: "mock-config-schema",
      generatedAt: new Date(0).toISOString(),
    },
  };
}

function buildWorkboardMocks(baseTime: number) {
  const boardId = "peter-tasks";
  const card = (
    id: string,
    title: string,
    status: string,
    priority: string,
    position: number,
    labels: string[],
  ) => ({
    id,
    title,
    status,
    priority,
    labels,
    position,
    createdAt: baseTime - 86_400_000,
    updatedAt: baseTime - position * 1_000,
    metadata: { automation: { boardId } },
  });
  const cards = [
    card("card-inbox", "Capture customer feedback themes", "todo", "normal", 1, ["research"]),
    card("card-brief", "Draft weekly product brief", "todo", "low", 2, ["writing"]),
    card("card-ready", "Prepare launch readiness checklist", "ready", "high", 1, ["launch"]),
    card("card-running", "Validate onboarding flow", "running", "urgent", 1, ["quality"]),
    card("card-review", "Review accessibility audit", "review", "high", 1, ["frontend"]),
    card("card-blocked", "Confirm staging environment access", "blocked", "normal", 1, ["ops"]),
    card("card-done", "Publish support handoff notes", "done", "low", 1, ["docs"]),
  ];
  const statuses = ["todo", "ready", "running", "review", "blocked", "done"];
  const board = {
    id: boardId,
    name: "Product Operations",
    description: "Shared product delivery queue",
    icon: "✓",
    color: "#2563eb",
    automationJobId: "job-product-operations-daily",
    total: cards.length,
    active: cards.length - 1,
    archived: 0,
    byStatus: Object.fromEntries(
      statuses.map((status) => [status, cards.filter((entry) => entry.status === status).length]),
    ),
    updatedAt: baseTime,
  };
  const sessionKey = "agent:main:workboard-proof";
  return {
    board,
    cards,
    sessionKey,
    methodResponses: {
      "board.get": {
        sessionKey,
        revision: 1,
        tabs: [{ tabId: "main", title: "Workboard", position: 0, chatDock: "hidden" }],
        widgets: [
          {
            name: "session-progress",
            tabId: "main",
            title: "Session progress",
            contentKind: "plugin",
            pluginKind: "session:progress",
            sizeW: 6,
            sizeH: 5,
            position: 0,
            grantState: "none",
            revision: 1,
          },
          {
            name: "workboard-product-operations",
            tabId: "main",
            title: "Product Operations",
            contentKind: "plugin",
            pluginKind: "workboard:board",
            props: { boardId },
            heightMode: "fixed",
            sizeW: 12,
            sizeH: 16,
            position: 1,
            grantState: "none",
            revision: 1,
          },
        ],
      },
      "workboard.boards.list": { boards: [board] },
      "workboard.cards.list": { boards: [board], cards, statuses },
      "workboard.cards.stats": { ...board, byAgent: {} },
      "workboard.cards.move": { card: cards[0] },
      "progressCard.get": {
        card: {
          sessionKey,
          revision: 2,
          updatedAt: baseTime,
          markdown: "**Product launch** is moving through final checks.",
          steps: [
            { step: "Confirm release scope", status: "completed" },
            { step: "Validate onboarding flow", status: "in_progress" },
            { step: "Publish support handoff", status: "pending" },
          ],
        },
      },
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
      'Mock Control UI is running. Open the chat picker, search for "telegram" or "claude", then use Load more repeatedly.',
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

function buildCodeFenceChatHistory(baseTime: number): unknown[] {
  const proseFence = (language: string, label: string) => {
    const lines = Array.from({ length: 16 }, (_, index) => `${label} line ${index + 1}`);
    return `\`\`\`${language}\n${lines.join("\n")}\n\`\`\``;
  };
  const jsonLines = Array.from({ length: 18 }, (_, index) => `  "item-${index + 1}",`);
  jsonLines[jsonLines.length - 1] = `  "item-${jsonLines.length}"`;
  return [
    chatHistoryMessage("assistant", proseFence("text", "Plain text"), baseTime),
    chatHistoryMessage("assistant", proseFence("md", "Markdown alias"), baseTime + 1_000),
    chatHistoryMessage("assistant", proseFence("markdown", "Markdown"), baseTime + 2_000),
    chatHistoryMessage(
      "assistant",
      `\`\`\`json\n[\n${jsonLines.join("\n")}\n]\n\`\`\``,
      baseTime + 3_000,
    ),
  ];
}

function searchPrefixes(term: string): string[] {
  return Array.from({ length: term.length }, (_value, index) => term.slice(0, index + 1));
}

async function createChatPickerScenario(
  fixture?: CliOptions["fixture"],
): Promise<ControlUiMockGatewayScenario> {
  const baseTime = Date.parse("2026-05-22T09:00:00.000Z");
  const selfProfile: UserProfile = {
    id: "presence-riley",
    displayName: "Riley",
    avatarMime: null,
    mergedInto: null,
    createdAt: baseTime,
    updatedAt: baseTime,
    emails: ["riley@example.com"],
    githubIdentity: null,
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
  const whatsappLoginQrDataUrl = await qrcode.toDataURL("mock-whatsapp-login", {
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
  const sessionWorkspaceRoot = "/mock/workspace";
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
  const swarmGroupId = "swarm:agent:main:main:mock-turn";
  const swarmChildRows =
    fixture === "swarm"
      ? [
          sessionRow("agent:main:subagent:swarm-plan", "National polling", baseTime - 9_000, {
            parentSessionKey: "agent:main:main",
            spawnedBy: "agent:main:main",
            swarmGroupId,
            swarmPhase: "Research",
            swarmPhaseRank: 0,
            status: "done",
          }),
          sessionRow("agent:main:subagent:swarm-work", "Work and labor", baseTime - 8_000, {
            hasActiveRun: true,
            parentSessionKey: "agent:main:main",
            spawnedBy: "agent:main:main",
            swarmGroupId,
            swarmLog: "Comparing labor, education, and consumer signals.",
            swarmPhase: "Research",
            swarmPhaseRank: 0,
            status: "running",
          }),
          sessionRow("agent:main:subagent:swarm-health", "Health", baseTime - 7_000, {
            hasActiveRun: true,
            parentSessionKey: "agent:main:main",
            spawnedBy: "agent:main:main",
            swarmGroupId,
            swarmPhase: "Research",
            swarmPhaseRank: 0,
            status: "running",
          }),
          sessionRow("agent:main:subagent:swarm-trust", "Governance and trust", baseTime - 6_000, {
            parentSessionKey: "agent:main:main",
            spawnedBy: "agent:main:main",
            subagentRunState: "active",
            swarmGroupId,
            swarmPhase: "Research",
            swarmPhaseRank: 0,
            status: undefined,
          }),
          sessionRow("agent:main:subagent:swarm-media", "Media signals", baseTime - 5_000, {
            parentSessionKey: "agent:main:main",
            spawnedBy: "agent:main:main",
            swarmGroupId,
            swarmPhase: "Research",
            swarmPhaseRank: 0,
            status: "failed",
          }),
        ]
      : [];
  const workboardMocks = buildWorkboardMocks(baseTime);
  const activityTime = Date.now();
  const activitySessions = buildActivitySessionRows(activityTime);
  const dashboardGallerySessions =
    fixture === "dashboards"
      ? [
          sessionRow("agent:main:dashboard:release-health", "Release health", baseTime - 3_000, {
            boardFace: "dashboard",
            createdActor: MOCK_ACTOR_MIRA,
            hasActiveRun: true,
            status: "running",
          }),
          sessionRow("agent:main:dashboard:model-spend", "Model spend", baseTime - 8_000, {
            boardFace: "dashboard",
            createdActor: MOCK_ACTOR_PETER,
          }),
          sessionRow("agent:main:dashboard:support-radar", "Support radar", baseTime - 18_000, {
            boardFace: "dashboard",
            createdActor: MOCK_ACTOR_MIRA,
          }),
          sessionRow("agent:main:dashboard:ci-signal", "CI signal", baseTime - 42_000, {
            boardFace: "dashboard",
            createdActor: MOCK_ACTOR_PETER,
          }),
          sessionRow("agent:main:dashboard:community-pulse", "Community pulse", baseTime - 75_000, {
            boardFace: "dashboard",
            createdActor: MOCK_ACTOR_MIRA,
          }),
          sessionRow("agent:main:dashboard:gateway-fleet", "Gateway fleet", baseTime - 130_000, {
            boardFace: "dashboard",
            createdActor: MOCK_ACTOR_PETER,
          }),
        ]
      : [];
  const activeGoal = {
    schemaVersion: 1 as const,
    id: "goal-mobile-parity",
    objective:
      "Make Goal work on mobile exactly as it does on desktop while preserving action access, progress visibility, timing, token usage, and composer space across narrow viewports. Keep the collapsed state compact enough for active conversations, while making the expanded state comfortable to scan and operate with one hand. Preserve clear hierarchy between the objective, elapsed time, token budget, and available actions without letting long content push the composer out of reach. Ensure the full objective remains readable when it contains detailed constraints, acceptance criteria, rollout notes, and operational context that cannot be reduced to a short summary. Account for long-running sessions whose goals accumulate multiple requirements, edge cases, validation steps, ownership notes, and deployment considerations. The operator should be able to review all of that context without losing access to the Goal controls or forcing the message composer below the visible viewport.",
    status: "active" as const,
    createdAt: activityTime - 14 * 60_000,
    updatedAt: activityTime - 30_000,
    tokenStart: 120_000,
    tokenStartFresh: true,
    tokensUsed: 127_000,
    tokenBudget: 300_000,
    continuationTurns: 3,
  };
  const sessions = [
    ...activitySessions,
    ...dashboardGallerySessions,
    ...(fixture === "workboard"
      ? [
          sessionRow(workboardMocks.sessionKey, "Product operations dashboard", baseTime, {
            boardFace: "dashboard",
            pinned: true,
          }),
        ]
      : []),
    sessionRow("agent:main:main", "Molty", baseTime - 1_000, {
      activeRunIds: [PLAN_DEMO_RUN_ID],
      childSessions: ["agent:main:lisbon-trip", ...swarmChildRows.map((row) => row.key)],
      hasActiveRun: true,
      status: "running",
      totalTokens: 170_000,
      totalTokensFresh: true,
      ...(fixture === "goal" ? { goal: activeGoal } : {}),
    }),
    ...swarmChildRows,
    sessionRow(OBSERVER_DEMO_SESSION_KEY, "Session observer demo", baseTime - 3_000, {
      activeRunIds: [OBSERVER_DEMO_RUN_ID],
      hasActiveRun: true,
      lastReadAt: baseTime + 2_000,
      observerDigest: {
        headline: "Opening the focused observer tests",
        health: "on-track",
        revision: 1,
        runId: OBSERVER_DEMO_RUN_ID,
        updatedAt: baseTime - 2_000,
      },
      startedAt: baseTime - 4_000,
      status: "running",
    }),
    sessionRow(NARRATION_DEMO_SESSION_KEY, "Sidebar narration demo", baseTime - 15_000, {
      createdActor: MOCK_ACTOR_MIRA,
      hasActiveRun: true,
      owner: { actor: MOCK_ACTOR_MIRA },
      startedAt: baseTime - 45_000,
      status: "running",
    }),
    sessionRow("agent:main:tax-research", "Tax filing research", baseTime - 60_000, {
      hasActiveRun: true,
      status: "running",
      childSessions: ["agent:main:subagent:tax-receipts"],
      pinned: true,
    }),
    sessionRow("agent:main:cloud-refactor", "Cloud refactor worker", baseTime - 70_000, {
      hasActiveRun: true,
      status: "running",
      startedAt: baseTime - 3_500_000,
      execCwd: "/workspace/openclaw",
      placement: {
        state: "active",
        generation: 3,
        createdAtMs: baseTime - 3_600_000,
        updatedAtMs: baseTime - 20_000,
        stateChangedAtMs: baseTime - 3_500_000,
        environmentId: "worker:9f2c4e7a81d24b06a5c3f8e1b7d94c1a",
        providerId: "machine0",
        profileId: "team",
        activeOwnerEpoch: 4,
        workerBundleHash: "b".repeat(64),
        workspaceBaseManifestRef: "sha256:cloud-refactor-base",
        remoteWorkspaceDir: "/workspace/openclaw",
        diskSpace: {
          status: "ok",
          availableBytes: 61 * 1024 ** 3,
          totalBytes: 100 * 1024 ** 3,
          observedAtMs: baseTime - 20_000,
        },
      },
    }),
    sessionRow(
      "agent:main:production-export",
      "Investigate transcript scroll-anchor regression when the final code block expands",
      baseTime - 75_000,
      {
        category: "Research",
        createdActor: MOCK_ACTOR_MIRA,
        execCwd: "/Users/demo/Projects/clawdbot",
        owner: { actor: MOCK_ACTOR_MIRA },
      },
    ),
    sessionRow("agent:main:model-budget", "Model budget review", baseTime - 80_000, {
      category: "Research",
      execCwd: "/Users/demo/Projects/openclaw",
      owner: { actor: { type: "human", id: "presence-riley", label: "Riley" } },
      status: "failed",
      lastRunError: "Model out of credits: openai/gpt-5.6",
    }),
    sessionRow("agent:main:work-openclaw", "OpenClaw work checkout", baseTime - 85_000, {
      createdActor: MOCK_ACTOR_PETER,
      execCwd: "/Users/demo/Work/openclaw",
      lastReadAt: baseTime - 120_000,
      owner: { actor: MOCK_ACTOR_PETER },
      participantCount: 4,
      participants: [
        { identity: { type: "profile", id: "profile-mira" }, label: "Mira" },
        { identity: { type: "profile", id: "profile-riley" }, label: "Riley" },
        { identity: { type: "profile", id: "profile-sam" }, label: "Sam" },
        { identity: { type: "profile", id: "profile-lee" }, label: "Lee" },
      ],
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
      execCwd: "/Users/demo/Projects",
      execNode: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
      hasAutomation: true,
      pinned: true,
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
    // Second repo plus a spawned worktree checkout so the sidebar's
    // Project grouping shows several sections and the worktree fold.
    sessionRow("agent:main:clawdbot-vite", "Vite upgrade spike", baseTime - 160_000, {
      worktree: {
        id: "wt-clawdbot-vite",
        branch: "openclaw/vite-upgrade",
        repoRoot: "~/Projects/clawdbot",
      },
    }),
    sessionRow("agent:main:project-grouping", "Sidebar project grouping", baseTime - 170_000, {
      spawnedCwd: "~/Projects/openclaw/.claude/worktrees/groups-c7c338",
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
      archivedBy: MOCK_ACTOR_MIRA,
      createdActor: MOCK_ACTOR_PETER,
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
  const richAttention = fixture === "approval";
  const cronMocks = buildCronMocks(Date.now(), { richAttention });
  const updateFixtureNow = Date.now();
  const updateFixture = buildUpdateFixture(fixture, updateFixtureNow);
  const updateSchedule = updateFixture?.schedule ?? null;
  const heldUpdateSchedule: UpdateScheduleState | null = updateSchedule?.campaign
    ? {
        ...updateSchedule,
        campaign: {
          ...updateSchedule.campaign,
          holdUntilMs: updateFixtureNow + 60 * 60_000,
          updatedAtMs: updateFixtureNow,
        },
      }
    : null;
  const modelAuthStatus = richAttention
    ? {
        ...modelProviders.authStatus,
        providers: modelProviders.authStatus.providers.map((provider) =>
          provider.provider === "google"
            ? {
                ...provider,
                displayName: "Google Gemini",
                status: "expired" as const,
                profiles: [
                  {
                    profileId: "shared engineering",
                    type: "oauth" as const,
                    status: "expired" as const,
                    expiry: {
                      at: updateFixtureNow - 12 * 60_000,
                      remainingMs: -12 * 60_000,
                      label: "12m ago",
                    },
                  },
                ],
              }
            : provider,
        ),
      }
    : modelProviders.authStatus;
  const channelWizard = buildChannelWizardMocks();
  const configMocks = buildConfigMocks({
    swarmEnabled: fixture === "swarm",
    workboardEnabled: fixture === "workboard",
  });
  const historyMessages =
    fixture === "attachments"
      ? buildChatAttachmentHistory(baseTime)
      : fixture === "code-fences"
        ? buildCodeFenceChatHistory(baseTime)
        : buildScrollableChatHistory(baseTime);
  const planInFlightRun = {
    runId: PLAN_DEMO_RUN_ID,
    text: "",
    plan: {
      explanation: "Keep the Control UI change focused",
      steps: [
        { step: "Inspect the transcript renderer", status: "completed" },
        { step: "Confirm the plan event contract", status: "completed" },
        { step: "Remove the duplicate card summary", status: "in_progress" },
        { step: "Run focused UI tests", status: "pending" },
        { step: "Capture browser proof", status: "pending" },
      ],
    },
  };
  const backgroundTasks = buildBackgroundTasksMock(baseTime);
  const custodianHistory = {
    turns: [
      {
        role: "user",
        text: "Can you check whether this system is ready?",
        at: baseTime - 18 * 60_000,
      },
      {
        role: "assistant",
        text: "Everything important is connected. I’ll keep watching for changes.",
        at: baseTime - 17 * 60_000,
      },
      {
        role: "user",
        text: "Please remember that I prefer concise updates.",
        at: baseTime - 16 * 60_000,
      },
    ],
  } satisfies SystemAgentChatHistoryResult;
  const custodianChanges = {
    entries: [
      {
        id: "mock-system-agent-model",
        at: baseTime - 6 * 60_000,
        kind: "operation",
        source: "system-agent",
        summary: "Updated the default model for the main agent",
        changedPaths: ["agents.defaults.model"],
      },
      {
        id: "mock-plugin-install",
        at: baseTime - 42 * 60_000,
        kind: "config-write",
        source: "plugin-install",
        summary: "Enabled the Telegram plugin",
        changedPaths: ["plugins.entries.telegram.enabled"],
      },
      {
        id: "mock-doctor-repair",
        at: baseTime - 2 * 60 * 60_000,
        kind: "config-write",
        source: "doctor",
        summary: "Repaired a stale channel account reference",
        changedPaths: ["channels.whatsapp.defaultAccount"],
      },
    ],
  } satisfies SystemChangesListResult;
  return {
    assistantAgentId: "main",
    assistantName: "Molty",
    defaultAgentId: "main",
    gatewayBootId: "mock-gateway-boot-1",
    serverBuildId: "mock",
    updateSchedule,
    updateAvailable: updateFixture?.available ?? null,
    // Advertised Gateway methods gate session actions (see
    // ui/src/lib/session-method-access.ts). Omitting the mutation methods left
    // every session context-menu row disabled, so the harness could not show
    // the menu operators actually see. browser.request/terminal.open likewise
    // gate the chat header's panel toggles, which stayed invisible here.
    featureMethods: [
      "browser.request",
      "chat.abort",
      "chat.history",
      "chat.send",
      "config.patch",
      "config.schema",
      "chat.metadata",
      "chat.startup",
      "question.list",
      "openclaw.changes.list",
      "openclaw.chat",
      "openclaw.chat.history",
      "progressCard.get",
      "sessions.delete",
      "sessions.diff",
      "sessions.files.set",
      "sessions.fork",
      "sessions.groups.delete",
      "sessions.groups.list",
      "sessions.groups.put",
      "sessions.groups.rename",
      "sessions.patch",
      "sessions.patchMany",
      "sessions.search",
      "sessions.catalog.list",
      "sessions.catalog.read",
      "sessions.create",
      "system.info",
      "desktop.observe",
      "environments.list",
      "terminal.open",
      ...(updateFixture ? ["update.hold", "update.run", "update.status"] : []),
      ...(fixture === "workboard"
        ? [
            "board.get",
            "workboard.boards.list",
            "workboard.cards.list",
            "workboard.cards.move",
            "workboard.cards.stats",
          ]
        : []),
    ],
    controlUiTabs:
      fixture === "workboard"
        ? [
            {
              group: "control",
              icon: "kanban",
              id: "workboard",
              label: "Workboard",
              placement: "route:workboard",
              pluginId: "workboard",
            },
          ]
        : [],
    controlUiWidgetKinds: [
      { pluginId: "session", kind: "session:progress", label: "Session progress" },
      ...(fixture === "workboard"
        ? [
            { pluginId: "workboard", kind: "workboard:board", label: "Workboard board" },
            { pluginId: "workboard", kind: "workboard:card", label: "Workboard card" },
            { pluginId: "workboard", kind: "workboard:mini", label: "Workboard summary" },
          ]
        : []),
    ],
    // Terminal has a second gate beyond the advertised method (see
    // ui/src/lib/terminal-availability.ts).
    terminalEnabled: true,
    // The mock rows span several owners; advertise the multi-identity policy
    // so people-aware UI (People sort, Person grouping) is exercisable here.
    hasMultipleSessionSharingIdentities: true,
    historyMessages,
    sessionGroups: ["Research"],
    sessionTranscripts: {
      ...backgroundTasks.sessionTranscripts,
      "agent:main:main": { messages: historyMessages, inFlightRun: planInFlightRun },
    },
    // Lights up the footer facepile and who's-online roster; the email-only
    // entry keeps the roster's no-display-name row exercised.
    presenceUsers: [
      {
        self: true,
        id: selfProfile.id,
        name: selfProfile.displayName ?? undefined,
        email: selfProfile.emails[0],
        avatarUrl: `/api/users/${selfProfile.id}/avatar`,
      },
      {
        id: "presence-colin",
        name: "Colin",
        email: "colin@example.com",
        onlineSince: activityTime - 47 * 60_000,
        lastActivityAt: activityTime - 2 * 60_000,
        deviceFamily: "Mac",
        platform: "macOS",
        timeZone: "America/Los_Angeles",
        watchedSessions: ["agent:activity:design-review", "agent:main:main"],
      },
      {
        id: "presence-colin",
        name: "Colin",
        email: "colin@example.com",
        onlineSince: activityTime - 47 * 60_000,
        lastActivityAt: activityTime - 2 * 60_000,
        deviceFamily: "Mac",
        platform: "macOS",
        timeZone: "America/Los_Angeles",
        watchedSessions: ["agent:activity:design-review"],
      },
      {
        id: "presence-patricia",
        email: "patricia.erichsen@example.com",
        onlineSince: activityTime - 12 * 60_000,
        lastActivityAt: activityTime - 30_000,
        deviceFamily: "iPhone",
        platform: "iOS",
        timeZone: "Europe/Stockholm",
        watchedSessions: ["agent:activity:support-handoff"],
      },
    ],
    methodResponses: {
      ...backgroundTasks.methodResponses,
      ...cronMocks,
      "progressCard.get": { card: null },
      "users.self": { profile: selfProfile },
      // Talk settings page pickers: realtime catalog with the model/voice
      // suggestion lists the gateway emits for provider entries.
      "talk.catalog": {
        modes: ["realtime", "stt-tts", "transcription"],
        transports: ["webrtc", "provider-websocket", "gateway-relay", "managed-room"],
        brains: ["agent-consult", "direct-tools", "none"],
        speech: { providers: [] },
        transcription: { providers: [] },
        realtime: {
          ready: true,
          activeProvider: "openai",
          providers: [
            {
              id: "openai",
              label: "OpenAI Realtime Voice",
              configured: true,
              defaultModel: "gpt-realtime-2.1",
              transports: ["webrtc", "gateway-relay"],
              models: [
                "gpt-realtime-2.1",
                "gpt-realtime-2.1-mini",
                "gpt-realtime-2",
                "gpt-live-1-codex",
              ],
              voices: [
                "alloy",
                "ash",
                "ballad",
                "cedar",
                "coral",
                "echo",
                "marin",
                "sage",
                "shimmer",
                "verse",
              ],
              modes: ["realtime"],
              brains: ["agent-consult"],
              supportsBrowserSession: true,
            },
            {
              id: "xai",
              label: "xAI Grok Voice",
              configured: false,
              defaultModel: "grok-voice-latest",
              transports: ["gateway-relay"],
              voices: ["eve", "ara", "rex", "sal", "leo"],
              modes: ["realtime"],
              brains: ["agent-consult"],
              supportsBrowserSession: false,
            },
          ],
        },
      },
      // Coding session catalogs so the sidebar's catalog sections (header
      // right-click menu, hide/restore preference) are exercised in the mock.
      // Ids must match registered plugin catalogs (`claude`, `codex`) or the
      // sidebar cannot resolve bundled brand marks.
      "sessions.catalog.list": {
        catalogs: [
          {
            id: "codex",
            label: "Codex",
            capabilities: { continueSession: true, archive: false },
            hosts: [
              {
                hostId: "gateway",
                label: "This Mac",
                kind: "gateway",
                connected: true,
                sessions: [
                  {
                    threadId: "codex-thread-1",
                    name: "Release checklist sweep",
                    cwd: "/Users/demo/projects/openclaw",
                    status: "idle",
                    updatedAt: baseTime - 10 * 60_000,
                    archived: false,
                    canContinue: true,
                    canArchive: false,
                  },
                  {
                    threadId: "codex-thread-2",
                    name: "Sidebar context-menu proof",
                    cwd: "/Users/demo/projects/openclaw",
                    status: "idle",
                    updatedAt: baseTime - 45 * 60_000,
                    archived: false,
                    canContinue: true,
                    canArchive: false,
                  },
                ],
              },
            ],
          },
          {
            id: "claude",
            label: "Claude Code",
            capabilities: { continueSession: true, archive: false },
            hosts: [
              {
                hostId: "gateway",
                label: "This Mac",
                kind: "gateway",
                connected: true,
                sessions: [
                  {
                    threadId: "claude-thread-1",
                    name: "Docs refresh",
                    cwd: "/Users/demo/projects/peekaboo",
                    status: "idle",
                    updatedAt: baseTime - 30 * 60_000,
                    archived: false,
                    canContinue: true,
                    canArchive: false,
                  },
                ],
              },
            ],
          },
        ],
      },
      "sessions.catalog.read": {
        cases: [
          {
            match: { catalogId: "codex", hostId: "gateway", threadId: "codex-thread-1" },
            response: {
              hostId: "gateway",
              threadId: "codex-thread-1",
              items: [
                {
                  id: "release-checklist-answer",
                  type: "agentMessage",
                  text: "The release checklist is complete and ready for review.",
                },
                {
                  id: "release-checklist-request",
                  type: "userMessage",
                  text: "Please sweep the release checklist for anything we missed.",
                },
              ],
            },
          },
          {
            match: { catalogId: "codex", hostId: "gateway", threadId: "codex-thread-2" },
            response: {
              hostId: "gateway",
              threadId: "codex-thread-2",
              items: [
                {
                  id: "sidebar-context-menu-answer",
                  type: "agentMessage",
                  text: "The sidebar context menu behaves as expected.",
                },
              ],
            },
          },
          {
            match: {
              catalogId: "claude",
              hostId: "gateway",
              threadId: "claude-thread-1",
            },
            response: {
              hostId: "gateway",
              threadId: "claude-thread-1",
              items: [
                {
                  id: "docs-refresh-answer",
                  type: "agentMessage",
                  text: "The documentation refresh is ready for review.",
                },
              ],
            },
          },
        ],
      },
      "system.info": {
        machineName: "Mock-Workstation",
        hostname: "mock-workstation.invalid",
        platform: "darwin",
        release: "25.0.0",
        arch: "arm64",
        osLabel: "macOS 26.5",
        nodeVersion: "24.15.0",
        pid: 4242,
        uptimeMs: (11 * 24 + 4) * 3_600_000,
        loadAverage: [3.2, 2.8, 2.4],
        cpuCount: 16,
        memoryTotalBytes: 68_719_476_736,
        memoryFreeBytes: 34_359_738_368,
        diskTotalBytes: 1_000_000_000_000,
        diskAvailableBytes: 640_000_000_000,
        diskPath: "/Users/demo/.openclaw",
        defaultAgentUtilityModel: {
          status: "auto",
          model: "anthropic/claude-haiku-4-5",
        },
      },
      "fs.listDir": {
        cases: [
          {
            match: { path: "/Users/demo/Projects/openclaw" },
            response: {
              path: "/Users/demo/Projects/openclaw",
              parent: "/Users/demo/Projects",
              home: "/Users/demo",
              entries: [
                { name: "ui", path: "/Users/demo/Projects/openclaw/ui" },
                { name: "src", path: "/Users/demo/Projects/openclaw/src" },
                { name: "docs", path: "/Users/demo/Projects/openclaw/docs" },
                { name: "packages", path: "/Users/demo/Projects/openclaw/packages" },
              ],
            },
          },
          {
            match: { path: "/Users/demo/Projects" },
            response: {
              path: "/Users/demo/Projects",
              parent: "/Users/demo",
              home: "/Users/demo",
              entries: [
                { name: "openclaw", path: "/Users/demo/Projects/openclaw" },
                { name: "clawdbot", path: "/Users/demo/Projects/clawdbot" },
                { name: "sweetistics", path: "/Users/demo/Projects/sweetistics" },
                { name: "Peekaboo", path: "/Users/demo/Projects/Peekaboo" },
              ],
            },
          },
          {
            match: {},
            response: {
              path: "/Users/demo",
              parent: "/Users",
              home: "/Users/demo",
              entries: [
                { name: "Projects", path: "/Users/demo/Projects" },
                { name: "Downloads", path: "/Users/demo/Downloads" },
                { name: ".config", path: "/Users/demo/.config", hidden: true },
              ],
            },
          },
        ],
      },
      "worktrees.branches": {
        cases: [
          {
            match: { repoRoot: "/Users/demo/Projects/openclaw" },
            response: {
              repoRoot: "/Users/demo/Projects/openclaw",
              branches: [
                { kind: "local", name: "main" },
                { kind: "local", name: "steipete/place-picker" },
              ],
              repositoryStatus: "git",
              defaultBranch: "main",
              headBranch: "main",
            },
          },
          {
            match: { repoRoot: "/Users/demo/Projects/clawdbot" },
            response: {
              repoRoot: "/Users/demo/Projects/clawdbot",
              branches: [
                { kind: "local", name: "main" },
                { kind: "local", name: "steipete/storage-selector-design" },
              ],
              repositoryStatus: "git",
              defaultBranch: "main",
              headBranch: "main",
            },
          },
        ],
      },
      "environments.list": {
        environments: [
          {
            id: "gateway",
            type: "gateway",
            label: "Gateway host",
            status: "available",
            desktop: true,
          },
          {
            id: "node:a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
            type: "node",
            label: "Mac Studio",
            status: "available",
            desktop: true,
          },
        ],
        profiles: [{ id: "aws", providerId: "aws" }],
      },
      // config.set/config.apply are served statefully by the mock gateway
      // (raw persists, hash advances) because config.get ships a raw fixture.
      "config.get": configMocks.get,
      "config.set": configMocks.set,
      "config.apply": configMocks.apply,
      "config.schema": configMocks.schema,
      "openclaw.chat.history": custodianHistory,
      "openclaw.changes.list": custodianChanges,
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
      // Pending exec approvals recover through the same list seam as the real
      // Inbox. Keep this fixture small enough to inspect both rows at once.
      "exec.approval.list":
        fixture === "approval"
          ? [
              {
                id: "mock-production-export-approval",
                request: {
                  command: "openclaw export --target production",
                  agentId: "main",
                  sessionKey: "agent:main:production-export",
                  host: "mock-workstation.invalid",
                  cwd: "/Users/demo/Projects/openclaw",
                  security: "full",
                  ask: "on-miss",
                  allowedDecisions: ["allow-once", "allow-always", "deny"],
                },
                createdAtMs: updateFixtureNow - 7 * 60_000,
                expiresAtMs: updateFixtureNow + 4 * 60 * 60_000,
              },
              {
                id: "mock-worktree-cleanup-approval",
                request: {
                  command: "git -C /mock/workspace clean -nd",
                  agentId: "release",
                  sessionKey: "agent:main:worktree-cleanup",
                  host: "mock-workstation.invalid",
                  cwd: "/mock/workspace",
                  security: "sandboxed",
                  ask: "always",
                  allowedDecisions: ["allow-once", "deny"],
                },
                createdAtMs: updateFixtureNow - 6 * 60_000,
                expiresAtMs: updateFixtureNow + 4 * 60 * 60_000,
              },
            ]
          : [],
      "plugin.approval.list": [],
      "openclaw.approval.list": [],
      "exec.approval.resolve": { ok: true },
      "plugin.approval.resolve": { ok: true },
      "approval.resolve": { ok: true },
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
      "plugins.inspect": buildPluginInspectMock(),
      "plugins.setEnabled": buildPluginSetEnabledMock(),
      "channels.status": buildChannelsStatusMock(baseTime),
      "channels.pairing.list": buildChannelsPairingMock(baseTime),
      "channels.pairing.approve": {
        cases: [
          {
            match: { requestId: "pairing-req-1" },
            response: {
              requestId: "pairing-req-1",
              senderId: "552731142",
              notification: "sent",
              commandOwnerBootstrap: "not-requested",
            },
          },
          {
            response: {
              requestId: "pairing-req-2",
              senderId: "+1 555 0192",
              notification: "unsupported",
              commandOwnerBootstrap: "not-requested",
            },
          },
        ],
      },
      "channels.pairing.dismiss": {
        cases: [
          {
            match: { requestId: "pairing-req-1" },
            response: { requestId: "pairing-req-1", senderId: "552731142" },
          },
          { response: { requestId: "pairing-req-2", senderId: "+1 555 0192" } },
        ],
      },
      "web.login.start": {
        message: "Scan the QR code with WhatsApp to link this device.",
        qrDataUrl: whatsappLoginQrDataUrl,
      },
      "web.login.wait": { message: "Linked.", connected: true },
      "wizard.start": channelWizard.start,
      "wizard.next": channelWizard.next,
      "wizard.cancel": { status: "cancelled" },
      "skills.proposals.list": skillWorkshop.list,
      "skills.proposals.inspect": skillWorkshop.inspect,
      "skills.proposals.historyStatus": skillWorkshop.historyStatus,
      "skills.proposals.historyScan": skillWorkshop.historyScan,
      "usage.cost": profileUsage.cost,
      "sessions.usage": profileUsage.sessions,
      "models.authStatus": modelAuthStatus,
      "update.hold": heldUpdateSchedule
        ? { ok: true, schedule: heldUpdateSchedule }
        : { ok: false },
      "update.run": updateFixture?.runResponse ?? {},
      "update.status": updateFixture?.statusResponse ?? {},
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
            displayName: "Mac mini",
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
            modelIdentifier: "Mac15,14",
            remoteIp: "192.168.1.11",
            version: "2026.6.11",
            connected: true,
            paired: true,
            approvalState: "approved",
            connectedAtMs: baseTime - 60_000,
            hostStats: {
              cpuCount: 24,
              loadAverage: [3.2, 2.8, 2.4],
              memoryTotalBytes: 192 * 1024 ** 3,
              memoryFreeBytes: 41 * 1024 ** 3,
              diskTotalBytes: 2 * 1024 ** 4,
              diskAvailableBytes: 1.2 * 1024 ** 4,
              updatedAtMs: baseTime,
            },
            caps: [
              "browser",
              "canvas",
              "screen",
              "computer",
              "file",
              "system",
              "mcp",
              "local-inference",
              "claude-sessions",
              "codex-cli-sessions",
              "pi-sessions",
            ],
            commands: [
              "desktop.stream",
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
            displayName: "Mac mini",
            platform: "darwin",
            deviceFamily: "Mac",
            modelIdentifier: "Mac16,11",
            remoteIp: "192.168.1.12",
            version: "2026.6.10",
            connected: true,
            paired: true,
            approvalState: "approved",
            lastSeenAtMs: baseTime - 82_800_000,
            hostStats: {
              cpuCount: 12,
              loadAverage: [15.4, 13.8, 11.2],
              memoryTotalBytes: 32 * 1024 ** 3,
              memoryFreeBytes: 2 * 1024 ** 3,
              diskTotalBytes: 1024 ** 4,
              diskAvailableBytes: 64 * 1024 ** 3,
              updatedAtMs: baseTime,
            },
            caps: ["browser", "computer", "file", "system", "codex-cli-sessions"],
            commands: ["desktop.stream", "screen.snapshot", "system.run"],
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
      "sessions.companion.ask": {
        cases: [
          {
            match: { sessionKey: OBSERVER_DEMO_SESSION_KEY },
            response: {
              answer: "It is rerunning the focused test to check whether the latest fix is stable.",
              ts: baseTime + 2_000,
            },
          },
        ],
      },
      // Saturated-main fixture so the debug page and overlay render queued and
      // group-budget states, not just idle lanes.
      "diagnostics.lanes": {
        ts: baseTime,
        lanes: [
          {
            lane: "cron",
            queuedCount: 0,
            activeCount: 1,
            maxConcurrent: 4,
            draining: false,
            generation: 1,
          },
          {
            lane: "cron-nested",
            queuedCount: 0,
            activeCount: 1,
            maxConcurrent: 4,
            draining: false,
            generation: 1,
            group: "cron-hooks",
            groupActive: 2,
            groupBudget: 4,
          },
          {
            lane: "hook-dispatch",
            queuedCount: 2,
            activeCount: 1,
            maxConcurrent: 4,
            draining: false,
            generation: 1,
            group: "cron-hooks",
            groupActive: 2,
            groupBudget: 4,
            reservedForLane: 1,
            blockedBy: "group-budget",
          },
          {
            lane: "main",
            queuedCount: 3,
            activeCount: 16,
            maxConcurrent: 16,
            draining: false,
            generation: 7,
            blockedBy: "lane",
          },
          {
            lane: "nested",
            queuedCount: 0,
            activeCount: 0,
            maxConcurrent: 1,
            draining: false,
            generation: 1,
          },
          {
            lane: "subagent",
            queuedCount: 5,
            activeCount: 8,
            maxConcurrent: 8,
            draining: false,
            generation: 4,
            blockedBy: "lane",
          },
        ],
        dynamic: {
          laneCount: 23,
          activeCount: 9,
          queuedCount: 4,
          queuedLaneCount: 3,
        },
      },
      status: {
        eventLoop: { utilization: 0.42, cpuCoreRatio: 0.24, delayP99Ms: 12, delayMaxMs: 87 },
        processMemory: {
          rssBytes: 432 * 1_048_576,
          heapUsedBytes: 210 * 1_048_576,
          heapTotalBytes: 280 * 1_048_576,
        },
        uptimeMs: 5_412_000,
      },
      "last-heartbeat": { ts: baseTime },
      "sessions.list": {
        cases: [
          // Child fetches must precede the catch-all page case (subset match).
          {
            match: { spawnedBy: "agent:main:main" },
            response: pagedSessionsListResponse([mainChildRow, ...swarmChildRows], 0),
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
          ...buildSessionListCases([...sessions, ...archivedSessions], {}, MOCK_SESSION_OWNERS),
        ],
      },
      "sessions.search": { results: [] },
      ...(fixture === "workboard" ? workboardMocks.methodResponses : {}),
    },
    models: modelProviders.models,
    repeatingSessionEvents: {
      intervalMs: 3_000,
      events: [
        {
          event: "session.observer",
          payload: {
            headline: "Reading the failing test and its board caller",
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
            assessment:
              "The first fix was incomplete, so the agent is narrowing the assertion path.",
            headline: "Third run of the same vitest file - two assertions still failing",
            health: "grinding",
            planProgress: { completed: 2, total: 4 },
            revision: 3,
            runId: OBSERVER_DEMO_RUN_ID,
            sessionKey: OBSERVER_DEMO_SESSION_KEY,
            updatedAt: baseTime + 4_000,
          },
        },
        {
          event: "session.observer",
          payload: {
            assessment: "Repeated identical failures suggest the current approach needs a reset.",
            headline: "Same failure five runs in a row - it may be circling",
            health: "stuck",
            planProgress: { completed: 2, total: 4 },
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
    sessions: [
      ...sessions,
      ...backgroundTasks.sessions,
      ...archivedSessions,
      ...telegramSessions,
      ...claudeSessions,
      taxChildRow,
    ],
    sessionKey: fixture === "workboard" ? workboardMocks.sessionKey : "agent:main:main",
    workspace: "/Users/demo/Projects/openclaw",
    workspaceGit: true,
  };
}

function escapeScriptContent(script: string): string {
  return script.replaceAll("</script", "<\\/script");
}

function createMockGatewayPlugin(
  scenario: ControlUiMockGatewayScenario,
  fixture?: CliOptions["fixture"],
): Plugin {
  const initScript = escapeScriptContent(createControlUiMockGatewayInitScript(scenario));
  const sameOriginGatewayScript = escapeScriptContent(createControlUiMockSameOriginGatewayScript());
  const statefulInitScript = escapeScriptContent(
    createControlUiPreviewInitScript() + skillLibraryMockInitScript(scenario.models),
  );
  const bootstrapBody = JSON.stringify(createControlUiMockBootstrapConfig(scenario));
  const pluginIconIds = new Set(
    buildPluginCatalogMock()
      .plugins.filter((plugin) => plugin.hasIcon)
      .map((plugin) => plugin.id),
  );
  const attachmentThemeToggle =
    fixture === "attachments"
      ? `    <style data-openclaw-control-ui-mock-theme-toggle>
      .control-ui-mock-theme-toggle { position: fixed; right: 16px; bottom: 16px; z-index: 1000; display: inline-flex; gap: 2px; padding: 3px; border: 1px solid var(--border-strong); border-radius: 999px; background: var(--card); box-shadow: var(--shadow-md); }
      .control-ui-mock-theme-toggle button { min-height: 28px; padding: 0 10px; border: 0; border-radius: 999px; color: var(--muted); background: transparent; font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; }
      .control-ui-mock-theme-toggle button[aria-pressed="true"] { color: var(--text); background: var(--bg-hover); }
    </style>
    <script data-openclaw-control-ui-mock-theme-toggle>
      addEventListener("DOMContentLoaded", () => {
        const control = document.createElement("div");
        control.className = "control-ui-mock-theme-toggle";
        control.setAttribute("aria-label", "Theme");
        const apply = (mode) => {
          const root = document.documentElement;
          root.dataset.themeMode = mode;
          root.dataset.themeResolved = mode;
          root.classList.toggle("wa-light", mode === "light");
          root.classList.toggle("wa-dark", mode === "dark");
          root.style.colorScheme = mode;
          for (const button of control.querySelectorAll("button")) {
            button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
          }
        };
        for (const mode of ["dark", "light"]) {
          const button = document.createElement("button");
          button.type = "button";
          button.dataset.mode = mode;
          button.textContent = mode === "dark" ? "Dark" : "Light";
          button.addEventListener("click", () => apply(mode));
          control.append(button);
        }
        document.body.append(control);
        apply(document.documentElement.dataset.themeMode === "light" ? "light" : "dark");
      });
    </script>
`
      : "";
  return {
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const prefix = "/__openclaw__/plugin-icon/";
        const pathname = new URL(req.url ?? "/", "http://openclaw.invalid").pathname;
        if (!pathname.startsWith(prefix)) {
          next();
          return;
        }
        const pluginId = decodeURIComponent(pathname.slice(prefix.length));
        if (!pluginIconIds.has(pluginId)) {
          next();
          return;
        }
        const icon = path.join(repoRoot, "extensions", pluginId, "assets", "icon.png");
        if (!fs.existsSync(icon)) {
          next();
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", "image/png");
        res.end(fs.readFileSync(icon));
      });
      server.middlewares.use(CONTROL_UI_BOOTSTRAP_CONFIG_PATH, (_req, res) => {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(bootstrapBody);
      });
    },
    // ui/vite.config.ts registers a placeholder bootstrap-config middleware and
    // config-file plugins load first, so without "pre" its stub answers every
    // request and the scenario's bootstrap fields never reach the app.
    enforce: "pre",
    name: "openclaw-control-ui-mock-gateway",
    transformIndexHtml(html) {
      return html.replace(
        "</head>",
        `${attachmentThemeToggle}    <script data-openclaw-control-ui-mock-locale>\n      try { localStorage.setItem("openclaw.i18n.locale", "en"); } catch {}\n    </script>\n    <script data-openclaw-control-ui-mock-gateway>\n${sameOriginGatewayScript}\n${initScript}\n${statefulInitScript}\n    </script>\n  </head>`,
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
const scenario = await createChatPickerScenario(options.fixture);
if (options.operatorScopes) {
  scenario.operatorScopes = options.operatorScopes;
}
// Vite replaces its deps cache when fixture plugins or mode change. Concurrent
// mocks need separate owners so one startup cannot invalidate another's modules.
const cacheRoot = path.join(repoRoot, ".artifacts", "control-ui-mock-vite");
await mkdir(cacheRoot, { recursive: true });
const cacheDir = await mkdtemp(path.join(cacheRoot, "server-"));
// Vite's SIGTERM handler calls process.exit() after closing, bypassing finally.
// The process owns this cache, so its exit hook is the single cleanup path.
process.once("exit", () => rmSync(cacheDir, { recursive: true, force: true }));
let server: ViteDevServer | undefined;
try {
  server = await createServer({
    base: "/",
    cacheDir,
    clearScreen: false,
    configFile: path.join(uiRoot, "vite.config.ts"),
    define: {
      "globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO": JSON.stringify({
        version: "2026.7.10",
        commit: "0123456789abcdef0123456789abcdef01234567",
        commitAt: "2026-07-10T11:22:33.000Z",
        builtAt: "2026-07-10T12:34:56.000Z",
        branch: null,
        dirty: null,
        release: false,
        buildId: scenario.serverBuildId,
      }),
    },
    logLevel: "error",
    optimizeDeps: {
      ...(options.fixture === "board"
        ? { entries: [path.join(uiRoot, "src", "test-helpers", "board-fixture.ts")] }
        : {}),
      include: ["lit/directives/repeat.js"],
    },
    plugins: [
      ...createStandaloneMockIsolationPlugins(),
      createMockGatewayPlugin(scenario, options.fixture),
      createBoardFixturePlugin(),
      ...(options.fixture === "attachments" ? [createChatAttachmentFixturePlugin()] : []),
    ],
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
  console.log(
    `[control-ui-mock] ${resolveServerUrl(server, options.host, controlUiSessionPath(scenario.sessionKey ?? "agent:main:main"))}`,
  );
  console.log(
    `[control-ui-mock] board fixture: ${resolveServerUrl(server, options.host, boardFixturePath)}`,
  );
  await waitForShutdown();
} finally {
  await server?.close();
}
