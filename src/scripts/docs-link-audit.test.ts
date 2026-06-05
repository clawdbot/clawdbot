// Docs link audit tests cover documentation link validation behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";

const {
  normalizeRoute,
  prepareAnchorAuditDocsDir,
  prepareMirroredDocsDir,
  resolveRoute,
  runDocsLinkAuditCli,
  sanitizeDocsConfigForEnglishOnly,
} = (await import("../../scripts/docs-link-audit.mjs")) as unknown as {
  normalizeRoute: (route: string) => string;
  prepareAnchorAuditDocsDir: (sourceDir?: string) => string;
  prepareMirroredDocsDir: (
    sourceDir?: string,
    options?: {
      resolveClawHubRepoPathImpl?: (value?: string, options?: { required?: boolean }) => string;
      syncClawHubDocsTreeImpl?: (
        targetDocsDir: string,
        options?: { repoPath?: string; required?: boolean },
      ) => unknown;
    },
  ) => {
    cleanup: () => void;
    dir: string;
    mirroredClawHub: boolean;
  };
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
      options: { cwd: string; env?: NodeJS.ProcessEnv; shell?: boolean; stdio: string },
    ) => { status: number | null; error?: { code?: string } };
    env?: NodeJS.ProcessEnv;
    nodeExecPath?: string;
    npmExecPath?: string;
    prepareAnchorAuditDocsDirImpl?: (sourceDir?: string) => string;
    cleanupAnchorAuditDocsDirImpl?: (dir: string) => void;
    prepareMirroredDocsDirImpl?: (sourceDir?: string) => {
      cleanup: () => void;
      dir: string;
      mirroredClawHub: boolean;
    };
  }) => number;
  sanitizeDocsConfigForEnglishOnly: (value: unknown) => unknown;
};

describe("docs-link-audit", () => {
  function tempEntries(prefix: string): Set<string> {
    return new Set(fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(prefix)));
  }

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

  it("cleans anchor audit docs copies when docs.json is invalid", () => {
    const tempDirs: string[] = [];
    const fixtureRoot = makeTempDir(tempDirs, "docs-link-audit-invalid-");
    const docsRoot = path.join(fixtureRoot, "docs");
    fs.mkdirSync(docsRoot, { recursive: true });
    fs.writeFileSync(path.join(docsRoot, "docs.json"), "{ invalid json", "utf8");

    const before = tempEntries("openclaw-docs-anchor-audit-");
    try {
      expect(() => prepareAnchorAuditDocsDir(docsRoot)).toThrow();
      const after = tempEntries("openclaw-docs-anchor-audit-");
      expect([...after].filter((entry) => !before.has(entry))).toEqual([]);
    } finally {
      cleanupTempDirs(tempDirs);
    }
  });

  it("does not create mirrored docs copies for non-root docs trees", () => {
    const tempDirs: string[] = [];
    const fixtureRoot = makeTempDir(tempDirs, "docs-link-audit-mirror-");
    const docsRoot = path.join(fixtureRoot, "docs");
    fs.mkdirSync(docsRoot, { recursive: true });

    const before = tempEntries("openclaw-docs-link-audit-");
    try {
      const mirroredDocsDir = prepareMirroredDocsDir(docsRoot);
      expect(mirroredDocsDir).toEqual({
        cleanup: expect.any(Function),
        dir: path.resolve(docsRoot),
        mirroredClawHub: false,
      });
      mirroredDocsDir.cleanup();
      const after = tempEntries("openclaw-docs-link-audit-");
      expect([...after].filter((entry) => !before.has(entry))).toEqual([]);
    } finally {
      cleanupTempDirs(tempDirs);
    }
  });

  it("cleans mirrored docs copies when ClawHub sync fails", () => {
    const before = tempEntries("openclaw-docs-link-audit-");

    expect(() =>
      prepareMirroredDocsDir(undefined, {
        resolveClawHubRepoPathImpl() {
          return path.join(os.tmpdir(), "clawhub-docs");
        },
        syncClawHubDocsTreeImpl() {
          throw new Error("sync failed");
        },
      }),
    ).toThrow("sync failed");

    const after = tempEntries("openclaw-docs-link-audit-");
    expect([...after].filter((entry) => !before.has(entry))).toEqual([]);
  });

  it("cleans mirrored docs copies when anchor prep fails", () => {
    let mirroredCleaned = false;

    expect(() =>
      runDocsLinkAuditCli({
        args: ["--anchors"],
        cleanupAnchorAuditDocsDirImpl() {
          throw new Error("anchor cleanup should not run");
        },
        prepareAnchorAuditDocsDirImpl() {
          throw new Error("anchor prep failed");
        },
        prepareMirroredDocsDirImpl: () => ({
          cleanup() {
            mirroredCleaned = true;
          },
          dir: path.join(os.tmpdir(), "openclaw-docs-mirrored"),
          mirroredClawHub: true,
        }),
      }),
    ).toThrow("anchor prep failed");
    expect(mirroredCleaned).toBe(true);
  });

  it("uses Mintlify through pnpm dlx for anchor validation", () => {
    let invocation:
      | {
          command: string;
          args: string[];
          options: { cwd: string; env?: NodeJS.ProcessEnv; shell?: boolean; stdio: string };
        }
      | undefined;
    let cleanedDir: string | undefined;
    const anchorDocsDir = path.join(os.tmpdir(), "docs-link-audit-anchor");
    const fakePnpm = path.join(anchorDocsDir, "pnpm.cjs");
    fs.mkdirSync(anchorDocsDir, { recursive: true });
    fs.writeFileSync(fakePnpm, "#!/usr/bin/env node\n", { mode: 0o755 });

    const exitCode = runDocsLinkAuditCli({
      args: ["--anchors"],
      env: { ...process.env, OPENCLAW_DOCS_LINK_SENTINEL: "1" },
      nodeExecPath: "/opt/node/bin/node",
      nodeVersion: "22.21.1",
      npmExecPath: fakePnpm,
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
      command: "/opt/node/bin/node",
      args: [fakePnpm, "dlx", "mint", "broken-links", "--check-anchors"],
      options: expect.objectContaining({
        cwd: anchorDocsDir,
        env: expect.objectContaining({ OPENCLAW_DOCS_LINK_SENTINEL: "1" }),
        shell: false,
        stdio: "inherit",
      }),
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
    const fakePnpm = path.join(anchorDocsDir, "pnpm.cjs");
    fs.mkdirSync(anchorDocsDir, { recursive: true });
    fs.writeFileSync(fakePnpm, "#!/usr/bin/env node\n", { mode: 0o755 });

    const exitCode = runDocsLinkAuditCli({
      args: ["--anchors"],
      nodeExecPath: "/opt/node/bin/node",
      nodeVersion: "25.3.0",
      npmExecPath: fakePnpm,
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
      args: [
        "exec",
        "--using=22",
        "node",
        fakePnpm,
        "dlx",
        "mint",
        "broken-links",
        "--check-anchors",
      ],
      options: { cwd: anchorDocsDir, stdio: "inherit" },
    });
    expect(cleanedDir).toBe(anchorDocsDir);
  });
});
