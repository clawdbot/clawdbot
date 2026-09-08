import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const [ref, workflowSha, allowFrozenSource] = process.argv.slice(2);
const isSha = (value) => /^[0-9a-f]{40}$/u.test(value ?? "");
const NATIVE_MARKER =
  /\b(?:configureFsSafeNative|getFsSafeNativeConfig|getNativeBinding)\b|@openclaw\/fs-safe\/native/u;
const LEGACY_PYTHON_ONLY_FS_SAFE_VERSION = "0.3.0";
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
    const readSource = (path) =>
      execFileSync("git", ["show", `${ref}:${path}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    const packageJson = JSON.parse(readSource("package.json"));
    if (packageJson.dependencies?.["@openclaw/fs-safe"] !== LEGACY_PYTHON_ONLY_FS_SAFE_VERSION) {
      return false;
    }
    const defaults = readSource("src/infra/fs-safe-defaults.ts");
    // fs-safe 0.3.0's public config module exports Python/lock controls only;
    // a built package on this exact dependency cannot consume native controls.
    return (
      defaults.includes('import { configureFsSafePython } from "@openclaw/fs-safe/config";') &&
      !NATIVE_MARKER.test(defaults)
    );
  } catch {
    // Missing or unreadable ownership sources are unknown, therefore strict.
    return false;
  }
}

// A canonical frozen release source may omit a proof for functionality it cannot use.
// Current, unknown, and native-consuming sources always verify the installed package.
const contract = isLegacyPythonOnlySource() ? "not-applicable" : "required";
process.stdout.write(`${contract}\n`);
