import JSON5 from "json5";
import { describe, expect, it } from "vitest";

import { parseFrontmatterBlock } from "./frontmatter.js";

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
    "clawdbot":
      {
        "emoji": "disk",
        "events": ["command:new"],
      },
  }
---
`;
    const result = parseFrontmatterBlock(content);
    expect(result.metadata).toBeDefined();

    const parsed = JSON5.parse(result.metadata ?? "") as { clawdbot?: { emoji?: string } };
    expect(parsed.clawdbot?.emoji).toBe("disk");
  });

  it("preserves inline JSON values", () => {
    const content = `---
name: inline-json
metadata: {"clawdbot": {"events": ["test"]}}
---
`;
    const result = parseFrontmatterBlock(content);
    expect(result.metadata).toBe('{"clawdbot": {"events": ["test"]}}');
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
  clawdbot:
    events:
      - command:new
---
`;
    const result = parseFrontmatterBlock(content);
    expect(result.enabled).toBe("true");
    expect(result.retries).toBe("3");
    expect(JSON.parse(result.tags ?? "[]")).toEqual(["alpha", "beta"]);
    const parsed = JSON5.parse(result.metadata ?? "") as { clawdbot?: { events?: string[] } };
    expect(parsed.clawdbot?.events).toEqual(["command:new"]);
  });

  it("returns empty when frontmatter is missing", () => {
    const content = "# No frontmatter";
    expect(parseFrontmatterBlock(content)).toEqual({});
  });
});
