import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { getWindowsSystem32ExePath } from "../../../src/infra/windows-install-roots.js";
import { signalCommandProcess } from "./package.e2e.test-support.js";

describe("packed SDK command support", () => {
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
});
