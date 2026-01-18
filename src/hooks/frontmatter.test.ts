import { describe, expect, it } from "vitest";
import { parseFrontmatter, resolveClawdbotMetadata } from "./frontmatter.js";

describe("parseFrontmatter", () => {
  it("parses single-line key-value pairs", () => {
    const content = `---
name: test-hook
description: "A test hook"
homepage: https://example.com
---

# Test Hook
`;
    const result = parseFrontmatter(content);
    expect(result.name).toBe("test-hook");
    expect(result.description).toBe("A test hook");
    expect(result.homepage).toBe("https://example.com");
  });

  it("handles missing frontmatter", () => {
    const content = "# Just a markdown file";
    const result = parseFrontmatter(content);
    expect(result).toEqual({});
  });

  it("handles unclosed frontmatter", () => {
    const content = `---
name: broken
`;
    const result = parseFrontmatter(content);
    expect(result).toEqual({});
  });

  it("parses multi-line metadata block with indented JSON", () => {
    const content = `---
name: session-memory
description: "Save session context"
metadata:
  {
    "clawdbot": {
      "emoji": "💾",
      "events": ["command:new"]
    }
  }
---

# Session Memory Hook
`;
    const result = parseFrontmatter(content);
    expect(result.name).toBe("session-memory");
    expect(result.description).toBe("Save session context");
    expect(result.metadata).toBeDefined();
    expect(typeof result.metadata).toBe("string");

    // Verify the metadata is valid JSON
    const parsed = JSON.parse(result.metadata as string);
    expect(parsed.clawdbot.emoji).toBe("💾");
    expect(parsed.clawdbot.events).toEqual(["command:new"]);
  });

  it("parses multi-line metadata with complex nested structure", () => {
    const content = `---
name: command-logger
description: "Log all command events"
metadata:
  {
    "clawdbot":
      {
        "emoji": "📝",
        "events": ["command"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled" }]
      }
  }
---
`;
    const result = parseFrontmatter(content);
    expect(result.name).toBe("command-logger");
    expect(result.metadata).toBeDefined();

    const parsed = JSON.parse(result.metadata as string);
    expect(parsed.clawdbot.emoji).toBe("📝");
    expect(parsed.clawdbot.events).toEqual(["command"]);
    expect(parsed.clawdbot.requires.config).toEqual(["workspace.dir"]);
    expect(parsed.clawdbot.install[0].kind).toBe("bundled");
  });

  it("handles single-line metadata (inline JSON)", () => {
    const content = `---
name: simple-hook
metadata: {"clawdbot": {"events": ["test"]}}
---
`;
    const result = parseFrontmatter(content);
    expect(result.name).toBe("simple-hook");
    expect(result.metadata).toBe('{"clawdbot": {"events": ["test"]}}');
  });

  it("handles mixed single-line and multi-line values", () => {
    const content = `---
name: mixed-hook
description: "A hook with mixed values"
homepage: https://example.com
metadata:
  {
    "clawdbot": {
      "events": ["command:new"]
    }
  }
enabled: true
---
`;
    const result = parseFrontmatter(content);
    expect(result.name).toBe("mixed-hook");
    expect(result.description).toBe("A hook with mixed values");
    expect(result.homepage).toBe("https://example.com");
    expect(result.metadata).toBeDefined();
    expect(result.enabled).toBe("true");
  });

  it("strips surrounding quotes from values", () => {
    const content = `---
name: "quoted-name"
description: 'single-quoted'
---
`;
    const result = parseFrontmatter(content);
    expect(result.name).toBe("quoted-name");
    expect(result.description).toBe("single-quoted");
  });

  it("handles CRLF line endings", () => {
    const content = "---\r\nname: test\r\ndescription: crlf\r\n---\r\n";
    const result = parseFrontmatter(content);
    expect(result.name).toBe("test");
    expect(result.description).toBe("crlf");
  });

  it("handles CR line endings", () => {
    const content = "---\rname: test\rdescription: cr\r---\r";
    const result = parseFrontmatter(content);
    expect(result.name).toBe("test");
    expect(result.description).toBe("cr");
  });
});

describe("resolveClawdbotMetadata", () => {
  it("extracts clawdbot metadata from parsed frontmatter", () => {
    const frontmatter = {
      name: "test-hook",
      metadata: JSON.stringify({
        clawdbot: {
          emoji: "🔥",
          events: ["command:new", "command:reset"],
          requires: {
            config: ["workspace.dir"],
            bins: ["git"],
          },
        },
      }),
    };

    const result = resolveClawdbotMetadata(frontmatter);
    expect(result).toBeDefined();
    expect(result?.emoji).toBe("🔥");
    expect(result?.events).toEqual(["command:new", "command:reset"]);
    expect(result?.requires?.config).toEqual(["workspace.dir"]);
    expect(result?.requires?.bins).toEqual(["git"]);
  });

  it("returns undefined when metadata is missing", () => {
    const frontmatter = { name: "no-metadata" };
    const result = resolveClawdbotMetadata(frontmatter);
    expect(result).toBeUndefined();
  });

  it("returns undefined when clawdbot key is missing", () => {
    const frontmatter = {
      metadata: JSON.stringify({ other: "data" }),
    };
    const result = resolveClawdbotMetadata(frontmatter);
    expect(result).toBeUndefined();
  });

  it("returns undefined for invalid JSON", () => {
    const frontmatter = {
      metadata: "not valid json {",
    };
    const result = resolveClawdbotMetadata(frontmatter);
    expect(result).toBeUndefined();
  });

  it("handles install specs", () => {
    const frontmatter = {
      metadata: JSON.stringify({
        clawdbot: {
          events: ["command"],
          install: [
            { id: "bundled", kind: "bundled", label: "Bundled with Clawdbot" },
            { id: "npm", kind: "npm", package: "@clawdbot/hook" },
          ],
        },
      }),
    };

    const result = resolveClawdbotMetadata(frontmatter);
    expect(result?.install).toHaveLength(2);
    expect(result?.install?.[0].kind).toBe("bundled");
    expect(result?.install?.[1].kind).toBe("npm");
    expect(result?.install?.[1].package).toBe("@clawdbot/hook");
  });

  it("handles os restrictions", () => {
    const frontmatter = {
      metadata: JSON.stringify({
        clawdbot: {
          events: ["command"],
          os: ["darwin", "linux"],
        },
      }),
    };

    const result = resolveClawdbotMetadata(frontmatter);
    expect(result?.os).toEqual(["darwin", "linux"]);
  });

  it("parses real session-memory HOOK.md format", () => {
    // This is the actual format used in the bundled hooks
    const content = `---
name: session-memory
description: "Save session context to memory when /new command is issued"
homepage: https://docs.clawd.bot/hooks#session-memory
metadata:
  {
    "clawdbot":
      {
        "emoji": "💾",
        "events": ["command:new"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with Clawdbot" }],
      },
  }
---

# Session Memory Hook
`;

    const frontmatter = parseFrontmatter(content);
    expect(frontmatter.name).toBe("session-memory");
    expect(frontmatter.metadata).toBeDefined();

    const clawdbot = resolveClawdbotMetadata(frontmatter);
    expect(clawdbot).toBeDefined();
    expect(clawdbot?.emoji).toBe("💾");
    expect(clawdbot?.events).toEqual(["command:new"]);
    expect(clawdbot?.requires?.config).toEqual(["workspace.dir"]);
    expect(clawdbot?.install?.[0].kind).toBe("bundled");
  });

  it("parses YAML metadata map", () => {
    const content = `---
name: yaml-metadata
metadata:
  clawdbot:
    emoji: disk
    events:
      - command:new
---
`;
    const frontmatter = parseFrontmatter(content);
    const clawdbot = resolveClawdbotMetadata(frontmatter);
    expect(clawdbot?.emoji).toBe("disk");
    expect(clawdbot?.events).toEqual(["command:new"]);
  });
});
