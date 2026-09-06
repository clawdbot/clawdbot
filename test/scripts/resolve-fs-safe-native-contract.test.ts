import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT = resolve("scripts/resolve-fs-safe-native-contract.mjs");
const tempDirectories = useAutoCleanupTempDirTracker(afterEach);

function commitSource(
  version: string,
  defaults: string,
  extraSource?: string,
  remoteBranch?: string,
) {
  const root = tempDirectories.make("openclaw-fs-safe-contract-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@openclaw.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "OpenClaw test"], { cwd: root });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ dependencies: { "@openclaw/fs-safe": version } })}\n`,
  );
  const defaultsPath = join(root, "src/infra/fs-safe-defaults.ts");
  mkdirSync(dirname(defaultsPath), { recursive: true });
  writeFileSync(defaultsPath, defaults);
  if (extraSource) {
    const sourcePath = join(root, "packages/example/native.ts");
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, extraSource);
  }
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
    const { root, ref } = commitSource(
      "0.3.0",
      legacyDefaults,
      undefined,
      "extended-stable/2026.6.33",
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
    const currentRelease = commitSource("0.3.0", legacyDefaults, undefined, "release/2026.6.35");
    expect(resolveContract(currentRelease.root, currentRelease.ref)).toBe("required");
    const unauthorized = commitSource("0.3.0", legacyDefaults);
    expect(resolveContract(unauthorized.root, unauthorized.ref, false)).toBe("required");
    expect(resolveContract(unauthorized.root, unauthorized.ref, true, unauthorized.ref)).toBe(
      "required",
    );
    const sibling = commitSource(
      "0.3.0",
      legacyDefaults,
      'import { getNativeBinding } from "@openclaw/fs-safe/native";\n',
    );
    expect(resolveContract(sibling.root, sibling.ref)).toBe("required");
  });
});
