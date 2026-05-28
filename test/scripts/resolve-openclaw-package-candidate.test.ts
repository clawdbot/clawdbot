import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  downloadUrl,
  loadTrustedPackageSource,
  parseArgs,
  readArtifactPackageCandidateMetadata,
  readPackageBuildSourceSha,
  resolveNpmPackageCandidatePackRunner,
  validateOpenClawPackageSpec,
} from "../../scripts/resolve-openclaw-package-candidate.mjs";

const tempDirs: string[] = [];

type LookupAddress = { address: string; family: number };

function lookupAddresses(addresses: LookupAddress[]) {
  return async () => addresses;
}

function unexpectedFetch(): never {
  throw new Error("downloadUrl should reject before fetching");
}

async function missing(file: string): Promise<boolean> {
  return await access(file).then(
    () => false,
    () => true,
  );
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("resolve-openclaw-package-candidate", () => {
  it("accepts only OpenClaw release package specs for npm candidates", () => {
    for (const spec of [
      "openclaw@beta",
      "openclaw@alpha",
      "openclaw@latest",
      "openclaw@2026.4.27",
      "openclaw@2026.4.27-1",
      "openclaw@2026.4.27-beta.2",
      "openclaw@2026.4.27-alpha.2",
    ]) {
      expect(validateOpenClawPackageSpec(spec), spec).toBeUndefined();
    }

    expect(() => validateOpenClawPackageSpec("@evil/openclaw@1.0.0")).toThrow(
      "package_spec must be openclaw@alpha",
    );
    expect(() => validateOpenClawPackageSpec("openclaw@canary")).toThrow(
      "package_spec must be openclaw@alpha",
    );
    expect(() => validateOpenClawPackageSpec("openclaw@2026.04.27")).toThrow(
      "package_spec must be openclaw@alpha",
    );
    expect(() => validateOpenClawPackageSpec("openclaw@npm:other-package")).toThrow(
      "package_spec must be openclaw@alpha",
    );
    expect(() => validateOpenClawPackageSpec("openclaw@file:../other-package.tgz")).toThrow(
      "package_spec must be openclaw@alpha",
    );
  });

  it("parses optional empty workflow inputs without rejecting the command line", () => {
    expect(
      parseArgs([
        "--source",
        "npm",
        "--package-ref",
        "release/2026.4.27",
        "--package-spec",
        "openclaw@beta",
        "--package-url",
        "",
        "--package-sha256",
        "",
        "--artifact-dir",
        ".",
        "--output-dir",
        ".artifacts/docker-e2e-package",
      ]),
    ).toEqual({
      artifactDir: ".",
      githubOutput: "",
      metadata: "",
      outputDir: ".artifacts/docker-e2e-package",
      outputName: "openclaw-current.tgz",
      packageSha256: "",
      packageRef: "release/2026.4.27",
      packageSpec: "openclaw@beta",
      packageUrl: "",
      source: "npm",
      trustedSourceId: "",
      trustedSourcePolicy: ".github/package-trusted-sources.json",
    });
  });

  it("resolves npm package candidates through the Windows npm.cmd toolchain shim", () => {
    const execPath = "C:\\nodejs\\node.exe";
    const npmCmdPath = path.win32.resolve(path.win32.dirname(execPath), "npm.cmd");

    const runner = resolveNpmPackageCandidatePackRunner(
      "openclaw@2026.5.26-beta.1",
      "C:\\openclaw\\.artifacts\\docker-e2e-package",
      {
        comSpec: "C:\\Windows\\System32\\cmd.exe",
        env: {},
        execPath,
        existsSync: (candidate) => candidate === npmCmdPath,
        platform: "win32",
      },
    );

    expect(runner).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        `${npmCmdPath} pack openclaw@2026.5.26-beta.1 --ignore-scripts --json --pack-destination C:\\openclaw\\.artifacts\\docker-e2e-package`,
      ],
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("loads named trusted package URL source policies", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-trusted-package-source-"));
    tempDirs.push(dir);
    const policy = path.join(dir, "trusted-sources.json");
    await writeFile(
      policy,
      JSON.stringify({
        schemaVersion: 1,
        sources: {
          "enterprise-artifactory": {
            allowPrivateNetwork: true,
            hosts: ["packages.internal"],
            pathPrefixes: ["/artifactory/openclaw/"],
            ports: [443, 8443],
            redirectHosts: ["packages.internal", "mirror.internal"],
          },
        },
      }),
    );

    await expect(loadTrustedPackageSource("enterprise-artifactory", policy)).resolves.toEqual({
      allowPrivateNetwork: true,
      auth: undefined,
      hosts: ["packages.internal"],
      id: "enterprise-artifactory",
      pathPrefixes: ["/artifactory/openclaw/"],
      ports: [443, 8443],
      redirectHosts: ["packages.internal", "mirror.internal"],
    });
    await expect(loadTrustedPackageSource("missing", policy)).rejects.toThrow(
      "Unknown trusted package source: missing",
    );
  });

  it("rejects unsafe package_url downloads before fetching private targets", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-download-"));
    tempDirs.push(dir);
    const target = path.join(dir, "openclaw.tgz");

    await expect(
      downloadUrl("http://packages.example/openclaw.tgz", target, {
        fetchImpl: unexpectedFetch,
        lookupHost: lookupAddresses([{ address: "93.184.216.34", family: 4 }]),
      }),
    ).rejects.toThrow("package_url must use https");
    await expect(
      downloadUrl("https://user@packages.example/openclaw.tgz", target, {
        fetchImpl: unexpectedFetch,
        lookupHost: lookupAddresses([{ address: "93.184.216.34", family: 4 }]),
      }),
    ).rejects.toThrow("package_url must not include credentials");
    await expect(
      downloadUrl("https://localhost/openclaw.tgz", target, {
        fetchImpl: unexpectedFetch,
        lookupHost: lookupAddresses([{ address: "127.0.0.1", family: 4 }]),
      }),
    ).rejects.toThrow(/private\/internal\/special-use/iu);
    await expect(
      downloadUrl("https://packages.example/openclaw.tgz", target, {
        fetchImpl: unexpectedFetch,
        lookupHost: lookupAddresses([{ address: "10.0.0.8", family: 4 }]),
      }),
    ).rejects.toThrow(/resolves to private\/internal\/special-use/iu);
    await expect(
      downloadUrl("https://packages.example/openclaw.tgz", target, {
        fetchImpl: unexpectedFetch,
        lookupHost: lookupAddresses([{ address: "64:ff9b::a9fe:a9fe", family: 6 }]),
      }),
    ).rejects.toThrow(/resolves to private\/internal\/special-use/iu);
  });

  it("allows private package_url downloads only through an explicit trusted source policy", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-download-"));
    tempDirs.push(dir);
    const target = path.join(dir, "openclaw.tgz");
    const trustedSource = {
      allowPrivateNetwork: true,
      hosts: ["packages.internal"],
      id: "enterprise-artifactory",
      pathPrefixes: ["/artifactory/openclaw/"],
      ports: [8443],
      redirectHosts: ["packages.internal"],
    };
    const requestedUrls: string[] = [];

    await downloadUrl("https://packages.internal:8443/artifactory/openclaw/openclaw.tgz", target, {
      fetchImpl: async (url: URL) => {
        requestedUrls.push(url.toString());
        return new Response(new Uint8Array([4, 5, 6]), {
          headers: { "content-length": "3" },
          status: 200,
        });
      },
      lookupHost: lookupAddresses([{ address: "10.0.0.8", family: 4 }]),
      maxBytes: 3,
      trustedSource,
    });

    expect(requestedUrls).toEqual([
      "https://packages.internal:8443/artifactory/openclaw/openclaw.tgz",
    ]);
    await expect(readFile(target)).resolves.toEqual(Buffer.from([4, 5, 6]));

    await expect(
      downloadUrl("https://evil.internal:8443/artifactory/openclaw/openclaw.tgz", target, {
        fetchImpl: unexpectedFetch,
        lookupHost: lookupAddresses([{ address: "10.0.0.9", family: 4 }]),
        trustedSource,
      }),
    ).rejects.toThrow("is not allowed by trusted package source enterprise-artifactory");
    await expect(
      downloadUrl("https://packages.internal:8443/other/openclaw.tgz", target, {
        fetchImpl: unexpectedFetch,
        lookupHost: lookupAddresses([{ address: "10.0.0.8", family: 4 }]),
        trustedSource,
      }),
    ).rejects.toThrow("path is not allowed by trusted package source enterprise-artifactory");
  });

  it("keeps trusted package_url redirects inside the named source policy", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-download-"));
    tempDirs.push(dir);
    const target = path.join(dir, "openclaw.tgz");
    const trustedSource = {
      allowPrivateNetwork: true,
      hosts: ["packages.internal"],
      id: "enterprise-artifactory",
      pathPrefixes: ["/artifactory/openclaw/"],
      ports: [8443],
      redirectHosts: ["packages.internal"],
    };

    await expect(
      downloadUrl("https://packages.internal:8443/artifactory/openclaw/openclaw.tgz", target, {
        fetchImpl: async () =>
          new Response(null, {
            headers: { location: "https://metadata.internal:8443/artifactory/openclaw/pwn.tgz" },
            status: 302,
          }),
        lookupHost: lookupAddresses([{ address: "10.0.0.8", family: 4 }]),
        trustedSource,
      }),
    ).rejects.toThrow("is not allowed by trusted package source enterprise-artifactory");
  });

  it("validates redirects for package_url downloads", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-download-"));
    tempDirs.push(dir);
    const target = path.join(dir, "openclaw.tgz");
    const requestedUrls: string[] = [];

    await expect(
      downloadUrl("https://packages.example/openclaw.tgz", target, {
        fetchImpl: async (url: URL) => {
          requestedUrls.push(url.toString());
          return new Response(null, {
            headers: { location: "https://169.254.169.254/latest/meta-data" },
            status: 302,
          });
        },
        lookupHost: lookupAddresses([{ address: "93.184.216.34", family: 4 }]),
      }),
    ).rejects.toThrow(/private\/internal\/special-use/iu);
    expect(requestedUrls).toEqual(["https://packages.example/openclaw.tgz"]);
  });

  it("cancels redirect response bodies before following the next hop", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-download-"));
    tempDirs.push(dir);
    const target = path.join(dir, "openclaw.tgz");
    const bodyCancelled: string[] = [];

    await expect(
      downloadUrl("https://packages.example/openclaw.tgz", target, {
        fetchImpl: async (url: URL) => {
          let cancelled = false;
          const body = new ReadableStream({
            start(controller) {
              const timer = setInterval(() => {
                if (cancelled) {
                  clearInterval(timer);
                  return;
                }
                try {
                  controller.enqueue(new Uint8Array([0]));
                } catch {
                  // Controller may already be closed after cancel.
                  clearInterval(timer);
                }
              }, 100);
            },
            cancel() {
              cancelled = true;
              bodyCancelled.push(url.toString());
            },
          });
          return new Response(body, {
            headers: { location: "https://packages.example/redirected.tgz" },
            status: 302,
          });
        },
        lookupHost: lookupAddresses([{ address: "93.184.216.34", family: 4 }]),
        timeoutMs: 5000,
      }),
    ).rejects.toThrow();
    // The redirect body must have been cancelled, not left open
    expect(bodyCancelled.length).toBeGreaterThan(0);
  });

  it("cancels response body on HTTP error before closing dispatcher", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-download-"));
    tempDirs.push(dir);
    const target = path.join(dir, "openclaw.tgz");
    let bodyCancelled = false;

    await expect(
      downloadUrl("https://packages.example/openclaw.tgz", target, {
        fetchImpl: async () => {
          const body = new ReadableStream({
            start(controller) {
              const timer = setInterval(() => {
                try {
                  controller.enqueue(new Uint8Array([0]));
                } catch {
                  clearInterval(timer);
                }
              }, 100);
            },
            cancel() {
              bodyCancelled = true;
            },
          });
          return new Response(body, { status: 500 });
        },
        lookupHost: lookupAddresses([{ address: "93.184.216.34", family: 4 }]),
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/failed to download package_url: HTTP 500/u);
    expect(bodyCancelled).toBe(true);
  });

  it("cancels response body on declared oversize before closing dispatcher", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-download-"));
    tempDirs.push(dir);
    const target = path.join(dir, "openclaw.tgz");
    let bodyCancelled = false;

    await expect(
      downloadUrl("https://packages.example/openclaw.tgz", target, {
        fetchImpl: async () => {
          const body = new ReadableStream({
            start(controller) {
              const timer = setInterval(() => {
                try {
                  controller.enqueue(new Uint8Array([0]));
                } catch {
                  clearInterval(timer);
                }
              }, 100);
            },
            cancel() {
              bodyCancelled = true;
            },
          });
          return new Response(body, {
            headers: { "content-length": String(1024 * 1024 * 100) },
            status: 200,
          });
        },
        lookupHost: lookupAddresses([{ address: "93.184.216.34", family: 4 }]),
        maxBytes: 1024,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/exceeds maximum download size/u);
    expect(bodyCancelled).toBe(true);
  });

  it("bounds package_url downloads and writes completed files atomically", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-download-"));
    tempDirs.push(dir);
    const target = path.join(dir, "openclaw.tgz");

    await expect(
      downloadUrl("https://packages.example/openclaw.tgz", target, {
        fetchImpl: async () =>
          new Response(new Uint8Array([1, 2, 3, 4]), {
            headers: { "content-length": "4" },
            status: 200,
          }),
        lookupHost: lookupAddresses([{ address: "93.184.216.34", family: 4 }]),
        maxBytes: 3,
      }),
    ).rejects.toThrow("package_url exceeds maximum download size");
    await expect(missing(target)).resolves.toBe(true);
    await expect(missing(`${target}.tmp`)).resolves.toBe(true);

    await downloadUrl("https://packages.example/openclaw.tgz", target, {
      fetchImpl: async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-length": "3" },
          status: 200,
        }),
      lookupHost: lookupAddresses([{ address: "93.184.216.34", family: 4 }]),
      maxBytes: 3,
    });
    await expect(readFile(target)).resolves.toEqual(Buffer.from([1, 2, 3]));
    await expect(missing(`${target}.tmp`)).resolves.toBe(true);
  });

  it("reads package source metadata from package artifacts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-candidate-"));
    tempDirs.push(dir);
    await writeFile(
      path.join(dir, "package-candidate.json"),
      JSON.stringify(
        {
          packageRef: "release/2026.4.30",
          packageSourceSha: "66ce632b9b7c5c7fdd3e66c739687d51638ad6e2",
          packageTrustedReason: "repository-branch-history",
          sha256: "a".repeat(64),
        },
        null,
        2,
      ),
    );

    await expect(readArtifactPackageCandidateMetadata(dir)).resolves.toEqual({
      packageRef: "release/2026.4.30",
      packageSourceSha: "66ce632b9b7c5c7fdd3e66c739687d51638ad6e2",
      packageTrustedReason: "repository-branch-history",
      sha256: "a".repeat(64),
    });
  });

  it("reads the source SHA from packed npm build metadata", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-build-info-"));
    tempDirs.push(dir);
    const root = path.join(dir, "package");
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
    await writeFile(
      path.join(root, "dist", "build-info.json"),
      JSON.stringify({ commit: "66CE632B9B7C5C7FDD3E66C739687D51638AD6E2" }),
    );
    const tarball = path.join(dir, "openclaw.tgz");
    await new Promise<void>((resolve, reject) => {
      execFile("tar", ["-czf", tarball, "-C", dir, "package"], (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    await expect(readPackageBuildSourceSha(tarball)).resolves.toBe(
      "66ce632b9b7c5c7fdd3e66c739687d51638ad6e2",
    );
  });
});
