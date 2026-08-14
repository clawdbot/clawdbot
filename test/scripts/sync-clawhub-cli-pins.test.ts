import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readClawHubIdentity,
  renderClawHubMaterializerPins,
  syncClawHubPins,
} from "../../scripts/sync-clawhub-cli-pins.mts";

describe("ClawHub CLI pin synchronization", () => {
  it("reads the exact identity from the trusted package graph", () => {
    const identity = readClawHubIdentity(process.cwd());

    expect(identity.version).toMatch(/^\d+\.\d+\.\d+/u);
    expect(identity.integrity).toMatch(/^sha512-/u);
    expect(identity.lockSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("updates all materializer identity pins together", () => {
    const rendered = renderClawHubMaterializerPins(
      [
        'expected_lock_sha256="old-lock"',
        'expected_clawhub_integrity="sha512-old"',
        '[[ "${clawhub_version}" == "0.0.0" ]] || {',
      ].join("\n"),
      {
        integrity: "sha512-new",
        lockSha256: "new-lock",
        version: "1.2.3",
      },
    );

    expect(rendered).toContain('expected_lock_sha256="new-lock"');
    expect(rendered).toContain('expected_clawhub_integrity="sha512-new"');
    expect(rendered).toContain('[[ "${clawhub_version}" == "1.2.3" ]]');
  });

  it("atomically replaces the materializer while preserving its mode", () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "openclaw-clawhub-pins-"));
    const packageDir = path.join(rootDir, ".github", "release", "clawhub-cli");
    const materializerPath = path.join(rootDir, "scripts", "materialize-clawhub-cli.sh");
    try {
      mkdirSync(packageDir, { recursive: true });
      mkdirSync(path.dirname(materializerPath), { recursive: true });
      writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({ dependencies: { clawhub: "1.2.3" } }),
      );
      writeFileSync(
        path.join(packageDir, "package-lock.json"),
        JSON.stringify({
          packages: {
            "node_modules/clawhub": {
              integrity: "sha512-new",
              version: "1.2.3",
            },
          },
        }),
      );
      writeFileSync(
        materializerPath,
        [
          'expected_lock_sha256="old-lock"',
          'expected_clawhub_integrity="sha512-old"',
          '[[ "${clawhub_version}" == "0.0.0" ]] || {',
        ].join("\n"),
      );
      chmodSync(materializerPath, 0o755);

      expect(syncClawHubPins(rootDir, true)).toBe(true);

      const rendered = readFileSync(materializerPath, "utf8");
      expect(rendered).toContain('expected_clawhub_integrity="sha512-new"');
      expect(rendered).toContain('[[ "${clawhub_version}" == "1.2.3" ]]');
      expect(statSync(materializerPath).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });
});
