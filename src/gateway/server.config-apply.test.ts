import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  connectOk,
  installGatewayTestHooks,
  onceMessage,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks();

describe("gateway config.apply", () => {
  it("writes config, stores sentinel, and schedules restart", async () => {
    vi.useFakeTimers();
    const sigusr1 = vi.fn();
    process.on("SIGUSR1", sigusr1);

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const id = "req-1";
    ws.send(
      JSON.stringify({
        type: "req",
        id,
        method: "config.apply",
        params: {
          raw: '{ "agent": { "workspace": "~/clawd" } }',
          sessionKey: "agent:main:whatsapp:dm:+15555550123",
          restartDelayMs: 0,
        },
      }),
    );
    const res = await onceMessage<{ ok: boolean; payload?: unknown }>(
      ws,
      (o) => o.type === "res" && o.id === id,
    );
    expect(res.ok).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    expect(sigusr1).toHaveBeenCalled();

    const sentinelPath = path.join(
      os.homedir(),
      ".clawdbot",
      "restart-sentinel.json",
    );
    const raw = await fs.readFile(sentinelPath, "utf-8");
    const parsed = JSON.parse(raw) as { payload?: { kind?: string } };
    expect(parsed.payload?.kind).toBe("config-apply");

    ws.close();
    await server.close();
    process.off("SIGUSR1", sigusr1);
    vi.useRealTimers();
  });

  it("rejects invalid raw config", async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const id = "req-2";
    ws.send(
      JSON.stringify({
        type: "req",
        id,
        method: "config.apply",
        params: {
          raw: "{",
        },
      }),
    );
    const res = await onceMessage<{ ok: boolean; error?: unknown }>(
      ws,
      (o) => o.type === "res" && o.id === id,
    );
    expect(res.ok).toBe(false);

    ws.close();
    await server.close();
  });
});
