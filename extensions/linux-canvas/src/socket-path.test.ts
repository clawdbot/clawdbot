import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linuxCanvasSocketExists, watchLinuxCanvasSocket } from "./socket-path.js";

const loggerMocks = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  createSubsystemLogger: () => loggerMocks,
}));

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  loggerMocks.warn.mockReset();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Linux Canvas socket availability", () => {
  it.runIf(process.platform === "linux")(
    "requires a live, user-only socket instead of a stale inode or symlink",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-linux-canvas-path-"));
      tempDirs.push(dir);
      const socketPath = path.join(dir, "canvas.sock");
      const symlinkPath = path.join(dir, "canvas-link.sock");
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      fs.chmodSync(socketPath, 0o600);

      expect(linuxCanvasSocketExists(socketPath)).toBe(true);
      fs.symlinkSync(socketPath, symlinkPath);
      expect(linuxCanvasSocketExists(symlinkPath)).toBe(false);
      fs.chmodSync(socketPath, 0o666);
      expect(linuxCanvasSocketExists(socketPath)).toBe(false);
      fs.chmodSync(socketPath, 0o600);

      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      expect(linuxCanvasSocketExists(socketPath)).toBe(false);
    },
  );

  it("reports synchronous and asynchronous watcher failures before falling back to polling", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-linux-canvas-watch-"));
    tempDirs.push(directory);
    const socketPath = path.join(directory, "canvas.sock");
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
    const watch = vi
      .spyOn(fs, "watch")
      .mockImplementationOnce(() => watcher as unknown as fs.FSWatcher)
      .mockImplementationOnce(() => {
        throw new Error("EMFILE");
      });

    const stop = watchLinuxCanvasSocket(socketPath, vi.fn());
    watcher.emit("error", new Error("ENOSPC"));
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      expect.stringContaining("continuing with availability polling: Error: ENOSPC"),
    );
    stop();
    expect(watcher.close).toHaveBeenCalledOnce();

    expect(() => watchLinuxCanvasSocket(socketPath, vi.fn())).not.toThrow();
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      expect.stringContaining("continuing with availability polling: Error: EMFILE"),
    );
    expect(watch).toHaveBeenCalledTimes(2);
  });
});
