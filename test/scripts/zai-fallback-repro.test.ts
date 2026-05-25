import { describe, expect, it } from "vitest";
import { resolveZaiFallbackPnpmCommand } from "../../scripts/zai-fallback-repro.ts";

describe("zai fallback repro command resolution", () => {
  it("wraps Windows pnpm.cmd without Node shell argv", () => {
    expect(
      resolveZaiFallbackPnpmCommand(
        ["openclaw", "agent", "--message", "hello world"],
        {
          comSpec: String.raw`C:\Windows\System32\cmd.exe`,
          npmExecPath: String.raw`C:\Program Files\nodejs\pnpm.cmd`,
          platform: "win32",
        },
      ),
    ).toEqual({
      args: [
        "/d",
        "/s",
        "/c",
        String.raw`""C:\Program Files\nodejs\pnpm.cmd" openclaw agent --message "hello world""`,
      ],
      command: String.raw`C:\Windows\System32\cmd.exe`,
      shell: false,
      windowsVerbatimArguments: true,
    });
  });
});
