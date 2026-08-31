// QA Lab product proof exercises hook delivery through a real Gateway child and qa-channel bus.
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createQaGatewayChild, type QaGatewayChild } from "./gateway-child.js";
import { startQaLabServer } from "./lab-server.js";
import { startQaProviderServer } from "./providers/server-runtime.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";

const HOOK_TOKEN = "qa-hook-account-routing-token";
const MARKER = "QA_HOOK_ACCOUNT_ROUTING_OK";
const DEFAULT_MARKER = "QA_HOOK_DEFAULT_ACCOUNT_ROUTING_OK";
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

async function startHookAccountFixture() {
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const lab = await startQaLabServer({
    repoRoot,
    embeddedGateway: "disabled",
  });
  const mock = await startQaProviderServer("mock-openai", {
    modelRefs: [MODEL],
  });
  const gatewayOwner = createQaGatewayChild();
  let gateway: QaGatewayChild | undefined;

  try {
    if (!mock) {
      throw new Error("mock-openai provider server did not start");
    }
    const transport = createQaChannelTransport(lab.state);
    gateway = await gatewayOwner.start({
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
                disabled: { name: "Disabled", enabled: false },
              },
            },
          },
        };
      },
    });
  } catch (error) {
    await gatewayOwner.stop().catch(() => undefined);
    await mock?.stop().catch(() => undefined);
    await lab.stop().catch(() => undefined);
    throw error;
  }
  if (!gateway || !mock) {
    throw new Error("hook account fixture did not start");
  }

  return {
    gateway,
    lab,
    stop: async () => {
      await gatewayOwner.stop().catch(() => undefined);
      await mock.stop().catch(() => undefined);
      await lab.stop().catch(() => undefined);
    },
  };
}

describe("hook agent account routing product proof", () => {
  let fixture: Awaited<ReturnType<typeof startHookAccountFixture>>;

  beforeAll(async () => {
    fixture = await startHookAccountFixture();
  }, 180_000);

  afterAll(async () => {
    await fixture?.stop();
  });

  it(
    "rejects invalid explicit accounts before running the agent",
    { timeout: 180_000 },
    async () => {
      const messageCountBefore = fixture.lab.state.getSnapshot().messages.length;

      for (const { accountId, expectedError } of [
        { accountId: "missing", expectedError: 'Unknown account "missing"' },
        { accountId: "disabled", expectedError: 'Account "disabled"' },
        { accountId: "__proto__", expectedError: 'Invalid account ID "__proto__"' },
      ]) {
        const response = await postJson(
          `${fixture.gateway.baseUrl}/hooks/agent`,
          {
            message: `Reply exactly: ${MARKER}`,
            deliver: true,
            channel: "qa-channel",
            to: "dm:hook-recipient",
            accountId,
          },
          { Authorization: `Bearer ${HOOK_TOKEN}` },
        );

        expect(response.status, JSON.stringify(response.json)).toBe(400);
        expect(response.json).toMatchObject({ ok: false, runId: expect.any(String) });
        expect((response.json as { error?: unknown }).error).toEqual(
          expect.stringContaining(expectedError),
        );
      }
      expect(fixture.lab.state.getSnapshot().messages).toHaveLength(messageCountBefore);
    },
  );

  it(
    "delivers exactly once through the selected qa-channel account",
    { timeout: 180_000 },
    async () => {
      const outboundCountBefore = fixture.lab.state
        .getSnapshot()
        .messages.filter((message) => message.direction === "outbound").length;
      const response = await postJson(
        `${fixture.gateway.baseUrl}/hooks/agent`,
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
          const outbound = fixture.lab.state
            .getSnapshot()
            .messages.filter((message) => message.direction === "outbound");
          expect(outbound).toHaveLength(outboundCountBefore + 1);
          expect(outbound.at(-1)).toMatchObject({
            accountId: "work",
            conversation: { id: "hook-recipient", kind: "direct" },
            text: MARKER,
          });
        },
        { interval: 50, timeout: 60_000 },
      );
      await sleep(500);

      const outbound = fixture.lab.state
        .getSnapshot()
        .messages.filter((message) => message.direction === "outbound");
      expect(outbound).toHaveLength(outboundCountBefore + 1);
      expect(
        outbound.slice(outboundCountBefore).filter((message) => message.accountId === "default"),
      ).toHaveLength(0);

      const defaultResponse = await postJson(
        `${fixture.gateway.baseUrl}/hooks/agent`,
        {
          message: `Reply exactly: ${DEFAULT_MARKER}`,
          deliver: true,
          channel: "qa-channel",
          to: "dm:hook-default-recipient",
        },
        { Authorization: `Bearer ${HOOK_TOKEN}` },
      );
      expect(defaultResponse.status, JSON.stringify(defaultResponse.json)).toBe(200);

      await vi.waitFor(
        () => {
          const currentOutbound = fixture.lab.state
            .getSnapshot()
            .messages.filter((message) => message.direction === "outbound");
          expect(currentOutbound).toHaveLength(outboundCountBefore + 2);
          expect(currentOutbound.at(-1)).toMatchObject({
            accountId: "default",
            conversation: { id: "hook-default-recipient", kind: "direct" },
            text: DEFAULT_MARKER,
          });
        },
        { interval: 50, timeout: 60_000 },
      );
    },
  );
});
