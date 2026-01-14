import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

type ParsedArgs = {
  maxLines: number;
};

function parseArgs(argv: string[]): ParsedArgs {
  let maxLines = 500;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--max") {
      const next = argv[index + 1];
      if (!next || Number.isNaN(Number(next))) throw new Error("Missing/invalid --max value");
      maxLines = Number(next);
      index++;
      continue;
    }
  }

  return { maxLines };
}

function gitLsFilesAll(): string[] {
  // Include untracked files too so local refactors don’t “pass” by accident.
  const stdout = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
  });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function countLines(filePath: string): Promise<number> {
  const content = await readFile(filePath, "utf8");
  // Count physical lines. Keeps the rule simple + predictable.
  return content.split("\n").length;
}

async function main() {
  // Makes `... | head` safe.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });

  const { maxLines } = parseArgs(process.argv.slice(2));
  const files = gitLsFilesAll()
    .filter((filePath) => existsSync(filePath))
    .filter((filePath) => filePath.endsWith(".ts") || filePath.endsWith(".tsx"));

  const results = await Promise.all(
    files.map(async (filePath) => ({ filePath, lines: await countLines(filePath) })),
  );

  const offenders = results
    .filter((result) => result.lines > maxLines)
    .sort((a, b) => b.lines - a.lines);

  if (!offenders.length) return;

  // Minimal, grep-friendly output.
  for (const offender of offenders) {
    // eslint-disable-next-line no-console
    console.log(`${offender.lines}\t${offender.filePath}`);
  }

  process.exitCode = 1;
}

await main();
