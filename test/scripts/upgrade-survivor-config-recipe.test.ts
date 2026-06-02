import { describe, expect, it } from "vitest";
import {
  CONFIG_COMMAND_MAX_BUFFER_BYTES,
  CONFIG_COMMAND_TIMEOUT_MS,
  resolveUpgradeSurvivorOpenClawCommand,
  runUpgradeSurvivorOpenClawStep,
} from "../../scripts/e2e/lib/upgrade-survivor/config-recipe.mjs";

describe("upgrade survivor config recipe command resolution", () => {
  it("wraps Windows openclaw npm shims through cmd.exe", () => {
    expect(
      resolveUpgradeSurvivorOpenClawCommand(
        ["config", "set", "models.providers.openai", '{"apiKey":"sk test"}', "--strict-json"],
        {
          comSpec: String.raw`C:\Windows\System32\cmd.exe`,
          platform: "win32",
        },
      ),
    ).toEqual({
      args: [
        "/d",
        "/s",
        "/c",
        'openclaw.cmd config set models.providers.openai "{""apiKey"":""sk test""}" --strict-json',
      ],
      command: String.raw`C:\Windows\System32\cmd.exe`,
      commandLabel:
        'openclaw config set models.providers.openai {"apiKey":"sk test"} --strict-json',
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("keeps POSIX openclaw invocations direct", () => {
    expect(
      resolveUpgradeSurvivorOpenClawCommand(["config", "validate"], {
        platform: "linux",
      }),
    ).toEqual({
      args: ["config", "validate"],
      command: "openclaw",
      commandLabel: "openclaw config validate",
      shell: false,
    });
  });

  it("bounds baseline config commands and reports spawn errors", () => {
    const calls: unknown[] = [];
    const timeoutError = Object.assign(new Error("spawnSync openclaw ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });

    const outcome = runUpgradeSurvivorOpenClawStep(
      {
        argv: ["config", "validate"],
        id: "validate",
        intent: "validate",
      },
      {
        spawnSyncCommand(command: string, args: string[], options: unknown) {
          calls.push({ args, command, options });
          return {
            error: timeoutError,
            signal: "SIGTERM",
            status: null,
            stderr: "still validating",
            stdout: "partial output",
          };
        },
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      args: ["config", "validate"],
      command: "openclaw",
      options: {
        killSignal: "SIGTERM",
        maxBuffer: CONFIG_COMMAND_MAX_BUFFER_BYTES,
        timeout: CONFIG_COMMAND_TIMEOUT_MS,
      },
    });
    expect(outcome).toMatchObject({
      command: "openclaw config validate",
      errorCode: "ETIMEDOUT",
      errorMessage: "spawnSync openclaw ETIMEDOUT",
      ok: false,
      signal: "SIGTERM",
      status: null,
      stderr: "still validating",
      stdout: "partial output",
    });
  });
});
