// Lint Suppressions tests cover lint suppressions script behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectLintDisableDirectives,
  isMaxLinesRule,
} from "../../scripts/check-max-lines-ratchet.mjs";
import { expectNoReaddirSyncDuring } from "../../src/test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles, toRepoRelativePath } from "../../src/test-utils/repo-files.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const IGNORED_DIRS = new Set([".cache", ".git", "build", "coverage", "dist", "node_modules"]);
const ROOTS = ["src", "extensions", "scripts", "ui"] as const;

type SuppressionEntry = {
  file: string;
  rule: string;
};

let productionLintSuppressionsCache: SuppressionEntry[] | null = null;
let productionCodeFilesCache: string[] | null = null;

function collectFileSuppressions(file: string, source: string): SuppressionEntry[] {
  return collectLintDisableDirectives(source, file).flatMap((rules) =>
    rules.filter((rule) => !isMaxLinesRule(rule)).map((rule) => ({ file, rule })),
  );
}

function isProductionCodeFile(relativePath: string): boolean {
  const basename = path.posix.basename(relativePath);
  if (!CODE_EXTENSIONS.has(path.extname(relativePath))) {
    return false;
  }
  if (basename.startsWith("__rootdir_boundary_canary__.")) {
    return false;
  }
  return !(
    relativePath.includes("/test/") ||
    relativePath.endsWith(".test.ts") ||
    relativePath.endsWith(".test.tsx") ||
    relativePath.endsWith(".spec.ts") ||
    relativePath.endsWith(".spec.tsx")
  );
}

function listGitCodeFiles(root: string): string[] | null {
  return (
    listGitTrackedFiles({ repoRoot, pathspecs: root })
      ?.filter(isProductionCodeFile)
      .filter((relativePath) => fs.existsSync(path.join(repoRoot, relativePath))) ?? null
  );
}

function walkCodeFiles(dir: string, files: string[] = []): string[] {
  const relativeRoot = toRepoRelativePath(repoRoot, dir);
  if (relativeRoot && !relativeRoot.startsWith("..") && !path.isAbsolute(relativeRoot)) {
    const gitFiles = listGitCodeFiles(relativeRoot);
    if (gitFiles) {
      files.push(...gitFiles);
      return files;
    }
  }

  if (!fs.existsSync(dir)) {
    return files;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      walkCodeFiles(fullPath, files);
      continue;
    }
    const relativePath = toRepoRelativePath(repoRoot, fullPath);
    if (!isProductionCodeFile(relativePath)) {
      continue;
    }
    files.push(relativePath);
  }
  return files;
}

function collectProductionLintSuppressions(): SuppressionEntry[] {
  if (productionLintSuppressionsCache) {
    return [...productionLintSuppressionsCache];
  }
  const gitEntries = collectProductionLintSuppressionsFromGit();
  if (gitEntries) {
    productionLintSuppressionsCache = gitEntries;
    return [...gitEntries];
  }
  const entries: SuppressionEntry[] = [];
  const files = listProductionCodeFiles();
  for (const relativePath of files) {
    const source = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
    entries.push(...collectFileSuppressions(relativePath, source));
  }
  productionLintSuppressionsCache = entries;
  return [...entries];
}

function collectProductionLintSuppressionsFromGit(): SuppressionEntry[] | null {
  const result = spawnSync(
    "git",
    ["grep", "-z", "-l", "-e", "oxlint-disable", "-e", "eslint-disable", "--", ...ROOTS],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.status === 1) {
    return [];
  }
  if (result.status !== 0) {
    return null;
  }
  const entries: SuppressionEntry[] = [];
  for (const file of result.stdout.split("\0").filter(Boolean)) {
    if (!isProductionCodeFile(file) || !fs.existsSync(path.join(repoRoot, file))) {
      continue;
    }
    entries.push(
      ...collectFileSuppressions(file, fs.readFileSync(path.join(repoRoot, file), "utf8")),
    );
  }
  return entries;
}

function listProductionCodeFiles(): string[] {
  productionCodeFilesCache ??= ROOTS.flatMap((root) =>
    walkCodeFiles(path.join(repoRoot, root)),
  ).toSorted();
  return [...productionCodeFilesCache];
}

function summarizeSuppressions(entries: readonly SuppressionEntry[]): string[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = `${entry.file}|${entry.rule}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => `${key}|${count}`).toSorted();
}

function filterExpectedSuppressionsForPresentFiles(entries: readonly string[]): string[] {
  return entries.filter((entry) => {
    const [file] = entry.split("|", 1);
    return file !== undefined && fs.existsSync(path.join(repoRoot, file));
  });
}

collectProductionLintSuppressions();

describe("production lint suppressions", () => {
  it("keeps companion rules visible beside max-lines suppressions", () => {
    expect(
      collectFileSuppressions(
        "src/example.ts",
        "/* oxlint-disable\nmax-lines, no-console\n-- TODO: split this file. */",
      ),
    ).toEqual([{ file: "src/example.ts", rule: "no-console" }]);
    expect(
      collectFileSuppressions(
        "src/example.ts",
        "/* oxlint-disable eslint/max-lines, no-debugger */",
      ),
    ).toEqual([{ file: "src/example.ts", rule: "no-debugger" }]);
    expect(collectFileSuppressions("src/example.ts", "/* oxlint-disable - reason */")).toEqual([]);
  });

  it("lists production files from git without walking source roots", () => {
    expectNoReaddirSyncDuring(() => {
      const files = listProductionCodeFiles();

      expect(files.length).toBeGreaterThan(0);
      expect(files.some((file) => file.endsWith(".test.ts"))).toBe(false);
    });
  });

  it("keeps the intentional production suppression tail on an explicit allowlist", () => {
    expect(summarizeSuppressions(collectProductionLintSuppressions())).toEqual(
      filterExpectedSuppressionsForPresentFiles([
        "extensions/browser/src/browser/pw-tools-core.interactions.ts|@typescript-eslint/no-implied-eval|3",
        "extensions/browser/src/cli/browser-cli-actions-input/register.files-downloads.ts|typescript/no-unnecessary-type-parameters|1",
        "extensions/browser/src/node-host/invoke-browser.ts|typescript/no-unnecessary-type-parameters|1",
        "extensions/diffs/src/viewer-client.ts|eslint/no-underscore-dangle|1",
        "extensions/discord/src/outbound-adapter.test-harness.ts|typescript/no-unnecessary-type-parameters|1",
        "extensions/discord/src/test-support/provider.test-support.ts|typescript/no-unnecessary-type-parameters|1",
        "extensions/feishu/src/bitable.ts|typescript/no-unnecessary-type-parameters|1",
        "extensions/matrix/src/onboarding.test-harness.ts|typescript/no-unnecessary-type-parameters|1",
        "extensions/slack/src/monitor/provider-support.ts|typescript/no-unnecessary-type-parameters|1",
        "scripts/changed-lanes.mjs|typescript/no-base-to-string|2",
        "scripts/changed-lanes.mjs|typescript/restrict-template-expressions|2",
        "src/agents/agent-bundle-mcp-runtime.ts|unicorn/prefer-add-event-listener|1",
        "src/agents/agent-tools.abort.ts|typescript/prefer-promise-reject-errors|1",
        "src/audit/audit-event-writer.ts|unicorn/require-post-message-target-origin|2",
        "src/channels/plugins/channel-runtime-surface.types.ts|typescript/no-unnecessary-type-parameters|1",
        "src/channels/plugins/contracts/test-helpers.ts|typescript/no-unnecessary-type-parameters|1",
        "src/channels/plugins/types.plugin.ts|typescript/no-explicit-any|1",
        "src/cli/cli-utils.ts|typescript/no-unnecessary-type-parameters|1",
        "src/cli/command-options.ts|typescript/no-unnecessary-type-parameters|1",
        "src/cli/plugins-cli-test-helpers.ts|typescript/no-unnecessary-type-parameters|1",
        "src/cli/test-runtime-capture.ts|typescript/no-unnecessary-type-parameters|1",
        "src/gateway/test-helpers.server.ts|typescript/no-unnecessary-type-parameters|1",
        "src/hooks/module-loader.ts|typescript/no-unnecessary-type-parameters|1",
        "src/infra/device-pairing-store.ts|typescript/no-unnecessary-type-parameters|1",
        "src/infra/exec-approvals-effective.ts|typescript/no-unnecessary-type-parameters|1",
        "src/infra/json-file.ts|typescript-eslint/no-unnecessary-type-parameters|1",
        "src/infra/outbound/send-deps.ts|typescript/no-unnecessary-type-parameters|1",
        "src/node-host/invoke.ts|typescript/no-unnecessary-type-parameters|1",
        "src/node-host/mcp.ts|unicorn/prefer-add-event-listener|1",
        "src/plugin-sdk/channel-config-helpers.ts|typescript/no-unnecessary-type-parameters|1",
        "src/plugin-sdk/channel-entry-contract.ts|typescript/no-unnecessary-type-parameters|1",
        "src/plugin-sdk/facade-loader.ts|typescript/no-unnecessary-type-parameters|1",
        "src/plugin-sdk/facade-runtime.ts|typescript/no-unnecessary-type-parameters|3",
        "src/plugin-sdk/json-store.ts|typescript-eslint/no-unnecessary-type-parameters|1",
        "src/plugin-sdk/qa-runner-runtime.ts|typescript/no-unnecessary-type-parameters|1",
        "src/plugin-sdk/test-helpers/public-surface-loader.ts|typescript/no-unnecessary-type-parameters|1",
        "src/plugin-sdk/test-helpers/subagent-hooks.ts|typescript/no-unnecessary-type-parameters|1",
        "src/plugins/hooks.ts|typescript/no-unnecessary-type-parameters|1",
        "src/plugins/host-hooks.ts|typescript/no-unnecessary-type-parameters|1",
        "src/plugins/lazy-service-module.ts|typescript/no-unnecessary-type-parameters|1",
        "src/plugins/public-surface-loader.ts|typescript/no-unnecessary-type-parameters|3",
        "src/plugins/runtime/runtime-plugin-boundary.ts|typescript/no-unnecessary-type-parameters|1",
        "src/plugins/runtime/types-channel.ts|typescript/no-unnecessary-type-parameters|1",
        "src/plugins/trusted-tool-policy.ts|typescript/no-unnecessary-type-parameters|1",
        "src/state/config-machine-state.ts|typescript/no-unnecessary-type-parameters|1",
        "src/system-agent/setup-inference-activate.ts|no-unsafe-finally|1",
        "src/system-agent/setup-inference-activate.ts|preserve-caught-error|1",
        "src/tasks/task-registry.sqlite.shared.ts|typescript/no-unnecessary-type-parameters|1",
        "src/test-utils/vitest-mock-fn.ts|typescript/no-explicit-any|1",
        "src/utils.ts|typescript/no-unnecessary-type-parameters|1",
        "src/version.ts|eslint/no-underscore-dangle|1",
        "ui/public/sw.js|unicorn/require-post-message-target-origin|1",
        // oxlint misreads CanvasRenderingContext2D.fill(path) as Array.fill.
        "ui/src/components/mascot-canvas.ts|unicorn/no-array-fill-with-reference-type|1",
      ]),
    );
  });

  it("keeps production no-explicit-any suppressions on an explicit allowlist", () => {
    const anySuppressions = collectProductionLintSuppressions().filter(
      (entry) => entry.rule === "typescript/no-explicit-any",
    );

    expect(anySuppressions).toEqual([
      {
        file: "src/channels/plugins/types.plugin.ts",
        rule: "typescript/no-explicit-any",
      },
      {
        file: "src/test-utils/vitest-mock-fn.ts",
        rule: "typescript/no-explicit-any",
      },
    ]);
  });
});
