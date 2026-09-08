import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { withServer, withTempDir } from "openclaw/plugin-sdk/test-env";
import { expect, test } from "vitest";
import {
  createQaGatewayChild,
  startQaMockOpenAiServer,
  writeJson,
} from "../../../../extensions/qa-lab/api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const BOT_TOKEN = `424242:${"A".repeat(35)}`;
const CHAT_ID = -1002468135790;
const ALLOWED_SENDER = 1357;
const DENIED_SENDER = 2468;

test("delivers configured-root media and visibly refuses the sender denied read", async () => {
  const calls: Array<{ method: string; text?: string; fileBytes?: number }> = [];
  const polls = new Set<ServerResponse>();
  const updates: unknown[] = [];
  const chat = { id: CHAT_ID, type: "supergroup", title: "QA Media Roots" };
  let updateId = 0;
  const succeed = (res: ServerResponse, result: unknown = true) =>
    writeJson(res, 200, { ok: true, result });
  const receive = (senderId: number, file: string) => {
    const update = {
      update_id: ++updateId,
      message: {
        message_id: updateId,
        date: Math.floor(Date.now() / 1000),
        chat,
        from: { id: senderId, is_bot: false, first_name: "QA Sender" },
        text: `Reply exactly: MEDIA:${file}`,
      },
    };
    const poll = polls.values().next().value;
    if (poll) {
      polls.delete(poll);
      succeed(poll, [update]);
    } else {
      updates.push(update);
    }
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const method = new URL(req.url ?? "/", "http://127.0.0.1").pathname.split("/").at(-1)!;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks);
    let text: string | undefined;
    let fileBytes: number | undefined;
    if (req.headers["content-type"]?.startsWith("multipart/form-data")) {
      const form = await new Response(raw, {
        headers: { "content-type": req.headers["content-type"] },
      }).formData();
      for (const value of form.values()) {
        if (typeof value !== "string") {
          fileBytes = (fileBytes ?? 0) + value.size;
        }
      }
    } else if (raw.length) {
      text = (JSON.parse(raw.toString()) as { text?: string }).text;
    }
    calls.push({ method, text, fileBytes });
    if (method === "getMe") {
      succeed(res, { id: 424242, is_bot: true, first_name: "QA", username: "qa_media_bot" });
    } else if (method === "getUpdates") {
      if (updates.length) {
        succeed(res, updates.splice(0));
      } else {
        polls.add(res);
        res.on("close", () => polls.delete(res));
      }
    } else if (method === "getChat") {
      succeed(res, chat);
    } else if (method === "sendMessage" || method === "sendPhoto" || method === "sendDocument") {
      succeed(res, { message_id: 9000 + calls.length, date: 1_754_000_000, chat, text });
    } else {
      succeed(res);
    }
  };
  await withServer(
    (req, res) =>
      void handle(req, res).catch((error: unknown) => {
        writeJson(res, 500, { error: String(error) });
      }),
    async (apiRoot) =>
      await withTempDir("openclaw-configured-media-", async (root) => {
        const canonicalRoot = await fs.realpath(root);
        const workspace = path.join(canonicalRoot, "workspace");
        const mediaRoot = path.join(canonicalRoot, "trusted");
        await fs.mkdir(workspace);
        await fs.mkdir(mediaRoot);
        const mediaFile = path.join(mediaRoot, "proof.txt");
        await fs.writeFile(mediaFile, "configured-root proof\n");
        const mock = await startQaMockOpenAiServer();
        const gatewayOwner = createQaGatewayChild();
        const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
        const outputDir = path.join(repoRoot, ".artifacts/qa-e2e/configured-media-roots", head);
        try {
          const gateway = await gatewayOwner.start({
            repoRoot,
            providerMode: "mock-openai",
            providerBaseUrl: `${mock.baseUrl}/v1`,
            transportBaseUrl: apiRoot,
            transport: {
              requiredPluginIds: ["telegram"],
              createGatewayConfig: () => ({
                messages: { groupChat: { visibleReplies: "automatic" } },
                channels: {
                  telegram: {
                    enabled: true,
                    botToken: BOT_TOKEN,
                    apiRoot,
                    groupPolicy: "open",
                    streaming: { mode: "off" },
                    commands: { native: false },
                    groups: {
                      [String(CHAT_ID)]: {
                        requireMention: false,
                        toolsBySender: { [`id:${DENIED_SENDER}`]: { deny: ["read"] } },
                      },
                    },
                  },
                },
              }),
            },
            controlUiEnabled: false,
            runtimeEnvPatch: {
              OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
              TELEGRAM_BOT_TOKEN: undefined,
            },
            mutateConfig: (cfg) => {
              cfg.agents!.defaults!.workspace = workspace;
              cfg.agents!.defaults!.mediaLocalRoots = [mediaRoot];
              cfg.tools = { ...cfg.tools, profile: "full" };
              cfg.bindings = [{ agentId: "qa", match: { channel: "telegram" } }];
              return cfg;
            },
          });
          expect(new URL(gateway.baseUrl).port).not.toBe("18789");
          await expect.poll(() => polls.size, { timeout: 30_000 }).toBeGreaterThan(0);
          receive(ALLOWED_SENDER, mediaFile);
          await expect
            .poll(() => calls.filter((call) => call.fileBytes), { timeout: 45_000 })
            .toEqual([{ method: "sendDocument", text: undefined, fileBytes: 22 }]);
          const allowedCalls = calls.length;
          receive(DENIED_SENDER, mediaFile);
          await expect
            .poll(
              () =>
                calls
                  .slice(allowedCalls)
                  .some(
                    (call) =>
                      call.method === "sendMessage" && call.text?.includes("Delivery failed"),
                  ),
              { timeout: 45_000 },
            )
            .toBe(true);
          expect(calls.slice(allowedCalls).filter((call) => call.fileBytes)).toEqual([]);
          const requests = (await (
            await fetch(`${mock.baseUrl}/debug/requests`)
          ).json()) as unknown[];
          expect(requests.length).toBeGreaterThanOrEqual(2);
          const verdict = {
            head,
            lane: "mock-gateway",
            passed: true,
            providerRequests: requests.length,
            allowed: calls.filter((call) => call.fileBytes),
            denied: calls.slice(allowedCalls).filter((call) => call.method === "sendMessage"),
            liveTelegram: false,
          };
          await fs.mkdir(outputDir, { recursive: true });
          await fs.writeFile(
            path.join(outputDir, "verdict.json"),
            JSON.stringify(verdict, null, 2),
          );
          console.log(`CONFIGURED_MEDIA_ROOTS ${JSON.stringify(verdict)}`);
        } finally {
          await stopQaGatewayFixture(gatewayOwner, {
            preserveToDir: path.join(outputDir, "gateway"),
          });
          await mock.stop();
          for (const poll of polls) {
            poll.destroy();
          }
        }
      }),
  );
}, 180_000);
