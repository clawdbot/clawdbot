// Print Cli Backend Live Metadata tests cover print cli backend live metadata script behavior.
import { describe, expect, it } from "vitest";
import { resolveCliBackendLiveMetadata } from "../../scripts/print-cli-backend-live-metadata.js";

describe("print-cli-backend-live-metadata", () => {
  it("builds one unsupported codex-cli metadata payload", async () => {
    expect(await resolveCliBackendLiveMetadata("codex-cli")).toEqual({
      provider: "codex-cli",
      unsupported: true,
      reason:
        "codex-cli is no longer a bundled CLI backend. Use openai/* with the Codex app-server runtime instead.",
    });
  });
});
