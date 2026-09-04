// Pnpm Audit Prod tests cover pnpm audit prod script behavior.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { toErrorObject as toLintErrorObject } from "@openclaw/normalization-core/error-coercion";
import { describe, expect, it, vi } from "vitest";
import {
  collectAllResolvedPackagesFromLockfile,
  collectProdResolvedPackagesFromLockfile,
  createBulkAdvisoryPayload,
  fetchBulkAdvisories,
  filterFindingsBySeverity,
  parseArgs,
  parseSnapshotKey,
  readBoundedBulkAdvisoryErrorText,
  runPnpmAuditProd,
  stripVersionDecorators,
} from "../../scripts/pre-commit/pnpm-audit-prod.mjs";

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => {}) }));

describe("pnpm-audit-prod", () => {
  it("keeps toolchain snapshots separate from production while auditing both documents", () => {
    const lockfile = `---
lockfileVersion: '9.0'
importers:
  .:
    packageManagerDependencies:
      pnpm: {specifier: 12.0.0, version: 12.0.0}
snapshots:
  pnpm@12.0.0:
    optionalDependencies:
      native: 2.0.0
  native@2.0.0: {}
  shared@1.0.0:
    dependencies:
      tool-only: 1.0.0
  tool-only@1.0.0: {}
---
lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      shared: {version: 1.0.0}
snapshots:
  shared@1.0.0: {}
`;
    expect(createBulkAdvisoryPayload(collectProdResolvedPackagesFromLockfile(lockfile))).toEqual({
      shared: ["1.0.0"],
    });
    expect(createBulkAdvisoryPayload(collectAllResolvedPackagesFromLockfile(lockfile))).toEqual({
      native: ["2.0.0"],
      pnpm: ["12.0.0"],
      shared: ["1.0.0"],
      "tool-only": ["1.0.0"],
    });
    expect(() => collectAllResolvedPackagesFromLockfile(`${lockfile}\n---\n`)).toThrow();
    const brokenApplication = lockfile.replace(
      "  shared@1.0.0: {}",
      "  shared@1.0.0:\n    dependencies:\n      native: 2.0.0",
    );
    expect(() => collectProdResolvedPackagesFromLockfile(brokenApplication)).toThrow(
      "Unable to resolve pnpm snapshot",
    );
  });
  it("parses explicit audit severity flags", () => {
    expect(parseArgs(["--min-severity", "critical"])).toEqual({ minSeverity: "critical" });
    expect(parseArgs(["--audit-level=moderate"])).toEqual({ minSeverity: "moderate" });
  });

  it("rejects missing audit severity flag values", () => {
    expect(() => parseArgs(["--min-severity"])).toThrow("--min-severity requires a value");
    expect(() => parseArgs(["--min-severity", "--audit-level", "critical"])).toThrow(
      "--min-severity requires a value",
    );
    expect(() => parseArgs(["--min-severity", "-h"])).toThrow("--min-severity requires a value");
    expect(() => parseArgs(["--audit-level="])).toThrow("--audit-level requires a value");
  });

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

  it("suppresses the overbroad Mistral malware advisory for the pre-compromise locked version", () => {
    const versionsByPackage = new Map([["@mistralai/mistralai", new Set(["2.2.1"])]]);
    const findings = filterFindingsBySeverity(
      {
        "@mistralai/mistralai": [
          {
            id: "1118204",
            severity: "critical",
            title: "Malware in @mistralai/mistralai",
            vulnerable_versions: ">=0",
            url: "https://github.com/advisories/GHSA-3q49-cfcf-g5fm",
          },
        ],
      },
      "high",
      versionsByPackage,
    );

    expect(findings).toEqual([]);
  });

  it("keeps the Mistral malware advisory blocking for compromised resolved versions", () => {
    const versionsByPackage = new Map([["@mistralai/mistralai", new Set(["2.2.4"])]]);
    const findings = filterFindingsBySeverity(
      {
        "@mistralai/mistralai": [
          {
            id: "1118204",
            severity: "critical",
            title: "Malware in @mistralai/mistralai",
            vulnerable_versions: ">=0",
            url: "https://github.com/advisories/GHSA-3q49-cfcf-g5fm",
          },
        ],
      },
      "high",
      versionsByPackage,
    );

    expect(findings).toEqual([
      {
        id: "1118204",
        packageName: "@mistralai/mistralai",
        severity: "critical",
        title: "Malware in @mistralai/mistralai",
        url: "https://github.com/advisories/GHSA-3q49-cfcf-g5fm",
        vulnerableVersions: ">=0",
      },
    ]);
  });

  it("bounds bulk advisory error response bodies", async () => {
    const tail = "tail-sentinel-should-not-appear";
    const response = new Response(`${"x".repeat(5000)}${tail}`, {
      status: 500,
    });

    const text = await readBoundedBulkAdvisoryErrorText(response);

    expect(text).toContain("[truncated]");
    expect(text).not.toContain(tail);
    expect(text.length).toBeLessThan(4200);
  });

  it.each([
    {
      caseName: "drops a split surrogate pair",
      responseBody: `abc\u{1f600}tail`,
      expectedText: "abc\n[truncated]",
    },
    {
      caseName: "preserves a complete surrogate pair",
      responseBody: `ab\u{1f600}tail`,
      expectedText: `ab\u{1f600}\n[truncated]`,
    },
  ])(
    "keeps bulk advisory error truncation UTF-16 safe: $caseName",
    async ({ responseBody, expectedText }) => {
      const response = new Response(responseBody, { status: 500 });

      await expect(readBoundedBulkAdvisoryErrorText(response, 4)).resolves.toBe(expectedText);
    },
  );

  it("retries a timed-out bulk advisory request with a fresh request lifecycle", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn(((_url, init) => {
      const signal = init?.signal;
      if (signal) {
        signals.push(signal);
      }
      if (signals.length === 2) {
        return Promise.resolve(new Response("{}", { status: 200 }));
      }
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(toLintErrorObject(signal.reason, "Non-Error rejection")),
          { once: true },
        );
      });
    }) as typeof fetch);

    await expect(
      fetchBulkAdvisories({
        payload: { axios: ["1.0.0"] },
        timeoutMs: 5,
        fetchImpl,
      }),
    ).resolves.toEqual({});
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it("fails closed after three timed-out bulk advisory requests", async () => {
    vi.mocked(delay).mockClear();
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn(((_url, init) => {
      const signal = init?.signal;
      if (signal) {
        signals.push(signal);
      }
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(toLintErrorObject(signal.reason, "Non-Error rejection")),
          { once: true },
        );
      });
    }) as typeof fetch);
    const request = fetchBulkAdvisories({
      payload: { axios: ["1.0.0"] },
      timeoutMs: 5,
      fetchImpl,
    });

    await expect(request).rejects.toThrow(
      /failed after 3 attempts.*Check npm registry availability/u,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(signals).toHaveLength(3);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(delay).toHaveBeenCalledTimes(2);
    const secondWaitMs = vi.mocked(delay).mock.calls[1]?.[0];
    expect(secondWaitMs).toBeGreaterThanOrEqual(2000);
    expect(secondWaitMs).toBeLessThan(4000);
  });

  it.each(["network error", "HTTP 503"])("recovers %s with bounded backoff", async (failure) => {
    vi.mocked(delay).mockClear();
    const fetchImpl = vi.fn(async () => new Response("{}"));
    fetchImpl.mockImplementationOnce(async () => {
      if (failure === "network error") {
        throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
      }
      return new Response("temporarily unavailable", { status: 503 });
    });

    await expect(
      fetchBulkAdvisories({ payload: { axios: ["1.0.0"] }, fetchImpl }),
    ).resolves.toEqual({});
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledOnce();
    const waitMs = vi.mocked(delay).mock.calls[0]?.[0];
    expect(waitMs).toBeGreaterThanOrEqual(1000);
    expect(waitMs).toBeLessThan(2000);
  });

  it.each(["network error", "HTTP 503"])("fails closed after repeated %s", async (failure) => {
    const fetchImpl = vi.fn(async () => {
      if (failure === "network error") {
        throw new TypeError("fetch failed");
      }
      return new Response("temporarily unavailable", { status: 503 });
    });
    await expect(fetchBulkAdvisories({ payload: { axios: ["1.0.0"] }, fetchImpl })).rejects.toThrow(
      /failed after 3 attempts.*Check npm registry availability/u,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry an untagged error with the timeout message", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("Bulk advisory request exceeded timeout of 5ms");
    });

    await expect(
      fetchBulkAdvisories({
        payload: { axios: ["1.0.0"] },
        timeoutMs: 5,
        fetchImpl,
      }),
    ).rejects.toThrow("Bulk advisory request exceeded timeout of 5ms");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    {
      caseName: "HTTP client failures",
      responseBodyMaxBytes: undefined,
      response: () => new Response("registry failure", { status: 403, statusText: "Forbidden" }),
      expectedError: /Bulk advisory request failed \(403 Forbidden\)/u,
    },
    {
      caseName: "invalid JSON",
      responseBodyMaxBytes: undefined,
      response: () => new Response("{", { status: 200 }),
      expectedError: /JSON/u,
    },
    {
      caseName: "empty bodies",
      responseBodyMaxBytes: undefined,
      response: () => new Response("", { status: 200 }),
      expectedError: /Bulk advisory response body was empty/u,
    },
    {
      caseName: "oversized bodies",
      responseBodyMaxBytes: 4,
      response: () => new Response("12345", { status: 200 }),
      expectedError: /Bulk advisory response body exceeded 4 bytes/u,
    },
  ])("does not retry $caseName", async ({ responseBodyMaxBytes, response, expectedError }) => {
    const fetchImpl = vi.fn(async () => response());

    await expect(
      fetchBulkAdvisories({
        payload: { axios: ["1.0.0"] },
        ...(responseBodyMaxBytes ? { responseBodyMaxBytes } : {}),
        fetchImpl,
      }),
    ).rejects.toThrow(expectedError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("clamps oversized bulk advisory request timers before scheduling", async () => {
    let signal: AbortSignal | undefined;
    const request = fetchBulkAdvisories({
      payload: { axios: ["1.0.0"] },
      timeoutMs: Number.MAX_SAFE_INTEGER,
      fetchImpl: (async (_url, init) => {
        signal = init?.signal ?? undefined;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 25);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });

    await expect(request).resolves.toEqual({});
    expect(signal?.aborted).toBe(false);
  });

  it.each([
    { status: 200, attempts: 3 },
    { status: 503, attempts: 3 },
    { status: 403, attempts: 1 },
  ])(
    "cancels stalled HTTP $status bodies without retrying client failures",
    async ({ status, attempts }) => {
      let cancellations = 0;
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              pull() {
                return new Promise(() => {});
              },
              cancel() {
                cancellations += 1;
              },
            }),
            { status },
          ),
      );
      await expect(
        fetchBulkAdvisories({ payload: { axios: ["1.0.0"] }, timeoutMs: 5, fetchImpl }),
      ).rejects.toThrow(/Bulk advisory request exceeded timeout/u);
      expect(fetchImpl).toHaveBeenCalledTimes(attempts);
      expect(cancellations).toBe(attempts);
    },
  );

  it("bounds successful bulk advisory response bodies", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = fetchBulkAdvisories({
      payload: { axios: ["1.0.0"] },
      responseBodyMaxBytes: 4,
      fetchImpl: async () =>
        new Response(body, {
          status: 200,
          headers: { "content-length": "5" },
        }),
    });

    await expect(request).rejects.toThrow(/Bulk advisory response body exceeded 4 bytes/u);
    expect(cancelled).toBe(true);
  });

  it("streams non-decimal bulk advisory content-length values through the body cap", async () => {
    let readStarted = false;
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        readStarted = true;
        controller.enqueue(new TextEncoder().encode("12345"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = fetchBulkAdvisories({
      payload: { axios: ["1.0.0"] },
      responseBodyMaxBytes: 4,
      fetchImpl: async () =>
        new Response(body, {
          status: 200,
          headers: { "content-length": "5junk" },
        }),
    });

    await expect(request).rejects.toThrow(/Bulk advisory response body exceeded 4 bytes/u);
    expect(readStarted).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("fails closed on empty successful bulk advisory response bodies", async () => {
    const request = fetchBulkAdvisories({
      payload: { axios: ["1.0.0"] },
      fetchImpl: async () => new Response("", { status: 200 }),
    });

    await expect(request).rejects.toThrow(/Bulk advisory response body was empty/u);
  });

  it.each([false, true])(
    "reports npm-only coverage with the audit outcome (blocked %s)",
    async (blocked) => {
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
          fetchImpl: async (input) => {
            const url =
              input instanceof URL ? input.href : input instanceof Request ? input.url : input;
            expect(url).toMatch(/\/-\/npm\/v1\/security\/advisories\/bulk$/u);
            return new Response(
              JSON.stringify(
                blocked
                  ? {
                      axios: [
                        {
                          id: "GHSA-test",
                          severity: "high",
                          title: "test issue",
                          vulnerable_versions: "<=1.0.0",
                          url: "https://github.com/advisories/GHSA-test",
                        },
                      ],
                    }
                  : {},
              ),
              {
                status: 200,
                headers: {
                  "content-type": "application/json",
                },
              },
            );
          },
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

        expect(exitCode).toBe(blocked ? 1 : 0);
        if (blocked) {
          expect(stdoutChunks).toStrictEqual([]);
          expect(stderrChunks.join("")).toContain(
            "Found 1 high or higher advisories from npm bulk",
          );
          expect(stderrChunks.join("")).toContain("upstream repository advisories not checked");
        } else {
          expect(stderrChunks).toStrictEqual([]);
          expect(stdoutChunks.join("")).toContain(
            "No matching high or higher advisories returned by npm bulk",
          );
          expect(stdoutChunks.join("")).toContain(
            "Upstream repository advisories were not checked",
          );
          expect(stdoutChunks.join("")).toContain("not comprehensive vulnerability clearance");
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  );
});
