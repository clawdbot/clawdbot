// Real grammY command handling and SQLite ingress, with a loopback Telegram API.
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { expect, it, vi } from "vitest";
import { defaultTelegramBotDeps } from "./bot-deps.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { createTelegramBot } from "./bot.js";
import { runTelegramChannelInboundEventWithHarness } from "./bot.test-helpers.js";
import * as callbackQueryAnswerState from "./callback-query-answer-state.js";
import { setTelegramRuntime } from "./runtime.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramAccountThrottlersForTest,
} from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";
import { createTelegramTransportIngressMonitor } from "./telegram-ingress-drain-factory.js";
import { openTelegramIngressQueue } from "./telegram-ingress-spool.js";

const downstream = vi.hoisted(() =>
  vi.fn(async (_ctx: MsgContext) => ({
    queuedFinal: false,
    counts: { block: 0, final: 0, tool: 0 },
  })),
);

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    runChannelInboundEvent: async (params: Parameters<typeof actual.runChannelInboundEvent>[0]) =>
      await runTelegramChannelInboundEventWithHarness(
        actual,
        params,
        async (dispatchParams) => await downstream(dispatchParams.ctx),
      ),
  };
});

it.each(["none", "middleware", "handler"] as const)(
  "answers a callback during a native menu request with %s ACK recovery",
  async (recovery) => {
    downstream.mockClear();
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-native-admission-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    resetPluginStateStoreForTests({ closeDatabase: false });
    resetTelegramAccountThrottlersForTest();
    setTelegramRuntime({
      state: {
        openChannelIngressQueue: (
          options?: Omit<Parameters<typeof createChannelIngressQueueForTests>[0], "channelId">,
        ) => createChannelIngressQueueForTests({ ...options, channelId: "telegram" }),
        openKeyedStore: ((options) =>
          createPluginStateKeyedStoreForTests(
            "telegram",
            options,
          )) as TelegramRuntime["state"]["openKeyedStore"],
      },
      channel: {},
    } as TelegramRuntime);

    const requests: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const runtimeErrors: unknown[] = [];
    let menu: Message.TextMessage | undefined;
    let heldMenuResponse: ServerResponse | undefined;
    const heldAnswerResponses: ServerResponse[] = [];
    let releaseAnswers = recovery === "none";
    const sendResult = (response: ServerResponse, result: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, result }));
    };
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
          string,
          unknown
        >;
        const method = request.url?.split("/").at(-1) ?? "";
        requests.push({ method, payload });
        if (method === "answerCallbackQuery" && !releaseAnswers) {
          const answerCount = requests.filter((entry) => entry.method === method).length;
          if (recovery === "middleware" && answerCount === 1) {
            response.writeHead(503, { "content-type": "application/json" });
            response.end(
              JSON.stringify({ ok: false, error_code: 503, description: "ACK unavailable" }),
            );
          } else {
            heldAnswerResponses.push(response);
          }
          return;
        }
        if (method === "sendMessage" && payload.reply_markup) {
          menu = {
            message_id: 80,
            date: 1_736_380_800,
            chat: { id: 111, type: "private", first_name: "Ada" },
            from: telegramBotInfoForTest,
            text: String(payload.text),
            reply_markup: payload.reply_markup as Message.TextMessage["reply_markup"],
          };
          heldMenuResponse = response;
          return;
        }
        sendResult(response, true);
      })().catch((error: unknown) =>
        response.destroy(error instanceof Error ? error : new Error(String(error))),
      );
    });
    const telegramTransport = { fetch, sourceFetch: fetch, close: async () => {} };
    let monitor: ReturnType<typeof createTelegramTransportIngressMonitor> | undefined;
    const readHandlerAnswer = vi.spyOn(
      callbackQueryAnswerState,
      "getTelegramCallbackQueryAnswerPromise",
    );
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const cfg: OpenClawConfig = {
        commands: { native: true, nativeSkills: false },
        channels: { telegram: { apiRoot, dmPolicy: "open", allowFrom: ["*"] } },
        session: { store: path.join(stateDir, "sessions.json") },
      };
      const bot = createTelegramBot({
        token: "123456:loopback-token",
        botInfo: telegramBotInfoForTest,
        config: cfg,
        telegramTransport,
        telegramDeps: {
          ...defaultTelegramBotDeps,
          getRuntimeConfig: () => cfg,
          listSkillCommandsForAgents: () => [],
          readChannelAllowFromStore: async () => [],
        },
        runtime: {
          log: () => {},
          error: (error) => runtimeErrors.push(error),
          exit: () => {
            throw new Error("unexpected runtime exit");
          },
        },
      });
      const answerRequests = vi.spyOn(bot.api, "answerCallbackQuery");
      const spoolDir = path.join(stateDir, "telegram", "ingress-spool-default");
      monitor = createTelegramTransportIngressMonitor({
        spoolDir,
        bot,
        cfg,
        accountId: "default",
        botInfo: telegramBotInfoForTest,
        pollIntervalMs: 10,
        onError: (error) => runtimeErrors.push(error),
      });
      const queue = openTelegramIngressQueue(spoolDir);
      const actor = { id: 111, is_bot: false, first_name: "Ada" };
      monitor.start();
      await monitor.admit({
        update_id: 1,
        message: {
          message_id: 1,
          date: 1_736_380_800,
          chat: { id: 111, type: "private", first_name: "Ada" },
          from: actor,
          text: "/usage",
          entities: [{ type: "bot_command", offset: 0, length: 6 }],
        },
      });
      await vi.waitFor(
        () => expect(menu, `native menu not sent: ${runtimeErrors.join("; ")}`).toBeDefined(),
        { timeout: 5_000, interval: 10 },
      );
      expect(await queue.listClaims()).toHaveLength(1);
      expect(downstream).not.toHaveBeenCalled();
      const button = menu?.reply_markup?.inline_keyboard
        .flat()
        .find((entry) => "callback_data" in entry && entry.callback_data === "tgcmd:/usage off");
      expect(button).toBeDefined();
      const callbackUpdate = {
        update_id: 2,
        callback_query: {
          id: "native-menu-callback",
          chat_instance: "native-menu-chat",
          from: actor,
          message: menu,
          data: button && "callback_data" in button ? button.callback_data : undefined,
        },
      };
      await monitor.admit(callbackUpdate);
      await vi.waitFor(
        () =>
          expect(requests.filter(({ method }) => method === "answerCallbackQuery")).toHaveLength(1),
        { timeout: 1_000, interval: 10 },
      );
      expect(await queue.listClaims()).toHaveLength(1);
      expect(await queue.listPending({ limit: "all" })).toHaveLength(1);
      expect(downstream).not.toHaveBeenCalled();
      if (recovery !== "none") {
        if (recovery === "middleware") {
          const firstAnswer = answerRequests.mock.results[0]?.value;
          expect(firstAnswer).toBeDefined();
          await expect(firstAnswer).rejects.toThrow("ACK unavailable");
        }
        expect(heldMenuResponse).toBeDefined();
        sendResult(heldMenuResponse!, menu);
        heldMenuResponse = undefined;
        if (recovery === "handler") {
          // Let the real router consume the pending admission answer before rejecting it.
          await vi.waitFor(() => expect(readHandlerAnswer).toHaveBeenCalled(), { interval: 10 });
          const firstResponse = heldAnswerResponses.shift();
          expect(firstResponse).toBeDefined();
          firstResponse!.writeHead(503, { "content-type": "application/json" });
          firstResponse!.end(
            JSON.stringify({ ok: false, error_code: 503, description: "ACK unavailable" }),
          );
        }
        await vi.waitFor(() => expect(answerRequests).toHaveBeenCalledTimes(2), { interval: 10 });
        await monitor.admit(callbackUpdate);
        await monitor.admit(callbackUpdate);
        releaseAnswers = true;
        for (const response of heldAnswerResponses) {
          sendResult(response, true);
        }
        await Promise.allSettled(answerRequests.mock.results.map((result) => result.value));
        const callbackRequests = requests.filter(({ method }) => method === "answerCallbackQuery");
        console.log(
          "CALLBACK_RECOVERY_HTTP_PROOF",
          JSON.stringify({ recovery, requests: callbackRequests.length }),
        );
        expect(callbackRequests).toHaveLength(2);
        expect(
          callbackQueryAnswerState.takeTelegramCallbackQueryAdmissionAnswer(
            bot,
            "native-menu-callback",
          ),
        ).toBeUndefined();
      }
    } finally {
      releaseAnswers = true;
      for (const response of heldAnswerResponses) {
        if (!response.writableEnded) {
          sendResult(response, true);
        }
      }
      if (heldMenuResponse && !heldMenuResponse.writableEnded) {
        sendResult(heldMenuResponse, menu);
      }
      await monitor?.waitForIdle();
      await monitor?.stop();
      readHandlerAnswer.mockRestore();
      await telegramTransport.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      clearTelegramRuntimeForTest();
      resetTelegramAccountThrottlersForTest();
      closeOpenClawStateDatabaseForTest();
      resetPluginStateStoreForTests({ closeDatabase: false });
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
    }
    expect(runtimeErrors).toEqual([]);
    expect(downstream).toHaveBeenCalledOnce();
  },
);
