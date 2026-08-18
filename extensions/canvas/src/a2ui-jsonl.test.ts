import { describe, expect, it } from "vitest";
import {
  buildA2UITextJsonl,
  validateNativeA2UIJsonl,
  validateSupportedA2UIJsonl,
} from "./a2ui-jsonl.js";

const BASIC_CATALOG = "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json";

describe("Canvas A2UI JSONL validation", () => {
  it("keeps unversioned v0.8 messages accepted", () => {
    expect(validateSupportedA2UIJsonl(buildA2UITextJsonl("hello"))).toMatchObject({
      version: "v0.8",
      messageCount: 2,
    });
  });

  it("accepts the v0.9 create, component, data, and delete message set", () => {
    const messages = [
      {
        version: "v0.9",
        createSurface: { surfaceId: "main", catalogId: BASIC_CATALOG },
      },
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "main",
          components: [{ id: "root", component: "Text", text: "hello" }],
        },
      },
      {
        version: "v0.9",
        updateDataModel: { surfaceId: "main", path: "/status", value: "ready" },
      },
      { version: "v0.9", deleteSurface: { surfaceId: "main" } },
    ];
    const jsonl = messages.map((message) => JSON.stringify(message)).join("\n");

    expect(validateSupportedA2UIJsonl(jsonl)).toMatchObject({
      version: "v0.9",
      messageCount: 4,
      messages,
    });
  });

  it("keeps native Canvas pushes on v0.8", () => {
    expect(validateNativeA2UIJsonl(buildA2UITextJsonl("hello"))).toMatchObject({
      version: "v0.8",
    });
    expect(() =>
      validateNativeA2UIJsonl(
        JSON.stringify({
          version: "v0.9",
          createSurface: { surfaceId: "main", catalogId: BASIC_CATALOG },
        }),
      ),
    ).toThrow("OpenClaw currently supports v0.8 only for native Canvas pushes");
  });

  it.each([
    ["empty input", " \n ", "no JSONL messages"],
    ["invalid JSON", "{", "line 1"],
    [
      "versioned v0.8 operation",
      JSON.stringify({ version: "v0.9", surfaceUpdate: { surfaceId: "main", components: [] } }),
      "v0.9 action key",
    ],
    [
      "unversioned v0.9 operation",
      JSON.stringify({ createSurface: { surfaceId: "main", catalogId: BASIC_CATALOG } }),
      "v0.8 action key",
    ],
    [
      "malformed createSurface",
      JSON.stringify({ version: "v0.9", createSurface: { surfaceId: "main" } }),
      "Invalid input",
    ],
    [
      "mixed versions",
      [
        JSON.stringify({ deleteSurface: { surfaceId: "legacy" } }),
        JSON.stringify({ version: "v0.9", deleteSurface: { surfaceId: "modern" } }),
      ].join("\n"),
      "mixed A2UI",
    ],
  ])("rejects $0", (_name, jsonl, expected) => {
    expect(() => validateSupportedA2UIJsonl(jsonl)).toThrow(expected);
  });
});
