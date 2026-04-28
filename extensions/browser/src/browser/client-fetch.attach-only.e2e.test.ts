import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempHomeEnv } from "../../test-support.js";
import { stopBrowserControlService } from "../control-service.js";
import { fetchBrowserJson } from "./client-fetch.js";

type TempHome = {
  home: string;
  restore: () => Promise<void>;
};

describe("browser client fetch attachOnly diagnostics", () => {
  let tempHome: TempHome | undefined;

  beforeEach(async () => {
    vi.useRealTimers();
    await stopBrowserControlService();
    clearRuntimeConfigSnapshot();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await stopBrowserControlService();
    clearRuntimeConfigSnapshot();
    await tempHome?.restore();
    tempHome = undefined;
  });

  it("does not suggest gateway restart when an attachOnly CDP endpoint hangs", async () => {
    tempHome = await createTempHomeEnv("openclaw-browser-client-fetch-live-");
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const configPath = path.join(tempHome.home, ".openclaw", "openclaw.json");
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          browser: {
            enabled: true,
            defaultProfile: "hung",
            attachOnly: true,
            profiles: {
              hung: {
                cdpUrl: `http://127.0.0.1:${port}`,
                attachOnly: true,
                color: "#00AA00",
              },
            },
          },
        },
        null,
        2,
      ),
    );
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    clearRuntimeConfigSnapshot();

    try {
      const thrown = await fetchBrowserJson("/tabs?profile=hung", { timeoutMs: 200 }).catch(
        (err: unknown) => err,
      );
      expect(thrown).toBeInstanceOf(Error);
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      expect(message).toContain("browser profile is external to OpenClaw");
      expect(message).toContain("Restarting the OpenClaw gateway will not launch it");
      expect(message).not.toContain("Restart the OpenClaw gateway");
      expect(message).not.toContain("Do NOT retry the browser tool");
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
