import fs from "node:fs/promises";
import path from "node:path";

type CodexProtocolArtifactRoots = {
  jsonRoot: string;
  typescriptRoot: string;
};

export async function stageCodexAppServerProtocolArtifacts(
  sourceRoot: string,
  roots: CodexProtocolArtifactRoots,
): Promise<void> {
  await stageGeneratedArtifactDirectory(sourceRoot, sourceRoot, roots);
}

async function stageGeneratedArtifactDirectory(
  sourceRoot: string,
  currentRoot: string,
  roots: CodexProtocolArtifactRoots,
): Promise<void> {
  const entries = await fs.readdir(currentRoot, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const sourcePath = path.join(currentRoot, entry.name);
      if (entry.isDirectory()) {
        await stageGeneratedArtifactDirectory(sourceRoot, sourcePath, roots);
        return;
      }
      if (!entry.isFile()) {
        return;
      }

      const kind = entry.name.endsWith(".ts")
        ? "typescript"
        : entry.name.endsWith(".json")
          ? "json"
          : undefined;
      if (kind === undefined) {
        return;
      }

      const targetRoot = kind === "typescript" ? roots.typescriptRoot : roots.jsonRoot;
      const targetPath = path.join(targetRoot, path.relative(sourceRoot, sourcePath));
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      if (kind === "json") {
        await fs.copyFile(sourcePath, targetPath);
        return;
      }

      const source = await fs.readFile(sourcePath, "utf8");
      await fs.writeFile(targetPath, normalizeGeneratedTypeScript(source));
    }),
  );
}

function normalizeGeneratedTypeScript(text: string): string {
  // Codex emits TS-oriented relative imports; OpenClaw consumes the staged tree as NodeNext.
  return text
    .replace(/(from\s+["'])(\.{1,2}\/[^"']+?)(\.js)?(["'])/g, "$1$2.js$4")
    .replace('export * as v2 from "./v2.js";', 'export * as v2 from "./v2/index.js";')
    .replaceAll("| null | null", "| null");
}
