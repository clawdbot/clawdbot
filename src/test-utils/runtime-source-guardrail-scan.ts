import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { listRuntimeSourceFiles } from "./repo-scan.js";

export type RuntimeSourceGuardrailFile = {
  relativePath: string;
  source: string;
};

const DEFAULT_GUARDRAIL_SKIP_PATTERNS = [
  /\.test\.tsx?$/,
  /\.test-helpers\.tsx?$/,
  /\.test-utils\.tsx?$/,
  /\.test-harness\.tsx?$/,
  /\.test-support\.tsx?$/,
  /\.suite\.tsx?$/,
  /\.e2e\.tsx?$/,
  /\.d\.ts$/,
  /[\\/](?:__tests__|tests|test-helpers|test-utils|test-support)[\\/]/,
  /[\\/][^\\/]*test-helpers(?:\.[^\\/]+)?\.ts$/,
  /[\\/][^\\/]*test-utils(?:\.[^\\/]+)?\.ts$/,
  /[\\/][^\\/]*test-harness(?:\.[^\\/]+)?\.ts$/,
  /[\\/][^\\/]*test-support(?:\.[^\\/]+)?\.ts$/,
];

const runtimeSourceGuardrailCache = new Map<string, Promise<RuntimeSourceGuardrailFile[]>>();
const trackedRuntimeSourceListCache = new Map<string, string[]>();
const FILE_READ_CONCURRENCY = 24;

export function shouldSkipGuardrailRuntimeSource(relativePath: string): boolean {
  return DEFAULT_GUARDRAIL_SKIP_PATTERNS.some((pattern) => pattern.test(relativePath));
}

async function readRuntimeSourceFiles(
  repoRoot: string,
  absolutePaths: string[],
): Promise<RuntimeSourceGuardrailFile[]> {
  const output: Array<RuntimeSourceGuardrailFile | undefined> = Array.from({
    length: absolutePaths.length,
  });
  let nextIndex = 0;

  const worker = async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= absolutePaths.length) {
        return;
      }
      const absolutePath = absolutePaths[index];
      if (!absolutePath) {
        continue;
      }
      let source: string;
      try {
        source = await fs.readFile(absolutePath, "utf8");
      } catch {
        // File tracked by git but deleted on disk (e.g. pending deletion).
        continue;
      }
      output[index] = {
        relativePath: path.relative(repoRoot, absolutePath),
        source,
      };
    }
  };

  const workers = Array.from(
    { length: Math.min(FILE_READ_CONCURRENCY, Math.max(1, absolutePaths.length)) },
    () => worker(),
  );
  await Promise.all(workers);
  return output.filter((entry): entry is RuntimeSourceGuardrailFile => entry !== undefined);
}

function tryListTrackedRuntimeSourceFiles(repoRoot: string): string[] | null {
  const cached = trackedRuntimeSourceListCache.get(repoRoot);
  if (cached) {
    return cached.slice();
  }

  try {
    const stdout = execFileSync("git", ["-C", repoRoot, "ls-files", "--", "src", "extensions"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const files = stdout
      .split(/\r?\n/u)
      .filter(Boolean)
      .filter((relativePath) => relativePath.endsWith(".ts") || relativePath.endsWith(".tsx"))
      .filter((relativePath) => !shouldSkipGuardrailRuntimeSource(relativePath))
      .map((relativePath) => path.join(repoRoot, relativePath));
    trackedRuntimeSourceListCache.set(repoRoot, files);
    return files.slice();
  } catch {
    return null;
  }
}

export async function loadRuntimeSourceFilesForGuardrails(
  repoRoot: string,
): Promise<RuntimeSourceGuardrailFile[]> {
  let pending = runtimeSourceGuardrailCache.get(repoRoot);
  if (!pending) {
    pending = (async () => {
      const trackedFiles = tryListTrackedRuntimeSourceFiles(repoRoot);
      const sourceFiles =
        trackedFiles ??
        (
          await listRuntimeSourceFiles(repoRoot, {
            roots: ["src", "extensions"],
            extensions: [".ts", ".tsx"],
          })
        ).filter((absolutePath) => {
          const relativePath = path.relative(repoRoot, absolutePath);
          return !shouldSkipGuardrailRuntimeSource(relativePath);
        });
      return await readRuntimeSourceFiles(repoRoot, sourceFiles);
    })();
    runtimeSourceGuardrailCache.set(repoRoot, pending);
  }
  return await pending;
}
