// Coverage for candidate fallback error attribution.
import { describe, expect, it } from "vitest";
import { executeWebSearchCandidates } from "./runtime-execution.js";

function candidate(id: string, execute: () => Promise<unknown>) {
  return {
    id,
    createTool: () => ({
      description: id,
      parameters: {},
      execute,
    }),
  } as unknown as Parameters<typeof executeWebSearchCandidates>[0]["candidates"][number];
}

describe("executeWebSearchCandidates", () => {
  it("surfaces the first candidate's error when every candidate fails", async () => {
    await expect(
      executeWebSearchCandidates({
        candidates: [
          candidate("google", async () => {
            throw new Error("google unreachable");
          }),
          candidate("duckduckgo", async () => {
            throw new Error("duckduckgo unreachable");
          }),
        ],
        args: {},
        allowFallback: true,
      }),
    ).rejects.toThrow("google unreachable");
  });
});
