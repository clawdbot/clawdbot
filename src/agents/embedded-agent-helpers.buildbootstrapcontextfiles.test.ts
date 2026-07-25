// Covers bootstrap context rendering, truncation, and transcript header setup.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildBootstrapContextFiles,
  ensureSessionHeader,
  resolveBootstrapMaxChars,
  resolveBootstrapPromptTruncationWarningMode,
  resolveBootstrapTotalMaxChars,
} from "./embedded-agent-helpers.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";
import { DEFAULT_AGENTS_FILENAME } from "./workspace.js";

const EXPECTED_DEFAULT_BOOTSTRAP_MAX_CHARS = 20_000;
const EXPECTED_DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS = 60_000;
const EXPECTED_DEFAULT_BOOTSTRAP_PROMPT_TRUNCATION_WARNING_MODE = "always";

const makeFile = (overrides: Partial<WorkspaceBootstrapFile>): WorkspaceBootstrapFile => ({
  name: DEFAULT_AGENTS_FILENAME,
  path: "/tmp/AGENTS.md",
  content: "",
  missing: false,
  ...overrides,
});

const createLargeBootstrapFiles = (): WorkspaceBootstrapFile[] => [
  makeFile({ name: "AGENTS.md", content: "a".repeat(10_000) }),
  makeFile({ name: "SOUL.md", path: "/tmp/SOUL.md", content: "b".repeat(10_000) }),
  makeFile({ name: "USER.md", path: "/tmp/USER.md", content: "c".repeat(10_000) }),
];

describe("ensureSessionHeader", () => {
  it("creates transcript files with restrictive permissions", async () => {
    // Session transcripts can contain private prompts and tool outputs, so both
    // the directory and file need restrictive permissions from creation.
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-header-"));
    try {
      const sessionFile = path.join(tempDir, "nested", "session.jsonl");
      await ensureSessionHeader({ sessionFile, sessionId: "session-1", cwd: tempDir });

      expect((await fs.stat(path.dirname(sessionFile))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(sessionFile)).mode & 0o777).toBe(0o600);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("buildBootstrapContextFiles", () => {
  it("keeps missing markers", () => {
    const files = [makeFile({ missing: true, content: undefined })];
    expect(buildBootstrapContextFiles(files)).toEqual([
      {
        path: "/tmp/AGENTS.md",
        content: "[MISSING] Expected at: /tmp/AGENTS.md",
      },
    ]);
  });
  it("skips empty or whitespace-only content", () => {
    const files = [makeFile({ content: "   \n  " })];
    expect(buildBootstrapContextFiles(files)).toStrictEqual([]);
  });
  it("truncates large bootstrap content", () => {
    const head = `HEAD-${"a".repeat(600)}`;
    const tail = `${"b".repeat(300)}-TAIL`;
    const long = `${head}${tail}`;
    const files = [makeFile({ name: "TOOLS.md", content: long })];
    const warnings: string[] = [];
    const maxChars = 200;
    const [result] = buildBootstrapContextFiles(files, {
      maxChars,
      warn: (message) => warnings.push(message),
    });
    const kept = result?.content.match(/kept (\d+)\+(\d+) chars/);
    expect(kept?.slice(0, 3)).toStrictEqual(["kept 74+24 chars", "74", "24"]);
    const headChars = Number(kept?.[1]);
    const tailChars = Number(kept?.[2]);
    expect(result?.content).toContain("[...truncated, read TOOLS.md for full content...]");
    expect(result?.content.length).toBe(199);
    expect(result?.content.length).toBeLessThan(long.length);
    expect(result?.content.length).toBeLessThanOrEqual(maxChars);
    expect(result?.content.startsWith(long.slice(0, headChars))).toBe(true);
    if (tailChars > 0) {
      expect(result?.content.endsWith(long.slice(-tailChars))).toBe(true);
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("TOOLS.md");
    expect(warnings[0]).toContain("limit 200");
  });
  it("keeps generic and AGENTS.md truncation valid at UTF-16 boundaries", () => {
    const cases = [
      {
        file: makeFile({
          name: "TOOLS.md",
          path: "/tmp/TOOLS.md",
          content: `${"h".repeat(73)}😀${"m".repeat(200)}😀${"t".repeat(23)}`,
        }),
        maxChars: 200,
        expectedHead: "h".repeat(73),
        expectedTail: "t".repeat(23),
      },
      {
        file: makeFile({
          content: `${"a".repeat(269)}😀${"b".repeat(638)}😀${"c".repeat(89)}`,
        }),
        maxChars: 600,
        expectedHead: "a".repeat(269),
        expectedTail: "c".repeat(89),
      },
    ];

    for (const testCase of cases) {
      const [result] = buildBootstrapContextFiles([testCase.file], {
        maxChars: testCase.maxChars,
      });

      expect(result?.content.startsWith(testCase.expectedHead)).toBe(true);
      expect(result?.content.endsWith(testCase.expectedTail)).toBe(true);
      expect(result?.content).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
      );
    }
  });
  it("fits the rendered truncation marker inside the per-file budget", () => {
    const maxChars = EXPECTED_DEFAULT_BOOTSTRAP_MAX_CHARS;
    const files = [
      makeFile({
        name: "USER.md",
        path: "/tmp/USER.md",
        content: "a".repeat(maxChars * 2),
      }),
    ];
    const [result] = buildBootstrapContextFiles(files, { maxChars });
    expect(result?.content).toContain("[...truncated, read USER.md for full content...]");
    expect(result?.content.length).toBeLessThanOrEqual(maxChars);
  });
  it("keeps policy digest lines from oversized AGENTS.md middle content", () => {
    // AGENTS.md truncation keeps scoped-policy signals from the middle so model
    // prompts do not lose routing instructions just because head/tail are large.
    const requiredScopedInstruction =
      "- Required scoped instruction: read scoped AGENTS.md before editing subtree work.";
    const content = [
      "# Root policy",
      "A".repeat(900),
      "## Scoped policy",
      requiredScopedInstruction,
      "B".repeat(700),
      "tail marker",
    ].join("\n");
    const [result] = buildBootstrapContextFiles([makeFile({ content })], {
      maxChars: 600,
    });

    expect(result?.content.length).toBeLessThanOrEqual(600);
    expect(result?.content).toContain("[Policy digest from AGENTS.md]");
    expect(result?.content).toContain(requiredScopedInstruction);
    expect(result?.content).toContain("[...truncated, read AGENTS.md for full content...]");
  });
  it("keeps bootstrap bytes in tiny per-file budgets when the marker is longer than the limit", () => {
    const maxChars = 64;
    const content = `HEAD-${"a".repeat(1_000)}-TAIL`;
    const files = [
      makeFile({
        name: "USER.md",
        path: "/tmp/USER.md",
        content,
      }),
    ];
    const [result] = buildBootstrapContextFiles(files, { maxChars });
    expect(result?.content.startsWith("HEAD-")).toBe(true);
    expect(result?.content.endsWith("-TAIL")).toBe(true);
    expect(result?.content).toContain("truncated");
    expect(result?.content.length).toBeLessThanOrEqual(maxChars);
  });
  it("keeps at least one bootstrap byte when only the compact marker fits", () => {
    const maxChars = 22;
    const content = `HEAD-${"a".repeat(1_000)}-TAIL`;
    const files = [
      makeFile({
        name: "USER.md",
        path: "/tmp/USER.md",
        content,
      }),
    ];
    const [result] = buildBootstrapContextFiles(files, { maxChars });
    expect(result?.content).toContain("truncated");
    expect(result?.content.length).toBeLessThanOrEqual(maxChars);
    expect(result?.content).toContain("H");
  });
  it("keeps content under the default limit", () => {
    const long = "a".repeat(EXPECTED_DEFAULT_BOOTSTRAP_MAX_CHARS - 10);
    const files = [makeFile({ content: long })];
    const [result] = buildBootstrapContextFiles(files);
    expect(result?.content).toBe(long);
    expect(result?.content).not.toContain("[...truncated, read AGENTS.md for full content...]");
  });

  it("keeps total injected bootstrap characters under the new default total cap", () => {
    // Total caps bound prompt growth across multiple bootstrap files, not only
    // per-file truncation.
    const files = createLargeBootstrapFiles();
    const result = buildBootstrapContextFiles(files);
    const totalChars = result.reduce((sum, entry) => sum + entry.content.length, 0);
    expect(totalChars).toBeLessThanOrEqual(EXPECTED_DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS);
    expect(result).toHaveLength(3);
    expect(result[2]?.content).toBe("c".repeat(10_000));
  });

  it("caps total injected bootstrap characters when totalMaxChars is configured", () => {
    const files = createLargeBootstrapFiles();
    const result = buildBootstrapContextFiles(files, { totalMaxChars: 24_000 });
    const totalChars = result.reduce((sum, entry) => sum + entry.content.length, 0);
    expect(totalChars).toBeLessThanOrEqual(24_000);
    expect(result).toHaveLength(3);
    expect(result[2]?.content).toContain("[...truncated, read USER.md for full content...]");
  });

  it("enforces strict total cap even when truncation markers are present", () => {
    const files = [
      makeFile({ name: "AGENTS.md", content: "a".repeat(1_000) }),
      makeFile({ name: "SOUL.md", path: "/tmp/SOUL.md", content: "b".repeat(1_000) }),
    ];
    const result = buildBootstrapContextFiles(files, {
      maxChars: 100,
      totalMaxChars: 150,
    });
    const totalChars = result.reduce((sum, entry) => sum + entry.content.length, 0);
    expect(totalChars).toBeLessThanOrEqual(150);
  });

  it("skips bootstrap injection when remaining total budget is too small", () => {
    // Tiny remaining budgets are worse than useless for full files; skip them
    // instead of adding misleading partial context.
    const files = [makeFile({ name: "AGENTS.md", content: "a".repeat(1_000) })];
    const result = buildBootstrapContextFiles(files, {
      maxChars: 200,
      totalMaxChars: 40,
    });
    expect(result).toStrictEqual([]);
  });

  it("keeps missing markers under small total budgets", () => {
    const files = [makeFile({ missing: true, content: undefined })];
    const result = buildBootstrapContextFiles(files, {
      totalMaxChars: 20,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.content.length).toBeLessThanOrEqual(20);
    expect(result[0]?.content.startsWith("[MISSING]")).toBe(true);
  });

  it("skips files with missing or invalid paths and emits warnings", () => {
    const malformedMissingPath = {
      name: "SKILL-SECURITY.md",
      missing: false,
      content: "secret",
    } as unknown as WorkspaceBootstrapFile;
    const malformedNonStringPath = {
      name: "SKILL-SECURITY.md",
      path: 123,
      missing: false,
      content: "secret",
    } as unknown as WorkspaceBootstrapFile;
    const malformedWhitespacePath = {
      name: "SKILL-SECURITY.md",
      path: "   ",
      missing: false,
      content: "secret",
    } as unknown as WorkspaceBootstrapFile;
    const good = makeFile({ content: "hello" });
    const warnings: string[] = [];
    const result = buildBootstrapContextFiles(
      [malformedMissingPath, malformedNonStringPath, malformedWhitespacePath, good],
      {
        warn: (msg) => warnings.push(msg),
      },
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe("/tmp/AGENTS.md");
    expect(warnings).toHaveLength(3);
    expect(
      warnings.filter((warning) => !warning.includes('missing or invalid "path" field')),
    ).toStrictEqual([]);
  });

  it("handles undefined file names without crashing", () => {
    const fileWithUndefinedName = {
      name: undefined,
      path: "/tmp/test.md",
      content: "content",
      missing: false,
    } as unknown as WorkspaceBootstrapFile;
    const warnings: string[] = [];
    const result = buildBootstrapContextFiles([fileWithUndefinedName], {
      warn: (msg) => warnings.push(msg),
    });
    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
  });
});

type BootstrapLimitResolverCase = {
  name: "bootstrapMaxChars" | "bootstrapTotalMaxChars";
  resolve: (cfg?: OpenClawConfig, agentId?: string | null) => number;
  defaultValue: number;
};

const BOOTSTRAP_LIMIT_RESOLVERS: BootstrapLimitResolverCase[] = [
  {
    name: "bootstrapMaxChars",
    resolve: resolveBootstrapMaxChars,
    defaultValue: EXPECTED_DEFAULT_BOOTSTRAP_MAX_CHARS,
  },
  {
    name: "bootstrapTotalMaxChars",
    resolve: resolveBootstrapTotalMaxChars,
    defaultValue: EXPECTED_DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS,
  },
];

describe("bootstrap limit resolvers", () => {
  it("return defaults when unset", () => {
    for (const resolver of BOOTSTRAP_LIMIT_RESOLVERS) {
      expect(resolver.resolve()).toBe(resolver.defaultValue);
    }
  });

  it("use configured values when valid", () => {
    for (const resolver of BOOTSTRAP_LIMIT_RESOLVERS) {
      const cfg = {
        agents: { defaults: { [resolver.name]: 12345 } },
      } as OpenClawConfig;
      expect(resolver.resolve(cfg)).toBe(12345);
    }
  });

  it("uses per-agent values before defaults", () => {
    for (const resolver of BOOTSTRAP_LIMIT_RESOLVERS) {
      const cfg = {
        agents: {
          defaults: { [resolver.name]: 12345 },
          list: [{ id: "worker", [resolver.name]: 6789 }],
        },
      } as OpenClawConfig;
      expect(resolver.resolve(cfg, "worker")).toBe(6789);
    }
  });

  it("falls back to defaults when the agent has no override", () => {
    for (const resolver of BOOTSTRAP_LIMIT_RESOLVERS) {
      const cfg = {
        agents: {
          defaults: { [resolver.name]: 12345 },
          list: [{ id: "worker" }],
        },
      } as OpenClawConfig;
      expect(resolver.resolve(cfg, "worker")).toBe(12345);
    }
  });

  it("fall back when values are invalid", () => {
    for (const resolver of BOOTSTRAP_LIMIT_RESOLVERS) {
      const cfg = {
        agents: { defaults: { [resolver.name]: -1 } },
      } as OpenClawConfig;
      expect(resolver.resolve(cfg)).toBe(resolver.defaultValue);
    }
  });
});

describe("resolveBootstrapPromptTruncationWarningMode", () => {
  it("defaults to always", () => {
    expect(resolveBootstrapPromptTruncationWarningMode()).toBe("always");
    expect(EXPECTED_DEFAULT_BOOTSTRAP_PROMPT_TRUNCATION_WARNING_MODE).toBe("always");
  });

  it("ignores retired explicit modes", () => {
    expect(
      resolveBootstrapPromptTruncationWarningMode({
        agents: { defaults: { bootstrapPromptTruncationWarning: "off" } },
      } as OpenClawConfig),
    ).toBe("always");
    expect(
      resolveBootstrapPromptTruncationWarningMode({
        agents: { defaults: { bootstrapPromptTruncationWarning: "once" } },
      } as OpenClawConfig),
    ).toBe("always");
    expect(
      resolveBootstrapPromptTruncationWarningMode({
        agents: { defaults: { bootstrapPromptTruncationWarning: "always" } },
      } as OpenClawConfig),
    ).toBe("always");
  });

  it("falls back to default for invalid values", () => {
    expect(
      resolveBootstrapPromptTruncationWarningMode({
        agents: { defaults: { bootstrapPromptTruncationWarning: "invalid" } },
      } as unknown as OpenClawConfig),
    ).toBe(EXPECTED_DEFAULT_BOOTSTRAP_PROMPT_TRUNCATION_WARNING_MODE);
  });
});
