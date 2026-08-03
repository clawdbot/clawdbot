// OpenClaw SDK tests cover package behavior.
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { getWindowsSystem32ExePath } from "../../../src/infra/windows-install-roots.js";
import { createPackedSdkConsumer, signalCommandProcess } from "./package.e2e.test-support.js";

describe("OpenClaw SDK package e2e", () => {
  it("force-kills Windows package command process trees when graceful taskkill fails", () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const killMock = vi.fn();
      const child = {
        pid: 12345,
        kill: killMock,
      } as unknown as ReturnType<typeof spawn>;
      const runTaskkill = vi
        .fn()
        .mockReturnValueOnce({ status: 1 })
        .mockReturnValueOnce({ status: 0 });

      signalCommandProcess(child, "SIGTERM", runTaskkill);

      const taskkillPath = getWindowsSystem32ExePath("taskkill.exe");
      expect(runTaskkill).toHaveBeenNthCalledWith(1, taskkillPath, ["/PID", "12345", "/T"], {
        stdio: "ignore",
        windowsHide: true,
      });
      expect(runTaskkill).toHaveBeenNthCalledWith(2, taskkillPath, ["/PID", "12345", "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      expect(killMock).not.toHaveBeenCalled();
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, "platform", platformDescriptor);
      }
    }
  });

  it("packs and imports from an external temp consumer", async () => {
    const consumer = await createPackedSdkConsumer();
    try {
      await consumer.run(`
        import { GatewayClientTransport, OpenClaw, normalizeGatewayEvent } from "@openclaw/sdk";
        if (typeof GatewayClientTransport !== "function") throw new Error("missing transport export");
        if (typeof OpenClaw !== "function") throw new Error("missing client export");
        const event = normalizeGatewayEvent({
          event: "agent",
          payload: { runId: "pack-smoke", stream: "lifecycle", data: { phase: "start" } }
        });
        if (event.type !== "run.started") throw new Error("unexpected event normalization");
      `);
    } finally {
      await consumer.cleanup();
    }
  }, 240_000);
});
