// Tool Surface Live Bench tests cover manual repro argument parsing only.
import { describe, expect, it } from "vitest";
import { parseBenchArgs } from "../../scripts/repro/tool-surface-live-bench.ts";

describe("tool surface live bench repro", () => {
  it("parses provider, surface, and task selections", () => {
    expect(
      parseBenchArgs([
        "--providers=openai,google",
        "--surfaces=direct,code-mode",
        "--tasks=recovery",
      ]),
    ).toMatchObject({
      providers: ["openai", "google"],
      surfaces: ["direct", "code-mode"],
      taskIds: ["recovery"],
    });
  });

  it("rejects unknown selections and misspelled arguments", () => {
    expect(() => parseBenchArgs(["--providers=ollama"])).toThrow(
      "unknown --providers value: ollama",
    );
    expect(() => parseBenchArgs(["--surface=direct"])).toThrow(
      "unknown argument: --surface=direct",
    );
    expect(() => parseBenchArgs(["--model-openai=gpt-test"])).toThrow(
      "unknown argument: --model-openai=gpt-test",
    );
  });
});
