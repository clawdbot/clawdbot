// Built-CLI SQLite flip proof requires dist entrypoints before running the gateway lifecycle.
import { describe, expect, it } from "vitest";
import { assertSqliteFlipProofCore } from "../helpers/sqlite-sessions-transcripts-flip-proof-assertions.ts";
import { runSqliteSessionsTranscriptsFlipProof } from "../helpers/sqlite-sessions-transcripts-flip-proof.ts";

describe("SQLite sessions/transcripts flip built CLI proof", () => {
  it("proves the lifecycle through the built gateway CLI entrypoint", async () => {
    const report = await runSqliteSessionsTranscriptsFlipProof({ requireBuiltCli: true });

    expect(report.gatewayEntrypoint).toEqual(
      expect.arrayContaining([expect.stringMatching(/^dist\/index\.(?:js|mjs)$/u)]),
    );
    assertSqliteFlipProofCore(report);
  }, 180_000);
});
