// Verifies chat-facing CLI snippets execute the OpenClaw CLI even from harness-hosted gateways.
import { describe, expect, it } from "vitest";
import {
  buildCurrentOpenClawCliArgv,
  buildCurrentOpenClawCliCommand,
  buildCurrentOpenClawCliExecEnv,
} from "./commands-openclaw-cli.js";

describe("buildCurrentOpenClawCliArgv", () => {
  it("delegates launch policy while keeping shell rendering local", () => {
    const args = ["sessions", "export-trajectory"];
    const argv = buildCurrentOpenClawCliArgv(args);
    expect(argv.at(-2)).toBe("sessions");
    expect(argv.at(-1)).toBe("export-trajectory");
    expect(buildCurrentOpenClawCliCommand(args)).toBe(argv.map((value) => `'${value}'`).join(" "));
  });

  it("clears inherited Vitest runner environment for CLI child processes", () => {
    expect(
      buildCurrentOpenClawCliExecEnv({
        PATH: "/usr/bin",
        VITEST: "true",
        VITEST_POOL_ID: "pool",
        OPENCLAW_VITEST_MAX_WORKERS: "1",
      }),
    ).toEqual({
      VITEST: "",
      VITEST_POOL_ID: "",
      OPENCLAW_VITEST_MAX_WORKERS: "",
    });
  });
});
