import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { ensureExtensionRelayDaemonProcess } from "./extension-relay-daemon-spawn.js";

const ENTRY = "/opt/openclaw/dist/extensions/browser/relay-daemon-entry.js";

describe("ensureExtensionRelayDaemonProcess", () => {
  it("skips when no relay credential exists", async () => {
    const spawnProcess = vi.fn();
    const status = await ensureExtensionRelayDaemonProcess({
      cfg: {},
      port: 18_799,
      entryPath: ENTRY,
      readToken: () => null,
      probe: async () => false,
      spawnProcess,
    });
    expect(status).toBe("skipped");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("spawns the daemon entry with the resolved port", async () => {
    const spawnProcess = vi.fn();
    const status = await ensureExtensionRelayDaemonProcess({
      cfg: { browser: { profiles: { work: { driver: "extension", cdpPort: 19123 } } } },
      port: 19_123,
      entryPath: ENTRY,
      execPath: "/usr/bin/node",
      readToken: () => "a".repeat(64),
      probe: async () => false,
      spawnProcess,
    });
    expect(status).toBe("spawned");
    expect(spawnProcess).toHaveBeenCalledWith("/usr/bin/node", [ENTRY, "--port", "19123"]);
  });
});

describe("relay port ownership", () => {
  it("leaves an existing listener alone and spawns only after it closes", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const spawnProcess = vi.fn();
    const params = {
      cfg: { browser: { profiles: { work: { driver: "extension" as const, cdpPort: port } } } },
      port,
      entryPath: ENTRY,
      readToken: () => "a".repeat(64),
      spawnProcess,
    };
    try {
      expect(await ensureExtensionRelayDaemonProcess(params)).toBe("running");
      expect(spawnProcess).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    expect(await ensureExtensionRelayDaemonProcess(params)).toBe("spawned");
    expect(spawnProcess).toHaveBeenCalledOnce();
  });
});
