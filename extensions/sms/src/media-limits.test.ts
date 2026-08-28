import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { saveResponseMedia } from "openclaw/plugin-sdk/media-runtime";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createPluginRuntimeMediaMock,
  createPluginRuntimeMock,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSmsAccount } from "./accounts.js";
import { materializeSmsInboundMedia, tryHandleHostedSmsMediaRequest } from "./media.js";
import { setSmsRuntime } from "./runtime.js";
import { prepareSmsMediaAttempt } from "./send.js";

const MB = 1024 * 1024;
const ACCOUNT_SID = `AC${"a".repeat(32)}`;
const MESSAGE_SID = `MM${"b".repeat(32)}`;
const baseAccount = {
  accountSid: ACCOUNT_SID,
  authToken: "test-token",
  fromNumber: "+15555550100",
  publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
};

describe("SMS configured media limits", () => {
  let stateDir: string;
  let state: OpenClawTestState;
  let server: Server | undefined;

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "sms-media-limit" });
    stateDir = state.stateDir;
    setSmsRuntime(
      createPluginRuntimeMock({
        state: {
          openKeyedStore: (options) =>
            createPluginStateKeyedStoreForTests("sms", {
              ...options,
              env: state.env,
            }),
        },
      }),
    );
  });

  afterEach(async () => {
    if (server) {
      const closingServer = server;
      await new Promise<void>((resolve, reject) => {
        closingServer.close((error) => (error ? reject(error) : resolve()));
      });
      server = undefined;
    }
    await state.cleanup();
  });

  it.each([
    { name: "channel root", sms: { mediaMaxMb: 1 / MB }, accountId: undefined, agentLimit: 1 },
    {
      name: "normalized named account",
      sms: { mediaMaxMb: 1, accounts: { Support: { mediaMaxMb: 1 / MB } } },
      accountId: " SUPPORT ",
      agentLimit: 1,
    },
    {
      name: "configured default account",
      sms: { defaultAccount: "support", accounts: { support: { mediaMaxMb: 1 / MB } } },
      accountId: undefined,
      agentLimit: 1,
    },
    {
      name: "inherited root limit",
      sms: { mediaMaxMb: 1 / MB, accounts: { support: { enabled: true } } },
      accountId: "support",
      agentLimit: 1,
    },
    { name: "agent default", sms: {}, accountId: undefined, agentLimit: 1 / MB },
  ])(
    "rejects a local attachment above the $name cap before staging",
    async ({ sms, accountId, agentLimit }) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { mediaMaxMb: agentLimit } },
        channels: { sms: { ...baseAccount, ...sms } },
      };
      const filePath = path.join(stateDir, "attachment.pdf");
      await fs.writeFile(filePath, "%PDF-1.4\nmedia-limit-proof\n%%EOF");

      await expect(
        prepareSmsMediaAttempt({
          account: resolveSmsAccount(cfg, accountId),
          text: "caption",
          mediaUrl: filePath,
          mediaLocalRoots: [stateDir],
        }),
      ).rejects.toThrow(/SMS media preparation failed before Twilio dispatch: Media exceeds/);
    },
  );

  it("serves exact below-cap bytes through the hosted HTTP route", async () => {
    const bytes = Buffer.from("%PDF-1.4\nmedia-limit-proof\n%%EOF");
    const filePath = path.join(stateDir, "attachment.pdf");
    await fs.writeFile(filePath, bytes);
    const account = resolveSmsAccount({
      agents: { defaults: { mediaMaxMb: 1 / MB } },
      channels: { sms: { ...baseAccount, mediaMaxMb: bytes.length / MB } },
    });
    const attempt = await prepareSmsMediaAttempt({
      account,
      text: "caption",
      mediaUrl: filePath,
      mediaLocalRoots: [stateDir],
    });
    const hostedServer = createServer((req, res) => {
      void tryHandleHostedSmsMediaRequest(req, res, account.accountId).catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
    server = hostedServer;
    await new Promise<void>((resolve) => {
      hostedServer.listen(0, "127.0.0.1", resolve);
    });
    const address = hostedServer.address();
    if (!address || typeof address === "string") {
      throw new Error("expected local HTTP listener");
    }
    const hosted = new URL(attempt.hostedMediaUrl);
    const response = await fetch(
      `http://127.0.0.1:${address.port}${hosted.pathname}${hosted.search}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    await attempt.cleanupHostedMedia();
  });

  it.each([
    { file: "attachment.pdf", magic: "%PDF-1.4", size: 500_001, error: /500,000 byte limit/ },
    { file: "attachment.gif", magic: "GIF89a", size: 5_000_000, error: /GIF exceeds/ },
  ])(
    "retains Twilio's ceiling for $file when the configured cap is larger",
    async ({ file, magic, size, error }) => {
      const filePath = path.join(stateDir, file);
      const bytes = Buffer.alloc(size);
      bytes.write(magic);
      await fs.writeFile(filePath, bytes);
      await expect(
        prepareSmsMediaAttempt({
          account: resolveSmsAccount({ channels: { sms: { ...baseAccount, mediaMaxMb: 10 } } }),
          text: "caption",
          mediaUrl: filePath,
          mediaLocalRoots: [stateDir],
        }),
      ).rejects.toThrow(error);
    },
  );

  it("applies the per-attachment cap without making it a shared inbound budget", async () => {
    const account = resolveSmsAccount({
      channels: { sms: { ...baseAccount, mediaMaxMb: 32 / MB } },
    });
    const bytes = Buffer.from("%PDF-1.4\nmedia-limit-proof\n%%EOF");
    const bodies = [bytes, Buffer.alloc(33), bytes];
    const media = createPluginRuntimeMediaMock({
      saveRemoteMedia: async (options) => {
        const body = bodies.shift();
        if (!body) {
          throw new Error("unexpected attachment fetch");
        }
        return await saveResponseMedia(
          new Response(body, { headers: { "content-type": "application/pdf" } }),
          { ...options, sourceUrl: options.url },
        );
      },
    });
    const result = await materializeSmsInboundMedia({
      account,
      msg: {
        accountSid: ACCOUNT_SID,
        messageSid: MESSAGE_SID,
        from: "+15555550101",
        to: baseAccount.fromNumber,
        body: "three attachments",
        media: ["c", "d", "e"].map((id) => ({
          url: `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages/${MESSAGE_SID}/Media/ME${id.repeat(32)}`,
          contentType: "application/pdf",
        })),
      },
      mediaRuntime: { media },
    });
    expect(result.media).toHaveLength(2);
    expect(result.body).toBe("three attachments\n\n[1 Twilio MMS attachment unavailable]");
    expect(bodies).toEqual([]);
    await result.cleanup();
  });
});
