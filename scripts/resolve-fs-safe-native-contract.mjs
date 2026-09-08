import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const [ref, workflowSha, allowFrozenSource] = process.argv.slice(2);
const isSha = (value) => /^[0-9a-f]{40}$/u.test(value ?? "");
assert.ok(isSha(ref), "ref must be a full lowercase commit SHA");
assert.ok(isSha(workflowSha), "workflow SHA must be a full lowercase commit SHA");

function isCanonicalFrozenReleaseSource() {
  try {
    const branches = execFileSync(
      "git",
      [
        "for-each-ref",
        "--format=%(refname:short)",
        "--contains",
        ref,
        "refs/remotes/origin/extended-stable",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return branches
      .split("\n")
      .some((branch) => /^origin\/extended-stable\/\d{4}\.(?:[1-9]|1[0-2])\.33$/u.test(branch));
  } catch {
    return false;
  }
}

function isLegacyPythonOnlySource() {
  if (allowFrozenSource !== "1" || ref === workflowSha || !isCanonicalFrozenReleaseSource()) {
    return false;
  }
  try {
    const defaults = execFileSync("git", ["show", `${ref}:src/infra/fs-safe-defaults.ts`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (
      !defaults.includes('import { configureFsSafePython } from "@openclaw/fs-safe/config";') ||
      /\b(?:configureFsSafeNative|getFsSafeNativeConfig|getNativeBinding)\b|@openclaw\/fs-safe\/native/u.test(
        defaults,
      )
    ) {
      return false;
    }
    execFileSync(
      "git",
      [
        "grep",
        "-qE",
        "\\b(configureFsSafeNative|getFsSafeNativeConfig|getNativeBinding)\\b|@openclaw/fs-safe/native",
        ref,
        "--",
        "src",
        "packages",
        "extensions",
      ],
      { stdio: "ignore" },
    );
    return false;
  } catch (error) {
    // Only git grep's no-match status proves the complete product tree is pre-native.
    return error && typeof error === "object" && "status" in error && error.status === 1;
  }
}

// A canonical frozen release source may omit a proof for functionality it cannot use.
// Current, unknown, and native-consuming sources always verify the installed package.
const contract = isLegacyPythonOnlySource() ? "not-applicable" : "required";
process.stdout.write(`${contract}\n`);
