// Plain GitHub CLI helper tests cover wrapper-safe gh execution for maintainer scripts.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  execGhApiRead,
  execPlainGh,
  plainGhEnv,
  PLAIN_GH_SYSTEM_CANDIDATES,
  resolvePlainGhBin,
} from "../../scripts/lib/plain-gh.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeFakeGh(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "plain-gh-"));
  tempDirs.push(dir);
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir);
  const ghPath = path.join(binDir, "gh");
  writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
printf 'argv=%s\\n' "$*"
printf 'NO_COLOR=%s\\n' "\${NO_COLOR-}"
printf 'GH_FORCE_TTY=%s\\n' "\${GH_FORCE_TTY-}"
printf 'FORCE_COLOR=%s\\n' "\${FORCE_COLOR-}"
printf 'CLICOLOR=%s\\n' "\${CLICOLOR-}"
printf 'CLICOLOR_FORCE=%s\\n' "\${CLICOLOR_FORCE-}"
printf 'COLORTERM_SET=%s\\n' "\${COLORTERM+x}"
printf 'OPENCLAW_GH_BIN_SET=%s\\n' "\${OPENCLAW_GH_BIN+x}"
`,
  );
  chmodSync(ghPath, 0o755);
  return ghPath;
}

function makeLargeFakeGh(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "plain-gh-large-"));
  tempDirs.push(dir);
  const ghPath = path.join(dir, "gh");
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const bytes = Number(process.env.PLAIN_GH_FAKE_BYTES ?? "0");
process.stdout.write("x".repeat(bytes));
`,
  );
  chmodSync(ghPath, 0o755);
  return ghPath;
}

describe("plain gh helpers", () => {
  it("prefers OPENCLAW_GH_BIN over PATH shims", () => {
    const ghPath = makeFakeGh();

    expect(
      resolvePlainGhBin({
        HOME: path.dirname(path.dirname(ghPath)),
        OPENCLAW_GH_BIN: ghPath,
        PATH: "",
      }),
    ).toBe(ghPath);
  });

  it("prefers package-manager gh paths over bin shims", () => {
    const realGh = makeFakeGh();
    const shimGh = makeFakeGh();

    expect(resolvePlainGhBin({ PATH: shimGh }, [realGh, shimGh])).toBe(realGh);
    expect(PLAIN_GH_SYSTEM_CANDIDATES.indexOf("/opt/homebrew/opt/gh/bin/gh")).toBeLessThan(
      PLAIN_GH_SYSTEM_CANDIDATES.indexOf("/opt/homebrew/bin/gh"),
    );
  });

  it("normalizes color environment for JSON-safe gh output", () => {
    expect(
      plainGhEnv({
        CLICOLOR: "1",
        CLICOLOR_FORCE: "1",
        COLORTERM: "truecolor",
        FORCE_COLOR: "3",
      }),
    ).toMatchObject({
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      CLICOLOR: "0",
      CLICOLOR_FORCE: "0",
    });
    expect(plainGhEnv({ COLORTERM: "truecolor" })).not.toHaveProperty("COLORTERM");
    expect(plainGhEnv({ GH_FORCE_TTY: "120" })).not.toHaveProperty("GH_FORCE_TTY");
  });

  it("routes explicit GET reads through the PATH shim", () => {
    const ghPath = makeFakeGh();
    const output = execGhApiRead("repos/openclaw/openclaw/pulls/1", {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_GH_BIN: "/identity-sensitive/plain-gh",
        PATH: `${path.dirname(ghPath)}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });

    expect(output).toContain("argv=api repos/openclaw/openclaw/pulls/1 --method GET");
    expect(output).toContain("OPENCLAW_GH_BIN_SET=");
  });

  it("runs the shell helper with color disabled", () => {
    const ghPath = makeFakeGh();
    const outputPath = path.join(path.dirname(path.dirname(ghPath)), "output.txt");
    const script = [
      "set -euo pipefail",
      "source scripts/lib/plain-gh.sh",
      `OPENCLAW_GH_BIN=${JSON.stringify(ghPath)}`,
      "export OPENCLAW_GH_BIN",
      `gh_plain api rate_limit > ${JSON.stringify(outputPath)}`,
    ].join("\n");

    const result = spawnSync("bash", ["-lc", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        CLICOLOR: "1",
        CLICOLOR_FORCE: "1",
        COLORTERM: "truecolor",
        FORCE_COLOR: "3",
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toContain("argv=api rate_limit");
    expect(readFileSync(outputPath, "utf8")).toContain("NO_COLOR=1");
    expect(readFileSync(outputPath, "utf8")).toContain("GH_FORCE_TTY=");
    expect(readFileSync(outputPath, "utf8")).toContain("FORCE_COLOR=0");
    expect(readFileSync(outputPath, "utf8")).toContain("CLICOLOR=0");
    expect(readFileSync(outputPath, "utf8")).toContain("CLICOLOR_FORCE=0");
    expect(readFileSync(outputPath, "utf8")).toContain("COLORTERM_SET=");
  });

  it("captures large gh payloads by default", () => {
    const ghPath = makeLargeFakeGh();
    const bytes = 2 * 1024 * 1024;

    const output = execPlainGh(["api", "large"], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_GH_BIN: ghPath,
        PLAIN_GH_FAKE_BYTES: String(bytes),
      },
    });

    expect(output).toHaveLength(bytes);
  });

  it("keeps the shell resolver on external gh binaries", () => {
    const helper = readFileSync("scripts/lib/plain-gh.sh", "utf8");

    expect(helper).toContain("type -P gh");
    expect(helper).not.toContain("command -v gh");
    expect(helper.indexOf("/opt/homebrew/opt/gh/bin/gh")).toBeLessThan(
      helper.indexOf("/opt/homebrew/bin/gh"),
    );
  });
});
