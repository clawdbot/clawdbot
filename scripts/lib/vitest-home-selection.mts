import path from "node:path";
import { combineTestHomeSelections, type TestHomeSelection } from "../../test/test-home-policy.mts";
import { fullSuiteVitestShards } from "../../test/vitest/vitest.test-shards.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
// These are the setup.env owners, including the root-matrix variant of unit-fast.
const hermeticProjects = new Set([
  "unit-fast",
  "unit-fast-root",
  "unit-fast-isolated",
  "unit-fast-fake-timers",
  "gateway-server-isolated",
]);
const leafConfigs = new Set([
  ...fullSuiteVitestShards.flatMap((shard) => shard.projects),
  ...[
    "unit",
    "unit-fast-root",
    "agents",
    "auto-reply",
    "extension-codex",
    "live",
    "e2e",
    "package-docker",
    "ui-e2e",
  ].map((name) => `test/vitest/vitest.${name}.config.ts`),
]);

function projectName(config: string): string {
  return path
    .basename(config)
    .replace(/^vitest\./u, "")
    .replace(/\.config\.ts$/u, "");
}

function combinePolicies(configs: readonly string[]): TestHomeSelection {
  return combineTestHomeSelections(
    configs.map((config) =>
      hermeticProjects.has(projectName(config)) ? "hermetic" : "live-aware",
    ),
  );
}

/** Classify declarations only. Never import a selected config to authorize a real home. */
export function resolveVitestHomeSelection(
  args: string[],
  options: { cwd?: string; defaultConfig?: string; env?: NodeJS.ProcessEnv } = {},
): TestHomeSelection {
  let config: string | undefined;
  let root: string | undefined;
  const projects: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") {
      break;
    }
    const [flag = "", inline] = arg.split(/[=](.*)/su);
    // CAC also accepts grouped, negated, and dotted selectors. Decline those
    // spellings rather than authorizing a different project set by guessing.
    if (
      flag.startsWith("---") ||
      (flag.startsWith("-") && !flag.startsWith("--") && flag.length > 2) ||
      /^--(?:no-)?(?:config|c|root|r|project)\./u.test(flag) ||
      /^--no-(?:config|c|root|r|project)$/u.test(flag)
    ) {
      return "unknown";
    }
    if (["--config", "--c", "-c", "--root", "--r", "-r", "--project"].includes(flag)) {
      const value = inline ?? args[++index];
      if (!value || value.startsWith("-")) {
        return "unknown";
      }
      if (flag === "--project") {
        projects.push(value);
      } else if (flag === "--root" || flag === "--r" || flag === "-r") {
        if (root !== undefined) {
          return "unknown";
        }
        root = value;
      } else {
        if (config !== undefined) {
          return "unknown";
        }
        config = value;
      }
    }
    // Unrelated options never consume a following flag in CAC. Inspect every
    // token so an optional value cannot hide a config/root/project selector.
  }
  const cwd = options.cwd ?? process.cwd();
  const selectedRoot = path.resolve(cwd, root ?? ".");
  // Even known leaf configs can resolve relative setup files through --root.
  if (selectedRoot !== repoRoot) {
    return "unknown";
  }
  const selectedConfig = path.resolve(
    selectedRoot,
    config ?? options.defaultConfig ?? "vitest.config.ts",
  );
  const relative = path.relative(repoRoot, selectedConfig).split(path.sep).join("/");
  let candidates: readonly string[];
  if (relative === "vitest.config.ts" || relative === "test/vitest/vitest.config.ts") {
    // An exact project selector can prove policy; unfiltered root is mixed.
    if (projects.length === 0) {
      return "mixed";
    }
    candidates = [...leafConfigs];
  } else if (relative === "test/vitest/vitest.gateway.config.ts") {
    if (options.env?.OPENCLAW_GATEWAY_PROJECT_SHARDS === "0") {
      return "live-aware";
    }
    candidates = [...leafConfigs].filter((entry) => projectName(entry).startsWith("gateway-"));
  } else {
    const shard = fullSuiteVitestShards.find((entry) => entry.config === relative);
    if (!shard) {
      return leafConfigs.has(relative) ? combinePolicies([relative]) : "unknown";
    }
    candidates = shard.projects;
  }
  const policy = combinePolicies(candidates);
  if (projects.length === 0 || policy !== "mixed") {
    return policy;
  }
  // Globs/negations and unknown names cannot establish a single policy before config loading.
  if (projects.some((name) => !candidates.some((entry) => projectName(entry) === name))) {
    return "unknown";
  }
  return combinePolicies(candidates.filter((entry) => projects.includes(projectName(entry))));
}
