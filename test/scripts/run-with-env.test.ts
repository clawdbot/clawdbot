import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  isRunWithEnvHelpRequest,
  parseRunWithEnvArgs,
  resolveSpawnCommand,
} from "../../scripts/run-with-env.mjs";

describe("run-with-env", () => {
  it("parses leading env assignments before the command separator", () => {
    expect(
      parseRunWithEnvArgs([
        "OPENCLAW_GATEWAY_PROJECT_SHARDS=1",
        "EMPTY=",
        "--",
        "node",
        "scripts/run-vitest.mjs",
        "run",
      ]),
    ).toEqual({
      env: {
        OPENCLAW_GATEWAY_PROJECT_SHARDS: "1",
        EMPTY: "",
      },
      command: "node",
      args: ["scripts/run-vitest.mjs", "run"],
    });
  });

  it("rejects missing command separators", () => {
    expect(() => parseRunWithEnvArgs(["OPENCLAW_GATEWAY_PROJECT_SHARDS=1", "node"])).toThrow(
      /Usage:/u,
    );
  });

  it("prints wrapper help without spawning a command", () => {
    const result = spawnSync(process.execPath, ["scripts/run-with-env.mjs", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: node scripts/run-with-env.mjs");
    expect(result.stderr).toBe("");
  });

  it("keeps command help passthrough after the separator", () => {
    expect(
      isRunWithEnvHelpRequest(["OPENCLAW_GATEWAY_PROJECT_SHARDS=1", "--", "node", "--help"]),
    ).toBe(false);
  });

  it("rejects malformed assignments before spawning", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-with-env.mjs",
        "1INVALID=value",
        "--",
        "node",
        "-e",
        "process.stdout.write('spawned')",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("invalid environment assignment");
  });

  it("uses the current Node executable for node commands", () => {
    expect(resolveSpawnCommand("node", ["scripts/run-vitest.mjs"], "node.exe")).toEqual({
      command: "node.exe",
      args: ["scripts/run-vitest.mjs"],
    });
  });
});
