import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

const PRIMARY_MODEL = "anthropic/claude-opus-4-8";
const FALLBACK_MODEL = "anthropic/claude-sonnet-4-6";
const REFUSAL_EXPLANATION = "Service unavailable. Try again.";
const REFUSAL_TEXT =
  "The provider refused this request (category: reasoning_extraction). Revise the request and try again.";

type GatewayRun = {
  runId?: unknown;
  status?: unknown;
};

type GatewayHistory = {
  messages?: Array<{ role?: unknown; content?: unknown }>;
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).toReversed()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "provider refusal product proof cleanup failed");
  }
});

function messageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : [],
    )
    .join("\n");
}

async function startRefusingAnthropicProvider() {
  const requests: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
      }
      requests.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        [
          { type: "message_start", message: { id: "msg_refusal", usage: {} } },
          {
            type: "message_delta",
            delta: {
              stop_reason: "refusal",
              stop_details: {
                type: "refusal",
                category: "reasoning_extraction",
                explanation: REFUSAL_EXPLANATION,
              },
            },
            usage: { input_tokens: 3, output_tokens: 0 },
          },
          { type: "message_stop" },
        ]
          .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          .join(""),
      );
    })().catch((error: unknown) => {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("refusing Anthropic provider did not bind a loopback port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe("Gateway provider refusal product proof", () => {
  it("keeps a structured Anthropic refusal terminal across retry and fallback", async () => {
    const provider = await startRefusingAnthropicProvider();
    cleanups.push(() => provider.stop());
    const gatewayOwner = createQaGatewayChild();
    cleanups.push(() => stopQaGatewayFixture(gatewayOwner));
    const gateway = await gatewayOwner.start({
      repoRoot: process.cwd(),
      command: {
        executablePath: process.execPath,
        argsPrefix: ["--import", "tsx", "src/entry.ts"],
        cwd: process.cwd(),
        tempParentDir: process.env.TMPDIR ?? tmpdir(),
        usePackagedPlugins: false,
      },
      providerBaseUrl: provider.baseUrl,
      providerMode: "mock-openai",
      primaryModel: PRIMARY_MODEL,
      alternateModel: FALLBACK_MODEL,
      transportBaseUrl: "http://127.0.0.1",
      controlUiEnabled: false,
      runtimeEnvPatch: {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      },
      mutateConfig: ({ plugins: _plugins, ...config }) => config,
    });

    const sessionKey = `agent:qa:provider-refusal-${randomUUID()}`;
    const started = (await gateway.call(
      "chat.send",
      {
        sessionKey,
        message: "Trigger the deterministic provider refusal.",
        deliver: false,
        idempotencyKey: randomUUID(),
      },
      { timeoutMs: 30_000 },
    )) as GatewayRun;
    expect(started).toMatchObject({ status: "started" });
    expect(typeof started.runId).toBe("string");

    const terminal = (await gateway.call(
      "agent.wait",
      { runId: started.runId, timeoutMs: 30_000 },
      { timeoutMs: 35_000 },
    )) as GatewayRun;
    const history = (await gateway.call(
      "chat.history",
      { sessionKey, limit: 20 },
      { timeoutMs: 10_000 },
    )) as GatewayHistory;
    const refusal = history.messages?.find(
      (message) => message.role === "assistant" && messageText(message.content) === REFUSAL_TEXT,
    );
    const proof = {
      requestCount: provider.requests.length,
      requestModels: provider.requests.map((body) => (body as { model?: unknown }).model),
      terminalStatus: terminal.status,
      refusalText: refusal ? messageText(refusal.content) : undefined,
    };
    console.log(`[gateway provider-refusal proof] ${JSON.stringify(proof)}`);
    expect(proof).toMatchObject({
      requestCount: 1,
      requestModels: ["claude-opus-4-8"],
      terminalStatus: "error",
      refusalText: REFUSAL_TEXT,
    });
    expect(JSON.stringify({ terminal, history })).not.toContain(REFUSAL_EXPLANATION);
  }, 60_000);
});
