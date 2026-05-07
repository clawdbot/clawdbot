import fs from "node:fs/promises";
import path from "node:path";
import {
  generateExperimentalCodexAppServerProtocolSource,
  selectedCodexAppServerJsonSchemas,
} from "./lib/codex-app-server-protocol-source.js";

const targetRoot = path.resolve(
  process.cwd(),
  "extensions/codex/src/app-server/protocol-generated",
);

const source = await generateExperimentalCodexAppServerProtocolSource();
try {
  await fs.rm(targetRoot, { recursive: true, force: true });
  await fs.mkdir(targetRoot, { recursive: true });

  for (const schema of selectedCodexAppServerJsonSchemas) {
    await fs.mkdir(path.dirname(path.join(targetRoot, "json", schema)), { recursive: true });
    const schemaSource = await fs.readFile(path.join(source.jsonRoot, schema), "utf8");
    await fs.writeFile(
      path.join(targetRoot, "json", schema),
      `${JSON.stringify(JSON.parse(schemaSource), null, 2)}\n`,
    );
  }
} finally {
  await source.cleanup();
}

console.log(`Synced Codex app-server generated protocol from ${source.codexRepo}`);
