// Shared scanner for the extension wildcard re-export guards.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepoRoot } from "./repo-root.mjs";

const repoRoot = resolveRepoRoot(import.meta.url);
const guardedFileNames = new Set(["api.ts", "runtime-api.ts"]);
const recursivelySkippedDirectories = new Set(["node_modules", ".git", "dist"]);

type ScriptIo = {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
};

export type ExtensionWildcardReexportPolicy = {
  fileScope: "all-extension-api-files" | "extension-root-api-files";
  pattern: RegExp;
  successMessage: string;
  findingsMessage: string;
  remediationMessage: string;
};

async function isFileFollowingLinks(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function listGuardedFiles(policy: ExtensionWildcardReexportPolicy) {
  const files: string[] = [];
  const recursive = policy.fileScope === "all-extension-api-files";

  async function visit(dir: string, depth: number) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          (!recursive && depth > 0) ||
          (recursive && recursivelySkippedDirectories.has(entry.name))
        ) {
          continue;
        }
        await visit(filePath, depth + 1);
        continue;
      }
      if (!guardedFileNames.has(entry.name) || (!recursive && depth !== 1)) {
        continue;
      }
      // The root-only SDK guard historically follows API barrel symlinks; the
      // recursive local-barrel guard intentionally retains Dirent semantics.
      if (recursive ? entry.isFile() : await isFileFollowingLinks(filePath)) {
        files.push(filePath);
      }
    }
  }

  await visit(path.join(repoRoot, "extensions"), 0);
  return files.toSorted((left, right) => left.localeCompare(right));
}

function findWildcardReexportLines(source: string, pattern: RegExp) {
  return source
    .split(/\r?\n/u)
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => pattern.test(text));
}

async function collectWildcardReexports(policy: ExtensionWildcardReexportPolicy) {
  const findings = [];
  for (const filePath of await listGuardedFiles(policy)) {
    const source = await fs.readFile(filePath, "utf8");
    for (const match of findWildcardReexportLines(source, policy.pattern)) {
      findings.push({
        file: path.relative(repoRoot, filePath).split(path.sep).join("/"),
        line: match.line,
        text: match.text.trim(),
      });
    }
  }
  return findings.toSorted(
    (left, right) => left.file.localeCompare(right.file) || left.line - right.line,
  );
}

export function createExtensionWildcardReexportScanner(policy: ExtensionWildcardReexportPolicy) {
  async function main(argv = process.argv.slice(2), io: ScriptIo = process) {
    const findings = await collectWildcardReexports(policy);
    if (argv.includes("--json")) {
      io.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
    } else if (findings.length === 0) {
      io.stdout.write(`${policy.successMessage}\n`);
    } else {
      io.stderr.write(`${policy.findingsMessage}\n`);
      for (const finding of findings) {
        io.stderr.write(`- ${finding.file}:${finding.line} ${finding.text}\n`);
      }
      io.stderr.write(`${policy.remediationMessage}\n`);
    }
    return findings.length === 0 ? 0 : 1;
  }

  async function exitIfMain(importMetaUrl: string) {
    if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(importMetaUrl)) {
      process.exit(await main());
    }
  }

  return {
    exitIfMain,
    findLines: (source: string) => findWildcardReexportLines(source, policy.pattern),
    main,
  };
}
