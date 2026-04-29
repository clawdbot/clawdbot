import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCiSafeCodexConfig,
  writeCiSafeCodexConfig,
} from "../../scripts/prepare-codex-ci-config.ts";
import { withTempDir } from "../test-utils/temp-dir.js";

describe("prepare-codex-ci-config", () => {
  it("renders a minimal trusted non-interactive Codex config for the target repo", () => {
    expect(
      buildCiSafeCodexConfig({
        projectPath: "/tmp/openclaw-pr-sync.xph5uu",
      }),
    ).toBe(
      [
        "# Generated for Codex CI runs.",
        "# Keep the checked-out repo trusted while avoiding maintainer-local",
        "# provider/profile overrides that do not exist on CI runners.",
        'approval_policy = "never"',
        'sandbox_mode = "workspace-write"',
        'model_reasoning_effort = "low"',
        "",
        '[projects."/tmp/openclaw-pr-sync.xph5uu"]',
        'trust_level = "trusted"',
        "",
      ].join("\n"),
    );
  });

  it("writes the generated config to disk", async () => {
    await withTempDir("codex-ci-config-", async (tempDir) => {
      const outputPath = path.join(tempDir, ".codex", "config.toml");
      const projectPath = path.join(tempDir, "repo");

      await writeCiSafeCodexConfig({
        outputPath,
        projectPath,
      });

      await expect(fs.readFile(outputPath, "utf-8")).resolves.toContain(
        `approval_policy = "never"`,
      );
      await expect(fs.readFile(outputPath, "utf-8")).resolves.toContain(
        `model_reasoning_effort = "low"`,
      );
      await expect(fs.readFile(outputPath, "utf-8")).resolves.toContain(
        `[projects."${projectPath}"]`,
      );
    });
  });
});
