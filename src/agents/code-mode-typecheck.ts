/** Optional, worker-owned compiler program. No guest module or filesystem resolution. */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ToolInputError } from "./tool-input-error.js";

export async function checkCodeModeTypes(
  ts: typeof import("typescript"),
  code: string,
  options: { declarations: string; maxBytes: number },
): Promise<void> {
  const files = new Map<string, string>();
  let bytes = 0;
  const add = (name: string, text: string) => {
    bytes += Buffer.byteLength(text, "utf8");
    // Reuse the existing allowance, not an additional configurable memory budget.
    if (bytes > options.maxBytes) {
      throw new ToolInputError(
        "TypeScript preflight input exceeds the existing memory allowance; narrow the program or catalog.",
      );
    }
    files.set(name, text);
  };
  add("user.ts", "async function __openclawPreflight() {\n" + code + "\n}");
  add("guest.d.ts", options.declarations);
  const libDir = dirname(createRequire(import.meta.url).resolve("typescript"));
  const loadLib = async (name: string): Promise<void> => {
    if (files.has(name)) {
      return;
    }
    if (!/^lib\.[a-z0-9.]+\.d\.ts$/u.test(name)) {
      throw new ToolInputError("Invalid preflight standard library.");
    }
    const text = await readFile(join(libDir, name), "utf8");
    add(name, text);
    for (const ref of ts.preProcessFile(text).libReferenceDirectives) {
      await loadLib("lib." + ref.fileName + ".d.ts");
    }
  };
  await loadLib("lib.es2022.d.ts");
  const host: import("typescript").CompilerHost = {
    getSourceFile: (name, target) => {
      const text = files.get(name);
      return text === undefined ? undefined : ts.createSourceFile(name, text, target, true);
    },
    getDefaultLibFileName: () => "lib.es2022.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    fileExists: (name) => files.has(name),
    readFile: (name) => files.get(name),
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram(
    [...files.keys()],
    {
      strict: true,
      noEmit: true,
      noLib: true,
      noResolve: true,
      types: [],
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
    },
    host,
  );
  const failure = ts
    .getPreEmitDiagnostics(program)
    .find((d) => d.category === ts.DiagnosticCategory.Error);
  if (failure) {
    const point =
      failure.file && failure.start !== undefined
        ? failure.file.getLineAndCharacterOfPosition(failure.start)
        : undefined;
    const location =
      failure.file?.fileName === "user.ts" && point
        ? "openclaw-code-mode:user.ts:" +
          Math.max(1, point.line) +
          ":" +
          (point.character + 1) +
          ": "
        : "";
    throw new ToolInputError(
      "TypeScript preflight failed: " +
        location +
        ts.flattenDiagnosticMessageText(failure.messageText, "\n"),
    );
  }
}
