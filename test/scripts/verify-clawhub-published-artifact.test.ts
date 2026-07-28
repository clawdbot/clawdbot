import { createHash } from "node:crypto";
/* oxlint-disable typescript/no-base-to-string -- fetch mocks normalize standard RequestInfo inputs for registry URL assertions. */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  verifyPublishedClawHubArtifacts,
  verifyPublishedClawHubPackage,
} from "../../scripts/verify-clawhub-published-artifact.mjs";

const tempDirs: string[] = [];
const clawhubToolchainSha256 = "d".repeat(64);
const clawhubToolchainVersion = "0.23.1";
const clawhubToolchainIntegrity =
  "sha512-YvUImhsVaM90BUAv3uP7lfABziwR5XL3ch2Owa+GvNxwQ2xzZFmZC0yVjAtQbvep+dDDS16nUGRwKx7jqnTOEA==";

function immutableBinding() {
  return {
    artifactDigest: "c".repeat(64),
    artifactId: "456",
    clawhubToolchainIntegrity,
    clawhubToolchainSha256,
    clawhubToolchainVersion,
  };
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function identity(artifact: Uint8Array) {
  return {
    sha256: createHash("sha256").update(artifact).digest("hex"),
    size: artifact.byteLength,
    npmIntegrity: `sha512-${createHash("sha512").update(artifact).digest("base64")}`,
    npmShasum: createHash("sha1").update(artifact).digest("hex"),
  };
}

function writeManifest(mode: "publish" | "configure-only", artifact: Uint8Array, runAttempt = "1") {
  const root = mkdtempSync(join(tmpdir(), "openclaw-clawhub-readback-"));
  tempDirs.push(root);
  const path = join(root, "manifest.json");
  const artifactIdentity = identity(artifact);
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      repository: "openclaw/openclaw",
      targetSha: "a".repeat(40),
      workflowSha: "b".repeat(40),
      runId: "123",
      runAttempt,
      artifactName: `clawhub-bootstrap-aaaaaaaaaaaa-123-${runAttempt}`,
      clawhubToolchainIntegrity,
      clawhubToolchainSha256,
      clawhubToolchainVersion,
      requestedPlugins: ["@openclaw/meta"],
      entries: [
        {
          packageName: "@openclaw/meta",
          version: "2026.7.1-beta.3",
          packageDir: "extensions/meta",
          publishTag: "beta",
          bootstrapMode: mode,
          requiresManualOverride: mode === "configure-only",
          artifactPath: "packages/meta/openclaw-meta-2026.7.1-beta.3.tgz",
          sha256: artifactIdentity.sha256,
          size: artifactIdentity.size,
        },
      ],
    }),
  );
  return path;
}

function writeExpectedArtifact(artifact: Uint8Array) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-clawhub-oidc-readback-"));
  tempDirs.push(root);
  const artifactDir = join(root, "artifact");
  mkdirSync(artifactDir);
  writeFileSync(join(artifactDir, "openclaw-meta-2026.7.1-beta.3.tgz"), artifact);
  return artifactDir;
}

function artifactResponse(artifact: Uint8Array, body: BodyInit = artifact as unknown as BodyInit) {
  const artifactIdentity = identity(artifact);
  return new Response(body, {
    headers: {
      "content-length": String(artifact.byteLength),
      "x-clawhub-artifact-sha256": artifactIdentity.sha256,
      "x-clawhub-npm-integrity": artifactIdentity.npmIntegrity,
      "x-clawhub-npm-shasum": artifactIdentity.npmShasum,
    },
  });
}

function metadataResponse(artifact: Uint8Array, body?: BodyInit) {
  const artifactIdentity = identity(artifact);
  return new Response(
    body ??
      JSON.stringify({
        package: { name: "@openclaw/meta" },
        version: "2026.7.1-beta.3",
        artifact: {
          kind: "npm-pack",
          sha256: artifactIdentity.sha256,
          size: artifactIdentity.size,
          npmIntegrity: artifactIdentity.npmIntegrity,
          npmShasum: artifactIdentity.npmShasum,
        },
      }),
    { headers: { "content-type": "application/json" } },
  );
}

function registryFetch(artifact: Uint8Array) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/trusted-publisher")) {
      return Response.json({
        trustedPublisher: {
          provider: "github-actions",
          repository: "openclaw/openclaw",
          workflowFilename: "plugin-clawhub-release.yml",
          environment: null,
        },
      });
    }
    if (url.endsWith("/artifact/download")) {
      return artifactResponse(artifact);
    }
    if (url.endsWith("/artifact")) {
      return metadataResponse(artifact);
    }
    return Response.json({
      package: { tags: { beta: "2026.7.1-beta.3" } },
    });
  });
}

describe("ClawHub published artifact verification", () => {
  it("uses bounded streaming reads with an active attempt timeout", () => {
    const source = readFileSync("scripts/verify-clawhub-published-artifact.mjs", "utf8");
    expect(source).not.toContain(".arrayBuffer(");
    expect(source).toContain("response.body.getReader()");
    expect(source).toContain("readBoundedBytes(response, url, MAX_JSON_BYTES)");
    expect(source).toContain("readBoundedBytes(response, url, MAX_ARTIFACT_BYTES)");
    expect(source).toContain("AbortSignal.timeout(timeoutMs)");
  });

  it("verifies normal OIDC publication against the exact prepared artifact bytes", async () => {
    const artifact = new TextEncoder().encode("exact oidc tgz bytes");
    const fetchImpl = registryFetch(artifact);
    const evidence = await verifyPublishedClawHubPackage({
      expectedArtifactDir: writeExpectedArtifact(artifact),
      packageName: "@openclaw/meta",
      packageVersion: "2026.7.1-beta.3",
      publishTag: "beta",
      registry: "https://clawhub.example",
      retryOptions: { fetchImpl, attempts: 1, delayMs: 1 },
    });

    expect(evidence).toMatchObject({
      schemaVersion: 1,
      verificationMode: "oidc-postpublish",
      expectedArtifact: identity(artifact),
      package: {
        packageName: "@openclaw/meta",
        registrySha256: identity(artifact).sha256,
        registrySize: artifact.byteLength,
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("rejects a non-GitHub Actions trusted publisher", async () => {
    const artifact = new TextEncoder().encode("exact oidc tgz bytes");
    const fetchImpl = registryFetch(artifact);
    fetchImpl
      .mockResolvedValueOnce(
        Response.json({
          package: { tags: { beta: "2026.7.1-beta.3" } },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          trustedPublisher: {
            provider: "other",
            repository: "openclaw/openclaw",
            workflowFilename: "plugin-clawhub-release.yml",
            environment: null,
          },
        }),
      );

    await expect(
      verifyPublishedClawHubPackage({
        expectedArtifactDir: writeExpectedArtifact(artifact),
        packageName: "@openclaw/meta",
        packageVersion: "2026.7.1-beta.3",
        publishTag: "beta",
        registry: "https://clawhub.example",
        retryOptions: { fetchImpl, attempts: 1, delayMs: 1 },
      }),
    ).rejects.toThrow("trusted publisher provider mismatch");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects ambiguous or symlinked normal OIDC artifacts before registry access", async () => {
    const artifact = new TextEncoder().encode("exact oidc tgz bytes");
    const fetchImpl = registryFetch(artifact);
    const ambiguous = writeExpectedArtifact(artifact);
    writeFileSync(join(ambiguous, "second.tgz"), artifact);
    await expect(
      verifyPublishedClawHubPackage({
        expectedArtifactDir: ambiguous,
        packageName: "@openclaw/meta",
        packageVersion: "2026.7.1-beta.3",
        publishTag: "beta",
        retryOptions: { fetchImpl, attempts: 1, delayMs: 1 },
      }),
    ).rejects.toThrow("exactly one root .tgz regular file");

    const root = mkdtempSync(join(tmpdir(), "openclaw-clawhub-oidc-symlink-"));
    tempDirs.push(root);
    const artifactDir = join(root, "artifact");
    const target = join(root, "target.tgz");
    mkdirSync(artifactDir);
    writeFileSync(target, artifact);
    symlinkSync(target, join(artifactDir, "linked.tgz"));
    await expect(
      verifyPublishedClawHubPackage({
        expectedArtifactDir: artifactDir,
        packageName: "@openclaw/meta",
        packageVersion: "2026.7.1-beta.3",
        publishTag: "beta",
        retryOptions: { fetchImpl, attempts: 1, delayMs: 1 },
      }),
    ).rejects.toThrow("exactly one root .tgz regular file");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires exact bytes and complete artifact metadata", async () => {
    const artifact = new TextEncoder().encode("exact tgz bytes");
    const evidence = await verifyPublishedClawHubArtifacts({
      ...immutableBinding(),
      manifestPath: writeManifest("publish", artifact),
      registry: "https://clawhub.example",
      terminalRunAttempt: "2",
      retryOptions: { fetchImpl: registryFetch(artifact), attempts: 1, delayMs: 1 },
    });
    expect(evidence).toMatchObject({
      schemaVersion: 2,
      producerRunAttempt: "1",
      terminalRunAttempt: "2",
      artifactName: "clawhub-bootstrap-aaaaaaaaaaaa-123-1",
      clawhubToolchainIntegrity,
      clawhubToolchainSha256,
      clawhubToolchainVersion,
      requestedPlugins: ["@openclaw/meta"],
      verificationMode: "postpublish",
      packages: [
        {
          packageName: "@openclaw/meta",
          registrySha256: identity(artifact).sha256,
          registrySize: artifact.byteLength,
          npmIntegrity: identity(artifact).npmIntegrity,
          npmShasum: identity(artifact).npmShasum,
          artifactMetadata: {
            kind: "npm-pack",
            packageName: "@openclaw/meta",
            version: "2026.7.1-beta.3",
          },
        },
      ],
    });
  });

  it("proves configure-only registry bytes before trusted-publisher mutation", async () => {
    const artifact = new TextEncoder().encode("historical exact bytes");
    const fetchImpl = registryFetch(artifact);
    const evidence = await verifyPublishedClawHubArtifacts({
      ...immutableBinding(),
      manifestPath: writeManifest("configure-only", artifact),
      mode: "configure-only-preflight",
      registry: "https://clawhub.example",
      terminalRunAttempt: "1",
      retryOptions: { fetchImpl, attempts: 1, delayMs: 1 },
    });
    expect(evidence.packages[0]).toMatchObject({
      bootstrapMode: "configure-only",
      expectedSha256: identity(artifact).sha256,
      registrySha256: identity(artifact).sha256,
    });
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith("/trusted-publisher"))).toBe(
      false,
    );
  });

  it("rejects a missing configure-only tag before artifact or publisher requests", async () => {
    const artifact = new TextEncoder().encode("historical exact bytes");
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL) =>
      Response.json({
        package: { tags: { beta: "2026.7.1-beta.2" } },
      }),
    );

    await expect(
      verifyPublishedClawHubArtifacts({
        ...immutableBinding(),
        manifestPath: writeManifest("configure-only", artifact),
        mode: "configure-only-preflight",
        registry: "https://clawhub.example",
        terminalRunAttempt: "1",
        retryOptions: { fetchImpl, attempts: 1, delayMs: 1 },
      }),
    ).rejects.toThrow(
      "@openclaw/meta@2026.7.1-beta.3 ClawHub artifact did not stabilize after 1 attempts; last failure @openclaw/meta ClawHub tag beta mismatch",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/artifact"))).toBe(false);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith("/trusted-publisher"))).toBe(
      false,
    );
  });

  it("retries invalid JSON, body read failures, and eventual byte convergence", async () => {
    const expected = new TextEncoder().encode("expected");
    const wrong = new TextEncoder().encode("wrong");
    let detailCalls = 0;
    let artifactCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.includes("/artifact") && !url.endsWith("/trusted-publisher")) {
        detailCalls += 1;
        if (detailCalls === 1) {
          return new Response("{invalid");
        }
        return Response.json({ package: { tags: { beta: "2026.7.1-beta.3" } } });
      }
      if (url.endsWith("/trusted-publisher")) {
        return Response.json({
          trustedPublisher: {
            provider: "github-actions",
            repository: "openclaw/openclaw",
            workflowFilename: "plugin-clawhub-release.yml",
            environment: null,
          },
        });
      }
      if (url.endsWith("/artifact")) {
        return metadataResponse(expected);
      }
      artifactCalls += 1;
      if (artifactCalls === 1) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("truncated body"));
            },
          }),
        );
      }
      if (artifactCalls === 2) {
        return artifactResponse(expected, wrong);
      }
      return artifactResponse(expected);
    });
    const sleep = vi.fn(async () => {});
    await expect(
      verifyPublishedClawHubArtifacts({
        ...immutableBinding(),
        manifestPath: writeManifest("publish", expected),
        registry: "https://clawhub.example",
        terminalRunAttempt: "1",
        retryOptions: { fetchImpl, attempts: 4, delayMs: 1, sleep },
      }),
    ).resolves.toMatchObject({ packages: [{ registrySha256: identity(expected).sha256 }] });
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("keeps the attempt timeout active through a stalled body", async () => {
    const artifact = new TextEncoder().encode("expected");
    let artifactCalls = 0;
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("/artifact")) {
          return metadataResponse(artifact);
        }
        if (url.endsWith("/artifact/download")) {
          artifactCalls += 1;
          if (artifactCalls === 1) {
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  init?.signal?.addEventListener(
                    "abort",
                    () => controller.error(init.signal?.reason),
                    { once: true },
                  );
                },
              }),
            );
          }
          return artifactResponse(artifact);
        }
        if (!url.includes("/artifact")) {
          return Response.json({
            package: { tags: { beta: "2026.7.1-beta.3" } },
          });
        }
        throw new Error(`unexpected URL ${url}`);
      },
    );

    await expect(
      verifyPublishedClawHubArtifacts({
        ...immutableBinding(),
        manifestPath: writeManifest("configure-only", artifact),
        mode: "configure-only-preflight",
        registry: "https://clawhub.example",
        terminalRunAttempt: "1",
        retryOptions: { fetchImpl, attempts: 2, delayMs: 1, timeoutMs: 10 },
      }),
    ).resolves.toMatchObject({ packages: [{ registrySize: artifact.byteLength }] });
    expect(artifactCalls).toBe(2);
  });

  it("cancels retryable response bodies and never sleeps after the final attempt", async () => {
    const artifact = new TextEncoder().encode("expected");
    const canceled: string[] = [];
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            canceled.push("retry");
          },
        }),
        { status: 503 },
      );
    });
    await expect(
      verifyPublishedClawHubArtifacts({
        ...immutableBinding(),
        manifestPath: writeManifest("configure-only", artifact),
        mode: "configure-only-preflight",
        registry: "https://clawhub.example",
        terminalRunAttempt: "1",
        retryOptions: { fetchImpl, attempts: 2, delayMs: 1, sleep },
      }),
    ).rejects.toThrow("did not stabilize after 2 attempts");
    expect(canceled).toEqual(["retry", "retry"]);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("fails immediately on permanent HTTP errors and explicit size limits", async () => {
    const artifact = new TextEncoder().encode("expected");
    const permanentFetch = vi.fn(async () => new Response("denied", { status: 403 }));
    const permanentSleep = vi.fn(async () => {});
    await expect(
      verifyPublishedClawHubArtifacts({
        ...immutableBinding(),
        manifestPath: writeManifest("configure-only", artifact),
        mode: "configure-only-preflight",
        registry: "https://clawhub.example",
        terminalRunAttempt: "1",
        retryOptions: {
          fetchImpl: permanentFetch,
          attempts: 3,
          delayMs: 1,
          sleep: permanentSleep,
        },
      }),
    ).rejects.toThrow("returned HTTP 403");
    expect(permanentFetch).toHaveBeenCalledTimes(1);
    expect(permanentSleep).not.toHaveBeenCalled();

    const oversizedFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/artifact")) {
        return new Response("{}", {
          headers: { "content-length": String(1024 * 1024 + 1) },
        });
      }
      return Response.json({
        package: { tags: { beta: "2026.7.1-beta.3" } },
      });
    });
    await expect(
      verifyPublishedClawHubArtifacts({
        ...immutableBinding(),
        manifestPath: writeManifest("configure-only", artifact),
        mode: "configure-only-preflight",
        registry: "https://clawhub.example",
        terminalRunAttempt: "1",
        retryOptions: { fetchImpl: oversizedFetch, attempts: 3, delayMs: 1 },
      }),
    ).rejects.toThrow("exceeded 1048576 bytes");
    expect(oversizedFetch).toHaveBeenCalledTimes(2);

    const oversizedArtifactFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/artifact/download")) {
        return new Response(null, {
          headers: { "content-length": String(130 * 1024 * 1024 + 1) },
        });
      }
      if (url.endsWith("/artifact")) {
        return metadataResponse(artifact);
      }
      return Response.json({
        package: { tags: { beta: "2026.7.1-beta.3" } },
      });
    });
    await expect(
      verifyPublishedClawHubArtifacts({
        ...immutableBinding(),
        manifestPath: writeManifest("configure-only", artifact),
        mode: "configure-only-preflight",
        registry: "https://clawhub.example",
        terminalRunAttempt: "1",
        retryOptions: { fetchImpl: oversizedArtifactFetch, attempts: 3, delayMs: 1 },
      }),
    ).rejects.toThrow("exceeded 136314880 bytes");
  });

  it("requires a terminal attempt at or after the immutable producer attempt", async () => {
    const artifact = new TextEncoder().encode("expected");
    const baseOptions = {
      ...immutableBinding(),
      manifestPath: writeManifest("configure-only", artifact),
      mode: "configure-only-preflight",
      registry: "https://clawhub.example",
      retryOptions: { fetchImpl: registryFetch(artifact), attempts: 1, delayMs: 1 },
    };

    await expect(verifyPublishedClawHubArtifacts(baseOptions)).rejects.toThrow(
      "terminalRunAttempt must be an integer",
    );
    await expect(
      verifyPublishedClawHubArtifacts({ ...baseOptions, terminalRunAttempt: "0" }),
    ).rejects.toThrow("terminalRunAttempt must be an integer");
    await expect(
      verifyPublishedClawHubArtifacts({
        ...baseOptions,
        manifestPath: writeManifest("configure-only", artifact, "2"),
        terminalRunAttempt: "1",
      }),
    ).rejects.toThrow("greater than or equal to the producer run attempt");

    for (const invalid of ["1junk", "1.5", "1e2"]) {
      await expect(
        verifyPublishedClawHubArtifacts({
          ...baseOptions,
          terminalRunAttempt: invalid,
        }),
      ).rejects.toThrow("terminalRunAttempt must be an integer");
    }
    await expect(
      verifyPublishedClawHubArtifacts({
        ...baseOptions,
        artifactId: "1junk",
        terminalRunAttempt: "1",
      }),
    ).rejects.toThrow("artifactId must be an integer");
    await expect(
      verifyPublishedClawHubArtifacts({
        ...baseOptions,
        artifactDigest: "A".repeat(64),
        terminalRunAttempt: "1",
      }),
    ).rejects.toThrow("artifactDigest is invalid");
  });

  it("requires the locked ClawHub toolchain identity in the validated manifest", async () => {
    const artifact = new TextEncoder().encode("expected");
    const manifestPath = writeManifest("configure-only", artifact);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.clawhubToolchainSha256 = "A".repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest));

    await expect(
      verifyPublishedClawHubArtifacts({
        ...immutableBinding(),
        manifestPath,
        mode: "configure-only-preflight",
        registry: "https://clawhub.example",
        terminalRunAttempt: "1",
        retryOptions: { fetchImpl: registryFetch(artifact), attempts: 1, delayMs: 1 },
      }),
    ).rejects.toThrow("manifest.clawhubToolchainSha256 is invalid");

    manifest.clawhubToolchainSha256 = clawhubToolchainSha256;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(
      verifyPublishedClawHubArtifacts({
        ...immutableBinding(),
        clawhubToolchainSha256: "e".repeat(64),
        manifestPath,
        mode: "configure-only-preflight",
        registry: "https://clawhub.example",
        terminalRunAttempt: "1",
        retryOptions: { fetchImpl: registryFetch(artifact), attempts: 1, delayMs: 1 },
      }),
    ).rejects.toThrow("clawhubToolchainSha256 mismatch");
  });

  it("rejects noncanonical, oversized, and symlinked manifests before registry access", async () => {
    const artifact = new TextEncoder().encode("expected");
    const fetchImpl = registryFetch(artifact);
    const manifestPath = writeManifest("configure-only", artifact);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, unexpected: true }));
    await expect(
      verifyPublishedClawHubArtifacts({
        ...immutableBinding(),
        manifestPath,
        mode: "configure-only-preflight",
        registry: "https://clawhub.example",
        terminalRunAttempt: "1",
        retryOptions: { fetchImpl, attempts: 1, delayMs: 1 },
      }),
    ).rejects.toThrow("keys are invalid");

    const oversizedPath = writeManifest("configure-only", artifact);
    truncateSync(oversizedPath, 2 * 1024 * 1024 + 1);
    await expect(
      verifyPublishedClawHubArtifacts({
        ...immutableBinding(),
        manifestPath: oversizedPath,
        mode: "configure-only-preflight",
        registry: "https://clawhub.example",
        terminalRunAttempt: "1",
        retryOptions: { fetchImpl, attempts: 1, delayMs: 1 },
      }),
    ).rejects.toThrow("size is outside the allowed range: 2097153");

    const targetPath = writeManifest("configure-only", artifact);
    const symlinkPath = `${targetPath}.link`;
    symlinkSync(targetPath, symlinkPath);
    await expect(
      verifyPublishedClawHubArtifacts({
        ...immutableBinding(),
        manifestPath: symlinkPath,
        mode: "configure-only-preflight",
        registry: "https://clawhub.example",
        terminalRunAttempt: "1",
        retryOptions: { fetchImpl, attempts: 1, delayMs: 1 },
      }),
    ).rejects.toThrow("must be a regular file");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
