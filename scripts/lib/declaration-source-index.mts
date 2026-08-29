import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRunUrl } from "./direct-run.mjs";

/** Discover fresh declaration roots without retaining a compiler graph in the emitter. */
export function discoverDeclarationSources(tsconfig: string, entries: readonly string[]): string[] {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-declaration-sources-"));
  const output = path.join(directory, "sources.json");
  try {
    // Joining the child releases its entire graph before tsdown creates its program.
    // Use an artifact, not a buffered stdout payload proportional to the source tree.
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", fileURLToPath(import.meta.url), tsconfig, output, ...entries],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`Declaration source discovery failed (${result.signal ?? result.status})`);
    }
    const files: unknown = JSON.parse(fs.readFileSync(output, "utf8"));
    if (
      !Array.isArray(files) ||
      !files.every((file): file is string => typeof file === "string") ||
      !entries.every((entry) => files.includes(path.resolve(entry)))
    ) {
      throw new Error("Declaration source discovery returned an incomplete source index");
    }
    return files;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    const [tsconfig, output, ...entries] = process.argv.slice(2);
    if (!tsconfig || !output || entries.length === 0) {
      throw new Error("Expected a tsconfig, output path, and declaration entry sources");
    }
    // Only the discovery child loads TypeScript; the parent retains just file names.
    const { default: ts } = await import("typescript");
    const config = ts.getParsedCommandLineOfConfigFile(path.resolve(tsconfig), undefined, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    });
    if (!config || config.errors.length > 0) {
      throw new Error(
        config?.errors
          .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
          .join("\n") ?? "Unable to read declaration configuration",
      );
    }
    const roots = entries.map((entry) => path.resolve(entry));
    const program = ts.createProgram({
      rootNames: roots,
      options: config.options,
      projectReferences: config.projectReferences,
    });
    for (const entry of roots) {
      if (!program.getSourceFile(entry)) {
        throw new Error(`Missing declaration entry source: ${entry}`);
      }
    }
    // The declaration plugin never requests generation for installed dependency files.
    const files = program
      .getSourceFiles()
      .map((source) => path.resolve(source.fileName))
      .filter((file) => !file.split(/[\\/]/u).includes("node_modules"))
      .toSorted();
    fs.writeFileSync(output, `${JSON.stringify(files)}\n`, { flag: "wx" });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("[declaration-source-index] FAILED (exit 1)");
    process.exitCode = 1;
  }
}
