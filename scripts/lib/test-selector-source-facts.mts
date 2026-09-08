// Pre-install test selectors need a Node-only read boundary; no package or application imports.
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const IMPORT_SPECIFIER_PATTERN =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;
type SourceFile = { file: string; parseImports: boolean };

function parseStrings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === "string")) {
    throw new Error("Expected a string array in test selector source scan");
  }
  return value;
}

function parseFacts(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    !("imports" in value) ||
    !("matches" in value) ||
    !("references" in value)
  ) {
    throw new Error("Invalid test selector source facts");
  }
  return {
    imports: parseStrings(value.imports),
    matches: parseStrings(value.matches),
    references: parseStrings(value.references),
  };
}

/** Acquires complete JS-parsed facts with bounded asynchronous reads, joining one native child. */
export function readTestSelectorSourceFacts(
  cwd: string,
  files: SourceFile[],
  terms: string[],
  maxBuffer: number,
) {
  if (files.length === 0) {
    return [];
  }
  // The selector API is synchronous. A finite child owns the async reads and
  // exits before we return; inheriting loader hooks would reintroduce tsx work.
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd,
    env,
    input: JSON.stringify({ files, terms }),
    encoding: "utf8",
    maxBuffer,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0 || result.signal) {
    throw new Error(
      `Test selector source scan failed (${result.signal ?? result.status}): ${result.stderr}`,
      { cause: result.error },
    );
  }
  // Position is the file identity: require every requested row, including unreadable files.
  const rows: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(rows) || rows.length !== files.length) {
    throw new Error("Invalid test selector source scan row count");
  }
  return rows.flatMap((row: unknown, index) =>
    row === null ? [] : [{ file: files[index]!.file, ...parseFacts(row) }],
  );
}

async function readSourceFacts() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  const request: unknown = JSON.parse(input);
  if (
    !request ||
    typeof request !== "object" ||
    !("files" in request) ||
    !Array.isArray(request.files) ||
    !("terms" in request)
  ) {
    throw new Error("Invalid test selector source scan request");
  }
  const files = request.files.map((value: unknown): SourceFile => {
    if (
      !value ||
      typeof value !== "object" ||
      !("file" in value) ||
      typeof value.file !== "string" ||
      !("parseImports" in value) ||
      typeof value.parseImports !== "boolean"
    ) {
      throw new Error("Invalid test selector source scan file");
    }
    return { file: value.file, parseImports: value.parseImports };
  });
  const terms = parseStrings(request.terms);
  const readFacts = async ({ file, parseImports }: SourceFile) => {
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch {
      // Git inventories include deleted files; preserve the selector's unreadable-file behavior.
      return null;
    }
    const specifiers = (pattern: RegExp) =>
      parseImports
        ? [
            ...new Set(
              [...source.matchAll(pattern)]
                .map((match) => match[1] ?? match[2] ?? "")
                .filter((specifier) => specifier.startsWith(".")),
            ),
          ]
        : [];
    const matches = terms.filter((term) => source.includes(term));
    const tokens = matches.length > 0 ? new Set(source.match(/[A-Za-z0-9_.@+/-]{4,}/gu)) : null;
    return {
      imports: specifiers(IMPORT_SPECIFIER_PATTERN),
      matches,
      references: matches.filter((term) => tokens?.has(term)),
    };
  };
  const facts: (ReturnType<typeof parseFacts> | null)[] = files.map(() => null);
  const failures: unknown[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(32, files.length) }, async () => {
      while (next < files.length) {
        const index = next++;
        try {
          facts[index] = await readFacts(files[index]!);
        } catch (error) {
          failures.push(error);
        }
      }
    }),
  );
  // Join every read, including after a scan failure, before publishing or failing.
  if (failures.length > 0) {
    throw new AggregateError(failures, "Test selector source scan failed");
  }
  process.stdout.write(JSON.stringify(facts));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await readSourceFacts();
  } catch (error) {
    console.error(error);
    console.error("[test-selector-source-facts] FAILED (exit 1)");
    process.exitCode = 1;
  }
}
