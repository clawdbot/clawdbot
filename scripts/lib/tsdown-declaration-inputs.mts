import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { BuildContext } from "tsdown";
import type ts from "typescript";
import { portableRelativePath } from "./build-artifact-cache.mts";

const stagePrefix = (root: string) =>
  path.join(fs.realpathSync(root), ".artifacts/plugin-sdk-staging-");
const receiptPath = (output: string, name: string) =>
  path.join(output, "..", "compiler-inputs", `${name}.json`);

export function createDeclarationStage(root: string) {
  return fs.mkdtempSync(stagePrefix(root));
}

/** Requests and receipts belong only to the writer's fresh, joined private stage. */
export function requestDeclarationInputs(output: string, name: string, roots: string[]) {
  const file = receiptPath(output, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ roots }), { flag: "wx" });
}

export function createDeclarationInputCapture(name: string) {
  return async ({ options }: BuildContext) => {
    const stage = path.dirname(options.outDir);
    const prefix = stagePrefix(options.cwd);
    // Only the writer's private stage owns receipts. A direct build's sibling
    // compiler-inputs directory is ordinary checkout data, even if names match.
    if (
      path.basename(options.outDir) !== "dist" ||
      path.dirname(stage) !== path.dirname(prefix) ||
      !stage.startsWith(prefix)
    ) {
      return;
    }
    const file = receiptPath(options.outDir, name);
    if (!fs.existsSync(file)) {
      return;
    }
    const request: { roots: string[] } = JSON.parse(fs.readFileSync(file, "utf8"));
    const require = createRequire(import.meta.url);
    const fromTsdown = createRequire(require.resolve("tsdown"));
    const { globalContext }: { globalContext: { programs: ts.Program[] } } = await import(
      pathToFileURL(fromTsdown.resolve("rolldown-plugin-dts/tsc-context")).href
    );
    const roots = new Set(
      globalContext.programs.flatMap((program) =>
        program.getRootFileNames().map((root) => fs.realpathSync(root)),
      ),
    );
    if (
      request.roots.some((root) => !roots.has(fs.realpathSync(path.resolve(options.cwd, root))))
    ) {
      throw new Error(`Incomplete compiler membership for ${name}`);
    }
    const inputs = [
      ...new Set(
        globalContext.programs.flatMap((program) =>
          program
            .getSourceFiles()
            .map((source) => portableRelativePath(options.cwd, source.fileName)),
        ),
      ),
    ].toSorted();
    fs.writeFileSync(file, JSON.stringify({ ...request, inputs }));
  };
}

export function readDeclarationInputs(output: string, groups: readonly string[]) {
  return [
    ...new Set(
      groups.flatMap((name) => {
        const receipt: { roots: string[]; inputs?: unknown } = JSON.parse(
          fs.readFileSync(receiptPath(output, name), "utf8"),
        );
        if (
          !Array.isArray(receipt.inputs) ||
          // Bounded selections can leave empty partitions; only those requests
          // may finish successfully without creating a compiler Program.
          (!receipt.inputs.length && receipt.roots.length > 0) ||
          !receipt.inputs.every((input): input is string => typeof input === "string")
        ) {
          throw new Error(`Missing successful compiler membership for ${name}`);
        }
        return receipt.inputs;
      }),
    ),
  ].toSorted();
}
