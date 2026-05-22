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

function sessionRow(key: string, label: string, updatedAt: number) {
  return {
    contextTokens: null,
    displayName: label,
    hasActiveRun: false,
    key,
    kind: "direct",
    label,
    model: "gpt-5.5",
    modelProvider: "openai",
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

function createChatPickerScenario(): ControlUiMockGatewayScenario {
  const baseTime = Date.parse("2026-05-22T09:00:00.000Z");
  return {
    assistantAgentId: "openclaw-mock",
    assistantName: "OpenClaw mock",
    defaultAgentId: "openclaw-mock",
    historyMessages: [
      {
        content: [
          {
            text: 'Mock Control UI is running. Open the chat picker, search for "telegram", then use Load more.',
            type: "text",
          },
        ],
        role: "assistant",
        timestamp: baseTime,
      },
    ],
    methodResponses: {
      "sessions.list": {
        cases: [
          {
            match: { offset: 50, search: "telegram" },
            response: sessionsListResponse(
              [
                sessionRow("agent:telegram-51", "Telegram archive page 51", baseTime - 180_000),
                sessionRow("agent:telegram-52", "Telegram archive page 52", baseTime - 240_000),
              ],
              { hasMore: false, nextOffset: null, offset: 50, totalCount: 4 },
            ),
          },
          {
            match: { search: "telegram" },
            response: sessionsListResponse(
              [
                sessionRow("agent:telegram", "Telegram follow-up", baseTime - 60_000),
                sessionRow("agent:telegram-mobile", "Telegram mobile handoff", baseTime - 120_000),
              ],
              { hasMore: true, nextOffset: 50, totalCount: 4 },
            ),
          },
          {
            match: {},
            response: sessionsListResponse(
              [
                sessionRow("agent:alpha", "Alpha planning", baseTime - 1_000),
                sessionRow("agent:design", "Design review", baseTime - 30_000),
              ],
              { hasMore: true, nextOffset: 50, totalCount: 125 },
            ),
          },
        ],
      },
    },
    models: [{ id: "gpt-5.5", name: "gpt-5.5", provider: "openai" }],
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
