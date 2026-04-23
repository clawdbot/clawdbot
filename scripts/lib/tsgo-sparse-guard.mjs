import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CORE_TEST_CONFIGS = new Set([
  "tsconfig.core.test.json",
  "tsconfig.core.test.agents.json",
  "tsconfig.core.test.non-agents.json",
]);

const CORE_TEST_REQUIRED_PATHS = [
  "packages/plugin-package-contract/src/index.ts",
  "ui/src/i18n/lib/registry.ts",
  "ui/src/i18n/lib/types.ts",
  "ui/src/ui/app-settings.ts",
  "ui/src/ui/gateway.ts",
];

export function getSparseTsgoGuardError(
  args,
  { cwd = process.cwd(), fileExists = fs.existsSync, isSparseCheckoutEnabled } = {},
) {
  const projectPath = readProjectFlag(args);
  if (
    !projectPath ||
    !CORE_TEST_CONFIGS.has(path.basename(projectPath)) ||
    isMetadataOnlyCommand(args)
  ) {
    return null;
  }

  const sparseEnabled =
    isSparseCheckoutEnabled?.({ cwd }) ?? getGitBooleanConfig("core.sparseCheckout", { cwd });
  if (!sparseEnabled) {
    return null;
  }

  const missingPaths = CORE_TEST_REQUIRED_PATHS.filter(
    (relativePath) => !fileExists(path.join(cwd, relativePath)),
  );
  if (missingPaths.length === 0) {
    return null;
  }

  return [
    `${path.basename(projectPath)} requires a full worktree, but this checkout is sparse and missing files that the core test graph imports:`,
    ...missingPaths.map((relativePath) => `- ${relativePath}`),
    'Run "gwt sparse full" in this worktree, then rerun the tsgo command.',
  ].join("\n");
}

function getGitBooleanConfig(name, { cwd }) {
  const result = spawnSync("git", ["config", "--get", "--bool", name], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  if (result.error || (result.status ?? 1) !== 0) {
    return false;
  }

  return (result.stdout ?? "").trim() === "true";
}

function readProjectFlag(args) {
  return readFlagValue(args, "-p") ?? readFlagValue(args, "--project");
}

function isMetadataOnlyCommand(args) {
  return args.some((arg) =>
    ["--help", "-h", "--version", "-v", "--init", "--showConfig"].includes(arg),
  );
}

function readFlagValue(args, name) {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === name) {
      return args[index + 1];
    }
    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
  }
  return undefined;
}
