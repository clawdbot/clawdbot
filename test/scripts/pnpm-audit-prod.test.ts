import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectProdResolvedPackagesFromLockfile,
  createBulkAdvisoryPayload,
  filterFindingsBySeverity,
  parseSnapshotKey,
  runPnpmAuditProd,
  stripVersionDecorators,
} from "../../scripts/pre-commit/pnpm-audit-prod.mjs";

describe("pnpm-audit-prod", () => {
  it("parses scoped snapshot keys with peer suffixes", () => {
    expect(parseSnapshotKey("@scope/pkg@1.2.3(peer@4.5.6)")).toEqual({
      packageName: "@scope/pkg",
      reference: "1.2.3(peer@4.5.6)",
      version: "1.2.3",
    });
  });

  it("strips peer and patch decorators from resolved versions", () => {
    expect(stripVersionDecorators("7.0.0-rc.9(patch_hash=abc123)(sharp@0.34.5)")).toBe(
      "7.0.0-rc.9",
    );
    expect(stripVersionDecorators("1.2.3")).toBe("1.2.3");
  });

  it("collects the production graph from pnpm lockfile snapshots", () => {
    const lockfile = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      pkg-a:
        version: 1.0.0
    devDependencies:
      dev-only:
        version: 9.9.9
  extensions/demo:
    dependencies:
      '@scope/pkg':
        version: 2.0.0(peer@4.0.0)
      workspace-lib:
        version: link:../../packages/workspace-lib

snapshots:
  pkg-a@1.0.0:
    dependencies:
      transitive: 3.0.0(patch_hash=abc123)
  transitive@3.0.0(patch_hash=abc123): {}
  '@scope/pkg@2.0.0(peer@4.0.0)':
    optionalDependencies:
      opt-dep: 4.0.0
  opt-dep@4.0.0: {}
`;

    const payload = createBulkAdvisoryPayload(collectProdResolvedPackagesFromLockfile(lockfile));
    expect(payload).toEqual({
      "@scope/pkg": ["2.0.0"],
      "opt-dep": ["4.0.0"],
      "pkg-a": ["1.0.0"],
      transitive: ["3.0.0"],
    });
  });

  it("resolves npm alias snapshots to the real package name", () => {
    const lockfile = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      request:
        version: npm:@cypress/request@3.0.10

snapshots:
  '@cypress/request@3.0.10': {}
`;

    const payload = createBulkAdvisoryPayload(collectProdResolvedPackagesFromLockfile(lockfile));
    expect(payload).toEqual({
      "@cypress/request": ["3.0.10"],
    });
  });

  it("reads inline importer dependency maps without repo dependencies", () => {
    const lockfile = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      axios: {specifier: ^1.0.0, version: 1.0.0}
      '@scope/pkg': {'version': '2.0.0(peer@4.0.0)'}

snapshots:
  axios@1.0.0: {}
  '@scope/pkg@2.0.0(peer@4.0.0)': {}
`;

    const payload = createBulkAdvisoryPayload(collectProdResolvedPackagesFromLockfile(lockfile));
    expect(payload).toEqual({
      "@scope/pkg": ["2.0.0"],
      axios: ["1.0.0"],
    });
  });

  it("resolves quoted snapshot keys that contain tarball URLs", () => {
    const lockfile = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      wrapper:
        version: 1.0.0

snapshots:
  wrapper@1.0.0:
    dependencies:
      libsignal: '@whiskeysockets/libsignal-node@https://codeload.github.com/whiskeysockets/libsignal-node/tar.gz/abc123'
  '@whiskeysockets/libsignal-node@https://codeload.github.com/whiskeysockets/libsignal-node/tar.gz/abc123':
    dependencies:
      curve25519-js: 0.0.4
  curve25519-js@0.0.4: {}
`;

    const payload = createBulkAdvisoryPayload(collectProdResolvedPackagesFromLockfile(lockfile));
    expect(payload).toEqual({
      "@whiskeysockets/libsignal-node": [
        "https://codeload.github.com/whiskeysockets/libsignal-node/tar.gz/abc123",
      ],
      "curve25519-js": ["0.0.4"],
      wrapper: ["1.0.0"],
    });
  });

  it("filters advisory findings by minimum severity", () => {
    const findings = filterFindingsBySeverity(
      {
        axios: [
          {
            id: "GHSA-low",
            severity: "moderate",
            title: "moderate issue",
          },
          {
            id: "GHSA-high",
            severity: "high",
            title: "high issue",
            url: "https://github.com/advisories/GHSA-high",
          },
        ],
      },
      "high",
    );

    expect(findings).toEqual([
      {
        id: "GHSA-high",
        packageName: "axios",
        severity: "high",
        title: "high issue",
        url: "https://github.com/advisories/GHSA-high",
        vulnerableVersions: null,
      },
    ]);
  });

  it("returns a failing exit code when bulk advisories include high severity findings", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "openclaw-audit-prod-"));
    await writeFile(
      path.join(tempDir, "pnpm-lock.yaml"),
      `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      axios:
        version: 1.0.0

snapshots:
  axios@1.0.0: {}
`,
      "utf8",
    );

    try {
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      const exitCode = await runPnpmAuditProd({
        rootDir: tempDir,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              axios: [
                {
                  id: "GHSA-test",
                  severity: "high",
                  title: "test issue",
                  vulnerable_versions: "<=1.0.0",
                  url: "https://github.com/advisories/GHSA-test",
                },
              ],
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          ),
        stdout: {
          write(chunk: string) {
            stdoutChunks.push(chunk);
            return true;
          },
        } as NodeJS.WriteStream,
        stderr: {
          write(chunk: string) {
            stderrChunks.push(chunk);
            return true;
          },
        } as NodeJS.WriteStream,
      });

      expect(exitCode).toBe(1);
      expect(stdoutChunks).toEqual([]);
      expect(stderrChunks.join("")).toContain("Found 1 high or higher advisories");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
