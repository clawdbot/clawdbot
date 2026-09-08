import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT = resolve("scripts/resolve-fs-safe-native-contract.mjs");
const tempDirectories = useAutoCleanupTempDirTracker(afterEach);

function commitSource(
  fsSafeVersion: string,
  defaults: string,
  remoteBranch?: string,
  productVersion = "2026.6.33",
) {
  const root = tempDirectories.make("openclaw-fs-safe-contract-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@openclaw.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "OpenClaw test"], { cwd: root });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ version: productVersion, dependencies: { "@openclaw/fs-safe": fsSafeVersion } })}\n`,
  );
  const defaultsPath = join(root, "src/infra/fs-safe-defaults.ts");
  mkdirSync(dirname(defaultsPath), { recursive: true });
  writeFileSync(defaultsPath, defaults);
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  if (remoteBranch) {
    execFileSync("git", ["update-ref", `refs/remotes/origin/${remoteBranch}`, "HEAD"], {
      cwd: root,
    });
  }
  return {
    root,
    ref: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  };
}

function resolveContract(
  root: string,
  ref: string,
  allowFrozenSource = true,
  workflowSha = "f".repeat(40),
) {
  return execFileSync(process.execPath, [SCRIPT, ref, workflowSha, allowFrozenSource ? "1" : "0"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

const legacyDefaults = 'import { configureFsSafePython } from "@openclaw/fs-safe/config";\n';

describe("resolve-fs-safe-native-contract", () => {
  it("reports the actual 0.3 selected-source contract as not applicable when authorized", () => {
    const { root, ref } = commitSource("0.3.0", legacyDefaults, "extended-stable/2026.6.33");
    expect(resolveContract(root, ref)).toBe("not-applicable");
  });

  it("reports the exact 2026.7.33 Python-only 0.4.1 contract as not applicable", () => {
    const { root, ref } = commitSource(
      "0.4.1",
      legacyDefaults,
      "extended-stable/2026.7.33",
      "2026.7.33",
    );
    expect(resolveContract(root, ref)).toBe("not-applicable");
  });

  it("keeps the current native consumer contract strict", () => {
    const { root, ref } = commitSource(
      "0.8.1",
      'import { configureFsSafeNative } from "@openclaw/fs-safe/config";\n',
    );
    expect(resolveContract(root, ref)).toBe("required");
  });

  it("keeps current, unapproved, unauthorized, or sibling-native source contracts strict", () => {
    const unapproved = commitSource("0.3.0", legacyDefaults);
    expect(resolveContract(unapproved.root, unapproved.ref)).toBe("required");
    const currentRelease = commitSource("0.3.0", legacyDefaults, "release/2026.6.35");
    expect(resolveContract(currentRelease.root, currentRelease.ref)).toBe("required");
    const unauthorized = commitSource("0.3.0", legacyDefaults);
    expect(resolveContract(unauthorized.root, unauthorized.ref, false)).toBe("required");
    expect(resolveContract(unauthorized.root, unauthorized.ref, true, unauthorized.ref)).toBe(
      "required",
    );
    const unknownDependency = commitSource("0.3.1", legacyDefaults, "extended-stable/2026.6.33");
    expect(resolveContract(unknownDependency.root, unknownDependency.ref)).toBe("required");
    const unknownProduct = commitSource(
      "0.4.1",
      legacyDefaults,
      "extended-stable/2026.8.33",
      "2026.8.33",
    );
    expect(resolveContract(unknownProduct.root, unknownProduct.ref)).toBe("required");
  });

  it("uses only sparse-materialized fs-safe ownership sources for an authorized legacy target", () => {
    const root = tempDirectories.make("openclaw-fs-safe-sparse-contract-");
    const ref = "a".repeat(40);
    const gitPath = join(root, "git");
    writeFileSync(
      gitPath,
      `#!/usr/bin/env sh
case "$1" in
  for-each-ref) printf '%s\\n' 'origin/extended-stable/2026.6.33' ;;
  show)
    case "$2" in
      ${ref}:package.json)
        printf '%s\\n' '{"version":"2026.6.33","dependencies":{"@openclaw/fs-safe":"0.3.0"}}' ;;
      ${ref}:src/infra/fs-safe-defaults.ts)
        printf '%s\\n' 'import { configureFsSafePython } from "@openclaw/fs-safe/config";' ;;
      *) echo "unmaterialized source: $2" >&2; exit 128 ;;
    esac ;;
  *) echo "unexpected git operation: $1" >&2; exit 128 ;;
esac
`,
    );
    chmodSync(gitPath, 0o755);
    const output = execFileSync(process.execPath, [SCRIPT, ref, "f".repeat(40), "1"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
    }).trim();
    expect(output).toBe("not-applicable");
  });
});
