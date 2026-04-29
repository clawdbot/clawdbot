import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { describe, expect, it, vi } from "vitest";
import { backupVerifyCommand } from "../commands/backup-verify.js";
import type { RuntimeEnv } from "../runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  buildExtensionsNodeModulesFilter,
  createBackupArchive,
  formatBackupCreateSummary,
  type BackupCreateResult,
} from "./backup-create.js";

function makeResult(overrides: Partial<BackupCreateResult> = {}): BackupCreateResult {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    archiveRoot: "openclaw-backup-2026-01-01",
    archivePath: "/tmp/openclaw-backup.tar.gz",
    dryRun: false,
    includeWorkspace: true,
    onlyConfig: false,
    verified: false,
    assets: [],
    skipped: [],
    ...overrides,
  };
}

async function listArchiveEntries(archivePath: string): Promise<string[]> {
  const entries: string[] = [];
  await tar.t({
    file: archivePath,
    gzip: true,
    onentry: (entry) => {
      entries.push(entry.path);
      entry.resume();
    },
  });
  return entries;
}

describe("formatBackupCreateSummary", () => {
  const backupArchiveLine = "Backup archive: /tmp/openclaw-backup.tar.gz";

  it.each([
    {
      name: "formats created archives with included and skipped paths",
      result: makeResult({
        verified: true,
        assets: [
          {
            kind: "state",
            sourcePath: "/state",
            archivePath: "archive/state",
            displayPath: "~/.openclaw",
          },
        ],
        skipped: [
          {
            kind: "workspace",
            sourcePath: "/workspace",
            displayPath: "~/Projects/openclaw",
            reason: "covered",
            coveredBy: "~/.openclaw",
          },
        ],
      }),
      expected: [
        backupArchiveLine,
        "Included 1 path:",
        "- state: ~/.openclaw",
        "Skipped 1 path:",
        "- workspace: ~/Projects/openclaw (covered by ~/.openclaw)",
        "Created /tmp/openclaw-backup.tar.gz",
        "Archive verification: passed",
      ],
    },
    {
      name: "formats dry runs and pluralized counts",
      result: makeResult({
        dryRun: true,
        assets: [
          {
            kind: "config",
            sourcePath: "/config",
            archivePath: "archive/config",
            displayPath: "~/.openclaw/config.json",
          },
          {
            kind: "credentials",
            sourcePath: "/oauth",
            archivePath: "archive/oauth",
            displayPath: "~/.openclaw/oauth",
          },
        ],
      }),
      expected: [
        backupArchiveLine,
        "Included 2 paths:",
        "- config: ~/.openclaw/config.json",
        "- credentials: ~/.openclaw/oauth",
        "Dry run only; archive was not written.",
      ],
    },
  ])("$name", ({ result, expected }) => {
    expect(formatBackupCreateSummary(result)).toEqual(expected);
  });
});

describe("buildExtensionsNodeModulesFilter", () => {
  it("excludes dependency trees only under state extensions", () => {
    const filter = buildExtensionsNodeModulesFilter("/state/");

    expect(filter("/state/extensions/demo/openclaw.plugin.json")).toBe(true);
    expect(filter("/state/extensions/demo/src/index.js")).toBe(true);
    expect(filter("/state/extensions/demo/node_modules/dep/index.js")).toBe(false);
    expect(filter("/state/extensions/demo/vendor/node_modules/dep/index.js")).toBe(false);
    expect(filter("/state/node_modules/dep/index.js")).toBe(true);
    expect(filter("/state/extensions-node_modules/demo/index.js")).toBe(true);
  });

  it("normalizes Windows path separators", () => {
    const filter = buildExtensionsNodeModulesFilter("C:\\Users\\me\\.openclaw\\");

    expect(filter(String.raw`C:\Users\me\.openclaw\extensions\demo\index.js`)).toBe(true);
    expect(
      filter(String.raw`C:\Users\me\.openclaw\extensions\demo\node_modules\dep\index.js`),
    ).toBe(false);
  });
});

describe("createBackupArchive", () => {
  it("omits installed plugin node_modules from the real archive while keeping plugin files", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-plugin-deps-",
        scenario: "minimal",
      },
      async (state) => {
        const stateDir = state.stateDir;
        const outputDir = state.path("backups");
        await fs.mkdir(path.join(stateDir, "extensions", "demo", "node_modules", "dep"), {
          recursive: true,
        });
        await fs.mkdir(path.join(stateDir, "extensions", "demo", "src"), { recursive: true });
        await fs.mkdir(path.join(stateDir, "node_modules", "root-dep"), { recursive: true });
        await fs.writeFile(
          path.join(stateDir, "extensions", "demo", "openclaw.plugin.json"),
          '{"id":"demo"}\n',
          "utf8",
        );
        await fs.writeFile(
          path.join(stateDir, "extensions", "demo", "src", "index.js"),
          "export default {}\n",
          "utf8",
        );
        await fs.writeFile(
          path.join(stateDir, "extensions", "demo", "node_modules", "dep", "index.js"),
          "module.exports = {}\n",
          "utf8",
        );
        await fs.writeFile(
          path.join(stateDir, "node_modules", "root-dep", "index.js"),
          "module.exports = {}\n",
          "utf8",
        );
        await fs.mkdir(outputDir, { recursive: true });

        const result = await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: Date.UTC(2026, 3, 28, 12, 0, 0),
        });
        const entries = await listArchiveEntries(result.archivePath);

        expect(
          entries.some((entry) => entry.endsWith("/state/extensions/demo/openclaw.plugin.json")),
        ).toBe(true);
        expect(entries.some((entry) => entry.endsWith("/state/extensions/demo/src/index.js"))).toBe(
          true,
        );
        expect(
          entries.some((entry) => entry.endsWith("/state/node_modules/root-dep/index.js")),
        ).toBe(true);
        expect(
          entries.some((entry) => entry.includes("/state/extensions/demo/node_modules/")),
        ).toBe(false);

        const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        await expect(
          backupVerifyCommand(runtime, { archive: result.archivePath }),
        ).resolves.toMatchObject({ ok: true });
      },
    );
  });
});
