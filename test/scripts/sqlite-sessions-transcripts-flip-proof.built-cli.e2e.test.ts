// Built-CLI SQLite flip proof requires dist entrypoints before running the gateway lifecycle.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../../src/test-utils/env.js";
import { assertSqliteFlipProofCore } from "../helpers/sqlite-sessions-transcripts-flip-proof-assertions.ts";
import { runSqliteSessionsTranscriptsFlipProof } from "../helpers/sqlite-sessions-transcripts-flip-proof.ts";

describe("SQLite sessions/transcripts flip built CLI proof", () => {
  it("proves the lifecycle through the built gateway CLI entrypoint", async () => {
    const report = await withEnvAsync({ ZAI_API_KEY: "ambient-provider-fixture" }, () =>
      runSqliteSessionsTranscriptsFlipProof({ requireBuiltCli: true }),
    );

    expect(report.gatewayEntrypoint).toEqual(
      expect.arrayContaining([expect.stringMatching(/^dist\/index\.(?:js|mjs)$/u)]),
    );
    assertSqliteFlipProofCore(report);
    // Source checkouts also discover source-only plugins. Verify the packaged
    // provider this proof actually exercises without excluding those plugins.
    expect(report.bundledPlugins).toContainEqual({
      id: "openai",
      source: path.resolve("dist", "extensions", "openai", "index.js"),
    });
  }, 420_000);
});
