import { describe, expect, it } from "vitest";
import { applyQaMergePatch } from "./suite-merge-patch.js";

describe("applyQaMergePatch", () => {
  it("merges object arrays by id when the target array is id-keyed", () => {
    expect(
      applyQaMergePatch(
        {
          agents: [
            { id: "qa", model: { primary: "openai/gpt-5.5" }, tools: ["read"] },
            { id: "keep", enabled: true },
          ],
        },
        {
          agents: [
            { id: "qa", model: { fallback: "anthropic/claude-opus-4-8" } },
            { id: "new", enabled: false },
          ],
        },
      ),
    ).toEqual({
      agents: [
        {
          id: "qa",
          model: {
            primary: "openai/gpt-5.5",
            fallback: "anthropic/claude-opus-4-8",
          },
          tools: ["read"],
        },
        { id: "keep", enabled: true },
        { id: "new", enabled: false },
      ],
    });
  });

  it("replaces primitive arrays", () => {
    expect(
      applyQaMergePatch(
        {
          tools: {
            deny: ["image_generate"],
          },
        },
        {
          tools: {
            deny: ["shell"],
          },
        },
      ),
    ).toEqual({
      tools: {
        deny: ["shell"],
      },
    });
  });

  it("ignores prototype-mutating object keys", () => {
    const patch = JSON.parse(
      `{"plugins":{"entries":{}},"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}`,
    ) as Record<string, unknown>;

    expect(applyQaMergePatch({}, patch)).toEqual({ plugins: { entries: {} } });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
