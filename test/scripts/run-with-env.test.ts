import { describe, expect, it } from "vitest";
import {
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
      /usage:/u,
    );
  });

  it("uses the current Node executable for node commands", () => {
    expect(resolveSpawnCommand("node", ["scripts/run-vitest.mjs"], "node.exe")).toEqual({
      command: "node.exe",
      args: ["scripts/run-vitest.mjs"],
    });
  });
});
