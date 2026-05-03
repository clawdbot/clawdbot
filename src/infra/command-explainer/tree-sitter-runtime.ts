import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import * as TreeSitter from "web-tree-sitter";

const require = createRequire(import.meta.url);

let parserPromise: Promise<TreeSitter.Parser> | null = null;
let parserLoader: () => Promise<TreeSitter.Parser> = loadParser;
const MAX_COMMAND_EXPLANATION_SOURCE_CHARS = 128 * 1024;
const MAX_COMMAND_EXPLANATION_PARSE_MS = 500;

export function resolvePackageFileForCommandExplanation(
  packageName: string,
  fileName: string,
): string {
  let packageEntry: string;
  try {
    packageEntry = require.resolve(packageName);
  } catch (error) {
    throw new Error(
      `Unable to resolve ${packageName} while loading the shell command explainer parser`,
      { cause: error },
    );
  }

  let directory = path.dirname(packageEntry);
  const searched: string[] = [];
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = path.join(directory, fileName);
    searched.push(candidate);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  throw new Error(
    `Unable to locate ${fileName} in ${packageName} while loading the shell command explainer parser; searched ${searched.join(", ")}`,
  );
}

function resolveWebTreeSitterFile(fileName: string): string {
  return resolvePackageFileForCommandExplanation("web-tree-sitter", fileName);
}

function resolveBashWasmPath(): string {
  return resolvePackageFileForCommandExplanation("tree-sitter-bash", "tree-sitter-bash.wasm");
}

async function loadParser(): Promise<TreeSitter.Parser> {
  await TreeSitter.Parser.init({
    locateFile: resolveWebTreeSitterFile,
  });
  const language = await TreeSitter.Language.load(resolveBashWasmPath());
  const parser = new TreeSitter.Parser();
  parser.setLanguage(language);
  return parser;
}

export function getBashParserForCommandExplanation(): Promise<TreeSitter.Parser> {
  parserPromise ??= parserLoader().catch((error: unknown) => {
    parserPromise = null;
    throw error;
  });
  return parserPromise;
}

export function setBashParserLoaderForCommandExplanationForTest(
  loader?: () => Promise<TreeSitter.Parser>,
): void {
  parserPromise = null;
  parserLoader = loader ?? loadParser;
}

/**
 * Low-level parser access for tests and parser diagnostics.
 * Callers own the returned Tree and must call tree.delete().
 * Prefer explainShellCommand for normal command-explainer use.
 */
export async function parseBashForCommandExplanation(source: string): Promise<TreeSitter.Tree> {
  if (source.length > MAX_COMMAND_EXPLANATION_SOURCE_CHARS) {
    throw new Error("Shell command is too large to explain");
  }
  const parser = await getBashParserForCommandExplanation();
  const deadlineMs = performance.now() + MAX_COMMAND_EXPLANATION_PARSE_MS;
  let timedOut = false;
  const tree = parser.parse(source, null, {
    progressCallback: () => {
      timedOut = performance.now() > deadlineMs;
      return timedOut;
    },
  });
  if (!tree) {
    parser.reset();
    if (timedOut) {
      throw new Error(
        `tree-sitter-bash timed out after ${MAX_COMMAND_EXPLANATION_PARSE_MS}ms while parsing shell command`,
      );
    }
    throw new Error("tree-sitter-bash returned no parse tree");
  }
  return tree;
}
