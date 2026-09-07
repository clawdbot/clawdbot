// Repository skill content tests hold shipped skill instructions to the scanner's critical rules.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanSkillContent } from "./scanner.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Skills are instructions an agent executes on the maintainer's own machine, so a critical
// scanner pattern here (pipe-to-shell installs, secret exfiltration, prompt injection) is a
// shipped defect, not a proposal-time warning the workshop scanner would catch first.
const SKILL_ROOTS = [".agents/skills", "skills", "custodian-skills"] as const;

async function collectSkillFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const root of SKILL_ROOTS) {
    const entries = await fs.readdir(path.join(repoRoot, root), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const relativePath = path.join(root, entry.name, "SKILL.md");
      const exists = await fs
        .access(path.join(repoRoot, relativePath))
        .then(() => true)
        .catch(() => false);
      if (exists) {
        files.push(relativePath);
      }
    }
  }
  return files.toSorted();
}

describe("repository skill content", () => {
  it("keeps every shipped SKILL.md free of critical scanner findings", async () => {
    const files = await collectSkillFiles();
    expect(files.length).toBeGreaterThan(0);

    const findings: string[] = [];
    for (const relativePath of files) {
      const content = await fs.readFile(path.join(repoRoot, relativePath), "utf8");
      for (const finding of scanSkillContent(content, relativePath)) {
        if (finding.severity === "critical") {
          findings.push(`${relativePath}:${finding.line} ${finding.ruleId}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });
});
