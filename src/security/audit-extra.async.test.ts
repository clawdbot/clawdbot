import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  collectInstalledSkillsCodeSafetyFindings,
  collectPluginsCodeSafetyFindings,
} from "./audit-extra.async.js";
import * as skillScanner from "./skill-scanner.js";

vi.mock("../agents/skills.js", () => ({
  loadWorkspaceSkillEntries: (workspaceDir: string) => {
    const sep = workspaceDir.includes("\\") ? "\\" : "/";
    const baseDir = `${workspaceDir}${sep}skills${sep}evil-skill`;
    return [
      {
        skill: {
          baseDir,
          description: "test skill",
          filePath: `${baseDir}${sep}SKILL.md`,
          name: "evil-skill",
          source: "user",
        },
        frontmatter: {},
      },
    ];
  },
}));

describe("audit-extra async code safety", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let sharedCodeSafetyStateDir = "";
  let sharedCodeSafetyWorkspaceDir = "";

  const makeTmpDir = async (label: string) => {
    const dir = path.join(fixtureRoot, `case-${caseId++}-${label}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  const createSharedCodeSafetyFixture = async () => {
    const stateDir = await makeTmpDir("audit-scanner-shared");
    const workspaceDir = path.join(stateDir, "workspace");
    const pluginDir = path.join(stateDir, "extensions", "evil-plugin");
    const skillDir = path.join(workspaceDir, "skills", "evil-skill");

    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "evil-plugin",
        openclaw: { extensions: [".hidden/index.js"] },
      }),
    );

    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      `---
name: evil-skill
description: test skill
---

# evil-skill
`,
      "utf-8",
    );

    return { stateDir, workspaceDir };
  };

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-security-audit-async-"));
    const codeSafetyFixture = await createSharedCodeSafetyFixture();
    sharedCodeSafetyStateDir = codeSafetyFixture.stateDir;
    sharedCodeSafetyWorkspaceDir = codeSafetyFixture.workspaceDir;
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports detailed code-safety issues for both plugins and skills", async () => {
    vi.spyOn(skillScanner, "scanDirectoryWithSummary").mockImplementation(async (dirPath) => {
      const isPlugin = dirPath.includes(`${path.sep}evil-plugin`);
      const file = isPlugin
        ? path.join(dirPath, ".hidden", "index.js")
        : path.join(dirPath, "runner.js");
      return {
        scannedFiles: 1,
        critical: 1,
        warn: 0,
        info: 0,
        findings: [
          {
            ruleId: "dangerous-exec",
            severity: "critical",
            file,
            line: 1,
            message: "dangerous exec",
            evidence: "exec(...)",
          },
        ],
      };
    });

    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: sharedCodeSafetyWorkspaceDir } },
    };
    const [pluginFindings, skillFindings] = await Promise.all([
      collectPluginsCodeSafetyFindings({ stateDir: sharedCodeSafetyStateDir }),
      collectInstalledSkillsCodeSafetyFindings({ cfg, stateDir: sharedCodeSafetyStateDir }),
    ]);

    const pluginFinding = pluginFindings.find(
      (finding) => finding.checkId === "plugins.code_safety" && finding.severity === "critical",
    );
    expect(pluginFinding).toBeDefined();
    expect(pluginFinding?.detail).toContain("dangerous-exec");
    expect(pluginFinding?.detail).toMatch(/\.hidden[\\/]+index\.js:\d+/);

    const skillFinding = skillFindings.find(
      (finding) => finding.checkId === "skills.code_safety" && finding.severity === "critical",
    );
    expect(skillFinding).toBeDefined();
    expect(skillFinding?.detail).toContain("dangerous-exec");
    expect(skillFinding?.detail).toMatch(/runner\.js:\d+/);
  });

  it("flags plugin extension entry path traversal in deep audit", async () => {
    const tmpDir = await makeTmpDir("audit-scanner-escape");
    const pluginDir = path.join(tmpDir, "extensions", "escape-plugin");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "escape-plugin",
        openclaw: { extensions: ["../outside.js"] },
      }),
    );
    await fs.writeFile(path.join(pluginDir, "index.js"), "export {};");

    const findings = await collectPluginsCodeSafetyFindings({ stateDir: tmpDir });
    expect(findings.some((f) => f.checkId === "plugins.code_safety.entry_escape")).toBe(true);
  });

  it("surfaces manifest_parse_error finding when plugin package.json is malformed JSON", async () => {
    const tmpDir = await makeTmpDir("audit-manifest-parse-error");
    const pluginDir = path.join(tmpDir, "extensions", "broken-plugin");
    await fs.mkdir(pluginDir, { recursive: true });
    // Deliberately malformed JSON — simulates a plugin corrupting its manifest
    // to hide declared extension entrypoints from the deep code scanner.
    await fs.writeFile(path.join(pluginDir, "package.json"), "{ not valid json !!!", "utf-8");

    const findings = await collectPluginsCodeSafetyFindings({ stateDir: tmpDir });
    const finding = findings.find((f) => f.checkId === "plugins.code_safety.manifest_parse_error");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("warn");
    expect(finding?.detail).toContain("broken-plugin");
    // Deep scan should still continue (scan_failed should NOT be emitted for the same plugin)
    expect(
      findings.some(
        (f) =>
          f.checkId === "plugins.code_safety.scan_failed" && f.detail?.includes("broken-plugin"),
      ),
    ).toBe(false);
  });

  it("reports scan_failed when plugin code scanner throws during deep audit", async () => {
    const scanSpy = vi
      .spyOn(skillScanner, "scanDirectoryWithSummary")
      .mockRejectedValueOnce(new Error("boom"));

    try {
      const tmpDir = await makeTmpDir("audit-scanner-throws");
      const pluginDir = path.join(tmpDir, "extensions", "scanfail-plugin");
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(
        path.join(pluginDir, "package.json"),
        JSON.stringify({
          name: "scanfail-plugin",
          openclaw: { extensions: ["index.js"] },
        }),
      );
      await fs.writeFile(path.join(pluginDir, "index.js"), "export {};");

      const findings = await collectPluginsCodeSafetyFindings({ stateDir: tmpDir });
      expect(findings.some((f) => f.checkId === "plugins.code_safety.scan_failed")).toBe(true);
    } finally {
      scanSpy.mockRestore();
    }
  });
});
