import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  CORE_HEALTH_CHECKS,
  registerCoreHealthChecks,
  resetCoreHealthChecksForTest,
} from "./doctor-core-checks.js";
import {
  clearHealthChecksForTest,
  listHealthChecks,
  registerHealthCheck,
} from "./health-check-registry.js";

describe("registerCoreHealthChecks", () => {
  let tmp: string | undefined;

  beforeEach(() => {
    clearHealthChecksForTest();
    resetCoreHealthChecksForTest();
  });

  afterEach(async () => {
    if (tmp !== undefined) {
      await fs.rm(tmp, { recursive: true, force: true });
      tmp = undefined;
    }
  });

  it("registers the built-in health checks once", () => {
    registerCoreHealthChecks();
    registerCoreHealthChecks();

    expect(listHealthChecks().map((check) => check.id)).toEqual([
      "core/doctor/gateway-config",
      "core/doctor/command-owner",
      "core/doctor/workspace-status",
      "core/doctor/skills-readiness",
      "core/doctor/browser-clawd-profile-residue",
      "core/doctor/final-config-validation",
    ]);
  });

  it("can retry after a duplicate registration failure is cleared", () => {
    registerHealthCheck({
      id: "core/doctor/gateway-config",
      kind: "core",
      description: "duplicate",
      async detect() {
        return [];
      },
    });

    expect(() => registerCoreHealthChecks()).toThrow("health check already registered");

    clearHealthChecksForTest();
    registerCoreHealthChecks();

    expect(listHealthChecks()).toHaveLength(6);
  });

  it("shows the repair-capable health check shape with skills readiness", async () => {
    tmp = await fs.mkdtemp(join(tmpdir(), "openclaw-health-skills-"));
    const skillDir = join(tmp, "skills", "missing-tool");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      join(skillDir, "SKILL.md"),
      `---
name: missing-tool
description: Missing tool
metadata: '{"openclaw":{"requires":{"bins":["openclaw-test-missing-skill-bin"]}}}'
---

# Missing tool
`,
      "utf-8",
    );
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: tmp,
          skills: ["missing-tool"],
        },
      },
    };
    const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/skills-readiness");

    expect(check?.repair).toBeTypeOf("function");

    const findings = await check?.detect({
      mode: "lint",
      runtime: { log() {}, error() {}, exit() {} },
      cfg,
      cwd: tmp,
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/skills-readiness",
        severity: "warning",
        path: "skills.entries.missing-tool.enabled",
      }),
    );
    await expect(
      check?.detect(
        {
          mode: "fix",
          runtime: { log() {}, error() {}, exit() {} },
          cfg,
          cwd: tmp,
        },
        { paths: ["skills.entries.other-tool.enabled"] },
      ),
    ).resolves.toEqual([]);
    await expect(
      check?.detect(
        {
          mode: "fix",
          runtime: { log() {}, error() {}, exit() {} },
          cfg,
          cwd: tmp,
        },
        { paths: ["skills.entries.missing-tool.enabled"] },
      ),
    ).resolves.toContainEqual(
      expect.objectContaining({
        path: "skills.entries.missing-tool.enabled",
      }),
    );

    const repaired = await check?.repair?.(
      {
        mode: "fix",
        runtime: { log() {}, error() {}, exit() {} },
        cfg,
        cwd: tmp,
      },
      findings ?? [],
    );
    expect(repaired?.config?.skills?.entries?.["missing-tool"]).toEqual({ enabled: false });
    expect(repaired?.changes).toContain("Disabled unavailable skill missing-tool.");
    expect(repaired?.effects).toContainEqual(
      expect.objectContaining({
        kind: "config",
        action: "disable-skill",
        target: "skills.entries.missing-tool.enabled",
      }),
    );
  });
});
