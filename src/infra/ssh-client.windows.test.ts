import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSshClient } from "./ssh-client.js";
import { getWindowsInstallRoots } from "./windows-install-roots.js";

const describeWindows = process.platform === "win32" ? describe : describe.skip;

describeWindows("resolveSshClient on Windows", () => {
  it("resolves and launches the OS-managed OpenSSH client", () => {
    const resolved = resolveSshClient();
    const expected = path.win32.join(
      getWindowsInstallRoots().systemRoot,
      "System32",
      "OpenSSH",
      "ssh.exe",
    );

    expect(resolved?.toLowerCase()).toBe(expected.toLowerCase());
    if (!resolved) {
      throw new Error("expected the Windows OpenSSH client to resolve");
    }
    const result = spawnSync(resolved, ["-V"], {
      encoding: "utf8",
      windowsHide: true,
    });
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/OpenSSH_for_Windows/i);
  });
});
