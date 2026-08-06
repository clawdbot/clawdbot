// Testbox env hydration tests keep custom helper profiles self-contained.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const tempDirs = new Set<string>();
const SCRIPT = "scripts/ci-hydrate-testbox-env.sh";

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

function runBash(args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("/bin/bash", ["--noprofile", "--norc", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("scripts/ci-hydrate-testbox-env.sh", () => {
  it("bakes custom profile paths into the generated helper default", () => {
    const root = makeTempDir(tempDirs, "openclaw-testbox-env-");
    const home = join(root, "home");
    const profilePath = join(root, "custom profile.env");
    const helperPath = join(root, "bin", "openclaw-testbox-env");

    runBash([SCRIPT, profilePath, helperPath], {
      HOME: home,
      OPENAI_API_KEY: "testbox-sentinel-key",
    });

    expect(existsSync(profilePath)).toBe(true);
    expect(readFileSync(profilePath, "utf8")).toContain(
      "export OPENAI_API_KEY=testbox-sentinel-key",
    );
    expect(statSync(helperPath).mode & 0o777).toBe(0o700);

    const helper = readFileSync(helperPath, "utf8");
    expect(helper).toContain("default_profile_path=");
    expect(helper).toContain("custom\\ profile.env");
    expect(helper).not.toContain(".openclaw-testbox-live.profile");

    const output = runBash([helperPath, "env"], {
      HOME: home,
      OPENCLAW_TESTBOX_PROFILE_FILE: "",
    });
    expect(output).toContain("OPENAI_API_KEY=testbox-sentinel-key\n");
  });
});
