import fs from "node:fs/promises";
import path from "node:path";

const codexRepo = process.env.OPENCLAW_CODEX_REPO
  ? path.resolve(process.env.OPENCLAW_CODEX_REPO)
  : path.resolve(process.cwd(), "../codex");

const sourceRoot = path.join(codexRepo, "codex-rs/app-server-protocol/schema");
const targetRoot = path.resolve(
  process.cwd(),
  "extensions/codex/src/app-server/protocol-generated",
);

const selectedJsonSchemas = [
  "DynamicToolCallParams.json",
  "v2/ErrorNotification.json",
  "v2/GetAccountResponse.json",
  "v2/ModelListResponse.json",
  "v2/ThreadResumeResponse.json",
  "v2/ThreadStartResponse.json",
  "v2/TurnCompletedNotification.json",
  "v2/TurnStartResponse.json",
] as const;

await fs.rm(targetRoot, { recursive: true, force: true });
await fs.mkdir(targetRoot, { recursive: true });
await fs.cp(path.join(sourceRoot, "typescript"), path.join(targetRoot, "typescript"), {
  recursive: true,
});
await rewriteTypeScriptImports(path.join(targetRoot, "typescript"));

for (const schema of selectedJsonSchemas) {
  await fs.mkdir(path.dirname(path.join(targetRoot, "json", schema)), { recursive: true });
  await fs.copyFile(path.join(sourceRoot, "json", schema), path.join(targetRoot, "json", schema));
}

console.log(`Synced Codex app-server generated protocol from ${sourceRoot}`);

async function rewriteTypeScriptImports(root: string): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        await rewriteTypeScriptImports(fullPath);
        return;
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) {
        return;
      }
      const text = await fs.readFile(fullPath, "utf8");
      await fs.writeFile(
        fullPath,
        text
          .replace(/(from\s+["'])(\.{1,2}\/[^"']+?)(\.js)?(["'])/g, "$1$2.js$4")
          .replace('export * as v2 from "./v2.js";', 'export * as v2 from "./v2/index.js";')
          .replaceAll("| null | null", "| null"),
      );
    }),
  );
}
