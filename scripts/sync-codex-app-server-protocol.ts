// Sync Codex App Server Protocol script supports OpenClaw repository automation.
import fs from "node:fs/promises";
import path from "node:path";
import {
  compactCodexAppServerProtocolJsonSchemas,
  formatCodexAppServerProtocolJsonText,
  generateExperimentalCodexAppServerProtocolSource,
  selectedCodexAppServerJsonSchemas,
} from "./lib/codex-app-server-protocol-source.js";

const targetRoot = path.resolve(
  process.cwd(),
  "extensions/codex/src/app-server/protocol-generated",
);

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main(): Promise<void> {
  const source = await generateExperimentalCodexAppServerProtocolSource();
  try {
    const selectedSchemas = new Map<string, unknown>();
    for (const schema of selectedCodexAppServerJsonSchemas) {
      const schemaSource = await fs.readFile(path.join(source.jsonRoot, schema), "utf8");
      selectedSchemas.set(schema, JSON.parse(schemaSource));
    }
    const compactedSchemas = compactCodexAppServerProtocolJsonSchemas(selectedSchemas);

    await fs.rm(targetRoot, { recursive: true, force: true });
    await fs.mkdir(targetRoot, { recursive: true });

    for (const [schema, value] of compactedSchemas) {
      await fs.mkdir(path.dirname(path.join(targetRoot, "json", schema)), { recursive: true });
      await fs.writeFile(
        path.join(targetRoot, "json", schema),
        formatCodexAppServerProtocolJsonText(JSON.stringify(value)),
      );
    }
  } finally {
    await source.cleanup();
  }

  console.log(`Synced Codex app-server generated protocol from ${source.codexRepo}`);
}
