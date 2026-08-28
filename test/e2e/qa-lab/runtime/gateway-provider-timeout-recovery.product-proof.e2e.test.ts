import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

const MODEL_REF = "mock-openai/gpt-5.6-luna";
const RESPONSE_MARKER = "PROVIDER_TIMEOUT_RECOVERY_PROOF_OK";
const GLOBAL_RECOVERY_FLOOR_MS = 360_000;
const CHECKPOINT_AFTER_FLOOR_MS = GLOBAL_RECOVERY_FLOOR_MS + 45_000;
const PROVIDER_ALLOWANCE_MS = 450_000;
const TEST_TIMEOUT_MS = PROVIDER_ALLOWANCE_MS + 60_000;

type StabilityEvent = {
  type?: unknown;
  action?: unknown;
  ageMs?: unknown;
  reason?: unknown;
};

type StabilitySnapshot = {
  lastSeq?: unknown;
  events?: StabilityEvent[];
};

type GatewayChatRun = {
  runId?: unknown;
  status?: unknown;
};

type GatewayChatMessage = {
  role?: unknown;
  content?: unknown;
};

type GatewayChatHistory = {
  messages?: GatewayChatMessage[];
};

type ProviderProof = {
  requestStartedAt?: number;
  clientClosedAt?: number;
  responseReleasedAt?: number;
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
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "provider-timeout recovery proof cleanup failed");
  }
});

function writeResponsesEvents(response: ServerResponse, events: unknown[]): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  response.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}

function writeAssistantResponse(response: ServerResponse): void {
  const message = {
    type: "message",
    id: "provider-timeout-recovery-proof-message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: RESPONSE_MARKER, annotations: [] }],
  };
  writeResponsesEvents(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: "provider-timeout-recovery-proof-response",
        status: "completed",
        output: [message],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ]);
}

async function startControlledProvider() {
  let releaseResponse: (() => void) | undefined;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const proof: ProviderProof = {};
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "gpt-5.6-luna", object: "model" }] }));
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      for await (const chunk of request) {
        // Consume the real provider request before holding its response open.
        void chunk;
      }
      proof.requestStartedAt = Date.now();
      response.once("close", () => {
        if (proof.responseReleasedAt === undefined) {
          proof.clientClosedAt = Date.now();
        }
      });
      await responseGate;
      proof.responseReleasedAt = Date.now();
      writeAssistantResponse(response);
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("controlled provider did not bind a loopback port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    proof,
    release: () => releaseResponse?.(),
    stop: async () => {
      releaseResponse?.();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function messageText(message: GatewayChatMessage): string {
  if (typeof message.content === "string") {
    return message.content.trim();
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .flatMap((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : [],
    )
    .join("\n")
    .trim();
}

describe.runIf(process.env.OPENCLAW_PROVIDER_TIMEOUT_RECOVERY_PROOF === "1")(
  "Gateway provider-timeout recovery product proof",
  () => {
    it(
      "keeps a quiet provider request alive past recovery and completes within its allowance",
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const provider = await startControlledProvider();
        cleanups.push(() => provider.stop());
        const gatewayOwner = createQaGatewayChild();
        cleanups.push(() => stopQaGatewayFixture(gatewayOwner));
        const gateway = await gatewayOwner.start({
          repoRoot: process.cwd(),
          command: {
            executablePath: process.execPath,
            argsPrefix: ["--import", "tsx", "src/entry.ts"],
            cwd: process.cwd(),
            usePackagedPlugins: true,
          },
          providerBaseUrl: `${provider.baseUrl}/v1`,
          providerMode: "mock-openai",
          primaryModel: MODEL_REF,
          alternateModel: MODEL_REF,
          transportBaseUrl: "http://127.0.0.1",
          controlUiEnabled: false,
          runtimeEnvPatch: {
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_SKIP_CHANNELS: "1",
            OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
          },
          mutateConfig: ({ plugins: _plugins, ...config }) => {
            const providerConfig = config.models?.providers?.["mock-openai"];
            if (!providerConfig) {
              throw new Error("mock-openai provider is missing from QA gateway config");
            }
            return {
              ...config,
              diagnostics: { enabled: true },
              agents: {
                ...config.agents,
                defaults: {
                  ...config.agents?.defaults,
                  timeoutSeconds: TEST_TIMEOUT_MS / 1_000,
                },
              },
              models: {
                ...config.models,
                providers: {
                  ...config.models?.providers,
                  "mock-openai": {
                    ...providerConfig,
                    timeoutSeconds: PROVIDER_ALLOWANCE_MS / 1_000,
                  },
                },
              },
            };
          },
        });

        const baseline = (await gateway.call(
          "diagnostics.stability",
          { limit: 1000 },
          { timeoutMs: 10_000 },
        )) as StabilitySnapshot;
        const baselineSeq = typeof baseline.lastSeq === "number" ? baseline.lastSeq : 0;
        const sessionKey = `agent:qa:provider-timeout-recovery-${randomUUID()}`;
        const started = (await gateway.call(
          "chat.send",
          {
            sessionKey,
            message: "Hold this provider request open, then reply with the proof marker.",
            deliver: false,
            idempotencyKey: randomUUID(),
          },
          { timeoutMs: 30_000 },
        )) as GatewayChatRun;
        expect(started).toMatchObject({ status: "started" });
        expect(typeof started.runId).toBe("string");

        while (provider.proof.requestStartedAt === undefined) {
          await sleep(100);
        }
        while (Date.now() - provider.proof.requestStartedAt < CHECKPOINT_AFTER_FLOOR_MS) {
          const elapsedMs = Date.now() - provider.proof.requestStartedAt;
          console.log(
            JSON.stringify({
              phase: "provider-request-active",
              elapsedMs,
              globalRecoveryFloorMs: GLOBAL_RECOVERY_FLOOR_MS,
              providerAllowanceMs: PROVIDER_ALLOWANCE_MS,
              clientClosed: provider.proof.clientClosedAt !== undefined,
            }),
          );
          await sleep(Math.min(60_000, CHECKPOINT_AFTER_FLOOR_MS - elapsedMs));
        }

        const checkpointElapsedMs = Date.now() - provider.proof.requestStartedAt;
        const checkpoint = (await gateway.call(
          "diagnostics.stability",
          { limit: 1000, sinceSeq: baselineSeq },
          { timeoutMs: 10_000 },
        )) as StabilitySnapshot;
        const recoveryEvents = (checkpoint.events ?? []).filter(
          (event) =>
            event.type === "session.recovery.requested" ||
            event.type === "session.recovery.completed",
        );
        expect(checkpointElapsedMs).toBeGreaterThanOrEqual(CHECKPOINT_AFTER_FLOOR_MS);
        expect(checkpointElapsedMs).toBeLessThan(PROVIDER_ALLOWANCE_MS);
        expect(provider.proof.clientClosedAt).toBeUndefined();
        expect(recoveryEvents).toEqual([]);

        provider.release();
        const terminal = (await gateway.call(
          "agent.wait",
          { runId: started.runId, timeoutMs: 30_000 },
          { timeoutMs: 35_000 },
        )) as GatewayChatRun;
        expect(terminal.status).toBe("ok");
        const history = (await gateway.call(
          "chat.history",
          { sessionKey, limit: 20 },
          { timeoutMs: 10_000 },
        )) as GatewayChatHistory;
        expect(
          (history.messages ?? []).some(
            (message) => message.role === "assistant" && messageText(message) === RESPONSE_MARKER,
          ),
        ).toBe(true);

        console.log(
          JSON.stringify({
            phase: "provider-timeout-recovery-proof-complete",
            head: process.env.OPENCLAW_PROOF_HEAD_SHA ?? process.env.GITHUB_SHA ?? "local-checkout",
            checkpointElapsedMs,
            globalRecoveryFloorMs: GLOBAL_RECOVERY_FLOOR_MS,
            providerAllowanceMs: PROVIDER_ALLOWANCE_MS,
            recoveryEventsBeforeRelease: recoveryEvents.length,
            providerClientStayedConnected: provider.proof.clientClosedAt === undefined,
            terminalStatus: terminal.status,
            marker: RESPONSE_MARKER,
          }),
        );
      },
    );
  },
);
