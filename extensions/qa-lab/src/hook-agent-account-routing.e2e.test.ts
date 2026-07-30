// QA Lab product proof exercises hook delivery through a real Gateway child and qa-channel bus.
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { startQaGatewayChild } from "./gateway-child.js";
import { startQaLabServer } from "./lab-server.js";
import { startQaProviderServer } from "./providers/server-runtime.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";

const HOOK_TOKEN = "qa-hook-account-routing-token";
const MARKER = "QA_HOOK_ACCOUNT_ROUTING_OK";
const MODEL = "mock-openai/gpt-5.6-luna";

async function postJson(url: string, body: unknown, headers: Record<string, string>) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return {
    status: response.status,
    json: (await response.json()) as unknown,
  };
}

describe("hook agent account routing product proof", () => {
  it(
    "delivers exactly once through the selected qa-channel account",
    { timeout: 180_000 },
    async () => {
      const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
      const lab = await startQaLabServer({
        repoRoot,
        embeddedGateway: "disabled",
      });
      const mock = await startQaProviderServer("mock-openai", {
        modelRefs: [MODEL],
      });
      let gateway: Awaited<ReturnType<typeof startQaGatewayChild>> | undefined;

      try {
        if (!mock) {
          throw new Error("mock-openai provider server did not start");
        }
        const transport = createQaChannelTransport(lab.state);
        gateway = await startQaGatewayChild({
          repoRoot,
          useRepoCli: true,
          providerBaseUrl: `${mock.baseUrl}/v1`,
          providerMode: "mock-openai",
          primaryModel: MODEL,
          alternateModel: MODEL,
          transportBaseUrl: lab.listenUrl,
          transport,
          controlUiEnabled: false,
          mutateConfig: (config) => {
            const qaChannel = config.channels?.["qa-channel"];
            if (!qaChannel) {
              throw new Error("qa-channel transport config missing");
            }
            return {
              ...config,
              hooks: {
                enabled: true,
                token: HOOK_TOKEN,
                path: "/hooks",
              },
              channels: {
                ...config.channels,
                "qa-channel": {
                  ...qaChannel,
                  defaultAccount: "default",
                  accounts: {
                    default: { name: "Default" },
                    work: { name: "Work" },
                  },
                },
              },
            };
          },
        });

        const response = await postJson(
          `${gateway.baseUrl}/hooks/agent`,
          {
            message: `Reply exactly: ${MARKER}`,
            deliver: true,
            channel: "qa-channel",
            to: "dm:hook-recipient",
            accountId: "work",
          },
          { Authorization: `Bearer ${HOOK_TOKEN}` },
        );
        expect(response.status, JSON.stringify(response.json)).toBe(200);

        const body = response.json as { ok?: boolean; runId?: string };
        expect(body.ok).toBe(true);
        expect(body.runId).toEqual(expect.any(String));

        await vi.waitFor(
          () => {
            const outbound = lab.state
              .getSnapshot()
              .messages.filter((message) => message.direction === "outbound");
            expect(outbound).toHaveLength(1);
            expect(outbound[0]).toMatchObject({
              accountId: "work",
              conversation: { id: "hook-recipient", kind: "direct" },
              text: MARKER,
            });
          },
          { interval: 50, timeout: 60_000 },
        );
        await sleep(500);

        const outbound = lab.state
          .getSnapshot()
          .messages.filter((message) => message.direction === "outbound");
        expect(outbound).toHaveLength(1);
        expect(outbound.filter((message) => message.accountId === "default")).toHaveLength(0);
      } finally {
        await gateway?.stop().catch(() => undefined);
        await mock?.stop().catch(() => undefined);
        await lab.stop().catch(() => undefined);
      }
    },
  );
});
