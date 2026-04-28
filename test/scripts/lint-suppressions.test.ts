import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const IGNORED_DIRS = new Set([".cache", ".git", "build", "coverage", "dist", "node_modules"]);
const ROOTS = ["src", "extensions", "scripts", "ui"] as const;
const SUPPRESSION_PATTERN = /(?:oxlint|eslint)-disable(?:-next-line)?\s+([@/\w-]+)(?:\s+--|$)/u;

type SuppressionEntry = {
  file: string;
  rule: string;
};

function walkCodeFiles(dir: string, files: string[] = []): string[] {
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
    if (!CODE_EXTENSIONS.has(path.extname(entry.name))) {
      continue;
    }
    if (entry.name.startsWith("__rootdir_boundary_canary__.")) {
      continue;
    }
    const relativePath = path.relative(repoRoot, fullPath).replaceAll(path.sep, "/");
    if (
      relativePath.includes("/test/") ||
      relativePath.endsWith(".test.ts") ||
      relativePath.endsWith(".test.tsx") ||
      relativePath.endsWith(".spec.ts") ||
      relativePath.endsWith(".spec.tsx")
    ) {
      continue;
    }
    files.push(relativePath);
  }
  return files;
}

function collectProductionLintSuppressions(): SuppressionEntry[] {
  const entries: SuppressionEntry[] = [];
  const files = ROOTS.flatMap((root) => walkCodeFiles(path.join(repoRoot, root))).toSorted();
  for (const relativePath of files) {
    const source = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
    for (const line of source.split("\n")) {
      const match = line.match(SUPPRESSION_PATTERN);
      if (!match) {
        continue;
      }
      entries.push({
        file: relativePath,
        rule: match[1],
      });
    }
  }
  return entries;
}

function summarizeSuppressions(entries: readonly SuppressionEntry[]): string[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = `${entry.file}|${entry.rule}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => `${key}|${count}`).toSorted();
}

describe("production lint suppressions", () => {
  it("keeps the intentional production suppression tail on an explicit allowlist", () => {
    expect(summarizeSuppressions(collectProductionLintSuppressions())).toEqual([
      "extensions/browser/src/browser/pw-tools-core.interactions.ts|@typescript-eslint/no-implied-eval|2",
      "extensions/browser/src/cli/browser-cli-actions-input/register.files-downloads.ts|typescript/no-unnecessary-type-parameters|1",
      "extensions/browser/src/node-host/invoke-browser.ts|typescript/no-unnecessary-type-parameters|1",
      "extensions/discord/src/outbound-adapter.test-harness.ts|typescript/no-unnecessary-type-parameters|1",
      "extensions/discord/src/test-support/provider.test-support.ts|typescript/no-unnecessary-type-parameters|1",
      "extensions/feishu/src/bitable.ts|typescript/no-unnecessary-type-parameters|1",
      "extensions/matrix/src/onboarding.test-harness.ts|typescript/no-unnecessary-type-parameters|1",
      "extensions/slack/src/monitor/provider-support.ts|typescript/no-unnecessary-type-parameters|1",
      "scripts/e2e/mcp-channels-harness.ts|unicorn/prefer-add-event-listener|1",
      "scripts/lib/extension-package-boundary.ts|typescript/no-unnecessary-type-parameters|1",
      "scripts/lib/plugin-npm-release.ts|typescript/no-unnecessary-type-parameters|1",
      "src/agents/agent-scope.ts|no-control-regex|1",
      "src/agents/pi-embedded-runner/run/images.ts|no-control-regex|1",
      "src/agents/skills-clawhub.ts|no-control-regex|1",
      "src/agents/subagent-attachments.ts|no-control-regex|1",
      "src/agents/subagent-spawn.ts|no-control-regex|1",
      "src/channels/plugins/channel-runtime-surface.types.ts|typescript/no-unnecessary-type-parameters|1",
      "src/channels/plugins/contracts/test-helpers.ts|typescript/no-unnecessary-type-parameters|1",
      "src/channels/plugins/types.plugin.ts|typescript/no-explicit-any|1",
      "src/cli/cli-utils.ts|typescript/no-unnecessary-type-parameters|1",
      "src/cli/command-options.ts|typescript/no-unnecessary-type-parameters|1",
      "src/cli/plugins-cli-test-helpers.ts|typescript/no-unnecessary-type-parameters|1",
      "src/cli/test-runtime-capture.ts|typescript/no-unnecessary-type-parameters|1",
      "src/config/types.channels.ts|@typescript-eslint/no-explicit-any|1",
      "src/gateway/test-helpers.server.ts|typescript/no-unnecessary-type-parameters|1",
      "src/hooks/module-loader.ts|typescript/no-unnecessary-type-parameters|1",
      "src/infra/channel-runtime-context.ts|typescript/no-unnecessary-type-parameters|1",
      "src/infra/exec-approvals-effective.ts|typescript/no-unnecessary-type-parameters|1",
      "src/infra/json-file.ts|typescript/no-unnecessary-type-parameters|1",
      "src/infra/outbound/send-deps.ts|typescript/no-unnecessary-type-parameters|1",
      "src/node-host/invoke.ts|typescript/no-unnecessary-type-parameters|1",
      "src/plugin-sdk/channel-config-helpers.ts|typescript/no-unnecessary-type-parameters|1",
      "src/plugin-sdk/channel-entry-contract.ts|typescript/no-unnecessary-type-parameters|1",
      "src/plugin-sdk/facade-loader.ts|typescript/no-unnecessary-type-parameters|1",
      "src/plugin-sdk/facade-runtime.ts|typescript/no-unnecessary-type-parameters|3",
      "src/plugin-sdk/qa-runner-runtime.ts|typescript/no-unnecessary-type-parameters|1",
      "src/plugin-sdk/test-helpers/package-manifest-contract.ts|typescript/no-unnecessary-type-parameters|1",
      "src/plugin-sdk/test-helpers/public-surface-loader.ts|typescript/no-unnecessary-type-parameters|1",
      "src/plugin-sdk/test-helpers/subagent-hooks.ts|typescript/no-unnecessary-type-parameters|1",
      "src/plugins/hooks.ts|typescript/no-unnecessary-type-parameters|1",
      "src/plugins/host-hook-runtime.ts|typescript/no-unnecessary-type-parameters|2",
      "src/plugins/host-hooks.ts|typescript/no-unnecessary-type-parameters|1",
      "src/plugins/lazy-service-module.ts|typescript/no-unnecessary-type-parameters|1",
      "src/plugins/public-surface-loader.ts|typescript/no-unnecessary-type-parameters|1",
      "src/plugins/runtime/runtime-plugin-boundary.ts|typescript/no-unnecessary-type-parameters|2",
      "src/plugins/runtime/types-channel.ts|typescript/no-unnecessary-type-parameters|1",
      "src/plugins/types.ts|typescript/no-unnecessary-type-parameters|1",
      "src/tasks/task-flow-registry.store.sqlite.ts|typescript/no-unnecessary-type-parameters|1",
      "src/tasks/task-registry.store.sqlite.ts|typescript/no-unnecessary-type-parameters|1",
      "src/test-utils/bundled-plugin-public-surface.ts|typescript/no-unnecessary-type-parameters|2",
      "src/test-utils/vitest-mock-fn.ts|typescript/no-explicit-any|1",
      "src/utils.ts|typescript/no-unnecessary-type-parameters|1",
      "ui/src/ui/views/overview-log-tail.ts|no-control-regex|1",
    ]);
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
