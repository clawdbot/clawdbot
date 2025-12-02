import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../logging.js", () => ({
  getChildLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

const originalHome = process.env.HOME;

afterEach(() => {
  process.env.HOME = originalHome;
  vi.resetModules();
});

describe("ipc hardening", () => {
  it("creates private socket dir and socket with tight perms", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "warelay-home-"));
    process.env.HOME = tmpHome;
    vi.resetModules();

    const ipc = await import("./ipc.js");

    const sendHandler = vi.fn().mockResolvedValue({ messageId: "msg1" });
    ipc.startIpcServer(sendHandler);

    const dirStat = fs.lstatSync(path.join(tmpHome, ".warelay", "ipc"));
    expect(dirStat.mode & 0o777).toBe(0o700);

    expect(ipc.isRelayRunning()).toBe(true);

    const socketStat = fs.lstatSync(ipc.getSocketPath());
    expect(socketStat.isSocket()).toBe(true);
    if (typeof process.getuid === "function") {
      expect(socketStat.uid).toBe(process.getuid());
    }

    ipc.stopIpcServer();
    expect(ipc.isRelayRunning()).toBe(false);
  });

  it("refuses to start when IPC dir is a symlink", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "warelay-home-"));
    const warelayDir = path.join(tmpHome, ".warelay");
    fs.mkdirSync(warelayDir, { recursive: true });
    fs.symlinkSync("/tmp", path.join(warelayDir, "ipc"));

    process.env.HOME = tmpHome;
    vi.resetModules();

    const ipc = await import("./ipc.js");
    const sendHandler = vi.fn().mockResolvedValue({ messageId: "msg1" });

    expect(() => ipc.startIpcServer(sendHandler)).toThrow(/symlink/i);
  });
});
