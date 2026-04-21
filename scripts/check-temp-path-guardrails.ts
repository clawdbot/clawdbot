import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

type QuoteChar = "'" | '"' | "`";

type QuoteScanState = {
  quote: QuoteChar | null;
  escaped: boolean;
};

type RuntimeSourceGuardrailFile = {
  relativePath: string;
  source: string;
};

const WEAK_RANDOM_SAME_LINE_PATTERN =
  /(?:Date\.now[^\r\n]*Math\.random|Math\.random[^\r\n]*Date\.now)/u;
const PATH_JOIN_CALL_PATTERN = /path\s*\.\s*join\s*\(/u;
const OS_TMPDIR_CALL_PATTERN = /os\s*\.\s*tmpdir\s*\(/u;
const FILE_READ_CONCURRENCY = 24;
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

function shouldSkipGuardrailRuntimeSource(relativePath: string): boolean {
  return DEFAULT_GUARDRAIL_SKIP_PATTERNS.some((pattern) => pattern.test(relativePath));
}

function stripCommentsForScan(input: string): string {
  return input.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function beginQuotedSection(state: QuoteScanState, ch: string): boolean {
  if (ch !== "'" && ch !== '"' && ch !== "`") {
    return false;
  }
  state.quote = ch;
  return true;
}

function consumeQuotedChar(state: QuoteScanState, ch: string): boolean {
  if (!state.quote) {
    return false;
  }
  if (state.escaped) {
    state.escaped = false;
    return true;
  }
  if (ch === "\\") {
    state.escaped = true;
    return true;
  }
  if (ch === state.quote) {
    state.quote = null;
  }
  return true;
}

function findMatchingParen(source: string, openIndex: number): number {
  let depth = 1;
  const quoteState: QuoteScanState = { quote: null, escaped: false };
  for (let i = openIndex + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (consumeQuotedChar(quoteState, ch)) {
      continue;
    }
    if (beginQuotedSection(quoteState, ch)) {
      continue;
    }
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function splitTopLevelArguments(source: string): string[] {
  const out: string[] = [];
  let current = "";
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  const quoteState: QuoteScanState = { quote: null, escaped: false };
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoteState.quote) {
      current += ch;
      consumeQuotedChar(quoteState, ch);
      continue;
    }
    if (beginQuotedSection(quoteState, ch)) {
      current += ch;
      continue;
    }
    if (ch === "(") {
      parenDepth += 1;
      current += ch;
      continue;
    }
    if (ch === ")") {
      if (parenDepth > 0) {
        parenDepth -= 1;
      }
      current += ch;
      continue;
    }
    if (ch === "[") {
      bracketDepth += 1;
      current += ch;
      continue;
    }
    if (ch === "]") {
      if (bracketDepth > 0) {
        bracketDepth -= 1;
      }
      current += ch;
      continue;
    }
    if (ch === "{") {
      braceDepth += 1;
      current += ch;
      continue;
    }
    if (ch === "}") {
      if (braceDepth > 0) {
        braceDepth -= 1;
      }
      current += ch;
      continue;
    }
    if (ch === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) {
    out.push(current.trim());
  }
  return out;
}

function isOsTmpdirExpression(argument: string): boolean {
  return /^os\s*\.\s*tmpdir\s*\(\s*\)$/u.test(argument.trim());
}

function mightContainDynamicTmpdirJoin(source: string): boolean {
  if (!source.includes("path") || !source.includes("join") || !source.includes("tmpdir")) {
    return false;
  }
  return (
    (source.includes("path.join") || PATH_JOIN_CALL_PATTERN.test(source)) &&
    (source.includes("os.tmpdir") || OS_TMPDIR_CALL_PATTERN.test(source)) &&
    source.includes("`") &&
    source.includes("${")
  );
}

function hasDynamicTmpdirJoin(source: string): boolean {
  if (!mightContainDynamicTmpdirJoin(source)) {
    return false;
  }

  const scanSource = stripCommentsForScan(source);
  const joinPattern = /path\s*\.\s*join\s*\(/gu;
  let match: RegExpExecArray | null = joinPattern.exec(scanSource);
  while (match) {
    const openParenIndex = scanSource.indexOf("(", match.index);
    if (openParenIndex !== -1) {
      const closeParenIndex = findMatchingParen(scanSource, openParenIndex);
      if (closeParenIndex !== -1) {
        const argsSource = scanSource.slice(openParenIndex + 1, closeParenIndex);
        const args = splitTopLevelArguments(argsSource);
        if (args.length >= 2 && isOsTmpdirExpression(args[0])) {
          for (const arg of args.slice(1)) {
            const trimmed = arg.trim();
            if (trimmed.startsWith("`") && trimmed.includes("${")) {
              return true;
            }
          }
        }
      }
    }
    match = joinPattern.exec(scanSource);
  }
  return false;
}

function listTrackedRuntimeSourceFiles(repoRoot: string): string[] {
  const stdout = execFileSync("git", ["-C", repoRoot, "ls-files", "--", "src", "extensions"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .filter((relativePath) => relativePath.endsWith(".ts") || relativePath.endsWith(".tsx"))
    .filter((relativePath) => !shouldSkipGuardrailRuntimeSource(relativePath))
    .map((relativePath) => path.join(repoRoot, relativePath));
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

async function main() {
  const repoRoot = process.cwd();
  const files = await readRuntimeSourceFiles(repoRoot, listTrackedRuntimeSourceFiles(repoRoot));
  const offenders: string[] = [];
  const weakRandomMatches: string[] = [];

  for (const file of files) {
    const source = file.source;
    const mightContainTmpdirJoin =
      source.includes("tmpdir") &&
      source.includes("path") &&
      source.includes("join") &&
      source.includes("`");
    const mightContainWeakRandom = source.includes("Date.now") && source.includes("Math.random");

    if (!mightContainTmpdirJoin && !mightContainWeakRandom) {
      continue;
    }
    if (mightContainTmpdirJoin && hasDynamicTmpdirJoin(source)) {
      offenders.push(file.relativePath);
    }
    if (mightContainWeakRandom && WEAK_RANDOM_SAME_LINE_PATTERN.test(source)) {
      weakRandomMatches.push(file.relativePath);
    }
  }

  if (offenders.length === 0 && weakRandomMatches.length === 0) {
    return;
  }

  if (offenders.length > 0) {
    console.error("Dynamic os.tmpdir()/path.join() template paths found:");
    for (const offender of offenders) {
      console.error(`- ${offender}`);
    }
  }
  if (weakRandomMatches.length > 0) {
    console.error("Weak Date.now()+Math.random() same-line IDs found:");
    for (const offender of weakRandomMatches) {
      console.error(`- ${offender}`);
    }
  }
  process.exitCode = 1;
}

await main();
