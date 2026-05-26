import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("print-cli-backend-live-metadata", () => {
  it("prints one parseable unsupported codex-cli JSON payload", () => {
    const stdout = execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/print-cli-backend-live-metadata.ts", "codex-cli"],
      { encoding: "utf8" },
    );

    expect(JSON.parse(stdout)).toEqual({
      provider: "codex-cli",
      unsupported: true,
      reason:
        "codex-cli is no longer a bundled CLI backend. Use openai/* with the Codex app-server runtime instead.",
    });
  });
});
