import { mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  countSessionLogMentions,
  readSessionLogMentionLimits,
} from "../../scripts/e2e/lib/session-log-mentions.ts";

const tempRoots: string[] = [];

function makeTempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-session-log-mentions-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("session log mention scanner", () => {
  it("counts mentions across bounded session logs", async () => {
    const root = makeTempRoot();
    await fs.writeFile(path.join(root, "one.jsonl"), "API.read MCP.fixture API.read\n");
    await fs.writeFile(path.join(root, "two.jsonl"), "MCP.fixture\n");
    await fs.writeFile(path.join(root, "ignored.txt"), "API.read\n");

    await expect(
      countSessionLogMentions({
        sessionsDir: root,
        needles: {
          apiFileRead: "API.read",
          mcpNamespace: "MCP.fixture",
        },
      }),
    ).resolves.toEqual({
      apiFileRead: 2,
      mcpNamespace: 2,
    });
  });

  it("does not count user prompt lines as runtime mention proof", async () => {
    const root = makeTempRoot();
    await fs.writeFile(
      path.join(root, "prompts.jsonl"),
      [
        JSON.stringify({
          role: "user",
          content: 'Use API.read("mcp/index.d.ts") and MCP.fixture.lookupNote.',
        }),
        JSON.stringify({
          message: {
            role: "user",
            content: "Call fixture__lookup_note.",
          },
        }),
        JSON.stringify({
          role: "assistant",
          content: "API.read MCP.fixture fixture__lookup_note",
        }),
        "raw transcript fallback API.read",
        "",
      ].join("\n"),
    );

    await expect(
      countSessionLogMentions({
        sessionsDir: root,
        needles: {
          apiFileRead: "API.read",
          mcpNamespace: "MCP.fixture",
          mcpTool: "fixture__lookup_note",
        },
      }),
    ).resolves.toEqual({
      apiFileRead: 2,
      mcpNamespace: 1,
      mcpTool: 1,
    });
  });

  it("returns zero counts when the sessions directory is absent", async () => {
    await expect(
      countSessionLogMentions({
        sessionsDir: path.join(makeTempRoot(), "missing"),
        needles: {
          apiFileRead: "API.read",
        },
      }),
    ).resolves.toEqual({
      apiFileRead: 0,
    });
  });

  it("rejects oversized session log files before loading them", async () => {
    const root = makeTempRoot();
    await fs.writeFile(path.join(root, "huge.jsonl"), "x".repeat(64));

    await expect(
      countSessionLogMentions({
        limits: { fileMaxBytes: 32, totalMaxBytes: 1024 },
        sessionsDir: root,
        needles: {
          apiFileRead: "API.read",
        },
      }),
    ).rejects.toMatchObject({
      code: "ETOOBIG",
      message: expect.stringContaining("per-file limit"),
    });
  });

  it("rejects aggregate session log scans that exceed the total ceiling", async () => {
    const root = makeTempRoot();
    await fs.writeFile(path.join(root, "one.jsonl"), "x".repeat(24));
    await fs.writeFile(path.join(root, "two.jsonl"), "x".repeat(24));

    await expect(
      countSessionLogMentions({
        limits: { fileMaxBytes: 64, totalMaxBytes: 32 },
        sessionsDir: root,
        needles: {
          apiFileRead: "API.read",
        },
      }),
    ).rejects.toMatchObject({
      code: "ETOOBIG",
      message: expect.stringContaining("total limit"),
    });
  });

  it("rejects loose numeric env limits instead of parsing prefixes", () => {
    expect(() =>
      readSessionLogMentionLimits({
        OPENCLAW_SESSION_LOG_MENTION_FILE_MAX_BYTES: "1e3",
      }),
    ).toThrow("invalid OPENCLAW_SESSION_LOG_MENTION_FILE_MAX_BYTES: 1e3");
    expect(() =>
      readSessionLogMentionLimits({
        OPENCLAW_SESSION_LOG_MENTION_TOTAL_MAX_BYTES: "1000ms",
      }),
    ).toThrow("invalid OPENCLAW_SESSION_LOG_MENTION_TOTAL_MAX_BYTES: 1000ms");
  });
});
