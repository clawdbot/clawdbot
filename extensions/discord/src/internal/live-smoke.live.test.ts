import { Routes } from "discord-api-types/v10";
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { parseApplicationIdFromToken } from "../probe.js";
import { RequestClient } from "./rest.js";

const TOKEN = process.env.DISCORD_BOT_TOKEN ?? "";
const LIVE = isLiveTestEnabled(["DISCORD_LIVE_TEST"]) && TOKEN.length > 0;
const describeLive = LIVE ? describe : describe.skip;

describeLive("discord live smoke", () => {
  it("resolves bot identity and gateway metadata", async () => {
    const rest = new RequestClient(TOKEN, { queueRequests: false, timeout: 15_000 });

    const me = (await rest.get(Routes.user("@me"))) as { id?: string; bot?: boolean };
    expect(me.bot).toBe(true);
    expect(me.id).toBe(parseApplicationIdFromToken(TOKEN));

    const gateway = (await rest.get(Routes.gatewayBot())) as {
      url?: string;
      session_start_limit?: { max_concurrency?: number };
    };
    expect(gateway.url).toMatch(/^wss:\/\//);
    expect(gateway.session_start_limit?.max_concurrency).toBeGreaterThan(0);
  });
});
