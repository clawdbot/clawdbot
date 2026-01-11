import { describe, expect, test } from "vitest";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

const loadConfigHelpers = async () => await import("../config/config.js");

installGatewayTestHooks();

describe("gateway server providers", () => {
  test("providers.status returns snapshot without probe", async () => {
    const prevToken = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq<{
      providers?: Record<
        string,
        | {
            configured?: boolean;
            tokenSource?: string;
            probe?: unknown;
            lastProbeAt?: unknown;
          }
        | { linked?: boolean }
      >;
    }>(ws, "providers.status", { probe: false, timeoutMs: 2000 });
    expect(res.ok).toBe(true);
    const telegram = res.payload?.providers?.telegram;
    const signal = res.payload?.providers?.signal;
    expect(res.payload?.providers?.whatsapp).toBeTruthy();
    expect(telegram?.configured).toBe(false);
    expect(telegram?.tokenSource).toBe("none");
    expect(telegram?.probe).toBeUndefined();
    expect(telegram?.lastProbeAt).toBeNull();
    expect(signal?.configured).toBe(false);
    expect(signal?.probe).toBeUndefined();
    expect(signal?.lastProbeAt).toBeNull();

    ws.close();
    await server.close();
    if (prevToken === undefined) {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = prevToken;
    }
  });

  test("providers.logout reports no session when missing", async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq<{ cleared?: boolean; provider?: string }>(
      ws,
      "providers.logout",
      { provider: "whatsapp" },
    );
    expect(res.ok).toBe(true);
    expect(res.payload?.provider).toBe("whatsapp");
    expect(res.payload?.cleared).toBe(false);

    ws.close();
    await server.close();
  });

  test("providers.logout clears telegram bot token from config", async () => {
    const prevToken = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    const { readConfigFileSnapshot, writeConfigFile } =
      await loadConfigHelpers();
    await writeConfigFile({
      telegram: {
        botToken: "123:abc",
        groups: { "*": { requireMention: false } },
      },
    });

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq<{
      cleared?: boolean;
      envToken?: boolean;
      provider?: string;
    }>(ws, "providers.logout", { provider: "telegram" });
    expect(res.ok).toBe(true);
    expect(res.payload?.provider).toBe("telegram");
    expect(res.payload?.cleared).toBe(true);
    expect(res.payload?.envToken).toBe(false);

    const snap = await readConfigFileSnapshot();
    expect(snap.valid).toBe(true);
    expect(snap.config?.telegram?.botToken).toBeUndefined();
    expect(snap.config?.telegram?.groups?.["*"]?.requireMention).toBe(false);

    ws.close();
    await server.close();
    if (prevToken === undefined) {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = prevToken;
    }
  });
});
