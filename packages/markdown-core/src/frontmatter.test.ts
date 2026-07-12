// Markdown Core tests cover frontmatter behavior.
import { expectDefined } from "@openclaw/normalization-core";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { parseFrontmatterBlock, stripFrontmatterBlock } from "./frontmatter.js";

describe("parseFrontmatterBlock", () => {
  it("parses YAML block scalars", () => {
    const content = `---
name: yaml-hook
description: |
  line one
  line two
---
`;
    const result = parseFrontmatterBlock(content);
    expect(result.name).toBe("yaml-hook");
    expect(result.description).toBe("line one\nline two");
  });

  it("handles JSON5-style multi-line metadata", () => {
    const content = `---
name: session-memory
metadata:
  {
    "openclaw":
      {
        "emoji": "disk",
        "events": ["command:new"],
      },
  }
---
`;
    const result = parseFrontmatterBlock(content);
    expect(result.metadata).toBe('{"openclaw":{"emoji":"disk","events":["command:new"]}}');

    const parsed = JSON5.parse(expectDefined(result.metadata, "result.metadata test invariant"));
    expect(parsed.openclaw?.emoji).toBe("disk");
  });

  it("preserves inline JSON values", () => {
    const content = `---
name: inline-json
metadata: {"openclaw": {"events": ["test"]}}
---
`;
    const result = parseFrontmatterBlock(content);
    expect(result.metadata).toBe('{"openclaw": {"events": ["test"]}}');
  });

  it("stringifies YAML objects and arrays", () => {
    const content = `---
name: yaml-objects
enabled: true
retries: 3
tags:
  - alpha
  - beta
metadata:
  openclaw:
    events:
      - command:new
---
`;
    const result = parseFrontmatterBlock(content);
    expect(result.enabled).toBe("true");
    expect(result.retries).toBe("3");
    expect(JSON.parse(result.tags ?? "[]")).toEqual(["alpha", "beta"]);
    const parsed = JSON5.parse(result.metadata ?? "");
    expect(parsed.openclaw?.events).toEqual(["command:new"]);
  });

  it("preserves inline description values containing colons", () => {
    const content = `---
name: sample-skill
description: Use anime style IMPORTANT: Must be kawaii
---`;
    const result = parseFrontmatterBlock(content);
    expect(result.description).toBe("Use anime style IMPORTANT: Must be kawaii");
  });

  it("does not replace YAML block scalars with block indicators", () => {
    const content = `---
name: sample-skill
description: |-
  {json-like text}
---`;
    const result = parseFrontmatterBlock(content);
    expect(result.description).toBe("{json-like text}");
  });

  it("keeps nested YAML mappings as structured JSON", () => {
    const content = `---
name: sample-skill
metadata:
  openclaw: true
---`;
    const result = parseFrontmatterBlock(content);
    expect(result.metadata).toBe('{"openclaw":true}');
  });

  it("returns empty when frontmatter is missing", () => {
    const content = "# No frontmatter";
    expect(parseFrontmatterBlock(content)).toStrictEqual({});
  });

  it("ignores non-delimiter opening prefixes", () => {
    for (const prefix of ["---not", "----", "--- name"]) {
      const content = `${prefix}
name: nope
---
Body text`;
      expect(parseFrontmatterBlock(content)).toStrictEqual({});
    }
  });

  it("ignores non-delimiter closing prefixes", () => {
    const content = `---
name: nope
---not
Body text`;
    expect(parseFrontmatterBlock(content)).toStrictEqual({});
  });

  it("accepts delimiter lines with trailing whitespace", () => {
    const content = ["---   ", "name: sample", "---\t", "Body text"].join("\n");
    expect(parseFrontmatterBlock(content)).toStrictEqual({ name: "sample" });
    expect(stripFrontmatterBlock(content)).toBe("Body text");
  });

  it("preserves prototype-named keys when YAML value is null", () => {
    const content = `---
title: Hello
toString: null
constructor: null
valueOf: null
hasOwnProperty: null
---
Body text`;
    const result = parseFrontmatterBlock(content);
    expect(Object.hasOwn(result, "toString")).toBe(true);
    expect(result["toString"]).toBe("null");
    expect(Object.hasOwn(result, "constructor")).toBe(true);
    expect(result["constructor"]).toBe("null");
    expect(Object.hasOwn(result, "valueOf")).toBe(true);
    expect(result["valueOf"]).toBe("null");
    expect(Object.hasOwn(result, "hasOwnProperty")).toBe(true);
    expect(result["hasOwnProperty"]).toBe("null");
    // normal key unaffected
    expect(result.title).toBe("Hello");
  });

  it("parses frontmatter after a leading UTF-8 BOM", () => {
    const content = "\uFEFF---\nname: windows-skill\ndescription: Written by PowerShell\n---\n";
    const result = parseFrontmatterBlock(content);

    expect(result.name).toBe("windows-skill");
    expect(result.description).toBe("Written by PowerShell");
  });
});

describe("stripFrontmatterBlock", () => {
  it("removes a valid frontmatter block", () => {
    const content = `---
name: sample
---
Body text`;
    expect(stripFrontmatterBlock(content)).toBe("Body text");
  });

  it("preserves Markdown that starts with a non-delimiter prefix", () => {
    const content = `---not
name: nope
---not
Body text`;
    expect(stripFrontmatterBlock(content)).toBe(content);
  });
});
