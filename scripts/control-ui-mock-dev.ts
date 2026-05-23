import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../src/gateway/control-ui-contract.js";
import {
  createControlUiMockBootstrapConfig,
  createControlUiMockGatewayInitScript,
  type ControlUiMockGatewayScenario,
} from "../ui/src/test-helpers/control-ui-e2e.ts";

type CliOptions = {
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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiRoot = path.join(repoRoot, "ui");

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { host: "127.0.0.1", port: 5187 };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--host") {
      options.host = args[++i] ?? options.host;
    } else if (arg.startsWith("--host=")) {
      options.host = arg.slice("--host=".length) || options.host;
    } else if (arg === "--port") {
      options.port = parsePort(args[++i], options.port);
    } else if (arg.startsWith("--port=")) {
      options.port = parsePort(arg.slice("--port=".length), options.port);
    }
  }
  return options;
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : fallback;
}

function sessionRow(
  key: string,
  label: string,
  updatedAt: number,
  options: { model?: string; modelProvider?: string } = {},
) {
  return {
    contextTokens: null,
    displayName: label,
    hasActiveRun: false,
    key,
    kind: "direct",
    label,
    model: options.model ?? "gpt-5.5",
    modelProvider: options.modelProvider ?? "openai",
    status: "done",
    totalTokens: 0,
    updatedAt,
  };
}

function sessionsListResponse(sessions: unknown[], options: SessionListOptions) {
  return {
    count: sessions.length,
    defaults: {
      contextTokens: null,
      model: "gpt-5.5",
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

  return messages;
}

function searchPrefixes(term: string): string[] {
  return Array.from({ length: term.length }, (_value, index) => term.slice(0, index + 1));
}

function createChatPickerScenario(): ControlUiMockGatewayScenario {
  const baseTime = Date.parse("2026-05-22T09:00:00.000Z");
  const sessions = [
    sessionRow("agent:alpha", "Alpha planning", baseTime - 1_000),
    ...buildSessionRows({
      baseTime: baseTime - 60_000,
      count: TOTAL_MOCK_SESSIONS - 1,
      keyPrefix: "history",
      labelPrefix: "Long running session",
    }),
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
  return {
    assistantAgentId: "openclaw-mock",
    assistantName: "OpenClaw mock",
    defaultAgentId: "openclaw-mock",
    historyMessages: buildScrollableChatHistory(baseTime),
    methodResponses: {
      "sessions.list": {
        cases: [
          ...buildSearchSessionListCases(telegramSessions, searchPrefixes("telegram")),
          ...buildSearchSessionListCases(claudeSessions, [
            ...searchPrefixes("claude"),
            ...searchPrefixes("claude-sonnet-4-6"),
            ...searchPrefixes("anthropic"),
          ]),
          ...buildSessionListCases(sessions),
        ],
      },
    },
    models: [
      { id: "gpt-5.5", name: "gpt-5.5", provider: "openai" },
      { id: "claude-sonnet-4-6", name: "claude-sonnet-4-6", provider: "anthropic" },
    ],
    sessionKey: "agent:alpha",
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

function hostForUrl(boundAddress: string, requestedHost: string): string {
  const host = boundAddress === "0.0.0.0" || boundAddress === "::" ? requestedHost : boundAddress;
  const reachableHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return reachableHost.includes(":") ? `[${reachableHost}]` : reachableHost;
}

function resolveServerUrl(server: ViteDevServer, requestedHost: string): string {
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("Control UI mock server did not expose a TCP port");
  }
  return `http://${hostForUrl(address.address, requestedHost)}:${address.port}/chat`;
}

async function waitForShutdown(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

const options = parseArgs(process.argv.slice(2));
const scenario = createChatPickerScenario();
const server = await createServer({
  base: "/",
  cacheDir: path.join(repoRoot, ".artifacts", "control-ui-mock-vite"),
  clearScreen: false,
  configFile: false,
  define: {
    OPENCLAW_CONTROL_UI_BUILD_ID: JSON.stringify("mock"),
  },
  logLevel: "error",
  optimizeDeps: {
    include: ["lit/directives/repeat.js"],
  },
  plugins: [createMockGatewayPlugin(scenario)],
  publicDir: path.join(uiRoot, "public"),
  root: uiRoot,
  server: {
    host: options.host,
    port: options.port,
    strictPort: false,
  },
});

await server.listen();
console.log(`[control-ui-mock] ${resolveServerUrl(server, options.host)}`);
await waitForShutdown();
await server.close();
