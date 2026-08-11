// Qa Lab tests cover suite merge patch plugin behavior.
import { describe, expect, it } from "vitest";
import { applyQaMergePatch, mergeQaMergePatchDocuments } from "./suite-merge-patch.js";

describe("applyQaMergePatch", () => {
  it("merges object arrays by id when the target array is id-keyed", () => {
    expect(
      applyQaMergePatch(
        {
          agents: [
            { id: "qa", model: { primary: "openai/gpt-5.6-luna" }, tools: ["read"] },
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
            primary: "openai/gpt-5.6-luna",
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

  it("deletes keys the patch nulls out", () => {
    expect(
      applyQaMergePatch(
        { messages: { groupChat: { mentionPatterns: ["openclaw"], visibleReplies: "automatic" } } },
        { messages: { groupChat: { mentionPatterns: null } } },
      ),
    ).toEqual({ messages: { groupChat: { visibleReplies: "automatic" } } });
  });

  it("ignores prototype-mutating object keys", () => {
    const patch = JSON.parse(
      `{"plugins":{"entries":{}},"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}`,
    ) as Record<string, unknown>;

    expect(applyQaMergePatch({}, patch)).toEqual({ plugins: { entries: {} } });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe("mergeQaMergePatchDocuments", () => {
  it("keeps a deletion the scenario asked for instead of consuming it", () => {
    // Collecting patches merges them into an empty accumulator. Applying the
    // deletion there would drop a key the accumulator never had, so the config
    // the gateway starts with would keep the value the scenario removed.
    const collected = mergeQaMergePatchDocuments(
      {},
      { messages: { groupChat: { mentionPatterns: null } } },
    );

    expect(collected).toEqual({ messages: { groupChat: { mentionPatterns: null } } });
    expect(
      applyQaMergePatch({ messages: { groupChat: { mentionPatterns: ["openclaw"] } } }, collected),
    ).toEqual({ messages: { groupChat: {} } });
  });

  it("lets a later scenario patch override an earlier one in both directions", () => {
    const collected = mergeQaMergePatchDocuments(
      { agents: { entries: { qa: { identity: { name: "C-3PO QA", emoji: "🤖" } } } } },
      { agents: { entries: { qa: { identity: { name: "小蝶🦋", emoji: null } } } } },
    );

    expect(collected).toEqual({
      agents: { entries: { qa: { identity: { name: "小蝶🦋", emoji: null } } } },
    });
  });

  it("composes id-keyed entries two scenarios each own part of", () => {
    // Collecting patches must not let the later document drop fields the
    // earlier one set on the same entry: the application step sees only the
    // collected result and cannot reconstruct what was discarded.
    const collected = mergeQaMergePatchDocuments(
      {
        agents: {
          list: [
            { id: "qa", identity: { name: "小蝶🦋" } },
            { id: "other", tools: {} },
          ],
        },
      },
      { agents: { list: [{ id: "qa", model: { primary: "mock-openai/gpt-5.6-luna" } }] } },
    );

    expect(collected).toEqual({
      agents: {
        list: [
          {
            id: "qa",
            identity: { name: "小蝶🦋" },
            model: { primary: "mock-openai/gpt-5.6-luna" },
          },
          { id: "other", tools: {} },
        ],
      },
    });
  });

  it("keeps a deletion inside an id-keyed entry for the application step", () => {
    const collected = mergeQaMergePatchDocuments(
      { agents: { list: [{ id: "qa", identity: { name: "C-3PO QA", emoji: "🤖" } }] } },
      { agents: { list: [{ id: "qa", identity: { emoji: null } }] } },
    );

    expect(collected).toEqual({
      agents: { list: [{ id: "qa", identity: { name: "C-3PO QA", emoji: null } }] },
    });
    expect(
      applyQaMergePatch({ agents: { list: [{ id: "qa", identity: { emoji: "🤖" } }] } }, collected),
    ).toEqual({ agents: { list: [{ id: "qa", identity: { name: "C-3PO QA" } }] } });
  });

  it("ignores prototype-mutating object keys", () => {
    const patch = JSON.parse(
      `{"messages":{"groupChat":{}},"__proto__":{"polluted":true}}`,
    ) as Record<string, unknown>;

    expect(mergeQaMergePatchDocuments({}, patch)).toEqual({ messages: { groupChat: {} } });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
