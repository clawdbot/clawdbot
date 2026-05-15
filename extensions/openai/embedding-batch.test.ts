import { describe, expect, it } from "vitest";
import { parseOpenAiBatchOutput } from "./embedding-batch.js";

describe("OpenAI embedding batch output", () => {
  it("wraps malformed JSONL output", () => {
    expect(() => parseOpenAiBatchOutput('{"custom_id":"ok"}\n{not json')).toThrow(
      "OpenAI embedding batch output contained malformed JSONL",
    );
  });
});
