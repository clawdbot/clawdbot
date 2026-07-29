#!/usr/bin/env node
// Writes the `bin/docs-list` wrapper used by package scripts and docs tooling.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binDir = path.join(root, "bin");
const binPath = path.join(binDir, "docs-list");

fs.mkdirSync(binDir, { recursive: true });

const wrapper = `#!/usr/bin/env node\nimport { spawnSync } from "node:child_process";\nimport path from "node:path";\nimport { fileURLToPath } from "node:url";\n\nconst here = path.dirname(fileURLToPath(import.meta.url));\nconst script = path.join(here, "..", "scripts", "docs-list.js");\n\nconst result = spawnSync(process.execPath, [script], { stdio: "inherit" });\nprocess.exit(result.status ?? 1);\n`;

fs.writeFileSync(binPath, wrapper, { mode: 0o755 });
