import { describe, it, expect } from "vitest";
import { extractToolResultText, tryParseA2UIOperations, groupBySurface } from "./a2ui.js";

// Surface-id extraction is internal to a2ui.ts; exercise it through the public
// `groupBySurface`, whose grouping key is the operation's resolved surfaceId
// (or "default" when none is present).
function surfaceIdOf(op: Record<string, unknown>): string {
  // groupBySurface always yields at least one group (falling back to "default").
  return [...groupBySurface([op]).keys()][0]!;
}

describe("extractToolResultText", () => {
  it("joins text blocks", () => {
    const content = [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ];
    expect(extractToolResultText(content)).toBe("hello\nworld");
  });

  it("ignores non-text blocks", () => {
    const content = [
      { type: "image", data: "..." },
      { type: "text", text: "only text" },
    ];
    expect(extractToolResultText(content)).toBe("only text");
  });

  it("returns empty string for non-array", () => {
    expect(extractToolResultText(null)).toBe("");
    expect(extractToolResultText(undefined)).toBe("");
    expect(extractToolResultText("string")).toBe("");
    expect(extractToolResultText(42)).toBe("");
  });

  it("returns empty string for empty array", () => {
    expect(extractToolResultText([])).toBe("");
  });
});

describe("tryParseA2UIOperations", () => {
  it("parses v0.9 wrapper with a2ui_operations key", () => {
    const json = JSON.stringify({
      a2ui_operations: [
        { version: "v0.9", createSurface: { surfaceId: "s1" } },
        { version: "v0.9", updateComponents: { surfaceId: "s1", components: [] } },
      ],
    });
    const result = tryParseA2UIOperations(json);
    expect(result).toHaveLength(2);
    expect(result![0]).toHaveProperty("version", "v0.9");
  });

  it("returns null for non-A2UI JSON object", () => {
    expect(tryParseA2UIOperations(JSON.stringify({ foo: "bar" }))).toBeNull();
  });

  it("returns null for plain text", () => {
    expect(tryParseA2UIOperations("hello world")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(tryParseA2UIOperations("")).toBeNull();
  });

  it("returns null for JSON array (not wrapper object)", () => {
    expect(tryParseA2UIOperations(JSON.stringify([1, 2, 3]))).toBeNull();
  });

  it("returns null when a2ui_operations is empty array", () => {
    expect(tryParseA2UIOperations(JSON.stringify({ a2ui_operations: [] }))).toBeNull();
  });

  it("returns null when a2ui_operations items lack version/op keys", () => {
    expect(
      tryParseA2UIOperations(JSON.stringify({ a2ui_operations: [{ random: true }] })),
    ).toBeNull();
  });
});

describe("surface-id grouping", () => {
  it("extracts surfaceId from createSurface", () => {
    expect(surfaceIdOf({ version: "v0.9", createSurface: { surfaceId: "my-surface" } })).toBe(
      "my-surface",
    );
  });

  it("extracts surfaceId from updateComponents", () => {
    expect(
      surfaceIdOf({ version: "v0.9", updateComponents: { surfaceId: "s2", components: [] } }),
    ).toBe("s2");
  });

  it("extracts surfaceId from updateDataModel", () => {
    expect(
      surfaceIdOf({ version: "v0.9", updateDataModel: { surfaceId: "s3", path: "/", value: {} } }),
    ).toBe("s3");
  });

  it("extracts surfaceId from deleteSurface", () => {
    expect(surfaceIdOf({ version: "v0.9", deleteSurface: { surfaceId: "s4" } })).toBe("s4");
  });

  it('falls back to "default" when no surfaceId present', () => {
    expect(surfaceIdOf({ version: "v0.9" })).toBe("default");
  });
});

describe("groupBySurface", () => {
  it("groups operations by surfaceId", () => {
    const ops = [
      { version: "v0.9", createSurface: { surfaceId: "a" } },
      { version: "v0.9", createSurface: { surfaceId: "b" } },
      { version: "v0.9", updateComponents: { surfaceId: "a", components: [] } },
    ];
    const groups = groupBySurface(ops);
    expect(groups.size).toBe(2);
    expect(groups.get("a")).toHaveLength(2);
    expect(groups.get("b")).toHaveLength(1);
  });

  it("uses 'default' for operations without surfaceId", () => {
    const ops = [{ version: "v0.9" }];
    const groups = groupBySurface(ops);
    expect(groups.get("default")).toHaveLength(1);
  });
});
