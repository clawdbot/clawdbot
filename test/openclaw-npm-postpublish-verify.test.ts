import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
// OpenClaw npm postpublish tests validate postpublish verification behavior.
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
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { listBundledPluginPackArtifacts } from "../scripts/lib/bundled-plugin-build-entries.mjs";
import {
  buildPublishedInstallCommandArgs,
  buildPublishedInstallScenarios,
  collectInstalledAlwaysAllowedRuntimeFacadeErrors,
  collectInstalledBundledExtensionManifestErrors,
  collectInstalledBundledRuntimeSidecarPaths,
  collectInstalledContextEngineRuntimeErrors,
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
import {
  WORKER_BUNDLE_ENTRY_PATH,
  WORKER_BUNDLE_GITHUB_EXEC_LAUNCHER_PATH,
  WORKER_BUNDLE_RSYNC_RECEIVER_PATH,
} from "../src/shared/worker-bundle-hash.js";
import { withEnv } from "../src/test-utils/env.js";

const INSTALLED_ROOT_DIST_JS_FILE_SCAN_LIMIT = 10_000;
const requiredBundledPluginPackPaths = listBundledPluginPackArtifacts();
const workerDeployPaths = [
  `dist/worker/${WORKER_BUNDLE_ENTRY_PATH}`,
  `dist/worker/${WORKER_BUNDLE_GITHUB_EXEC_LAUNCHER_PATH}`,
  `dist/worker/${WORKER_BUNDLE_RSYNC_RECEIVER_PATH}`,
];
const workerDistPaths = new Set(workerDeployPaths.map((path) => path.slice("dist/".length)));

describe("parseOpenClawNpmPostpublishVerifyArgs", () => {
  it("keeps trusted release verification independent from target app dependencies", () => {
    const source = readFileSync("scripts/openclaw-npm-postpublish-verify.ts", "utf8");

    expect(source).toContain('from "./lib/error-format.mts"');
    expect(source).not.toContain('from "../src/infra/errors.ts"');
  });

  it("supports help and package-manager separators", () => {
    expect(parseOpenClawNpmPostpublishVerifyArgs(["--help"])).toEqual({
      help: true,
      version: "",
    });
    expect(parseOpenClawNpmPostpublishVerifyArgs(["--", "2026.3.23"])).toEqual({
      help: false,
      targetRoot: resolve("."),
      version: "2026.3.23",
    });
    expect(parseOpenClawNpmPostpublishVerifyArgs(["2026.3.23", "/tmp/target"])).toEqual({
      help: false,
      targetRoot: "/tmp/target",
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
    expect(() => parseOpenClawNpmPostpublishVerifyArgs(["2026.3.23", ".", "extra"])).toThrow(
      "Unexpected openclaw npm postpublish verifier argument: extra",
    );
  });

  it("binds every release-maintainer invocation to the validated frozen target root", () => {
    const skill = readFileSync(".agents/skills/release-openclaw-maintainer/SKILL.md", "utf8");
    const command = "node --import tsx scripts/openclaw-npm-postpublish-verify.ts";
    const invocations = skill.split("\n").filter((line) => line.includes(command));

    expect(invocations.length).toBeGreaterThan(0);
    for (const invocation of invocations) {
      expect(invocation).toContain("<validated-frozen-target-root>");
    }
    expect(skill).toContain("already proven equal to the immutable release candidate SHA");
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

  function writeExpectedBundledExtensionManifests(
    packageRoot: string,
    omittedIds: readonly string[] = [],
  ): void {
    const omitted = new Set(omittedIds);
    for (const relativePath of requiredBundledPluginPackPaths) {
      const match = /^dist\/extensions\/([^/]+)\//u.exec(relativePath);
      if (!match || omitted.has(match[1] ?? "")) {
        continue;
      }
      const artifactPath = join(packageRoot, relativePath);
      mkdirSync(dirname(artifactPath), { recursive: true });
      writeFileSync(artifactPath, relativePath.endsWith(".json") ? "{}\n" : "export {};\n", "utf8");
    }
    const inventoryPath = join(packageRoot, "dist", "postinstall-inventory.json");
    mkdirSync(dirname(inventoryPath), { recursive: true });
    writeFileSync(inventoryPath, JSON.stringify(requiredBundledPluginPackPaths), "utf8");
  }

  it("flags version mismatches", () => {
    const errors = collectInstalledPackageErrors({
      expectedVersion: "2026.3.23-2",
      installedVersion: "2026.3.23",
      packageRoot: "/tmp/empty-openclaw",
      workerDeployPaths,
    });

    expect(errors[0]).toBe(
      "installed package version mismatch: expected 2026.3.23-2, found 2026.3.23.",
    );
  });

  it("rejects an oversized worker before the full verifier reads its contents", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writeFileSync(join(packageRoot, "package.json"), '{"version":"2026.3.23"}\n', "utf8");
      const workerPath = join(packageRoot, "dist", "worker", WORKER_BUNDLE_ENTRY_PATH);
      mkdirSync(dirname(workerPath), { recursive: true });
      writeFileSync(workerPath, "/* Failed to load legacy context engine runtime. */\n", "utf8");
      truncateSync(workerPath, 80 * 1024 * 1024 + 1);

      const errors = collectInstalledPackageErrors({
        expectedVersion: "2026.3.23",
        installedVersion: "2026.3.23",
        packageRoot,
        workerDeployPaths,
      });
      const sizeError = `installed package root dist file 'worker/${WORKER_BUNDLE_ENTRY_PATH}' is invalid or exceeds 83886080 bytes.`;

      expect(errors.filter((error) => error === sizeError)).toEqual([sizeError]);
      expect(errors).not.toContain(
        "installed package includes unresolved legacy context engine runtime loader; rebuild with a bundler-traceable LegacyContextEngine import.",
      );
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it.each(["ollama", "lmstudio"])(
    "rejects a missing installed bundled %s provider directory",
    (providerId) => {
      const packageRoot = makeInstalledPackageRoot();

      try {
        writeFileSync(join(packageRoot, "package.json"), '{"version":"2026.3.23"}\n', "utf8");
        writeExpectedBundledExtensionManifests(packageRoot, [providerId]);

        const missingManifestPath = join(
          packageRoot,
          "dist",
          "extensions",
          providerId,
          "package.json",
        );
        const expectedError = `installed bundled extension manifest missing: ${missingManifestPath}.`;
        const missingArtifactErrors = requiredBundledPluginPackPaths
          .filter((relativePath) => relativePath.startsWith(`dist/extensions/${providerId}/`))
          .map((relativePath) =>
            relativePath.endsWith("/package.json")
              ? expectedError
              : `installed bundled plugin artifact missing: ${relativePath}.`,
          );

        expect(collectInstalledBundledExtensionManifestErrors(packageRoot)).toStrictEqual(
          missingArtifactErrors,
        );
        expect(
          collectInstalledPackageErrors({
            expectedVersion: "2026.3.23",
            installedVersion: "2026.3.23",
            packageRoot,
            workerDeployPaths,
          }),
        ).toContain(expectedError);
      } finally {
        rmSync(packageRoot, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["plugin manifest", "dist/extensions/ollama/openclaw.plugin.json"],
    ["generated plugin artifact", "dist/extensions/ollama/provider-discovery.js"],
  ])("rejects an installed bundled %s missing after postinstall", (_, relativePath) => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writeExpectedBundledExtensionManifests(packageRoot);
      rmSync(join(packageRoot, relativePath));

      expect(collectInstalledBundledExtensionManifestErrors(packageRoot)).toContain(
        `installed bundled plugin artifact missing: ${relativePath}.`,
      );
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ["plugin manifest", "dist/extensions/ollama/openclaw.plugin.json"],
    ["generated plugin artifact", "dist/extensions/ollama/provider-discovery.js"],
  ])("rejects an installed bundled %s omitted from its inventory", (_, relativePath) => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writeExpectedBundledExtensionManifests(packageRoot);
      writeFileSync(
        join(packageRoot, "dist", "postinstall-inventory.json"),
        JSON.stringify(requiredBundledPluginPackPaths.filter((entry) => entry !== relativePath)),
        "utf8",
      );

      expect(collectInstalledBundledExtensionManifestErrors(packageRoot)).toContain(
        `installed bundled plugin artifact omitted from dist inventory: ${relativePath}.`,
      );
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("rejects an installed package without its bundled extension root", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      const errors = collectInstalledBundledExtensionManifestErrors(packageRoot);

      expect(errors).toEqual(
        expect.arrayContaining(
          ["ollama", "lmstudio"].map(
            (providerId) =>
              `installed bundled extension manifest missing: ${join(
                packageRoot,
                "dist",
                "extensions",
                providerId,
                "package.json",
              )}.`,
          ),
        ),
      );
      for (const excludedId of ["acpx", "qa-channel", "qa-lab"]) {
        expect(errors.some((error) => error.includes(join("extensions", excludedId)))).toBe(false);
      }
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("keeps bundled manifest requirements stable after the build filter changes", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      const expectedErrors = collectInstalledBundledExtensionManifestErrors(packageRoot);
      const filteredErrors = withEnv({ OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: "ollama" }, () =>
        collectInstalledBundledExtensionManifestErrors(packageRoot),
      );

      expect(filteredErrors).toStrictEqual(expectedErrors);
      expect(filteredErrors).toEqual(
        expect.arrayContaining(
          ["ollama", "lmstudio"].flatMap((providerId) => [
            `installed bundled extension manifest missing: ${join(
              packageRoot,
              "dist",
              "extensions",
              providerId,
              "package.json",
            )}.`,
            `installed bundled plugin artifact missing: dist/extensions/${providerId}/openclaw.plugin.json.`,
          ]),
        ),
      );
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("verifies every bundled manifest when the build filter exists before module initialization", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      const probe = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--eval",
          [
            'import { collectInstalledBundledExtensionManifestErrors } from "./scripts/openclaw-npm-postpublish-verify.ts";',
            `process.stdout.write(JSON.stringify(collectInstalledBundledExtensionManifestErrors(${JSON.stringify(packageRoot)})));`,
          ].join("\n"),
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...process.env, OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: "ollama" },
          timeout: 30_000,
        },
      );

      expect(probe.error).toBeUndefined();
      expect(probe.status, probe.stderr).toBe(0);
      expect(JSON.parse(probe.stdout)).toEqual(
        expect.arrayContaining(
          ["ollama", "lmstudio"].flatMap((providerId) => [
            `installed bundled extension manifest missing: ${join(
              packageRoot,
              "dist",
              "extensions",
              providerId,
              "package.json",
            )}.`,
            `installed bundled plugin artifact missing: dist/extensions/${providerId}/openclaw.plugin.json.`,
          ]),
        ),
      );
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("does not require excluded external or private plugin package manifests", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writeExpectedBundledExtensionManifests(packageRoot);
      for (const excludedId of ["acpx", "qa-channel", "qa-lab"]) {
        mkdirSync(join(packageRoot, "dist", "extensions", excludedId), { recursive: true });
      }

      expect(collectInstalledBundledExtensionManifestErrors(packageRoot)).toStrictEqual([]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
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
          workerDeployPaths,
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
      writeExpectedBundledExtensionManifests(packageRoot);
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
          workerDeployPaths,
        }),
      ).toContain(manifestErrors[0]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "missing",
      undefined,
      "installed package worker deploy artifact is missing: dist/worker/github-exec-launcher.mjs.",
    ],
    [
      "symlink",
      "symlink",
      "installed package worker deploy artifact is not a regular file: dist/worker/github-exec-launcher.mjs.",
    ],
    [
      "directory",
      "directory",
      "installed package worker deploy artifact is not a regular file: dist/worker/github-exec-launcher.mjs.",
    ],
  ])("rejects a %s target-declared worker artifact", (_, kind, expectedError) => {
    const packageRoot = makeInstalledPackageRoot();
    const launcherPath = join(
      packageRoot,
      `dist/worker/${WORKER_BUNDLE_GITHUB_EXEC_LAUNCHER_PATH}`,
    );
    try {
      mkdirSync(dirname(launcherPath), { recursive: true });
      writeFileSync(join(packageRoot, "package.json"), '{"version":"2026.3.23"}\n');
      writeFileSync(join(packageRoot, `dist/worker/${WORKER_BUNDLE_ENTRY_PATH}`), "export {};\n");
      writeFileSync(
        join(packageRoot, `dist/worker/${WORKER_BUNDLE_RSYNC_RECEIVER_PATH}`),
        "export {};\n",
      );
      if (kind === "symlink") {
        symlinkSync(WORKER_BUNDLE_ENTRY_PATH, launcherPath);
      } else if (kind === "directory") {
        mkdirSync(launcherPath);
      }
      expect(
        collectInstalledPackageErrors({
          expectedVersion: "2026.3.23",
          installedVersion: "2026.3.23",
          packageRoot,
          workerDeployPaths,
        }),
      ).toContain(expectedError);
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
      ]);
    });
  });

  it("accepts a package with the activation runtime and allowlisted sidecars", () => {
    withInstalledPackageRoot((packageRoot) => {
      writeInstalledFile(packageRoot, "dist/facade-activation-check.runtime.js");
      writeInstalledFile(packageRoot, "dist/extensions/image-generation-core/runtime-api.js");

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

  it("ignores extension-owned JavaScript assets", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      const viewerPath = join(
        packageRoot,
        "dist",
        "extensions",
        "diffs",
        "assets",
        "viewer-runtime.js",
      );
      mkdirSync(dirname(viewerPath), { recursive: true });
      writeFileSync(
        viewerPath,
        'throw new Error("Failed to load legacy context engine runtime.");\n',
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
        `installed package root dist contains more than ${INSTALLED_ROOT_DIST_JS_FILE_SCAN_LIMIT} JavaScript files; refusing to scan unbounded package contents.`,
      ]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
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

  it("flags undeclared imports from nested mjs and direct cjs root dist files", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writePackageFile(packageRoot, "package.json", {
        version: "2026.4.22",
        dependencies: {},
      });
      mkdirSync(join(packageRoot, "dist", "runtime"), { recursive: true });
      writeFileSync(
        join(packageRoot, "dist", "runtime", "esm-entry.mjs"),
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
        "installed package root is missing declared runtime dependency 'mjs-only' for dist importers: runtime/esm-entry.mjs. Add it to package.json dependencies/optionalDependencies.",
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

  it.each([
    {
      expected: [
        "installed package root dist file 'oversized.js' is invalid or exceeds 6291456 bytes.",
      ],
      name: "rejects oversized direct dist files",
      relativePath: "oversized.js",
    },
    {
      expected: [
        "installed package root dist file 'runtime/oversized.js' is invalid or exceeds 6291456 bytes.",
      ],
      name: "rejects oversized arbitrary nested dist files",
      relativePath: "runtime/oversized.js",
    },
    {
      expected: [],
      name: "accepts the oversized worker deploy entrypoint",
      relativePath: `worker/${WORKER_BUNDLE_ENTRY_PATH}`,
    },
    {
      expected: [],
      name: "accepts the oversized worker rsync receiver",
      relativePath: `worker/${WORKER_BUNDLE_RSYNC_RECEIVER_PATH}`,
    },
    {
      expected: [
        `installed package root dist file 'worker/${WORKER_BUNDLE_ENTRY_PATH}' is invalid or exceeds 83886080 bytes.`,
      ],
      name: "rejects the worker deploy entrypoint above its dedicated parser bound",
      relativePath: `worker/${WORKER_BUNDLE_ENTRY_PATH}`,
      sparseSize: 80 * 1024 * 1024 + 1,
    },
  ])("$name", ({ expected, relativePath, sparseSize }) => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writePackageFile(packageRoot, "package.json", {
        version: "2026.4.22",
        dependencies: {},
      });
      const filePath = join(packageRoot, "dist", relativePath);
      mkdirSync(dirname(filePath), { recursive: true });
      if (sparseSize) {
        writeFileSync(filePath, "/*", "utf8");
        truncateSync(filePath, sparseSize);
      } else {
        writeFileSync(filePath, `/* ${"x".repeat(6 * 1024 * 1024)} */\n`, "utf8");
      }

      expect(collectInstalledRootDependencyManifestErrors(packageRoot, workerDistPaths)).toEqual(
        expected,
      );
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("excludes bundled extension modules from root dist dependency scans", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writePackageFile(packageRoot, "package.json", {
        version: "2026.4.22",
        dependencies: {},
      });
      mkdirSync(join(packageRoot, "dist", "extensions", "telegram"), { recursive: true });
      writeFileSync(join(packageRoot, "dist", "root-runtime.js"), 'import "root-only";\n', "utf8");
      writeFileSync(
        join(packageRoot, "dist", "extensions", "telegram", "runtime-api.js"),
        'import "extension-only";\n',
        "utf8",
      );

      expect(collectInstalledRootDependencyManifestErrors(packageRoot)).toEqual([
        "installed package root is missing declared runtime dependency 'root-only' for dist importers: root-runtime.js. Add it to package.json dependencies/optionalDependencies.",
      ]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });
});
