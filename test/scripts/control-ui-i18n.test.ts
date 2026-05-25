import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveControlUiI18nNpmInstallCommand,
  resolveControlUiI18nPnpmCommand,
  resolveControlUiI18nProcessCommand,
  resolvePiShimNodeCommand,
} from "../../scripts/control-ui-i18n.ts";

describe("control-ui-i18n command resolution", () => {
  const comSpec = String.raw`C:\Windows\System32\cmd.exe`;

  it("resolves Windows pi.cmd shims to the node CLI before multiline RPC prompts", () => {
    const piCmdPath = String.raw`C:\Users\runner\AppData\Roaming\npm\pi.cmd`;
    const cliPath = win32.join(
      win32.dirname(piCmdPath),
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "cli.js",
    );
    const command = resolvePiShimNodeCommand(piCmdPath, {
      existsSync: (candidate) => candidate === cliPath,
      platform: "win32",
    });

    expect(command).toEqual({
      args: [cliPath],
      executable: "node",
    });
    if (!command) {
      throw new Error("expected Windows Pi shim to resolve to a node command");
    }
    expect(
      resolveControlUiI18nProcessCommand(
        command.executable,
        [...command.args, "--system-prompt", "line one\nline two"],
        {
          comSpec,
          platform: "win32",
        },
      ),
    ).toEqual({
      args: [cliPath, "--system-prompt", "line one\nline two"],
      executable: "node",
      shell: false,
    });
  });

  it("routes Windows Pi package installs through toolchain-local npm.cmd", () => {
    const nodeExecPath = String.raw`C:\Program Files\nodejs\node.exe`;
    const npmCmdPath = win32.resolve(win32.dirname(nodeExecPath), "npm.cmd");

    expect(
      resolveControlUiI18nNpmInstallCommand("@pi/pai@1.2.3", {
        comSpec,
        env: { ComSpec: comSpec },
        execPath: nodeExecPath,
        existsSync: (candidate) => candidate === npmCmdPath,
        platform: "win32",
      }),
    ).toEqual({
      args: [
        "/d",
        "/s",
        "/c",
        String.raw`""C:\Program Files\nodejs\npm.cmd" install --silent --no-audit --no-fund @pi/pai@1.2.3"`,
      ],
      executable: comSpec,
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("routes Windows formatting through the active pnpm.cmd runner", () => {
    expect(
      resolveControlUiI18nPnpmCommand(
        ["exec", "oxfmt", "--stdin-filepath", "ui/src/i18n/generated.ts"],
        {
          comSpec,
          npmExecPath: String.raw`C:\Program Files\nodejs\pnpm.cmd`,
          platform: "win32",
        },
      ),
    ).toEqual({
      args: [
        "/d",
        "/s",
        "/c",
        String.raw`""C:\Program Files\nodejs\pnpm.cmd" exec oxfmt --stdin-filepath ui/src/i18n/generated.ts"`,
      ],
      executable: comSpec,
      shell: false,
      windowsVerbatimArguments: true,
    });
  });
});
