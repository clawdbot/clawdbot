// SQLite sessions/transcripts flip proof test runs the script-style gateway lifecycle probe.
import { describe, it } from "vitest";
import { withEnvAsync } from "../../src/test-utils/env.js";
import { assertSqliteFlipProofCore } from "../helpers/sqlite-sessions-transcripts-flip-proof-assertions.ts";
import { runSqliteSessionsTranscriptsFlipProof } from "../helpers/sqlite-sessions-transcripts-flip-proof.ts";

describe("SQLite sessions/transcripts flip proof harness", () => {
  it("proves isolated gateway lifecycle state stays SQLite-first", async () => {
    const report = await withEnvAsync({ ZAI_API_KEY: "ambient-provider-fixture" }, () =>
      runSqliteSessionsTranscriptsFlipProof(),
    );

    assertSqliteFlipProofCore(report);
  }, 420_000);
});
