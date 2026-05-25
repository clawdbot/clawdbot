import { describe, expect, it } from "vitest";
import { resolveNativeOpusInstallCommand } from "../../scripts/install-discord-native-opus.mjs";

describe("resolveNativeOpusInstallCommand", () => {
  it("wraps Windows pnpm.cmd without shell mode", () => {
    expect(
      resolveNativeOpusInstallCommand({
        comSpec: "C:\\Windows\\System32\\cmd.exe",
        nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
        npmExecPath: "C:\\Program Files\\nodejs\\pnpm.cmd",
        opusDir: "C:\\repo\\node_modules\\@discordjs\\opus",
        platform: "win32",
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        '""C:\\Program Files\\nodejs\\pnpm.cmd" --dir C:\\repo\\node_modules\\@discordjs\\opus exec node-pre-gyp install --fallback-to-build"',
      ],
      shell: false,
      windowsVerbatimArguments: true,
    });
  });
});
