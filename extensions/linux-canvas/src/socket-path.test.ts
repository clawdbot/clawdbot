import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { linuxCanvasSocketExists } from "./socket-path.js";

const tempDirs: string[] = [];

afterEach(() => {
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
});
