// Repository skill content tests hold shipped skill instructions to the scanner's critical rules.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listGitTrackedFiles, toRepoPath } from "../../test-utils/repo-files.js";
import { scanSkillContent } from "./scanner.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Skills are instructions an agent executes on the maintainer's own machine, so a critical
// scanner pattern here (pipe-to-shell installs, secret exfiltration, prompt injection) is a
// shipped defect, not a proposal-time warning the workshop scanner would catch first.
const CORE_SKILL_ROOTS = [".agents/skills", "skills", "custodian-skills"] as const;

type PluginManifest = {
  skills?: unknown;
};

async function collectSkillFiles(): Promise<string[]> {
  const trackedFiles = listGitTrackedFiles({
    repoRoot,
    pathspecs: [...CORE_SKILL_ROOTS, "extensions"],
  });
  if (trackedFiles === null) {
    throw new Error("Could not enumerate tracked repository skill files");
  }

  const skillFiles = new Set(
    trackedFiles.filter(
      (file) =>
        file.endsWith("/SKILL.md") && CORE_SKILL_ROOTS.some((root) => file.startsWith(`${root}/`)),
    ),
  );
  const manifestPaths = trackedFiles.filter((file) =>
    /^extensions\/[^/]+\/openclaw\.plugin\.json$/u.test(file),
  );

  for (const manifestPath of manifestPaths) {
    const manifest = JSON.parse(
      await fs.readFile(path.join(repoRoot, manifestPath), "utf8"),
    ) as PluginManifest;
    if (!Array.isArray(manifest.skills)) {
      continue;
    }
    for (const rawRoot of manifest.skills) {
      if (typeof rawRoot !== "string" || rawRoot.includes("node_modules")) {
        continue;
      }
      const relativeRoot = toRepoPath(
        path.relative(repoRoot, path.resolve(repoRoot, path.dirname(manifestPath), rawRoot)),
      );
      if (relativeRoot === ".." || relativeRoot.startsWith("../")) {
        continue;
      }
      for (const file of trackedFiles) {
        if (file.startsWith(`${relativeRoot}/`) && file.endsWith("/SKILL.md")) {
          skillFiles.add(file);
        }
      }
    }
  }

  return [...skillFiles].toSorted();
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
