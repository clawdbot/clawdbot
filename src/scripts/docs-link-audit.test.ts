import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";

const {
  normalizeRoute,
  prepareAnchorAuditDocsDir,
  resolveRoute,
  runDocsLinkAuditCli,
  sanitizeDocsConfigForEnglishOnly,
} = (await import("../../scripts/docs-link-audit.mjs")) as unknown as {
  normalizeRoute: (route: string) => string;
  prepareAnchorAuditDocsDir: (sourceDir?: string) => string;
  resolveRoute: (
    route: string,
    options?: { redirects?: Map<string, string>; routes?: Set<string> },
  ) => { ok: boolean; terminal: string; loop?: boolean };
  runDocsLinkAuditCli: (options?: {
    args?: string[];
    nodeVersion?: string;
    spawnSyncImpl?: (
      command: string,
      args: string[],
      options: { cwd: string; stdio: string },
    ) => { status: number | null; error?: { code?: string } };
    prepareAnchorAuditDocsDirImpl?: (sourceDir?: string) => string;
    cleanupAnchorAuditDocsDirImpl?: (dir: string) => void;
  }) => number;
  sanitizeDocsConfigForEnglishOnly: (value: unknown) => unknown;
};

describe("docs-link-audit", () => {
  it("normalizes route fragments away", () => {
    expect(normalizeRoute("/plugins/building-plugins#registering-agent-tools")).toBe(
      "/plugins/building-plugins",
    );
    expect(normalizeRoute("/plugins/building-plugins?tab=all")).toBe("/plugins/building-plugins");
  });

  it("resolves redirects that land on anchored sections", () => {
    const redirects = new Map([
      ["/plugins/agent-tools", "/plugins/building-plugins#registering-agent-tools"],
    ]);
    const routes = new Set(["/plugins/building-plugins"]);

    expect(resolveRoute("/plugins/agent-tools", { redirects, routes })).toEqual({
      ok: true,
      terminal: "/plugins/building-plugins",
    });
  });

  it("sanitizes docs.json to English-only route targets", () => {
    expect(
      sanitizeDocsConfigForEnglishOnly({
        navigation: [
          {
            language: "en",
            tabs: [
              {
                tab: "Docs",
                groups: [
                  {
                    group: "Keep",
                    pages: ["help/testing", "zh-CN/help/testing", "ja-JP/help/testing"],
                  },
                ],
              },
            ],
          },
          {
            language: "zh-Hans",
            tabs: [{ tab: "中文", groups: [{ group: "帮助", pages: ["zh-CN/help/testing"] }] }],
          },
        ],
        redirects: [
          { source: "/help/testing", destination: "/help/testing" },
          { source: "/zh-CN/help/testing", destination: "/help/testing" },
          { source: "/help/testing", destination: "/ja-JP/help/testing" },
        ],
      }),
    ).toEqual({
      navigation: [
        {
          language: "en",
          tabs: [
            {
              tab: "Docs",
              groups: [{ group: "Keep", pages: ["help/testing"] }],
            },
          ],
        },
      ],
      redirects: [{ source: "/help/testing", destination: "/help/testing" }],
    });
  });

  it("builds an English-only docs tree for anchor audits", () => {
    const tempDirs: string[] = [];
    const fixtureRoot = makeTempDir(tempDirs, "docs-link-audit-fixture-");
    const docsRoot = path.join(fixtureRoot, "docs");
    fs.mkdirSync(path.join(docsRoot, "help"), { recursive: true });
    fs.mkdirSync(path.join(docsRoot, "zh-CN", "help"), { recursive: true });
    fs.writeFileSync(
      path.join(docsRoot, "docs.json"),
      `${JSON.stringify(
        {
          navigation: [
            {
              language: "en",
              tabs: [{ tab: "Docs", groups: [{ group: "Help", pages: ["help/testing"] }] }],
            },
            {
              language: "zh-Hans",
              tabs: [{ tab: "中文", groups: [{ group: "帮助", pages: ["zh-CN/help/testing"] }] }],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    fs.writeFileSync(path.join(docsRoot, "help", "testing.md"), "# testing\n", "utf8");
    fs.writeFileSync(path.join(docsRoot, "zh-CN", "help", "testing.md"), "# 测试\n", "utf8");

    const anchorDocsDir = prepareAnchorAuditDocsDir(docsRoot);
    try {
      expect(fs.existsSync(path.join(anchorDocsDir, "help", "testing.md"))).toBe(true);
      expect(fs.existsSync(path.join(anchorDocsDir, "zh-CN"))).toBe(false);

      const sanitizedDocsJson = JSON.parse(
        fs.readFileSync(path.join(anchorDocsDir, "docs.json"), "utf8"),
      );
      expect(sanitizedDocsJson).toEqual({
        navigation: [
          {
            language: "en",
            tabs: [{ tab: "Docs", groups: [{ group: "Help", pages: ["help/testing"] }] }],
          },
        ],
      });
    } finally {
      fs.rmSync(anchorDocsDir, { recursive: true, force: true });
      cleanupTempDirs(tempDirs);
    }
  });

  it("uses Mintlify through pnpm dlx for anchor validation", () => {
    let invocation:
      | {
          command: string;
          args: string[];
          options: { cwd: string; stdio: string };
        }
      | undefined;
    let cleanedDir: string | undefined;
    const anchorDocsDir = path.join(os.tmpdir(), "docs-link-audit-anchor");

    const exitCode = runDocsLinkAuditCli({
      args: ["--anchors"],
      nodeVersion: "22.21.1",
      prepareAnchorAuditDocsDirImpl() {
        return anchorDocsDir;
      },
      cleanupAnchorAuditDocsDirImpl(dir) {
        cleanedDir = dir;
      },
      spawnSyncImpl(command, args, options) {
        invocation = { command, args, options };
        return { status: 0 };
      },
    });

    expect(exitCode).toBe(0);
    expect(invocation).toEqual({
      command: "pnpm",
      args: ["dlx", "mint", "broken-links", "--check-anchors"],
      options: {
        cwd: anchorDocsDir,
        stdio: "inherit",
      },
    });
    expect(cleanedDir).toBe(anchorDocsDir);
  });

  it("wraps Mintlify with Node 22 when the current Node is too new", () => {
    const invocations: Array<{
      command: string;
      args: string[];
      options: { cwd: string; stdio: string };
    }> = [];
    let cleanedDir: string | undefined;
    const anchorDocsDir = path.join(os.tmpdir(), "docs-link-audit-anchor");

    const exitCode = runDocsLinkAuditCli({
      args: ["--anchors"],
      nodeVersion: "25.3.0",
      prepareAnchorAuditDocsDirImpl() {
        return anchorDocsDir;
      },
      cleanupAnchorAuditDocsDirImpl(dir) {
        cleanedDir = dir;
      },
      spawnSyncImpl(command, args, options) {
        invocations.push({ command, args, options });
        return { status: 0 };
      },
    });

    expect(exitCode).toBe(0);
    expect(invocations).toHaveLength(2);
    const [versionCheck, linkCheck] = invocations;
    if (!versionCheck || !linkCheck) {
      throw new Error("Expected Mintlify wrapper invocations");
    }
    expect(versionCheck).toEqual({
      command: "fnm",
      args: [
        "exec",
        "--using=22",
        "node",
        "-e",
        "process.exit(Number(process.versions.node.split('.')[0]) === 22 ? 0 : 1)",
      ],
      options: { cwd: anchorDocsDir, stdio: "ignore" },
    });
    expect(linkCheck).toEqual({
      command: "fnm",
      args: ["exec", "--using=22", "pnpm", "dlx", "mint", "broken-links", "--check-anchors"],
      options: { cwd: anchorDocsDir, stdio: "inherit" },
    });
    expect(cleanedDir).toBe(anchorDocsDir);
  });
});
