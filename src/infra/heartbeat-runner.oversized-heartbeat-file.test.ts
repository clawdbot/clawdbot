// Regression test for bounded HEARTBEAT.md reads.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import { seedMainSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

installHeartbeatRunnerTestRuntime({ includeSlack: true });

afterEach(() => {
  loggingState.rawConsole = null;
  setLoggerOverride(null);
  resetLogger();
});

describe("runHeartbeatOnce oversized HEARTBEAT.md", () => {
  it("follows a symlinked HEARTBEAT.md to a regular file", async () => {
    if (process.platform === "win32") {
      // Symlink support in unit tests is not guaranteed on Windows CI runners.
      return;
    }
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "slack", to: "channel:C123" },
          },
        },
        channels: { slack: { heartbeat: { showOk: false } } },
        session: { store: storePath },
      };
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "slack",
        lastProvider: "slack",
        lastTo: "channel:C123",
      });
      const heartbeatPath = path.join(tmpDir, "HEARTBEAT.md");
      const targetPath = path.join(tmpDir, "real-HEARTBEAT.md");
      await fs.writeFile(targetPath, "- Check status\n", "utf-8");
      await fs.rm(heartbeatPath, { force: true });
      await fs.symlink(targetPath, heartbeatPath);

      replySpy.mockResolvedValue({ text: "ok" });
      const sendSlack = vi.fn().mockResolvedValue({ messageId: "m1", channelId: "C123" });

      const res = await runHeartbeatOnce({
        cfg,
        deps: {
          getReplyFromConfig: replySpy,
          slack: sendSlack,
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
      });

      expect(res.status).toBe("ran");
      expect(sendSlack).toHaveBeenCalledTimes(1);
    });
  });

  it("treats an oversized HEARTBEAT.md like a missing file and continues the run", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "slack", to: "channel:C123" },
          },
        },
        channels: { slack: { heartbeat: { showOk: false } } },
        session: { store: storePath },
      };
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "slack",
        lastProvider: "slack",
        lastTo: "channel:C123",
      });
      // Overwrite the default heartbeat file with content larger than the 16 MB cap.
      const oversizedContent = Buffer.alloc(16 * 1024 * 1024 + 1, "x");
      await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), oversizedContent);

      const warn = vi.fn();
      loggingState.rawConsole = { log: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
      setLoggerOverride({ level: "silent", consoleLevel: "warn" });

      replySpy.mockResolvedValue({ text: "needs attention" });
      const sendSlack = vi.fn().mockResolvedValue({ messageId: "m1", channelId: "C123" });

      const res = await runHeartbeatOnce({
        cfg,
        deps: {
          getReplyFromConfig: replySpy,
          slack: sendSlack,
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
      });

      expect(res.status).toBe("ran");
      expect(sendSlack).toHaveBeenCalledTimes(1);
      // Operators must see why their oversized heartbeat file no longer applies.
      expect(
        warn.mock.calls.some((call) => String(call[0]).includes("skipping oversized HEARTBEAT.md")),
      ).toBe(true);
    });
  });
});
