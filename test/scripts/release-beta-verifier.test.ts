// Release Beta Verifier tests cover release beta verifier script behavior.
/* oxlint-disable typescript/no-base-to-string -- fetch mock normalizes standard RequestInfo inputs for URL assertions. */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadClawHubBootstrapReadback,
  fetchJsonWithRetry,
  fetchStatusWithRetry,
  parseNpmViewFields,
  parseReleaseVerifyBetaArgs,
  readBoundedJsonResponse,
  resolveOpenClawNpmPostpublishVerifier,
  runNpmViewWithRetry,
  validateClawHubBootstrapEvidence,
} from "../../scripts/lib/release-beta-verifier.ts";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(files: Array<{ name: string; bytes: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const checksum = crc32(file.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(file.bytes.length, 18);
    local.writeUInt32LE(file.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, file.bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(file.bytes.length, 20);
    central.writeUInt32LE(file.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100600 * 0x10000) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + file.bytes.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("parseReleaseVerifyBetaArgs", () => {
  it("defaults beta verification to the matching tag and repo", () => {
    expect(parseReleaseVerifyBetaArgs(["2026.5.10-beta.3"])).toEqual({
      version: "2026.5.10-beta.3",
      tag: "v2026.5.10-beta.3",
      distTag: "beta",
      repo: "openclaw/openclaw",
      registry: "https://clawhub.ai",
      releaseSha: undefined,
      workflowRef: undefined,
      clawHubWorkflowRef: undefined,
      pluginSelection: [],
      clawHubBootstrapPlugins: [],
      evidenceOut: undefined,
      postpublishVerifier: undefined,
      skipPostpublish: false,
      skipGitHubRelease: false,
      skipClawHub: false,
      rerunFailedClawHub: false,
      workflowRuns: {},
    });
  });

  it("parses child run IDs and repair flags", () => {
    expect(
      parseReleaseVerifyBetaArgs([
        "--",
        "2026.5.10-beta.3",
        "--workflow-ref",
        "release/2026.5.10",
        "--release-sha",
        "a".repeat(40),
        "--clawhub-workflow-ref",
        "v2026.5.10-beta.3",
        "--plugins",
        "@openclaw/plugin-a,@openclaw/plugin-b",
        "--full-release-validation-run",
        "10",
        "--openclaw-npm-run",
        "11",
        "--plugin-npm-run",
        "22",
        "--plugin-clawhub-run",
        "33",
        "--plugin-clawhub-bootstrap-run",
        "34",
        "--clawhub-bootstrap-plugins",
        "@openclaw/plugin-b",
        "--npm-telegram-run",
        "44",
        "--evidence-out",
        ".artifacts/release-evidence.json",
        "--postpublish-verifier",
        "/tmp/trusted-postpublish.ts",
        "--skip-github-release",
        "--skip-clawhub",
        "--rerun-failed-clawhub",
      ]),
    ).toEqual({
      version: "2026.5.10-beta.3",
      tag: "v2026.5.10-beta.3",
      distTag: "beta",
      repo: "openclaw/openclaw",
      registry: "https://clawhub.ai",
      releaseSha: "a".repeat(40),
      workflowRef: "release/2026.5.10",
      clawHubWorkflowRef: "v2026.5.10-beta.3",
      pluginSelection: ["@openclaw/plugin-a", "@openclaw/plugin-b"],
      clawHubBootstrapPlugins: ["@openclaw/plugin-b"],
      evidenceOut: ".artifacts/release-evidence.json",
      postpublishVerifier: "/tmp/trusted-postpublish.ts",
      skipPostpublish: false,
      skipGitHubRelease: true,
      skipClawHub: true,
      rerunFailedClawHub: true,
      workflowRuns: {
        fullReleaseValidation: "10",
        openclawNpm: "11",
        pluginNpm: "22",
        pluginClawHub: "33",
        pluginClawHubBootstrap: "34",
        npmTelegram: "44",
      },
    });
  });

  it("only accepts the trusted tooling postpublish verifier override", () => {
    expect(resolveOpenClawNpmPostpublishVerifier("/tmp/release")).toBe(
      "/tmp/release/scripts/openclaw-npm-postpublish-verify.ts",
    );
    const trustedVerifier = resolve("scripts/openclaw-npm-postpublish-verify.ts");
    expect(resolveOpenClawNpmPostpublishVerifier("/tmp/release", trustedVerifier)).toBe(
      trustedVerifier,
    );
    expect(() =>
      resolveOpenClawNpmPostpublishVerifier("/tmp/release", "/tmp/untrusted-verifier.ts"),
    ).toThrow("must select the trusted tooling verifier");
    expect(() =>
      parseReleaseVerifyBetaArgs([
        "2026.5.10-beta.3",
        "--postpublish-verifier",
        trustedVerifier,
        "--skip-postpublish",
      ]),
    ).toThrow("cannot be combined");
  });

  it("requires exact target and package inputs for bootstrap run verification", () => {
    expect(() =>
      parseReleaseVerifyBetaArgs(["2026.5.10-beta.3", "--plugin-clawhub-bootstrap-run", "34"]),
    ).toThrow("--plugin-clawhub-bootstrap-run requires --release-sha");
    expect(() =>
      parseReleaseVerifyBetaArgs([
        "2026.5.10-beta.3",
        "--release-sha",
        "a".repeat(40),
        "--plugin-clawhub-bootstrap-run",
        "34",
      ]),
    ).toThrow("--plugin-clawhub-bootstrap-run requires --clawhub-bootstrap-plugins");
    expect(() =>
      parseReleaseVerifyBetaArgs([
        "2026.5.10-beta.3",
        "--clawhub-bootstrap-plugins",
        "@openclaw/plugin-b",
      ]),
    ).toThrow("--clawhub-bootstrap-plugins requires --plugin-clawhub-bootstrap-run");
  });
});

describe("validateClawHubBootstrapEvidence", () => {
  const clawhubToolchainIntegrity =
    "sha512-YvUImhsVaM90BUAv3uP7lfABziwR5XL3ch2Owa+GvNxwQ2xzZFmZC0yVjAtQbvep+dDDS16nUGRwKx7jqnTOEA==";
  const clawhubToolchainSha256 = "f44f670d70f13a8cde566a174cae5be682ad98456ec7a85aafd497f7d8c71816";
  const clawhubToolchainVersion = "0.23.1";
  const releaseSha = "a".repeat(40);
  const workflowSha = "b".repeat(40);
  const packageSha = "c".repeat(64);
  const readbackSha = "d".repeat(64);
  const run = {
    id: 34,
    name: "Plugin ClawHub New",
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: workflowSha,
    path: ".github/workflows/plugin-clawhub-new.yml@refs/heads/main",
    run_attempt: 2,
    status: "completed",
    conclusion: "success",
    html_url: "https://github.com/openclaw/openclaw/actions/runs/34",
    created_at: "2026-07-10T00:00:00Z",
    updated_at: "2026-07-10T00:02:00Z",
  };
  const workflowRun = {
    id: 34,
    head_branch: "main",
    head_sha: workflowSha,
  };
  const readbackArtifact = {
    id: 45,
    name: "clawhub-bootstrap-readback-34-2",
    digest: `sha256:${readbackSha}`,
    size_in_bytes: 1,
    expired: false,
    workflow_run: workflowRun,
  };
  const packageArtifact = {
    id: 46,
    name: `clawhub-bootstrap-${releaseSha.slice(0, 12)}-34-1`,
    digest: `sha256:${packageSha}`,
    expired: false,
    workflow_run: workflowRun,
  };
  const evidence = {
    schemaVersion: 2,
    repository: "openclaw/openclaw",
    targetSha: releaseSha,
    workflowSha,
    runId: "34",
    producerRunAttempt: "1",
    terminalRunAttempt: "2",
    artifactName: packageArtifact.name,
    artifactId: "46",
    artifactDigest: packageSha,
    clawhubToolchainIntegrity,
    clawhubToolchainSha256,
    clawhubToolchainVersion,
    requestedPlugins: ["@openclaw/meta"],
    verificationMode: "postpublish",
    packages: [
      {
        packageName: "@openclaw/meta",
        version: "2026.7.1-beta.3",
        expectedSha256: packageSha,
        expectedSize: 123,
        registrySha256: packageSha,
        registrySize: 123,
        npmIntegrity: "sha512-test",
        npmShasum: "1".repeat(40),
        artifactMetadata: {
          kind: "npm-pack",
          sha256: packageSha,
          size: 123,
          npmIntegrity: "sha512-test",
          npmShasum: "1".repeat(40),
          packageName: "@openclaw/meta",
          version: "2026.7.1-beta.3",
        },
      },
    ],
  };

  function validate(
    overrides: {
      run?: unknown;
      readbackArtifact?: unknown;
      packageArtifact?: unknown;
      evidence?: unknown;
      expectedPackages?: string[];
    } = {},
  ) {
    return validateClawHubBootstrapEvidence({
      repo: "openclaw/openclaw",
      runId: "34",
      releaseSha,
      expectedVersion: "2026.7.1-beta.3",
      expectedPackages: overrides.expectedPackages ?? ["@openclaw/meta"],
      run: overrides.run ?? run,
      readbackArtifact: overrides.readbackArtifact ?? readbackArtifact,
      readbackArchiveSha256: readbackSha,
      packageArtifact: overrides.packageArtifact ?? packageArtifact,
      evidence: overrides.evidence ?? evidence,
    });
  }

  it("binds the exact main run, attempt, target, package set, and artifact tuple", () => {
    expect(validate()).toMatchObject({
      id: "34",
      label: "Plugin ClawHub New",
      durationSeconds: 120,
      bootstrapEvidence: {
        targetSha: releaseSha,
        workflowSha,
        workflowPath: ".github/workflows/plugin-clawhub-new.yml",
        producerRunAttempt: "1",
        terminalRunAttempt: "2",
        readbackArtifactId: "45",
        readbackArtifactDigest: readbackSha,
        packageArtifactId: "46",
        packageArtifactDigest: packageSha,
        packageCount: 1,
        clawhubToolchainIntegrity,
        clawhubToolchainSha256,
        clawhubToolchainVersion,
      },
    });
  });

  it("rejects legacy release-ref runs and mismatched target/package evidence", () => {
    expect(() => validate({ run: { ...run, head_branch: "release/2026.7.1" } })).toThrow(
      "not dispatched from trusted main",
    );
    expect(() =>
      validate({
        run: { ...run, path: ".github/workflows/not-plugin-clawhub-new.yml" },
      }),
    ).toThrow("unexpected workflow path");
    expect(() => validate({ evidence: { ...evidence, targetSha: "e".repeat(40) } })).toThrow(
      "target SHA mismatch",
    );
    expect(() => validate({ expectedPackages: ["@openclaw/other"] })).toThrow(
      "requested package set mismatch",
    );
  });

  it("rejects stale attempts, changed artifact bytes, and metadata drift", () => {
    expect(() =>
      validate({
        readbackArtifact: {
          ...readbackArtifact,
          name: "clawhub-bootstrap-readback-34-1",
        },
      }),
    ).toThrow("does not bind the run attempt");
    expect(() =>
      validate({
        evidence: { ...evidence, terminalRunAttempt: "1" },
      }),
    ).toThrow("readback evidence run tuple mismatch");
    expect(() =>
      validate({
        evidence: { ...evidence, producerRunAttempt: "3" },
      }),
    ).toThrow("producer attempt is newer than its terminal attempt");
    expect(() =>
      validate({
        packageArtifact: {
          ...packageArtifact,
          name: `clawhub-bootstrap-${releaseSha.slice(0, 12)}-34-2`,
        },
        evidence: {
          ...evidence,
          artifactName: `clawhub-bootstrap-${releaseSha.slice(0, 12)}-34-2`,
        },
      }),
    ).toThrow("package artifact name does not bind the target and attempt");
    expect(() =>
      validate({
        packageArtifact: {
          ...packageArtifact,
          digest: `sha256:${"e".repeat(64)}`,
        },
      }),
    ).toThrow("package artifact digest mismatch");
    expect(() =>
      validate({
        evidence: {
          ...evidence,
          packages: [
            {
              ...expectDefined(evidence.packages[0], "first beta release package evidence"),
              artifactMetadata: {
                ...expectDefined(evidence.packages[0], "first beta release package evidence")
                  .artifactMetadata,
                npmIntegrity: "sha512-different",
              },
            },
          ],
        },
      }),
    ).toThrow("artifact metadata does not match downloaded bytes");
    expect(() =>
      validate({
        evidence: {
          ...evidence,
          clawhubToolchainSha256: "e".repeat(64),
        },
      }),
    ).toThrow("clawhubToolchainSha256 mismatch");
  });
});

describe("downloadClawHubBootstrapReadback", () => {
  const workflowSha = "b".repeat(40);
  const run = {
    id: 34,
    name: "Plugin ClawHub New",
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: workflowSha,
    path: ".github/workflows/plugin-clawhub-new.yml@refs/heads/main",
    run_attempt: 2,
    status: "completed",
    conclusion: "success",
  };
  const workflowAttempt = {
    id: 34,
    run_attempt: 2,
    head_sha: workflowSha,
    head_branch: "main",
    event: "workflow_dispatch",
    path: ".github/workflows/plugin-clawhub-new.yml",
    status: "completed",
    conclusion: "success",
    repository: { full_name: "openclaw/openclaw" },
    head_repository: { full_name: "openclaw/openclaw" },
  };

  function createFixture(
    archive: Buffer,
    overrides: {
      artifactMetadata?: Record<string, unknown>;
      workflowAttempt?: Record<string, unknown>;
    } = {},
  ) {
    const readbackArtifact = {
      id: 45,
      name: "clawhub-bootstrap-readback-34-2",
      digest: `sha256:${sha256(archive)}`,
      size_in_bytes: archive.length,
      expired: false,
      workflow_run: {
        id: 34,
        head_branch: "main",
        head_sha: workflowSha,
      },
    };
    const artifactMetadata = {
      ...readbackArtifact,
      ...overrides.artifactMetadata,
    };
    const attemptMetadata = {
      ...workflowAttempt,
      ...overrides.workflowAttempt,
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/actions/artifacts/45")) {
        return Response.json(artifactMetadata);
      }
      if (url.endsWith("/actions/runs/34/attempts/2")) {
        return Response.json(attemptMetadata);
      }
      if (url.endsWith("/actions/artifacts/45/zip")) {
        return new Response(archive as unknown as BodyInit, {
          headers: { "content-length": String(archive.length) },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    return { fetchImpl, readbackArtifact };
  }

  async function download(
    archive: Buffer,
    overrides?: Parameters<typeof createFixture>[1],
  ): Promise<{
    result: Awaited<ReturnType<typeof downloadClawHubBootstrapReadback>>;
    requests: number;
  }> {
    const fixture = createFixture(archive, overrides);
    const result = await downloadClawHubBootstrapReadback({
      repo: "openclaw/openclaw",
      runId: "34",
      run,
      readbackArtifact: fixture.readbackArtifact,
      token: "test-token",
      fetchImpl: fixture.fetchImpl,
      retryAttempts: 1,
      retryDelayMs: 1,
      timeoutMs: 1_000,
    });
    return { result, requests: fixture.fetchImpl.mock.calls.length };
  }

  it("downloads one exact readback file from the bound successful main attempt", async () => {
    const evidence = { schemaVersion: 2, targetSha: "a".repeat(40) };
    const archive = createStoredZip([
      {
        name: "clawhub-bootstrap-readback.json",
        bytes: Buffer.from(JSON.stringify(evidence)),
      },
    ]);

    await expect(download(archive)).resolves.toEqual({
      result: {
        value: evidence,
        archiveSha256: sha256(archive),
      },
      requests: 3,
    });
  });

  it("rejects stale live artifact and workflow-attempt metadata", async () => {
    const archive = createStoredZip([
      {
        name: "clawhub-bootstrap-readback.json",
        bytes: Buffer.from("{}"),
      },
    ]);

    await expect(
      download(archive, {
        artifactMetadata: { digest: `sha256:${"c".repeat(64)}` },
      }),
    ).rejects.toThrow("artifact metadata does not match the immutable publication tuple");
    await expect(
      download(archive, {
        workflowAttempt: { run_attempt: 1 },
      }),
    ).rejects.toThrow("workflow run does not match the immutable publication tuple");
  });

  it("rejects hostile or expanded readback inventories through the shared ZIP policy", async () => {
    const hostileArchives = [
      createStoredZip([{ name: "../clawhub-bootstrap-readback.json", bytes: Buffer.from("{}") }]),
      createStoredZip([
        { name: "clawhub-bootstrap-readback.json", bytes: Buffer.from("{}") },
        { name: "extra.json", bytes: Buffer.from("{}") },
      ]),
    ];

    for (const archive of hostileArchives) {
      await expect(download(archive)).rejects.toThrow(/(?:Unsafe ZIP entry|Actions artifact ZIP)/u);
    }
  });
});

describe("parseNpmViewFields", () => {
  it("accepts keyed npm view JSON", () => {
    expect(
      parseNpmViewFields(
        JSON.stringify({
          version: "2026.5.10-beta.3",
          "dist-tags.beta": "2026.5.10-beta.3",
          "dist.integrity": "sha512-test",
          "dist.tarball": "https://registry.example/openclaw.tgz",
        }),
        "beta",
      ),
    ).toEqual({
      version: "2026.5.10-beta.3",
      distTagVersion: "2026.5.10-beta.3",
      integrity: "sha512-test",
      tarball: "https://registry.example/openclaw.tgz",
    });
  });

  it("accepts nested npm view JSON", () => {
    expect(
      parseNpmViewFields(
        JSON.stringify({
          version: "2026.5.10-beta.3",
          "dist-tags": { beta: "2026.5.10-beta.3" },
          dist: {
            integrity: "sha512-test",
            tarball: "https://registry.example/openclaw.tgz",
          },
        }),
        "beta",
      ),
    ).toEqual({
      version: "2026.5.10-beta.3",
      distTagVersion: "2026.5.10-beta.3",
      integrity: "sha512-test",
      tarball: "https://registry.example/openclaw.tgz",
    });
  });
});

describe("runNpmViewWithRetry", () => {
  it("retries transient registry failures with online metadata reads", async () => {
    const calls: string[][] = [];
    const delays: number[] = [];

    await expect(
      runNpmViewWithRetry(["view", "openclaw@2026.5.10-beta.3", "version", "--json"], {
        attempts: 3,
        delay: async (delayMs) => {
          delays.push(delayMs);
        },
        run: (args) => {
          calls.push(args);
          if (calls.length < 3) {
            throw new Error("npm registry has not propagated the release yet");
          }
          return '"2026.5.10-beta.3"';
        },
      }),
    ).resolves.toBe('"2026.5.10-beta.3"');

    expect(calls).toHaveLength(3);
    expect(calls.every((args) => args.at(-1) === "--prefer-online")).toBe(true);
    expect(delays).toEqual([1000, 2000]);
  });
});

describe("fetchStatusWithRetry", () => {
  it("cancels retryable and returned GET response bodies", async () => {
    vi.useFakeTimers();
    const canceled: string[] = [];
    const responses = [
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            canceled.push("retry");
          },
        }),
        { status: 500 },
      ),
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            canceled.push("final");
          },
        }),
        { status: 200 },
      ),
    ];
    const fetchImpl = vi.fn(async () => {
      const response = responses.shift();
      if (!response) {
        throw new Error("unexpected fetch call");
      }
      return response;
    });
    vi.stubGlobal("fetch", fetchImpl);

    const status = fetchStatusWithRetry("https://clawhub.test/api/v1/package", "GET");
    await vi.advanceTimersByTimeAsync(1000);

    await expect(status).resolves.toBe(200);
    expect(canceled).toEqual(["retry", "final"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("fetchJsonWithRetry", () => {
  it("retries invalid and failed response bodies within the attempt budget", async () => {
    const delays: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("{invalid"))
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("truncated"));
            },
          }),
        ),
      )
      .mockResolvedValueOnce(Response.json({ ok: true }));

    await expect(
      fetchJsonWithRetry("https://clawhub.test/api/v1/package", {
        attempts: 3,
        delay: async (delayMs) => {
          delays.push(delayMs);
        },
        fetchImpl,
      }),
    ).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([1000, 2000]);
  });

  it("fails permanent client errors without retrying", async () => {
    const delay = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => new Response("denied", { status: 403 }));
    await expect(
      fetchJsonWithRetry("https://clawhub.test/api/v1/package", {
        attempts: 3,
        delay,
        fetchImpl,
      }),
    ).rejects.toThrow("returned HTTP 403");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });
});

describe("readBoundedJsonResponse", () => {
  it("parses JSON bodies within the release verifier limit", async () => {
    await expect(
      readBoundedJsonResponse(new Response('{"ok":true}'), "ClawHub package", 64),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects oversized JSON bodies by content length", async () => {
    await expect(
      readBoundedJsonResponse(
        new Response("{}", { headers: { "content-length": "65" } }),
        "ClawHub package",
        64,
      ),
    ).rejects.toThrow("ClawHub package response body exceeded 64 bytes.");
  });

  it("rejects oversized streamed JSON bodies", async () => {
    await expect(
      readBoundedJsonResponse(new Response('{"padding":"too-large"}'), "ClawHub package", 8),
    ).rejects.toThrow("ClawHub package response body exceeded 8 bytes.");
  });

  it("keeps ClawHub request timeouts active while reading JSON bodies", async () => {
    let canceled = false;
    const abortController = new AbortController();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"partial":'));
        },
        cancel() {
          canceled = true;
        },
      }),
    );

    const json = readBoundedJsonResponse(response, "ClawHub package", 64, {
      signal: abortController.signal,
    });

    await new Promise((resolveDelay) => {
      setTimeout(resolveDelay, 0);
    });
    abortController.abort(new Error("ClawHub body timed out"));

    await expect(json).rejects.toThrow("ClawHub body timed out");
    expect(canceled).toBe(true);
  });
});
