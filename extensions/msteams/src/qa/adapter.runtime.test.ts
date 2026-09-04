import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createMSTeamsQaTransportAdapter } from "./adapter.runtime.js";
import * as botFrameworkServer from "./bot-framework-server.js";

const createdDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    createdDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function listenOnLoopback(server: Server): Promise<number> {
  onTestFinished(async () => {
    if (server.listening) {
      const closed = once(server, "close");
      server.close();
      await closed;
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected loopback server address");
  }
  return address.port;
}

describe("Microsoft Teams QA transport adapter", () => {
  it("creates a private bootstrap, sends real webhook-shaped inbound, and cleans up", async () => {
    // openclaw-temp-dir: allow extension tests cannot import repo-only test helpers; afterEach removes it.
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-qa-"));
    createdDirs.push(outputDir);
    const addInboundMessage = vi.fn(async (input) => ({
      ...input,
      id: "bus-inbound-1",
      direction: "inbound",
      timestamp: Date.now(),
    }));
    const addOutboundMessage = vi.fn(async (input) => ({
      ...input,
      id: "bus-outbound-1",
      direction: "outbound",
      timestamp: Date.now(),
    }));
    let inboundActivity: Record<string, unknown> | undefined;
    const webhook = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        inboundActivity = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(202).end();
      })();
    });
    const webhookPort = await listenOnLoopback(webhook);
    // Keep the webhook port owned while the adapter starts its Connector listener.
    vi.spyOn(botFrameworkServer, "reserveMSTeamsQaWebhookPort").mockResolvedValue(webhookPort);
    const adapter = await createMSTeamsQaTransportAdapter({
      adapterOptions: { transportPolicy: { requireGroupMention: true } },
      channelId: "msteams",
      credentials: {} as never,
      driver: "live",
      messages: {
        addInboundMessage,
        addOutboundMessage,
        editMessage: vi.fn(),
      },
      outputDir,
    });

    let bootstrapPath: string;
    try {
      const env = adapter.createRuntimeEnvPatch?.();
      expect(env?.OPENCLAW_BUILD_PRIVATE_QA).toBe("1");
      expect(env).not.toHaveProperty("OPENCLAW_QA_MSTEAMS_CONNECTOR_URL");
      const bootstrapUrl = /--import=(\S+)/u.exec(env?.NODE_OPTIONS ?? "")?.[1];
      expect(bootstrapUrl).toMatch(/^file:/u);
      bootstrapPath = fileURLToPath(bootstrapUrl!);
      const bootstrap = await fs.readFile(bootstrapPath, "utf8");
      expect(bootstrap).toContain('Symbol.for("openclaw.msteams.privateQaRuntime")');
      expect(bootstrap).toContain("http://127.0.0.1:");
      const bootstrapConfig = JSON.parse(
        /globalThis\[key\] = (.+);$/mu.exec(bootstrap)?.[1] ?? "{}",
      ) as { connectorUrl?: string; nonce?: string; botToken?: string };
      expect(bootstrapConfig).toMatchObject({
        connectorUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/$/u),
        nonce: expect.any(String),
        botToken: expect.any(String),
      });
      expect(bootstrapConfig.botToken?.split(".")).toHaveLength(3);

      const config = adapter.createGatewayConfig({ baseUrl: "http://127.0.0.1" });
      expect(config.channels?.msteams?.webhook?.port).toBe(webhookPort);
      expect(config.channels?.msteams).toMatchObject({
        dmPolicy: "allowlist",
        allowFrom: ["00000000-0000-4000-8000-000000000002"],
      });
      await adapter.sendInbound({
        accountId: "default",
        conversation: { id: "qa-primary", kind: "channel" },
        senderId: "driver",
        senderName: "Driver",
        text: "@openclaw qa ingress",
        threadId: "thread-root",
        replyToId: "quoted-parent",
      });
      expect(inboundActivity).toMatchObject({
        text: "<at>openclaw</at> qa ingress",
        entities: [
          {
            type: "mention",
            text: "<at>openclaw</at>",
            mentioned: { id: "qa-msteams-app", name: "OpenClaw QA" },
          },
        ],
        serviceUrl: "https://smba.trafficmanager.net/qa",
        replyToId: "quoted-parent",
        from: {
          id: "qa-msteams-driver",
          aadObjectId: "00000000-0000-4000-8000-000000000002",
        },
        conversation: {
          id: "19:qa-primary@thread.tacv2;messageid=thread-root",
          conversationType: "channel",
        },
      });
      expect(addInboundMessage).toHaveBeenCalledTimes(1);
      expect(config.channels?.msteams?.requireMention).toBe(true);

      const outboundResponse = await fetch(
        `${bootstrapConfig.connectorUrl}qa/v3/conversations/${encodeURIComponent(
          "19:qa-primary@thread.tacv2;messageid=thread-root",
        )}/activities`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${bootstrapConfig.botToken}`,
            "content-type": "application/json",
            "x-openclaw-msteams-qa-nonce": bootstrapConfig.nonce!,
          },
          body: JSON.stringify({ type: "message", text: "qa outbound" }),
        },
      );
      expect(outboundResponse.status).toBe(200);
      expect(addOutboundMessage).toHaveBeenCalledWith({
        accountId: "default",
        senderId: "qa-msteams-app",
        text: "qa outbound",
        threadId: "thread-root",
        timestamp: expect.any(Number),
        to: "channel:qa-primary",
      });
    } finally {
      await adapter.cleanup?.();
    }
    await expect(fs.access(bootstrapPath)).rejects.toThrow();
  });

  it("does not follow webhook redirects to another loopback origin", async () => {
    // openclaw-temp-dir: allow extension tests cannot import repo-only test helpers; afterEach removes it.
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-qa-"));
    createdDirs.push(outputDir);
    const addInboundMessage = vi.fn();
    let redirectedRequests = 0;
    const redirectTarget = createServer((_request, response) => {
      redirectedRequests += 1;
      response.writeHead(200).end();
    });
    const targetPort = await listenOnLoopback(redirectTarget);
    const webhook = createServer((_request, response) => {
      response
        .writeHead(302, {
          location: `http://127.0.0.1:${targetPort}/internal`,
        })
        .end();
    });
    const webhookPort = await listenOnLoopback(webhook);
    vi.spyOn(botFrameworkServer, "reserveMSTeamsQaWebhookPort").mockResolvedValue(webhookPort);

    const adapter = await createMSTeamsQaTransportAdapter({
      adapterOptions: {},
      channelId: "msteams",
      credentials: {} as never,
      driver: "live",
      messages: {
        addInboundMessage,
        addOutboundMessage: vi.fn(),
        editMessage: vi.fn(),
      },
      outputDir,
    });

    try {
      const config = adapter.createGatewayConfig({ baseUrl: "http://127.0.0.1" });
      expect(config.channels?.msteams?.webhook?.port).toBe(webhookPort);
      await expect(
        adapter.sendInbound({
          accountId: "default",
          conversation: { id: "qa-primary", kind: "channel" },
          senderId: "driver",
          text: "qa ingress",
        }),
      ).rejects.toThrow("Too many redirects (limit: 0)");
      expect(redirectedRequests).toBe(0);
      expect(addInboundMessage).not.toHaveBeenCalled();
    } finally {
      await adapter.cleanup?.();
    }
  });
});
