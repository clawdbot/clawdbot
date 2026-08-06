// Gmail Windows tests cover gog watcher command invocation on Windows.
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getWindowsInstallRoots } from "../infra/windows-install-roots.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";

const mocks = vi.hoisted(() => ({
  resolveExecutable: vi.fn(),
}));

vi.mock("../infra/executable-path.js", () => ({
  resolveExecutable: mocks.resolveExecutable,
}));

async function importGmailWithExecutable(executable: string) {
  vi.resetModules();
  mocks.resolveExecutable.mockReset();
  mocks.resolveExecutable.mockReturnValue(executable);
  return await import("./gmail.js");
}

function expectedTrustedCmdExe(): string {
  return path.win32.join(getWindowsInstallRoots().systemRoot, "System32", "cmd.exe");
}

describe("resolveGogServeInvocation on Windows", () => {
  beforeEach(() => {});

  it("wraps spaced gog .cmd paths in an outer cmd.exe command line", async () => {
    const { resolveGogServeInvocation } = await importGmailWithExecutable(
      "C:\\Program Files\\gog\\gog.cmd",
    );

    await withMockedWindowsPlatform(async () => {
      const invocation = resolveGogServeInvocation([
        "gmail",
        "watch",
        "serve",
        "--account",
        "me@example.com",
      ]);

      expect(invocation).toEqual({
        command: expectedTrustedCmdExe(),
        args: [
          "/d",
          "/s",
          "/c",
          '""C:\\Program Files\\gog\\gog.cmd" gmail watch serve --account me@example.com"',
        ],
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
    });
  });

  it("escapes caret arguments for gog .cmd wrappers", async () => {
    const { resolveGogServeInvocation } = await importGmailWithExecutable("gog.cmd");

    await withMockedWindowsPlatform(async () => {
      const invocation = resolveGogServeInvocation([
        "gmail",
        "watch",
        "serve",
        "--label",
        "release/^1",
      ]);

      expect(invocation.args).toEqual([
        "/d",
        "/s",
        "/c",
        "gog.cmd gmail watch serve --label release/^^1",
      ]);
      expect(invocation.windowsVerbatimArguments).toBe(true);
    });
  });
});
