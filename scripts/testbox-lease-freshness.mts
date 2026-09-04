import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

const STATE_VERSION = 1;
const DEPENDENCY_INPUTS = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"];
const ENVIRONMENT_INPUTS = [
  ".crabbox.yaml",
  ".github/workflows/ci-check-testbox.yml",
  ".node-version",
  "scripts/crabbox-wrapper.mjs",
  "scripts/crabbox-wrapper.mts",
  "scripts/crabbox-source-capsule.mts",
  "scripts/crabbox-source-receiver.mts",
];

function optionValue(args: readonly string[], name: string, fallback = "") {
  const shortName = name.replace(/^--/u, "-");
  for (const [index, argument = ""] of args.entries()) {
    if (argument === name || argument === shortName) {
      return args[index + 1] ?? fallback;
    }
    if (argument.startsWith(`${name}=`) || argument.startsWith(`${shortName}=`)) {
      return argument.slice(argument.indexOf("=") + 1);
    }
  }
  return fallback;
}

function git(repoRoot: string, args: readonly string[]) {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
}

function listFiles(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }
  if (statSync(path).isFile()) {
    return [path];
  }
  return readdirSync(path, { withFileTypes: true })
    .flatMap((entry) => listFiles(resolve(path, entry.name)))
    .toSorted((left, right) => left.localeCompare(right));
}

function digestInputs(repoRoot: string, inputs: readonly string[]) {
  const hash = createHash("sha256");
  for (const input of inputs) {
    for (const path of listFiles(resolve(repoRoot, input))) {
      hash.update(path.slice(repoRoot.length));
      hash.update("\0");
      hash.update(readFileSync(path));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

function buildTestboxLeaseFingerprint(repoRoot: string, args: readonly string[]) {
  let baseSha;
  try {
    baseSha = git(repoRoot, ["merge-base", "HEAD", "refs/remotes/origin/main"]);
  } catch {
    baseSha = git(repoRoot, ["rev-parse", "HEAD"]);
  }
  return {
    version: STATE_VERSION,
    baseSha,
    headSha: git(repoRoot, ["rev-parse", "HEAD"]),
    dependencyDigest: digestInputs(repoRoot, [...DEPENDENCY_INPUTS, "patches"]),
    environmentDigest: digestInputs(repoRoot, ENVIRONMENT_INPUTS),
    workflow: optionValue(args, "--blacksmith-workflow", ".github/workflows/ci-check-testbox.yml"),
    job: optionValue(args, "--blacksmith-job", "check"),
    ref: optionValue(args, "--blacksmith-ref", "main"),
  };
}

export function testboxLeaseStaleReasons(saved: unknown, current: unknown) {
  if (!isRecord(saved) || saved.version !== STATE_VERSION || !isRecord(current)) {
    return ["state schema"];
  }
  return ["baseSha", "dependencyDigest", "environmentDigest", "workflow", "job", "ref"].filter(
    (key) => saved[key] !== current[key],
  );
}

export function prepareTestboxLeaseFreshness({
  args,
  env,
  provider,
  repoRoot,
}: {
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  provider: string;
  repoRoot: string;
}) {
  const id = optionValue(args, "--id");
  if (provider !== "blacksmith-testbox" || args[0] !== "run" || !id?.startsWith("tbx_")) {
    return null;
  }
  const configuredStateDir = env.OPENCLAW_TESTBOX_LEASE_STATE_DIR?.trim();
  if (env.VITEST && !configuredStateDir) {
    return null;
  }
  const stateDir = resolve(configuredStateDir || resolve(repoRoot, ".crabbox", "testbox-leases"));
  const path = resolve(stateDir, `${id}.json`);
  const current = buildTestboxLeaseFingerprint(repoRoot, args);
  if (existsSync(path)) {
    const saved: unknown = JSON.parse(readFileSync(path, "utf8"));
    const staleReasons = testboxLeaseStaleReasons(saved, current);
    if (staleReasons.length > 0 && env.OPENCLAW_TESTBOX_ALLOW_STALE !== "1") {
      throw new Error(
        `Testbox ${id} is stale (${staleReasons.join(", ")}); stop it and warm a fresh lease, or set OPENCLAW_TESTBOX_ALLOW_STALE=1 for an intentional diagnostic reuse`,
      );
    }
    return { current, path };
  }
  return { current, path };
}

export function recordTestboxLeaseFreshness(
  prepared: ReturnType<typeof prepareTestboxLeaseFreshness> | undefined,
) {
  if (!prepared) {
    return;
  }
  mkdirSync(resolve(prepared.path, ".."), { recursive: true });
  const temporaryPath = `${prepared.path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(prepared.current, null, 2)}\n`);
  renameSync(temporaryPath, prepared.path);
}
