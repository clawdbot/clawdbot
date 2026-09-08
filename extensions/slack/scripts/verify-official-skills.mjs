import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = join(pluginRoot, "skills", "_vendor", "slack-skills-plugin.json");

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function main() {
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  const failures = [];
  const digestPattern = /^[0-9a-f]{64}$/;

  for (const file of lock.files) {
    if (!digestPattern.test(file.sourceSha256) || !digestPattern.test(file.vendoredSha256)) {
      failures.push(
        `${file.destination}: source and vendored SHA-256 digests must be lowercase hex`,
      );
      continue;
    }

    const adapted = file.sourceSha256 !== file.vendoredSha256;
    if (adapted && (typeof file.adaptation !== "string" || file.adaptation.trim() === "")) {
      failures.push(`${file.destination}: adapted vendor files must explain their local changes`);
    } else if (!adapted && file.adaptation !== undefined) {
      failures.push(`${file.destination}: unmodified vendor files must not declare an adaptation`);
    }

    const path = join(pluginRoot, file.destination);
    try {
      const actual = sha256(await readFile(path));
      if (actual !== file.vendoredSha256) {
        failures.push(`${file.destination}: expected ${file.vendoredSha256}, got ${actual}`);
      }
    } catch (error) {
      failures.push(`${file.destination}: ${error.message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Slack official skill verification failed:\n${failures.join("\n")}`);
  }

  process.stdout.write(
    `Verified ${lock.files.length} Slack skill vendor files at ${lock.source.revision} (${lock.source.version}).\n`,
  );
}

await main();
