// E2E: ephemeral gateway must not leak MCP secrets via /mcp show replies.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { REDACTED_SENTINEL } from "../src/config/redact-snapshot.js";
import { connectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { extractFirstTextBlock } from "../src/shared/chat-message-content.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../src/utils/message-channel.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const E2E_TIMEOUT_MS = 180_000;
const CHAT_FINAL_TIMEOUT_MS = 45_000;

const HEADER_SECRET = "Bearer e2e-live-mcp-header-secret-value";
const ENV_SECRET = "e2e-live-mcp-env-secret-value";
const ARG_SECRET = "e2e-live-mcp-argv-secret-value";
const ARG_INLINE_SECRET = "e2e-live-mcp-inline-argv-secret-value";
const ARG_POSITIONAL_SECRET = "ghp_e2elivemcpargvtoken1234567890ABCD";
const SERVER_NAME = "billing-server";

type ChatEventPayload = {
  runId?: string;
  state?: string;
  message?: unknown;
  errorMessage?: string;
};

function collectFinalText(payload: ChatEventPayload | undefined): string {
  if (!payload) {
    return "";
  }
  const fromMessage = extractFirstTextBlock(payload.message);
  if (fromMessage) {
    return fromMessage;
  }
  if (typeof payload.errorMessage === "string") {
    return payload.errorMessage;
  }
  return JSON.stringify(payload);
}

async function waitForChatFinal(
  events: Array<{ event?: string; payload?: unknown }>,
  runId: string,
  timeoutMs = CHAT_FINAL_TIMEOUT_MS,
): Promise<ChatEventPayload> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const event of events) {
      if (event.event !== "chat" || !event.payload || typeof event.payload !== "object") {
        continue;
      }
      const payload = event.payload as ChatEventPayload;
      if (payload.runId === runId && payload.state === "final") {
        return payload;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `timed out waiting for chat final runId=${runId}; events=${JSON.stringify(
      events.slice(-12),
      null,
      2,
    )}`,
  );
}

describe("mcp show redaction e2e", () => {
  const instances: OpenClawTestInstance[] = [];

  afterAll(async () => {
    for (const instance of instances) {
      await instance.cleanup();
    }
  });

  it(
    "starts an ephemeral gateway and redacts MCP secrets from /mcp show chat replies",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const instance = await createOpenClawTestInstance({
        name: "mcp-show-redact",
        env: {
          OPENCLAW_TEST_FAST: "1",
        },
        config: {
          commands: {
            text: true,
            mcp: true,
          },
          mcp: {
            servers: {
              [SERVER_NAME]: {
                command: "uvx",
                args: [
                  "billing-mcp",
                  "--api-key",
                  ARG_SECRET,
                  `--token=${ARG_INLINE_SECRET}`,
                  ARG_POSITIONAL_SECRET,
                  "--region",
                  "us-east-1",
                ],
                transport: "streamable-http",
                url: "https://billing.example.com/mcp",
                headers: {
                  Authorization: HEADER_SECRET,
                },
                env: {
                  BILLING_TOKEN: ENV_SECRET,
                },
              },
              "local-tools": {
                command: "uvx",
                args: ["local-mcp"],
                env: {
                  TOOL_API_KEY: "second-env-secret-value",
                },
              },
            },
          },
        },
      });
      instances.push(instance);
      await instance.startGateway();

      const onDiskBefore = JSON.parse(await fs.readFile(instance.configPath, "utf8")) as {
        mcp?: { servers?: Record<string, { headers?: Record<string, string> }> };
      };
      expect(onDiskBefore.mcp?.servers?.[SERVER_NAME]?.headers?.Authorization).toBe(HEADER_SECRET);

      const events: Array<{ event?: string; payload?: unknown }> = [];
      const client = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
        onEvent: (event) => {
          events.push(event);
        },
      });

      try {
        const namedRunId = randomUUID();
        await client.request("chat.send", {
          sessionKey: "agent:main:main",
          message: `/mcp show ${SERVER_NAME}`,
          deliver: false,
          idempotencyKey: namedRunId,
        });
        const namedFinal = await waitForChatFinal(events, namedRunId);
        const namedText = collectFinalText(namedFinal);

        expect(namedText).toContain(`MCP server "${SERVER_NAME}"`);
        expect(namedText).toContain('"command": "uvx"');
        expect(namedText).toContain(REDACTED_SENTINEL);
        expect(namedText).not.toContain(HEADER_SECRET);
        expect(namedText).not.toContain(ENV_SECRET);
        expect(namedText).not.toContain(ARG_SECRET);
        expect(namedText).not.toContain(ARG_INLINE_SECRET);
        expect(namedText).not.toContain(ARG_POSITIONAL_SECRET);
        expect(namedText).toContain('"billing-mcp"');
        expect(namedText).toContain('"--api-key"');
        expect(namedText).toContain(`"--token=${REDACTED_SENTINEL}"`);
        expect(namedText).toContain('"--region"');
        expect(namedText).toContain('"us-east-1"');
        expect(namedText).not.toContain("e2e-live-mcp-header-secret-value");
        expect(namedText).not.toContain("e2e-live-mcp-env-secret-value");

        const listRunId = randomUUID();
        await client.request("chat.send", {
          sessionKey: "agent:main:main",
          message: "/mcp show",
          deliver: false,
          idempotencyKey: listRunId,
        });
        const listFinal = await waitForChatFinal(events, listRunId);
        const listText = collectFinalText(listFinal);

        expect(listText).toContain(`"${SERVER_NAME}"`);
        expect(listText).toContain('"local-tools"');
        expect(listText).toContain(REDACTED_SENTINEL);
        expect(listText).not.toContain(HEADER_SECRET);
        expect(listText).not.toContain(ENV_SECRET);
        expect(listText).not.toContain(ARG_SECRET);
        expect(listText).not.toContain(ARG_INLINE_SECRET);
        expect(listText).not.toContain(ARG_POSITIONAL_SECRET);
        expect(listText).not.toContain("second-env-secret-value");

        // CLI show → set can safely round-trip redacted argv because it preserves JSON arrays.
        // The chat set below intentionally omits args to avoid chat body bracket normalization.
        const cliArgSet = await instance.cli([
          "mcp",
          "set",
          SERVER_NAME,
          JSON.stringify({
            command: "uvx",
            args: [
              "billing-mcp",
              "--api-key",
              REDACTED_SENTINEL,
              `--token=${REDACTED_SENTINEL}`,
              REDACTED_SENTINEL,
              "--region",
              "us-east-1",
            ],
            headers: { Authorization: REDACTED_SENTINEL },
            env: { BILLING_TOKEN: REDACTED_SENTINEL },
          }),
        ]);
        expect(cliArgSet.code).toBe(0);
        expect(cliArgSet.stdout + cliArgSet.stderr).toContain(`Saved MCP server "${SERVER_NAME}"`);
        const afterCliArgSet = JSON.parse(await fs.readFile(instance.configPath, "utf8")) as {
          mcp?: {
            servers?: Record<
              string,
              {
                args?: string[];
                headers?: Record<string, string>;
                env?: Record<string, string>;
              }
            >;
          };
        };
        const argvRestored = afterCliArgSet.mcp?.servers?.[SERVER_NAME];
        expect(argvRestored?.args).toEqual([
          "billing-mcp",
          "--api-key",
          ARG_SECRET,
          `--token=${ARG_INLINE_SECRET}`,
          ARG_POSITIONAL_SECRET,
          "--region",
          "us-east-1",
        ]);
        expect(argvRestored?.headers?.Authorization).toBe(HEADER_SECRET);
        expect(argvRestored?.env?.BILLING_TOKEN).toBe(ENV_SECRET);
        expect(JSON.stringify(argvRestored)).not.toContain(REDACTED_SENTINEL);

        // show → set with redacted secrets must restore live values, not write the sentinel.
        // Keep the JSON free of array brackets so chat body normalization cannot mangle it.
        const setPayload = {
          command: "uvx",
          transport: "streamable-http",
          url: "https://billing.example.com/mcp",
          headers: {
            Authorization: REDACTED_SENTINEL,
          },
          env: {
            BILLING_TOKEN: REDACTED_SENTINEL,
          },
        };
        const setRunId = randomUUID();
        await client.request("chat.send", {
          sessionKey: "agent:main:main",
          message: `/mcp set ${SERVER_NAME}=${JSON.stringify(setPayload)}`,
          deliver: false,
          idempotencyKey: setRunId,
        });
        const setFinal = await waitForChatFinal(events, setRunId);
        const setText = collectFinalText(setFinal);
        expect(setText).toContain(`MCP server "${SERVER_NAME}" saved`);

        const onDiskAfter = JSON.parse(await fs.readFile(instance.configPath, "utf8")) as {
          mcp?: {
            servers?: Record<
              string,
              {
                command?: string;
                headers?: Record<string, string>;
                env?: Record<string, string>;
              }
            >;
          };
        };
        const saved = onDiskAfter.mcp?.servers?.[SERVER_NAME];
        expect(saved?.command).toBe("uvx");
        expect(saved?.headers?.Authorization).toBe(HEADER_SECRET);
        expect(saved?.env?.BILLING_TOKEN).toBe(ENV_SECRET);
        expect(JSON.stringify(saved)).not.toContain(REDACTED_SENTINEL);

        // Same process, same config: CLI set with sentinel also restores (write path e2e).
        const cliSet = await instance.cli([
          "mcp",
          "set",
          SERVER_NAME,
          JSON.stringify({
            command: "uvx",
            headers: { Authorization: REDACTED_SENTINEL },
            env: { BILLING_TOKEN: REDACTED_SENTINEL },
          }),
        ]);
        expect(cliSet.code).toBe(0);
        expect(cliSet.stdout + cliSet.stderr).toContain(`Saved MCP server "${SERVER_NAME}"`);
        const onDiskCli = JSON.parse(await fs.readFile(instance.configPath, "utf8")) as {
          mcp?: {
            servers?: Record<
              string,
              { headers?: Record<string, string>; env?: Record<string, string> }
            >;
          };
        };
        expect(onDiskCli.mcp?.servers?.[SERVER_NAME]?.headers?.Authorization).toBe(HEADER_SECRET);
        expect(onDiskCli.mcp?.servers?.[SERVER_NAME]?.env?.BILLING_TOKEN).toBe(ENV_SECRET);
      } finally {
        client.stop();
      }
    },
  );
});
