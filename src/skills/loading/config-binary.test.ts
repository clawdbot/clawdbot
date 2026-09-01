import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { withTempDirSync } from "../../test-helpers/temp-dir.js";
import { withEnv } from "../../test-utils/env.js";
import type { SkillEntry } from "../types.js";
import { shouldIncludeSkill } from "./config.js";

it("includes a skill after its required binary is installed on unchanged PATH", () => {
  withTempDirSync({ prefix: "openclaw-skill-binary-" }, (binDir) => {
    const filePath = path.join(binDir, "SKILL.md");
    const entry: SkillEntry = {
      skill: {
        name: "fixture-skill",
        description: "Requires a binary",
        filePath,
        baseDir: binDir,
        source: "openclaw-workspace",
        sourceInfo: { path: filePath, source: "test", scope: "temporary", origin: "top-level" },
        disableModelInvocation: false,
      },
      frontmatter: {},
      metadata: { requires: { bins: ["fixture-skill-tool"] } },
    };
    withEnv({ PATH: binDir }, () => {
      const included = () => shouldIncludeSkill({ entry, bundledAllowlist: undefined });
      expect(included()).toBe(false);
      const executable = path.join(binDir, "fixture-skill-tool");
      fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(executable, 0o755);
      expect(process.env.PATH).toBe(binDir);
      expect(included()).toBe(true);
    });
  });
});
