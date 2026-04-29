import fs from "node:fs";
import path from "node:path";

const stageDir = process.argv[2];
const depName = process.argv[3];
const manifestName = ".openclaw-runtime-deps.json";
const matches = [];

function visit(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      visit(fullPath);
      continue;
    }
    if (entry.name !== manifestName) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    } catch {
      continue;
    }
    const specs = Array.isArray(parsed.specs) ? parsed.specs : [];
    for (const spec of specs) {
      if (typeof spec === "string" && spec.startsWith(`${depName}@`)) {
        matches.push(`${fullPath}: ${spec}`);
      }
    }
  }
}

visit(stageDir);
if (matches.length > 0) {
  process.stderr.write(`${matches.join("\n")}\n`);
  process.exit(1);
}
