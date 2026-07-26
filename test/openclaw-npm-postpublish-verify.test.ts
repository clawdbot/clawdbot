import { generateKeyPairSync, sign } from "node:crypto";
// OpenClaw npm postpublish tests validate postpublish verification behavior.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildPublishedInstallCommandArgs,
  buildPublishedInstallScenarios,
  collectInstalledAlwaysAllowedRuntimeFacadeErrors,
  collectInstalledBundledExtensionManifestErrors,
  collectInstalledBundledRuntimeSidecarPaths,
  collectInstalledContextEngineRuntimeErrors,
  collectInstalledPluginSdkZodArtifactErrors,
  collectInstalledRootDependencyManifestErrors,
  collectInstalledPackageErrors,
  fetchRegistryJson,
  normalizeInstalledBinaryVersion,
  openClawNpmPostpublishVerifyUsage,
  parseOpenClawNpmPostpublishVerifyArgs,
  resolveInstalledBinaryCommandInvocation,
  resolveInstalledBinaryPath,
  retryNpmRegistryProvenanceRead,
  verifyNpmProvenanceAttestation,
  verifyNpmRegistrySignatures,
} from "../scripts/openclaw-npm-postpublish-verify.ts";

const INSTALLED_ROOT_DIST_JS_FILE_SCAN_LIMIT = 10_000;

describe("parseOpenClawNpmPostpublishVerifyArgs", () => {
  it("keeps trusted release verification independent from target app dependencies", () => {
    const source = readFileSync("scripts/openclaw-npm-postpublish-verify.ts", "utf8");

    expect(source).toContain('from "./lib/error-format.mjs"');
    expect(source).not.toContain('from "../src/infra/errors.ts"');
  });

  it("supports help and package-manager separators", () => {
    expect(parseOpenClawNpmPostpublishVerifyArgs(["--help"])).toEqual({
      help: true,
      version: "",
    });
    expect(parseOpenClawNpmPostpublishVerifyArgs(["--", "2026.3.23"])).toEqual({
      help: false,
      version: "2026.3.23",
    });
  });

  it("rejects missing, option-like, and extra arguments before verification", () => {
    expect(() => parseOpenClawNpmPostpublishVerifyArgs([])).toThrow(
      openClawNpmPostpublishVerifyUsage(),
    );
    expect(() => parseOpenClawNpmPostpublishVerifyArgs(["--tag"])).toThrow(
      "Unknown openclaw npm postpublish verifier option: --tag",
    );
    expect(() => parseOpenClawNpmPostpublishVerifyArgs(["2026.3.23", "extra"])).toThrow(
      "Unexpected openclaw npm postpublish verifier argument: extra",
    );
  });
});

function writeDistJavaScriptFiles(packageRoot: string, count: number): void {
  const distDir = join(packageRoot, "dist");
  mkdirSync(distDir, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    writeFileSync(join(distDir, `chunk-${index}.js`), "export {};\n", "utf8");
  }
}

describe("buildPublishedInstallScenarios", () => {
  it("uses a single fresh scenario for plain stable releases", () => {
    expect(buildPublishedInstallScenarios("2026.3.23")).toEqual([
      {
        name: "fresh-exact",
        installSpecs: ["openclaw@2026.3.23"],
        expectedVersion: "2026.3.23",
      },
    ]);
  });

  it("adds a stable-to-correction upgrade scenario for correction releases", () => {
    expect(buildPublishedInstallScenarios("2026.3.23-2")).toEqual([
      {
        name: "fresh-exact",
        installSpecs: ["openclaw@2026.3.23-2"],
        expectedVersion: "2026.3.23-2",
      },
      {
        name: "upgrade-from-base-stable",
        installSpecs: ["openclaw@2026.3.23", "openclaw@2026.3.23-2"],
        expectedVersion: "2026.3.23-2",
      },
    ]);
  });
});

describe("npm registry provenance verification", () => {
  const packageName = "openclaw";
  const version = "2026.3.23";
  const integrity = `sha512-${Buffer.from("registry integrity", "utf8").toString("base64")}`;
  const buildProvenancePayload = (releaseVersion: string, workflowRef: string) => ({
    subject: [
      {
        name: `pkg:npm/${packageName}@${releaseVersion}`,
        digest: {
          sha512: Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex"),
        },
      },
    ],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: "https://github.com/openclaw/openclaw",
            path: ".github/workflows/openclaw-npm-release.yml",
            ref: workflowRef,
          },
        },
      },
      runDetails: {
        builder: {
          id: "https://github.com/actions/runner/github-hosted",
        },
      },
    },
  });
  const provenancePayload = buildProvenancePayload(version, "refs/heads/release/2026.3.23");

  it("fetches npm registry JSON with bounded response handling", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init).toMatchObject({
        headers: {
          Accept: "application/json",
        },
        redirect: "error",
        signal: expect.any(AbortSignal),
      });
      return new Response(JSON.stringify({ ok: true }));
    });

    await expect(
      fetchRegistryJson("https://registry.example/openclaw", {
        fetchImpl: fetchImpl as typeof fetch,
        timeoutMs: 1234,
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("bounds oversized npm registry response bodies", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response("x".repeat(65), {
        headers: { "content-length": "65" },
      });
    });

    await expect(
      fetchRegistryJson("https://registry.example/openclaw", {
        fetchImpl,
        maxBodyBytes: 64,
        timeoutMs: 1234,
      }),
    ).rejects.toThrow(
      "npm registry https://registry.example/openclaw response body exceeded 64 bytes",
    );
  });

  it("keeps npm registry timeouts active while reading response bodies", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(new ReadableStream<Uint8Array>({ start() {} }));
    });

    await expect(
      fetchRegistryJson("https://registry.example/openclaw", {
        fetchImpl,
        timeoutMs: 5,
      }),
    ).rejects.toThrow(
      "npm registry request timed out after 5ms: https://registry.example/openclaw",
    );
  });

  it("verifies an npm registry signature against the matching public key", () => {
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const payload = `${packageName}@${version}:${integrity}`;
    const signature = sign("sha256", Buffer.from(payload, "utf8"), keys.privateKey).toString(
      "base64",
    );

    expect(() =>
      verifyNpmRegistrySignatures({
        packageName,
        version,
        integrity,
        signatures: [{ keyid: "test-key", sig: signature }],
        keys: [
          {
            keyid: "test-key",
            key: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
          },
        ],
      }),
    ).not.toThrow();
  });

  it("requires a trusted GitHub release identity for the exact SLSA provenance attestation", async () => {
    let verificationPolicy:
      | {
          certificateIdentityURI: string;
          certificateIssuer: string;
        }
      | undefined;

    await expect(
      verifyNpmProvenanceAttestation({
        packageName,
        version,
        integrity,
        attestations: [
          {
            predicateType: "https://slsa.dev/provenance/v1",
            bundle: {
              dsseEnvelope: {
                payload: Buffer.from(JSON.stringify(provenancePayload), "utf8").toString("base64"),
              },
            },
          },
        ],
        verifyBundle: async (_bundle, policy) => {
          verificationPolicy = policy;
        },
      }),
    ).resolves.toBeUndefined();
    expect(verificationPolicy).toEqual({
      certificateIssuer: "https://token.actions.githubusercontent.com",
      certificateIdentityURI:
        "https://github.com/openclaw/openclaw/.github/workflows/openclaw-npm-release.yml@refs/heads/release/2026.3.23",
    });

    verificationPolicy = undefined;
    const protectedWorkflowSha = "a".repeat(40);
    const protectedWorkflowRef = `refs/tags/release-publish/${protectedWorkflowSha.slice(0, 12)}-123`;
    await expect(
      verifyNpmProvenanceAttestation({
        packageName,
        version,
        integrity,
        attestations: [
          {
            predicateType: "https://slsa.dev/provenance/v1",
            bundle: {
              dsseEnvelope: {
                payload: Buffer.from(
                  JSON.stringify({
                    ...provenancePayload,
                    predicate: {
                      ...provenancePayload.predicate,
                      buildDefinition: {
                        ...provenancePayload.predicate.buildDefinition,
                        externalParameters: {
                          workflow: {
                            ...provenancePayload.predicate.buildDefinition.externalParameters
                              .workflow,
                            ref: protectedWorkflowRef,
                          },
                        },
                        resolvedDependencies: [
                          {
                            uri: `git+https://github.com/openclaw/openclaw@${protectedWorkflowRef}`,
                            digest: { gitCommit: protectedWorkflowSha },
                          },
                        ],
                      },
                    },
                  }),
                  "utf8",
                ).toString("base64"),
              },
            },
          },
        ],
        expectedWorkflowRef: protectedWorkflowRef,
        expectedWorkflowSha: protectedWorkflowSha,
        verifyBundle: async (_bundle, policy) => {
          verificationPolicy = policy;
        },
      }),
    ).resolves.toBeUndefined();
    expect(verificationPolicy).toEqual({
      certificateIssuer: "https://token.actions.githubusercontent.com",
      certificateIdentityURI: `https://github.com/openclaw/openclaw/.github/workflows/openclaw-npm-release.yml@${protectedWorkflowRef}`,
    });

    await expect(
      verifyNpmProvenanceAttestation({
        packageName,
        version,
        integrity,
        attestations: [
          {
            predicateType: "https://slsa.dev/provenance/v1",
            bundle: {
              dsseEnvelope: {
                payload: Buffer.from(
                  JSON.stringify({
                    ...provenancePayload,
                    predicate: {
                      ...provenancePayload.predicate,
                      buildDefinition: {
                        ...provenancePayload.predicate.buildDefinition,
                        externalParameters: {
                          workflow: {
                            ...provenancePayload.predicate.buildDefinition.externalParameters
                              .workflow,
                            ref: protectedWorkflowRef,
                          },
                        },
                        resolvedDependencies: [
                          {
                            uri: `git+https://github.com/openclaw/openclaw@${protectedWorkflowRef}`,
                            digest: { gitCommit: protectedWorkflowSha },
                          },
                        ],
                      },
                    },
                  }),
                  "utf8",
                ).toString("base64"),
              },
            },
          },
        ],
        expectedWorkflowRef: protectedWorkflowRef,
        expectedWorkflowSha: "b".repeat(40),
        verifyBundle: async () => undefined,
      }),
    ).rejects.toThrow(
      "npm provenance SHA-pinned release-publish ref does not match the approved workflow ref and SHA",
    );

    await expect(
      verifyNpmProvenanceAttestation({
        packageName,
        version,
        integrity,
        attestations: [
          {
            predicateType: "https://slsa.dev/provenance/v1",
            bundle: {
              dsseEnvelope: {
                payload: Buffer.from(
                  JSON.stringify({
                    ...provenancePayload,
                    subject: [{ name: "pkg:npm/openclaw@2026.3.24", digest: {} }],
                  }),
                  "utf8",
                ).toString("base64"),
              },
            },
          },
        ],
        verifyBundle: async () => undefined,
      }),
    ).rejects.toThrow("does not match");
  });

  it.each([
    ["2026.6.33", "refs/heads/extended-stable/2026.6.33"],
    ["2026.6.34", "refs/heads/extended-stable/2026.6.33"],
  ])(
    "trusts canonical extended-stable provenance for %s",
    async (extendedStableVersion, workflowRef) => {
      let verificationPolicy:
        | {
            certificateIdentityURI: string;
            certificateIssuer: string;
          }
        | undefined;

      await expect(
        verifyNpmProvenanceAttestation({
          packageName,
          version: extendedStableVersion,
          integrity,
          attestations: [
            {
              predicateType: "https://slsa.dev/provenance/v1",
              bundle: {
                dsseEnvelope: {
                  payload: Buffer.from(
                    JSON.stringify(buildProvenancePayload(extendedStableVersion, workflowRef)),
                    "utf8",
                  ).toString("base64"),
                },
              },
            },
          ],
          verifyBundle: async (_bundle, policy) => {
            verificationPolicy = policy;
          },
        }),
      ).resolves.toBeUndefined();
      expect(verificationPolicy).toEqual({
        certificateIssuer: "https://token.actions.githubusercontent.com",
        certificateIdentityURI: `https://github.com/openclaw/openclaw/.github/workflows/openclaw-npm-release.yml@${workflowRef}`,
      });
    },
  );

  it.each([
    ["later patch on a noncanonical branch", "2026.6.34", "refs/heads/extended-stable/2026.6.34"],
    ["patch below 33", "2026.6.32", "refs/heads/extended-stable/2026.6.33"],
    ["correction suffix", "2026.6.33-1", "refs/heads/extended-stable/2026.6.33"],
  ])(
    "rejects extended-stable provenance for %s",
    async (_label, extendedStableVersion, workflowRef) => {
      let verificationCalls = 0;

      await expect(
        verifyNpmProvenanceAttestation({
          packageName,
          version: extendedStableVersion,
          integrity,
          attestations: [
            {
              predicateType: "https://slsa.dev/provenance/v1",
              bundle: {
                dsseEnvelope: {
                  payload: Buffer.from(
                    JSON.stringify(buildProvenancePayload(extendedStableVersion, workflowRef)),
                    "utf8",
                  ).toString("base64"),
                },
              },
            },
          ],
          verifyBundle: async () => {
            verificationCalls += 1;
          },
        }),
      ).rejects.toThrow(
        `does not bind ${extendedStableVersion} to the trusted OpenClaw GitHub release workflow`,
      );
      expect(verificationCalls).toBe(0);
    },
  );

  it("rejects matching provenance from an untrusted source before Sigstore verification", async () => {
    let verificationCalls = 0;

    await expect(
      verifyNpmProvenanceAttestation({
        packageName,
        version,
        integrity,
        attestations: [
          {
            predicateType: "https://slsa.dev/provenance/v1",
            bundle: {
              dsseEnvelope: {
                payload: Buffer.from(
                  JSON.stringify({
                    ...provenancePayload,
                    predicate: {
                      ...provenancePayload.predicate,
                      buildDefinition: {
                        externalParameters: {
                          workflow: {
                            ...provenancePayload.predicate.buildDefinition.externalParameters
                              .workflow,
                            ref: "refs/heads/feature/untrusted",
                          },
                        },
                      },
                    },
                  }),
                  "utf8",
                ).toString("base64"),
              },
            },
          },
        ],
        verifyBundle: async () => {
          verificationCalls += 1;
        },
      }),
    ).rejects.toThrow("does not bind 2026.3.23 to the trusted OpenClaw GitHub release workflow");
    expect(verificationCalls).toBe(0);
  });

  it("rejects a matching provenance payload when Sigstore cannot verify its bundle", async () => {
    await expect(
      verifyNpmProvenanceAttestation({
        packageName,
        version,
        integrity,
        attestations: [
          {
            predicateType: "https://slsa.dev/provenance/v1",
            bundle: {
              dsseEnvelope: {
                payload: Buffer.from(JSON.stringify(provenancePayload), "utf8").toString("base64"),
              },
            },
          },
        ],
        verifyBundle: async () => {
          throw new Error("forged bundle");
        },
      }),
    ).rejects.toThrow("failed Sigstore verification");
  });

  it("retries incomplete or briefly stale provenance while npm publish propagates", async () => {
    let attempts = 0;
    const delays: number[] = [];

    await expect(
      retryNpmRegistryProvenanceRead(
        async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error(
              "npm provenance attestation does not bind 2026.3.23 to the trusted OpenClaw GitHub release workflow.",
            );
          }
          if (attempts === 2) {
            throw new Error(
              "npm registry provenance metadata is incomplete for openclaw@2026.3.23.",
            );
          }
          return "verified";
        },
        {
          attempts: 3,
          delay: async (delayMs) => {
            delays.push(delayMs);
          },
        },
      ),
    ).resolves.toBe("verified");
    expect(attempts).toBe(3);
    expect(delays).toEqual([1000, 2000]);
  });
});

describe("buildPublishedInstallCommandArgs", () => {
  it("runs lifecycle scripts for published install verification", () => {
    const args = buildPublishedInstallCommandArgs("/tmp/openclaw-prefix", "openclaw@2026.4.10");

    expect(args).toEqual([
      "install",
      "-g",
      "--prefix",
      "/tmp/openclaw-prefix",
      "openclaw@2026.4.10",
      "--no-fund",
      "--no-audit",
    ]);
    expect(args).not.toContain("--ignore-scripts");
  });
});

describe("collectInstalledPackageErrors", () => {
  function makeInstalledPackageRoot(): string {
    return mkdtempSync(join(tmpdir(), "openclaw-postpublish-package-"));
  }

  it("flags version mismatches", () => {
    const errors = collectInstalledPackageErrors({
      expectedVersion: "2026.3.23-2",
      installedVersion: "2026.3.23",
      packageRoot: "/tmp/empty-openclaw",
    });

    expect(errors[0]).toBe(
      "installed package version mismatch: expected 2026.3.23-2, found 2026.3.23.",
    );
  });

  it("requires runtime sidecars for bundled extensions included in the package", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writeFileSync(join(packageRoot, "package.json"), '{"version":"2026.3.23"}\n', "utf8");
      mkdirSync(join(packageRoot, "dist", "extensions", "telegram"), { recursive: true });
      writeFileSync(
        join(packageRoot, "dist", "extensions", "telegram", "package.json"),
        "{}\n",
        "utf8",
      );

      expect(collectInstalledBundledRuntimeSidecarPaths(packageRoot)).toContain(
        "dist/extensions/telegram/runtime-api.js",
      );
      expect(
        collectInstalledPackageErrors({
          expectedVersion: "2026.3.23",
          installedVersion: "2026.3.23",
          packageRoot,
        }),
      ).toContain(
        "installed package is missing required bundled runtime sidecar: dist/extensions/telegram/runtime-api.js",
      );
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("surfaces invalid installed bundled extension manifests", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writeFileSync(join(packageRoot, "package.json"), '{"version":"2026.3.23"}\n', "utf8");
      mkdirSync(join(packageRoot, "dist", "extensions", "telegram"), { recursive: true });
      writeFileSync(
        join(packageRoot, "dist", "extensions", "telegram", "package.json"),
        "{not-json\n",
        "utf8",
      );
      writeFileSync(
        join(packageRoot, "dist", "extensions", "telegram", "runtime-api.js"),
        "export {};\n",
        "utf8",
      );

      const manifestErrors = collectInstalledBundledExtensionManifestErrors(packageRoot);
      expect(manifestErrors).toHaveLength(1);
      expect(manifestErrors[0]).toContain(
        "installed bundled extension manifest invalid: failed to parse",
      );
      expect(manifestErrors[0]).toContain("dist/extensions/telegram/package.json");

      expect(
        collectInstalledPackageErrors({
          expectedVersion: "2026.3.23",
          installedVersion: "2026.3.23",
          packageRoot,
        }),
      ).toContain(manifestErrors[0]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });
});

describe("collectInstalledAlwaysAllowedRuntimeFacadeErrors", () => {
  function withInstalledPackageRoot(run: (packageRoot: string) => void): void {
    const packageRoot = mkdtempSync(join(tmpdir(), "openclaw-postpublish-facade-runtime-"));
    try {
      run(packageRoot);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  }

  function writeInstalledFile(packageRoot: string, relativePath: string): void {
    const filePath = join(packageRoot, relativePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "export {};\n", "utf8");
  }

  it("reports the activation runtime and every missing allowlisted sidecar", () => {
    withInstalledPackageRoot((packageRoot) => {
      expect(collectInstalledAlwaysAllowedRuntimeFacadeErrors(packageRoot)).toEqual([
        "installed package is missing required facade activation runtime: dist/facade-activation-check.runtime.js",
        "installed package allows bundled runtime facade image-generation-core/runtime-api.js but is missing required runtime sidecar: dist/extensions/image-generation-core/runtime-api.js.",
        "installed package allows bundled runtime facade media-understanding-core/runtime-api.js but is missing required runtime sidecar: dist/extensions/media-understanding-core/runtime-api.js.",
      ]);
    });
  });

  it("accepts a package with the activation runtime and allowlisted sidecars", () => {
    withInstalledPackageRoot((packageRoot) => {
      writeInstalledFile(packageRoot, "dist/facade-activation-check.runtime.js");
      writeInstalledFile(packageRoot, "dist/extensions/image-generation-core/runtime-api.js");
      writeInstalledFile(packageRoot, "dist/extensions/media-understanding-core/runtime-api.js");

      expect(collectInstalledAlwaysAllowedRuntimeFacadeErrors(packageRoot)).toStrictEqual([]);
    });
  });
});

describe("collectInstalledContextEngineRuntimeErrors", () => {
  function makeInstalledPackageRoot(): string {
    return mkdtempSync(join(tmpdir(), "openclaw-postpublish-context-engine-"));
  }

  it("rejects packaged bundles with unresolved legacy context engine runtime loaders", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      mkdirSync(join(packageRoot, "dist"), { recursive: true });
      writeFileSync(
        join(packageRoot, "dist", "runtime-plugins-BUG.js"),
        'throw new Error("Failed to load legacy context engine runtime.");\n',
        "utf8",
      );

      expect(collectInstalledContextEngineRuntimeErrors(packageRoot)).toEqual([
        "installed package includes unresolved legacy context engine runtime loader; rebuild with a bundler-traceable LegacyContextEngine import.",
      ]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("accepts packaged bundles that inline the legacy context engine registration", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      mkdirSync(join(packageRoot, "dist"), { recursive: true });
      writeFileSync(
        join(packageRoot, "dist", "runtime-plugins-OK.js"),
        "registerContextEngineForOwner('legacy', async () => new LegacyContextEngine());\n",
        "utf8",
      );

      expect(collectInstalledContextEngineRuntimeErrors(packageRoot)).toStrictEqual([]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("refuses unbounded packaged dist scans", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writeDistJavaScriptFiles(packageRoot, INSTALLED_ROOT_DIST_JS_FILE_SCAN_LIMIT + 1);

      expect(collectInstalledContextEngineRuntimeErrors(packageRoot)).toEqual([
        `installed package dist contains more than ${INSTALLED_ROOT_DIST_JS_FILE_SCAN_LIMIT} JavaScript files; refusing to scan unbounded package contents.`,
      ]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });
});

describe("collectInstalledPluginSdkZodArtifactErrors", () => {
  function withInstalledPackageRoot(run: (packageRoot: string) => void): void {
    const packageRoot = mkdtempSync(join(tmpdir(), "openclaw-postpublish-zod-sdk-"));
    try {
      run(packageRoot);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  }

  function writeInstalledFile(packageRoot: string, relativePath: string, contents: string): void {
    const filePath = join(packageRoot, ...relativePath.split("/"));
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents, "utf8");
  }

  it("requires the plugin-sdk zod artifact", () => {
    withInstalledPackageRoot((packageRoot) => {
      expect(collectInstalledPluginSdkZodArtifactErrors(packageRoot)).toEqual([
        "installed package is missing required plugin SDK artifact: dist/plugin-sdk/zod.js",
      ]);
    });
  });

  it("rejects plugin-sdk zod artifacts with a bare zod export", () => {
    withInstalledPackageRoot((packageRoot) => {
      writeInstalledFile(
        packageRoot,
        "dist/plugin-sdk/zod.js",
        'import "../zod-D2c0iocA.js";\nexport * from "zod";\n',
      );

      expect(collectInstalledPluginSdkZodArtifactErrors(packageRoot)).toEqual([
        "installed package plugin SDK zod artifact must be self-contained but dist/plugin-sdk/zod.js imports zod.",
      ]);
    });
  });

  it("rejects plugin-sdk zod artifacts when a reachable local chunk imports zod", () => {
    withInstalledPackageRoot((packageRoot) => {
      writeInstalledFile(
        packageRoot,
        "dist/plugin-sdk/zod.js",
        'export { z } from "../zod-D2c0iocA.js";\n',
      );
      writeInstalledFile(
        packageRoot,
        "dist/zod-D2c0iocA.js",
        'import * as zodCore from "zod/v4/core";\nexport const z = zodCore;\n',
      );

      expect(collectInstalledPluginSdkZodArtifactErrors(packageRoot)).toEqual([
        "installed package plugin SDK zod artifact must be self-contained but dist/zod-D2c0iocA.js imports zod/v4/core.",
      ]);
    });
  });

  it("accepts plugin-sdk zod artifacts that only import package-local chunks", () => {
    withInstalledPackageRoot((packageRoot) => {
      writeInstalledFile(
        packageRoot,
        "dist/plugin-sdk/zod.js",
        'export { z } from "../zod-D2c0iocA.js";\n',
      );
      writeInstalledFile(packageRoot, "dist/zod-D2c0iocA.js", "export const z = {};\n");

      expect(collectInstalledPluginSdkZodArtifactErrors(packageRoot)).toEqual([]);
    });
  });
});

describe("normalizeInstalledBinaryVersion", () => {
  it("accepts decorated CLI version output", () => {
    expect(normalizeInstalledBinaryVersion("OpenClaw 2026.4.8 (9ece252)")).toBe("2026.4.8");
    expect(normalizeInstalledBinaryVersion("OpenClaw 2026.4.8-beta.1 (9ece252)")).toBe(
      "2026.4.8-beta.1",
    );
    expect(normalizeInstalledBinaryVersion("OpenClaw 2026.4.8-alpha.1 (9ece252)")).toBe(
      "2026.4.8-alpha.1",
    );
  });
});

describe("resolveInstalledBinaryPath", () => {
  it("uses the Unix global bin path on non-Windows platforms", () => {
    expect(resolveInstalledBinaryPath("/tmp/openclaw-prefix", "darwin")).toBe(
      "/tmp/openclaw-prefix/bin/openclaw",
    );
  });

  it("uses the Windows npm shim path on win32", () => {
    expect(resolveInstalledBinaryPath("C:/openclaw-prefix", "win32")).toBe(
      "C:\\openclaw-prefix\\openclaw.cmd",
    );
  });
});

describe("resolveInstalledBinaryCommandInvocation", () => {
  it("runs the Unix installed binary directly", () => {
    expect(
      resolveInstalledBinaryCommandInvocation("/tmp/openclaw-prefix", ["--version"], {
        platform: "linux",
      }),
    ).toEqual({
      command: "/tmp/openclaw-prefix/bin/openclaw",
      args: ["--version"],
    });
  });

  it("wraps the Windows installed npm shim without Node shell argv", () => {
    expect(
      resolveInstalledBinaryCommandInvocation(
        "C:/openclaw prefix",
        ["agent", "--message", "hello world"],
        {
          comSpec: "C:\\Windows\\System32\\cmd.exe",
          platform: "win32",
        },
      ),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        '""C:\\openclaw prefix\\openclaw.cmd" agent --message "hello world""',
      ],
      windowsVerbatimArguments: true,
    });
  });
});

describe("collectInstalledRootDependencyManifestErrors", () => {
  function makeInstalledPackageRoot(): string {
    return mkdtempSync(join(tmpdir(), "openclaw-postpublish-root-deps-"));
  }

  function writePackageFile(root: string, relativePath: string, value: unknown): void {
    const fullPath = join(root, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  it("flags root dist imports whose declared runtime package name is missing", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writePackageFile(packageRoot, "package.json", {
        version: "2026.4.22",
        dependencies: {},
      });
      mkdirSync(join(packageRoot, "dist"), { recursive: true });
      writeFileSync(
        join(packageRoot, "dist", "typebox-CXXonh2u.js"),
        'import { Type } from "typebox";\nexport { Type };\n',
        "utf8",
      );

      expect(collectInstalledRootDependencyManifestErrors(packageRoot)).toEqual([
        "installed package root is missing declared runtime dependency 'typebox' for dist importers: typebox-CXXonh2u.js. Add it to package.json dependencies/optionalDependencies.",
      ]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("accepts root dist imports when the runtime package name is declared", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writePackageFile(packageRoot, "package.json", {
        version: "2026.4.22",
        dependencies: {
          typebox: "1.1.28",
        },
      });
      mkdirSync(join(packageRoot, "dist"), { recursive: true });
      writeFileSync(
        join(packageRoot, "dist", "typebox-CXXonh2u.js"),
        'import { Type } from "typebox";\nexport { Type };\n',
        "utf8",
      );

      expect(collectInstalledRootDependencyManifestErrors(packageRoot)).toStrictEqual([]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("accepts optional or externalized runtime imports", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writePackageFile(packageRoot, "package.json", {
        version: "2026.4.22",
        dependencies: {},
      });
      mkdirSync(join(packageRoot, "dist"), { recursive: true });
      writeFileSync(
        join(packageRoot, "dist", "optional-runtime.js"),
        ['await import("@a2ui/markdown-it");', 'await import("@lancedb/lancedb");', ""].join("\n"),
        "utf8",
      );
      writeFileSync(
        join(packageRoot, "dist", "externalized-plugin-runtime.js"),
        [
          'import * as lark from "@larksuiteoapi/node-sdk";',
          'import prism from "prism-media";',
          "export { lark, prism };",
          "",
        ].join("\n"),
        "utf8",
      );
      mkdirSync(join(packageRoot, "dist", "plugin-sdk"), { recursive: true });
      writeFileSync(
        join(packageRoot, "dist", "plugin-sdk/channel-test-helpers.js"),
        'import { expect, it } from "vitest";\nexport { expect, it };\n',
        "utf8",
      );

      expect(collectInstalledRootDependencyManifestErrors(packageRoot)).toStrictEqual([]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("flags undeclared imports from mjs and cjs root dist files", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writePackageFile(packageRoot, "package.json", {
        version: "2026.4.22",
        dependencies: {},
      });
      mkdirSync(join(packageRoot, "dist"), { recursive: true });
      writeFileSync(
        join(packageRoot, "dist", "esm-entry.mjs"),
        'export { value } from "mjs-only";\n',
        "utf8",
      );
      writeFileSync(
        join(packageRoot, "dist", "cjs-entry.cjs"),
        'const cjsOnly = require("cjs-only");\nmodule.exports = cjsOnly;\n',
        "utf8",
      );

      expect(collectInstalledRootDependencyManifestErrors(packageRoot)).toEqual([
        "installed package root is missing declared runtime dependency 'cjs-only' for dist importers: cjs-entry.cjs. Add it to package.json dependencies/optionalDependencies.",
        "installed package root is missing declared runtime dependency 'mjs-only' for dist importers: esm-entry.mjs. Add it to package.json dependencies/optionalDependencies.",
      ]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("ignores import-like text inside comments", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writePackageFile(packageRoot, "package.json", {
        version: "2026.4.22",
        dependencies: {},
      });
      mkdirSync(join(packageRoot, "dist"), { recursive: true });
      writeFileSync(
        join(packageRoot, "dist", "comment-only.js"),
        [
          '// import "fake-package";',
          '/* require("fake-package-two"); */',
          "export const ok = true;",
          "",
        ].join("\n"),
        "utf8",
      );

      expect(collectInstalledRootDependencyManifestErrors(packageRoot)).toStrictEqual([]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("ignores import-like text inside string literals", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writePackageFile(packageRoot, "package.json", {
        version: "2026.4.22",
        dependencies: {},
      });
      mkdirSync(join(packageRoot, "dist"), { recursive: true });
      writeFileSync(
        join(packageRoot, "dist", "string-only.js"),
        [
          "export const help = \"run import('fake-package') after setup\";",
          'export const note = "from \\"fake-package-two\\"";',
          "",
        ].join("\n"),
        "utf8",
      );

      expect(collectInstalledRootDependencyManifestErrors(packageRoot)).toStrictEqual([]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("returns a structured error when installed package.json is invalid", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      mkdirSync(join(packageRoot, "dist"), { recursive: true });
      writeFileSync(join(packageRoot, "package.json"), "{not-json\n", "utf8");

      const errors = collectInstalledRootDependencyManifestErrors(packageRoot);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.startsWith("installed package.json could not be parsed:")).toBe(true);
      expect(errors[0]?.endsWith(".")).toBe(true);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("refuses oversized root dist files", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writePackageFile(packageRoot, "package.json", {
        version: "2026.4.22",
        dependencies: {},
      });
      mkdirSync(join(packageRoot, "dist"), { recursive: true });
      writeFileSync(
        join(packageRoot, "dist", "oversized.js"),
        "x".repeat(6 * 1024 * 1024 + 1),
        "utf8",
      );

      expect(collectInstalledRootDependencyManifestErrors(packageRoot)).toEqual([
        "installed package root dist file 'oversized.js' is invalid or exceeds 6291456 bytes.",
      ]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("refuses unbounded root dist dependency scans", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writePackageFile(packageRoot, "package.json", {
        version: "2026.4.22",
        dependencies: {},
      });
      writeDistJavaScriptFiles(packageRoot, INSTALLED_ROOT_DIST_JS_FILE_SCAN_LIMIT + 1);

      expect(collectInstalledRootDependencyManifestErrors(packageRoot)).toEqual([
        `installed package root dist contains more than ${INSTALLED_ROOT_DIST_JS_FILE_SCAN_LIMIT} JavaScript files; refusing to scan unbounded package contents.`,
      ]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });
});
