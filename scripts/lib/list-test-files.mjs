import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function listTrackedTestFiles(rootDir, suffix = ".test.ts") {
  const result = spawnSync("git", ["ls-files", "--", rootDir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status === 0) {
    return result.stdout
      .split("\n")
      .map((line) => line.trim().replaceAll("\\", "/"))
      .filter((line) => line.endsWith(suffix))
      .toSorted((a, b) => a.localeCompare(b));
  }

  if (!existsSync(rootDir)) {
    return [];
  }

  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(suffix)) {
        files.push(path.replaceAll("\\", "/"));
      }
    }
  };

  visit(rootDir);
  return files.toSorted((a, b) => a.localeCompare(b));
}
