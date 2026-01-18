import { afterEach, describe, expect, test, vi } from "vitest";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

const loadConfigHelpers = async () => await import("../config/config.js");

installGatewayTestHooks();

const servers: Array<Awaited<ReturnType<typeof startServerWithClient>>> = [];

afterEach(async () => {
  for (const { server, ws } of servers) {
    try {
      ws.close();
      await server.close();
    } catch {
      /* ignore */
    }
  }
  servers.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 50));
});

describe("gateway server channels", () => {
  test("channels.status returns snapshot without probe", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", undefined);
    const result = await startServerWithClient();
    servers.push(result);
    const { ws } = result;
    await connectOk(ws);

    const res = await rpcReq<{
      channels?: Record<
        string,
        | {
            configured?: boolean;
            tokenSource?: string;
            probe?: unknown;
            lastProbeAt?: unknown;
          }
        | { linked?: boolean }
      >;
    }>(ws, "channels.status", { probe: false, timeoutMs: 2000 });
    expect(res.ok).toBe(true);
    const telegram = res.payload?.channels?.telegram;
    const signal = res.payload?.channels?.signal;
    expect(res.payload?.channels?.whatsapp).toBeTruthy();
    expect(telegram?.configured).toBe(false);
    expect(telegram?.tokenSource).toBe("none");
    expect(telegram?.probe).toBeUndefined();
    expect(telegram?.lastProbeAt).toBeNull();
    expect(signal?.configured).toBe(false);
    expect(signal?.probe).toBeUndefined();
    expect(signal?.lastProbeAt).toBeNull();
  });

  test("channels.logout reports no session when missing", async () => {
    const result = await startServerWithClient();
    servers.push(result);
    const { ws } = result;
    await connectOk(ws);

    const res = await rpcReq<{ cleared?: boolean; channel?: string }>(ws, "channels.logout", {
      channel: "whatsapp",
    });
    expect(res.ok).toBe(true);
    expect(res.payload?.channel).toBe("whatsapp");
    expect(res.payload?.cleared).toBe(false);
  });

  test("channels.logout clears telegram bot token from config", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", undefined);
    const { readConfigFileSnapshot, writeConfigFile } = await loadConfigHelpers();
    await writeConfigFile({
      channels: {
        telegram: {
          botToken: "123:abc",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    const result = await startServerWithClient();
    servers.push(result);
    const { ws } = result;
    await connectOk(ws);

    const res = await rpcReq<{
      cleared?: boolean;
      envToken?: boolean;
      channel?: string;
    }>(ws, "channels.logout", { channel: "telegram" });
    expect(res.ok).toBe(true);
    expect(res.payload?.channel).toBe("telegram");
    expect(res.payload?.cleared).toBe(true);
    expect(res.payload?.envToken).toBe(false);

    const snap = await readConfigFileSnapshot();
    expect(snap.valid).toBe(true);
    expect(snap.config?.channels?.telegram?.botToken).toBeUndefined();
    expect(snap.config?.channels?.telegram?.groups?.["*"]?.requireMention).toBe(false);
  });
});
