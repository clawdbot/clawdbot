import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function listShellScripts(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const scripts: string[] = [];

  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scripts.push(...(await listShellScripts(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".sh")) {
      scripts.push(entryPath);
    }
  }

  return scripts;
}

describe("e2e shell tempfile hygiene", () => {
  it("does not allocate FIFO paths with mktemp -u", async () => {
    const offenders: string[] = [];

    for (const scriptPath of await listShellScripts("scripts/e2e")) {
      const contents = await readFile(path.resolve(scriptPath), "utf8");
      if (contents.includes("mktemp -u")) {
        offenders.push(scriptPath);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("preserves wizard exit status when reporting failures", async () => {
    const contents = await readFile("scripts/e2e/lib/onboard/scenario.sh", "utf8");

    expect(contents).not.toContain('if ! wait "$wizard_pid"');
    expect(contents).toContain('wait "$wizard_pid" || wizard_status=$?');
  });
});
