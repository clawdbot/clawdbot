/** Channel recovery replies preserve decisions from the real account lifecycle owner. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ChannelGatewayContext } from "../channels/plugins/types.adapters.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { writeConfigFile } from "../config/config.js";
import { setActiveDegradedSecretOwners } from "../secrets/runtime-degraded-state.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  connectWebchatClient,
  getGatewayTestPort,
  installGatewayTestHooks,
  rpcReq,
  setTestPluginRegistry,
  startTestGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

type TestAccount = { accountId: string };

describe("channels.start account outcomes", () => {
  let server: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    setActiveDegradedSecretOwners([]);
  });

  it("reports skips and in-flight ownership while manual recovery bypasses the breaker", async () => {
    await withEnvAsync(
      { OPENCLAW_SKIP_CHANNELS: undefined, OPENCLAW_SKIP_PROVIDERS: undefined },
      async () => {
        const stopEntered = createDeferred();
        const releaseStop = createDeferred();
        const firstStart = createDeferred();
        const secondStart = createDeferred();
        const starts = [firstStart, secondStart];
        const startAccount = vi.fn(async ({ abortSignal }: ChannelGatewayContext<TestAccount>) => {
          starts.shift()?.resolve();
          await new Promise<void>((resolve) => {
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
        });
        const stopAccount = vi.fn(async () => {
          stopEntered.resolve();
          await releaseStop.promise;
        });
        const plugin: ChannelPlugin<TestAccount> = {
          ...createChannelTestPluginBase({ id: "telegram" }),
          config: {
            listAccountIds: () => ["disabled", "healthy", "unconfigured", "cold"],
            defaultAccountId: () => "healthy",
            resolveAccount: (_config, accountId) => ({ accountId: accountId ?? "healthy" }),
            isEnabled: (account) => account.accountId !== "disabled",
            isConfigured: (account) => account.accountId !== "unconfigured",
          },
          gateway: { startAccount, stopAccount },
        };
        setTestPluginRegistry(
          createTestRegistry([{ pluginId: "telegram", source: "test", plugin }]),
        );
        await writeConfigFile({
          gateway: {
            mode: "local",
            bind: "loopback",
            auth: { mode: "none" },
            reload: { mode: "off" },
          },
          channels: { telegram: { enabled: true, healthMonitor: { enabled: false } } },
        });
        const port = await getGatewayTestPort();
        server = await startTestGatewayServer(port, {
          auth: { mode: "none" },
          channelAutostartSuppression: {
            reason: "crash-loop-breaker",
            message: "synthetic safe mode",
          },
        });
        const ws = await connectWebchatClient({ port, scopes: ["operator.admin"] });
        try {
          expect(startAccount).not.toHaveBeenCalled();
          const invalidOverride = await rpcReq(ws, "channels.start", {
            channel: "telegram",
            manual: true,
          });
          expect(invalidOverride).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
          for (const accountId of ["disabled", "unconfigured"]) {
            const result = await rpcReq(ws, "channels.start", { channel: "telegram", accountId });
            expect(result).toMatchObject({
              ok: true,
              payload: {
                channel: "telegram",
                accountId,
                started: false,
                outcome: { status: "skipped", reason: accountId },
              },
            });
          }
          setActiveDegradedSecretOwners([
            {
              ownerKind: "account",
              ownerId: "telegram:cold",
              state: "unavailable",
              paths: ["channels.telegram.accounts.cold.botToken"],
              refKeys: ["env:default:SYNTHETIC_MISSING_CHANNEL_TOKEN"],
              reason: "secret reference was not found",
            },
          ]);
          const cold = await rpcReq(ws, "channels.start", {
            channel: "telegram",
            accountId: "cold",
          });
          expect(cold).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
          expect(startAccount).not.toHaveBeenCalled();
          const started = await rpcReq(ws, "channels.start", { channel: "telegram" });
          expect(started).toMatchObject({
            ok: true,
            payload: { accountId: "healthy", started: true, outcome: { status: "handed-off" } },
          });
          await firstStart.promise;
          const repeated = await rpcReq(ws, "channels.start", { channel: "telegram" });
          expect(repeated).toMatchObject({
            ok: true,
            payload: {
              accountId: "healthy",
              started: true,
              outcome: { status: "retry", reason: "task-owned" },
            },
          });
          expect(startAccount).toHaveBeenCalledOnce();
          const stopping = rpcReq(ws, "channels.stop", {
            channel: "telegram",
            accountId: "healthy",
          });
          await stopEntered.promise;
          const blocked = await rpcReq(ws, "channels.start", {
            channel: "telegram",
            accountId: "healthy",
          });
          expect(blocked).toMatchObject({
            ok: true,
            payload: {
              accountId: "healthy",
              started: true,
              outcome: { status: "retry", reason: "stop-in-flight" },
            },
          });
          expect(startAccount).toHaveBeenCalledOnce();
          releaseStop.resolve();
          expect(await stopping).toMatchObject({ ok: true, payload: { stopped: true } });
          const restarted = await rpcReq(ws, "channels.start", {
            channel: "telegram",
            accountId: "healthy",
          });
          expect(restarted).toMatchObject({
            ok: true,
            payload: { accountId: "healthy", started: true, outcome: { status: "handed-off" } },
          });
          await secondStart.promise;
          expect(startAccount).toHaveBeenCalledTimes(2);
        } finally {
          releaseStop.resolve();
          ws.close();
        }
      },
    );
  });
});
