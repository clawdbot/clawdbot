// Covers the in-repo private-key scanner that replaced the network-dependent
// pre-commit detect-private-key hook in the CI security-fast job.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  findPrivateKeyMarker,
  PRIVATE_KEY_MARKERS,
  PRIVATE_KEY_SCAN_EXCLUDE,
} from "../../scripts/detect-private-keys.mts";

const SCRIPT_PATH = fileURLToPath(
  new URL("../../scripts/detect-private-keys.mts", import.meta.url),
);

function runScanner(cwd: string, args: string[] = [], scriptPath = SCRIPT_PATH) {
  return spawnSync(process.execPath, [scriptPath, ...args], { cwd, encoding: "utf8" });
}

describe("detect-private-keys markers", () => {
  it.each(PRIVATE_KEY_MARKERS)("flags %s anywhere in file bytes", (marker) => {
    const content = Buffer.from(`prefix\n-----${marker}-----\nnot key material\n`);
    expect(findPrivateKeyMarker(content)).toBe(marker);
  });

  it("ignores public material and certificates", () => {
    expect(
      findPrivateKeyMarker(
        Buffer.from("-----BEGIN CERTIFICATE-----\n-----BEGIN PUBLIC KEY-----\n"),
      ),
    ).toBeUndefined();
  });

  it("keeps its own source free of literal markers instead of excluding itself", () => {
    const source = fs.readFileSync(SCRIPT_PATH);
    expect(findPrivateKeyMarker(source)).toBeUndefined();
    expect(PRIVATE_KEY_SCAN_EXCLUDE.test("scripts/detect-private-keys.mts")).toBe(false);
  });

  it("excludes colocated test fixtures and the iOS Fastfile, nothing else", () => {
    expect(PRIVATE_KEY_SCAN_EXCLUDE.test("src/infra/push-apns.test.ts")).toBe(true);
    expect(PRIVATE_KEY_SCAN_EXCLUDE.test("apps/ios/fastlane/Fastfile")).toBe(true);
    expect(PRIVATE_KEY_SCAN_EXCLUDE.test("src/infra/push-apns.ts")).toBe(false);
    expect(PRIVATE_KEY_SCAN_EXCLUDE.test("docs/push-apns.test.ts.md")).toBe(false);
    expect(PRIVATE_KEY_SCAN_EXCLUDE.test("vendor/apps/ios/fastlane/Fastfile.bak")).toBe(false);
  });
});

describe("detect-private-keys CLI", () => {
  let repoDir: string | undefined;

  afterEach(() => {
    if (repoDir) {
      fs.rmSync(repoDir, { recursive: true, force: true });
      repoDir = undefined;
    }
  });

  function createTrackedRepo(files: Record<string, string>) {
    repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "detect-private-keys-")));
    for (const [file, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(repoDir, file), content);
    }
    fs.symlinkSync("clean.txt", path.join(repoDir, "link.txt"));
    fs.writeFileSync(path.join(repoDir, "untracked.pem"), "-----BEGIN DSA PRIVATE KEY-----\n");
    expect(spawnSync("git", ["init", "-q", "."], { cwd: repoDir }).status).toBe(0);
    expect(
      spawnSync("git", ["add", "--", ...Object.keys(files), "link.txt"], { cwd: repoDir }).status,
    ).toBe(0);
    return repoDir;
  }

  it("fails with the wrapper trailer when a tracked file carries a key marker", () => {
    const cwd = createTrackedRepo({
      "clean.txt": "nothing to see\n",
      "leaked.pem": "-----BEGIN RSA PRIVATE KEY-----\nfixture only, no key material\n",
      "fixture.test.ts": "-----BEGIN EC PRIVATE KEY-----\n",
    });
    // Pull-request CI runs a `git show` copy of the base-ref scanner from
    // outside the candidate tree, so the file must work without siblings.
    const standaloneCopy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dpk-copy-")), "s.mts");
    fs.copyFileSync(SCRIPT_PATH, standaloneCopy);

    const result = runScanner(cwd, [], standaloneCopy);
    fs.rmSync(path.dirname(standaloneCopy), { recursive: true, force: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Private key found: leaked.pem (BEGIN RSA PRIVATE KEY)");
    expect(result.stderr).not.toContain("fixture.test.ts");
    expect(result.stderr).not.toContain("untracked.pem");
    expect(result.stderr.trimEnd().endsWith("[detect-private-keys] FAILED (exit 1)")).toBe(true);
  });

  it("passes a clean tree and scans only explicit paths when given", () => {
    const cwd = createTrackedRepo({
      "clean.txt": "nothing to see\n",
      "leaked.pem": "PuTTY-User-Key-File-2: ssh-rsa\n",
    });

    expect(runScanner(cwd, ["clean.txt"])).toMatchObject({
      status: 0,
      stdout: expect.stringContaining("scanned 1 files; no private keys found"),
    });
    expect(runScanner(cwd).status).toBe(1);
  });

  it("reports a crash as a failure instead of a silent pass", () => {
    const cwd = createTrackedRepo({ "clean.txt": "nothing to see\n" });

    const result = runScanner(cwd, ["missing.txt"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ENOENT");
    expect(result.stderr).toContain("[detect-private-keys] FAILED (exit 1)");
  });
});
