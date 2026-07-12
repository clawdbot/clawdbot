// Plugin ClawHub release tests validate plugin release metadata and artifacts.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOpenClawReleaseClawHubPlan,
  buildOpenClawReleaseClawHubRuntimeState,
  parseOpenClawReleaseClawHubPlanArgs,
} from "../scripts/lib/openclaw-release-clawhub-plan.ts";
import {
  collectClawHubPublishablePluginPackages,
  collectClawHubVersionGateErrors,
  collectPluginClawHubReleasePathsFromGitRange,
  collectPluginClawHubReleasePlan,
  resolveChangedClawHubPublishablePluginPackages,
  resolveSelectedClawHubPublishablePluginPackages,
  type PublishablePluginPackage,
} from "../scripts/lib/plugin-clawhub-release.ts";
import {
  collectPublishablePluginPackages,
  OPENCLAW_PLUGIN_NPM_REPOSITORY_URL,
} from "../scripts/lib/plugin-npm-release.ts";
import { runPluginClawHubReleaseCheck } from "../scripts/plugin-clawhub-release-check.ts";
import { cleanupTempDirs, makeTempRepoRoot } from "./helpers/temp-repo.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

function writeTarField(header: Buffer, offset: number, length: number, value: string) {
  const bytes = Buffer.from(value);
  if (bytes.byteLength > length) {
    throw new Error(`tar field exceeds ${length} bytes`);
  }
  bytes.copy(header, offset);
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number) {
  writeTarField(header, offset, length, `${value.toString(8).padStart(length - 2, "0")} \0`);
}

function createClawPackBytes(
  packageName: string,
  version: string,
  options: { duplicateNormalizedPackageJson?: boolean } = {},
) {
  function entry(name: string, contents: string, prefix = "") {
    const bytes = Buffer.from(contents);
    const header = Buffer.alloc(512);
    writeTarField(header, 0, 100, name);
    writeTarOctal(header, 100, 8, 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, bytes.byteLength);
    writeTarOctal(header, 136, 12, 0);
    header[156] = "0".charCodeAt(0);
    writeTarField(header, 257, 6, "ustar\0");
    writeTarField(header, 263, 2, "00");
    writeTarOctal(header, 329, 8, 0);
    writeTarOctal(header, 337, 8, 0);
    writeTarField(header, 345, 155, prefix);
    header.fill(0x20, 148, 156);
    const checksum = header.reduce((total, byte) => total + byte, 0);
    writeTarOctal(header, 148, 8, checksum);
    const padding = Buffer.alloc((512 - (bytes.byteLength % 512)) % 512);
    return Buffer.concat([header, bytes, padding]);
  }

  const packageJson = JSON.stringify({
    name: packageName,
    version,
    openclaw: { release: { publishToClawHub: true } },
  });
  const packageJsonEntries = options.duplicateNormalizedPackageJson
    ? [entry("package/package.json", packageJson), entry("package/package.json", packageJson)]
    : [entry("package/package.json", packageJson)];
  return gzipSync(
    Buffer.concat([
      ...packageJsonEntries,
      entry("package/openclaw.plugin.json", JSON.stringify({ id: "demo-plugin" })),
      Buffer.alloc(1024),
    ]),
  );
}

describe("resolveChangedClawHubPublishablePluginPackages", () => {
  const publishablePlugins: PublishablePluginPackage[] = [
    {
      extensionId: "feishu",
      packageDir: "extensions/feishu",
      packageName: "@openclaw/feishu",
      version: "2026.4.1",
      channel: "stable",
      publishTag: "latest",
    },
    {
      extensionId: "zalo",
      packageDir: "extensions/zalo",
      packageName: "@openclaw/zalo",
      version: "2026.4.1-beta.1",
      channel: "beta",
      publishTag: "beta",
    },
  ];

  it("ignores shared release-tooling changes", () => {
    expect(
      resolveChangedClawHubPublishablePluginPackages({
        plugins: publishablePlugins,
        changedPaths: ["pnpm-lock.yaml"],
      }),
    ).toStrictEqual([]);
  });
});

describe("collectClawHubPublishablePluginPackages", () => {
  it("requires the ClawHub external plugin contract", () => {
    const repoDir = createTempPluginRepo({
      includeClawHubContract: false,
    });

    expect(() => collectClawHubPublishablePluginPackages(repoDir)).toThrow(
      "openclaw.compat.pluginApi is required for external code plugin packages.",
    );
  });

  it("rejects unsafe extension directory names", () => {
    const repoDir = createTempPluginRepo({
      extensionId: "Demo Plugin",
    });

    expect(() => collectClawHubPublishablePluginPackages(repoDir)).toThrow(
      "Demo Plugin: extension directory name must match",
    );
  });

  it("validates only selected package names when filters are provided", () => {
    const repoDir = createTempPluginRepo({
      extraExtensionIds: ["broken-plugin"],
    });
    writeFileSync(
      join(repoDir, "extensions", "broken-plugin", "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/broken-plugin",
          version: "2026.4.1",
          openclaw: {
            extensions: ["./index.ts"],
            release: {
              publishToClawHub: true,
            },
          },
        },
        null,
        2,
      ),
    );

    expect(
      collectClawHubPublishablePluginPackages(repoDir, {
        packageNames: ["@openclaw/demo-plugin"],
      }).map((plugin) => plugin.packageName),
    ).toEqual(["@openclaw/demo-plugin"]);
  });

  it("collects exact release dependencies that must match npm latest", () => {
    const repoDir = createTempPluginRepo({
      requiredLatestDependencyVersion: "1.2.3",
    });

    expect(collectClawHubPublishablePluginPackages(repoDir)).toEqual([
      expect.objectContaining({
        packageName: "@openclaw/demo-plugin",
        requiredLatestDependencies: [
          {
            packageName: "demo-runtime",
            version: "1.2.3",
          },
        ],
      }),
    ]);
  });
});

describe("OpenClaw dual-published plugin metadata", () => {
  const dualPublishedPlugins = [
    {
      extensionId: "cohere",
      packageName: "@openclaw/cohere-provider",
      install: {
        clawhubSpec: "clawhub:@openclaw/cohere-provider",
        defaultChoice: "npm",
        minHostVersion: ">=2026.6.8",
        npmSpec: "@openclaw/cohere-provider",
      },
    },
    {
      extensionId: "diagnostics-otel",
      packageName: "@openclaw/diagnostics-otel",
      install: {
        clawhubSpec: "clawhub:@openclaw/diagnostics-otel",
        defaultChoice: "npm",
        minHostVersion: ">=2026.4.25",
        npmSpec: "@openclaw/diagnostics-otel",
      },
    },
    {
      extensionId: "diagnostics-prometheus",
      packageName: "@openclaw/diagnostics-prometheus",
      install: {
        clawhubSpec: "clawhub:@openclaw/diagnostics-prometheus",
        defaultChoice: "npm",
        minHostVersion: ">=2026.4.25",
        npmSpec: "@openclaw/diagnostics-prometheus",
      },
    },
    {
      extensionId: "gmi",
      packageName: "@openclaw/gmi-provider",
      install: {
        clawhubSpec: "clawhub:@openclaw/gmi-provider",
        defaultChoice: "npm",
        minHostVersion: ">=2026.6.8",
        npmSpec: "@openclaw/gmi-provider",
      },
    },
  ] as const;

  it("keeps dual-published plugins selectable through both ClawHub and npm release paths", () => {
    const packageNames = dualPublishedPlugins.map((plugin) => plugin.packageName);
    const clawHubPublishable = collectClawHubPublishablePluginPackages(undefined, {
      packageNames,
    });
    const npmPublishable = collectPublishablePluginPackages(undefined, {
      packageNames,
    });

    expect(clawHubPublishable.map((plugin) => plugin.packageName)).toEqual(packageNames);
    expect(npmPublishable.map((plugin) => plugin.packageName)).toEqual(packageNames);

    for (const plugin of dualPublishedPlugins) {
      const packageJson = JSON.parse(
        readFileSync(`extensions/${plugin.extensionId}/package.json`, "utf8"),
      ) as {
        openclaw?: {
          install?: {
            clawhubSpec?: string;
            defaultChoice?: string;
            minHostVersion?: string;
            npmSpec?: string;
          };
          release?: {
            publishToClawHub?: boolean;
            publishToNpm?: boolean;
          };
        };
      };

      expect(packageJson.openclaw?.install).toEqual(plugin.install);
      expect(packageJson.openclaw?.release).toEqual({
        publishToClawHub: true,
        publishToNpm: true,
      });
    }
  });
});

describe("collectClawHubVersionGateErrors", () => {
  it("requires a version bump when a publishable plugin changes", () => {
    const repoDir = createTempPluginRepo();
    const baseRef = git(repoDir, ["rev-parse", "HEAD"]);

    writeFileSync(
      join(repoDir, "extensions", "demo-plugin", "index.ts"),
      "export const demo = 2;\n",
    );
    git(repoDir, ["add", "."]);
    git(repoDir, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "change plugin",
    ]);
    const headRef = git(repoDir, ["rev-parse", "HEAD"]);

    const errors = collectClawHubVersionGateErrors({
      rootDir: repoDir,
      plugins: collectClawHubPublishablePluginPackages(repoDir),
      gitRange: { baseRef, headRef },
    });

    expect(errors).toEqual([
      "@openclaw/demo-plugin@2026.4.1: changed publishable plugin still has the same version in package.json.",
    ]);
  });

  it("does not require a version bump for the first ClawHub opt-in", () => {
    const repoDir = createTempPluginRepo({
      publishToClawHub: false,
    });
    const baseRef = git(repoDir, ["rev-parse", "HEAD"]);

    writeFileSync(
      join(repoDir, "extensions", "demo-plugin", "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/demo-plugin",
          version: "2026.4.1",
          type: "module",
          repository: {
            type: "git",
            url: OPENCLAW_PLUGIN_NPM_REPOSITORY_URL,
          },
          openclaw: {
            extensions: ["./index.ts"],
            compat: {
              pluginApi: ">=2026.4.1",
            },
            install: {
              npmSpec: "@openclaw/demo-plugin",
            },
            build: {
              openclawVersion: "2026.4.1",
            },
            release: {
              publishToClawHub: true,
            },
          },
        },
        null,
        2,
      ),
    );
    git(repoDir, ["add", "."]);
    git(repoDir, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "opt in",
    ]);
    const headRef = git(repoDir, ["rev-parse", "HEAD"]);

    const errors = collectClawHubVersionGateErrors({
      rootDir: repoDir,
      plugins: collectClawHubPublishablePluginPackages(repoDir),
      gitRange: { baseRef, headRef },
    });

    expect(errors).toStrictEqual([]);
  });

  it("does not require a version bump for shared release-tooling changes", () => {
    const repoDir = createTempPluginRepo();
    const { baseRef, headRef } = commitSharedReleaseToolingChange(repoDir);

    const errors = collectClawHubVersionGateErrors({
      rootDir: repoDir,
      plugins: collectClawHubPublishablePluginPackages(repoDir),
      gitRange: { baseRef, headRef },
    });

    expect(errors).toStrictEqual([]);
  });
});

describe("resolveSelectedClawHubPublishablePluginPackages", () => {
  it("selects all publishable plugins when shared release tooling changes", () => {
    const repoDir = createTempPluginRepo({
      extraExtensionIds: ["demo-two"],
    });
    const { baseRef, headRef } = commitSharedReleaseToolingChange(repoDir);

    const selected = resolveSelectedClawHubPublishablePluginPackages({
      rootDir: repoDir,
      plugins: collectClawHubPublishablePluginPackages(repoDir),
      gitRange: { baseRef, headRef },
    });

    expect(selected.map((plugin) => plugin.extensionId)).toEqual(["demo-plugin", "demo-two"]);
  });

  it("selects all publishable plugins when the shared setup action changes", () => {
    const repoDir = createTempPluginRepo({
      extraExtensionIds: ["demo-two"],
    });
    const baseRef = git(repoDir, ["rev-parse", "HEAD"]);

    mkdirSync(join(repoDir, ".github", "actions", "setup-node-env"), { recursive: true });
    writeFileSync(
      join(repoDir, ".github", "actions", "setup-node-env", "action.yml"),
      "name: setup-node-env\n",
    );
    git(repoDir, ["add", "."]);
    git(repoDir, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "shared helpers",
    ]);
    const headRef = git(repoDir, ["rev-parse", "HEAD"]);

    const selected = resolveSelectedClawHubPublishablePluginPackages({
      rootDir: repoDir,
      plugins: collectClawHubPublishablePluginPackages(repoDir),
      gitRange: { baseRef, headRef },
    });

    expect(selected.map((plugin) => plugin.extensionId)).toEqual(["demo-plugin", "demo-two"]);
  });
});

describe("collectPluginClawHubReleasePlan", () => {
  it("rejects stale required dependencies before querying ClawHub", async () => {
    const repoDir = createTempPluginRepo({
      requiredLatestDependencyVersion: "1.2.3",
    });

    await expect(
      collectPluginClawHubReleasePlan({
        rootDir: repoDir,
        selection: ["@openclaw/demo-plugin"],
        resolveLatestVersion: () => "1.2.4",
        fetchImpl: async () => {
          throw new Error("ClawHub should not be queried for a stale dependency.");
        },
      }),
    ).rejects.toThrow(
      '@openclaw/demo-plugin@2026.4.1: demo-runtime must match npm latest for release; found "1.2.3", latest is "1.2.4".',
    );
  });

  it("accepts required dependencies matching npm latest", async () => {
    const repoDir = createTempPluginRepo({
      requiredLatestDependencyVersion: "1.2.3",
    });
    const { fetchImpl } = createClawHubPlanFetch({
      packages: {
        "@openclaw/demo-plugin": {
          status: 200,
        },
      },
      trustedPublishers: {
        "@openclaw/demo-plugin": {
          status: 200,
          body: {
            trustedPublisher: {
              repository: "openclaw/openclaw",
              workflowFilename: "plugin-clawhub-release.yml",
            },
          },
        },
      },
      versions: {
        "@openclaw/demo-plugin@2026.4.1": 404,
      },
    });

    const plan = await collectPluginClawHubReleasePlan({
      rootDir: repoDir,
      selection: ["@openclaw/demo-plugin"],
      resolveLatestVersion: () => "1.2.3",
      fetchImpl,
      registryBaseUrl: "https://clawhub.ai",
    });

    expect(plan.candidates.map((plugin) => plugin.packageName)).toEqual(["@openclaw/demo-plugin"]);
  });

  it("fails closed when npm latest cannot be resolved", async () => {
    const repoDir = createTempPluginRepo({
      requiredLatestDependencyVersion: "1.2.3",
    });

    await expect(
      collectPluginClawHubReleasePlan({
        rootDir: repoDir,
        selection: ["@openclaw/demo-plugin"],
        resolveLatestVersion: () => {
          throw new Error("registry unavailable");
        },
        fetchImpl: async () => {
          throw new Error("ClawHub should not be queried when npm latest is unavailable.");
        },
      }),
    ).rejects.toThrow(
      "@openclaw/demo-plugin@2026.4.1: could not resolve npm latest for demo-runtime: registry unavailable",
    );
  });

  it("keeps existing trusted packages with missing versions as normal candidates", async () => {
    const repoDir = createTempPluginRepo();
    const { fetchImpl, requests } = createClawHubPlanFetch({
      packages: {
        "@openclaw/demo-plugin": {
          status: 200,
          body: {
            package: {},
            owner: {},
          },
        },
      },
      trustedPublishers: {
        "@openclaw/demo-plugin": {
          status: 200,
          body: {
            trustedPublisher: {
              repository: "openclaw/openclaw",
              workflowFilename: "plugin-clawhub-release.yml",
            },
          },
        },
      },
      versions: {
        "@openclaw/demo-plugin@2026.4.1": 404,
      },
    });

    const plan = await collectPluginClawHubReleasePlan({
      rootDir: repoDir,
      selection: ["@openclaw/demo-plugin"],
      fetchImpl,
      registryBaseUrl: "https://clawhub.ai",
    });

    expect(plan.candidates.map((plugin) => plugin.packageName)).toEqual(["@openclaw/demo-plugin"]);
    expect(plan.bootstrapCandidates).toStrictEqual([]);
    expect(plan.missingTrustedPublisher).toStrictEqual([]);
    expect(requests).toEqual([
      "/api/v1/packages/%40openclaw%2Fdemo-plugin",
      "/api/v1/packages/%40openclaw%2Fdemo-plugin/trusted-publisher",
      "/api/v1/packages/%40openclaw%2Fdemo-plugin/versions/2026.4.1",
    ]);
  });

  it("cancels unused ClawHub package and version response bodies", async () => {
    const repoDir = createTempPluginRepo();
    const canceled: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(requestUrl);

      if (url.pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin") {
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              canceled.push("package");
            },
          }),
          { status: 200 },
        );
      }
      if (url.pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin/trusted-publisher") {
        return new Response(
          JSON.stringify({
            trustedPublisher: {
              repository: "openclaw/openclaw",
              workflowFilename: "plugin-clawhub-release.yml",
            },
          }),
          { status: 200 },
        );
      }
      if (url.pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin/versions/2026.4.1") {
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              canceled.push("version");
            },
          }),
          { status: 404 },
        );
      }

      throw new Error(`Unexpected ClawHub request to ${url.pathname}`);
    };

    await collectPluginClawHubReleasePlan({
      rootDir: repoDir,
      selection: ["@openclaw/demo-plugin"],
      fetchImpl,
      registryBaseUrl: "https://clawhub.ai",
    });

    expect(canceled).toEqual(["package", "version"]);
  });

  it("retries a rate-limited trusted publisher lookup", async () => {
    const repoDir = createTempPluginRepo();
    let trustedPublisherRequests = 0;
    let rateLimitedBodyCanceled = false;
    const retryDelays: number[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const pathname = new URL(requestUrl).pathname;
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin") {
        return new Response("{}", { status: 200 });
      }
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin/trusted-publisher") {
        trustedPublisherRequests += 1;
        if (trustedPublisherRequests === 1) {
          return new Response(
            new ReadableStream({
              cancel() {
                rateLimitedBodyCanceled = true;
              },
            }),
            { status: 429 },
          );
        }
        return new Response(
          JSON.stringify({
            trustedPublisher: {
              repository: "openclaw/openclaw",
              workflowFilename: "plugin-clawhub-release.yml",
            },
          }),
          { status: 200 },
        );
      }
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin/versions/2026.4.1") {
        return new Response("", { status: 404 });
      }
      throw new Error(`Unexpected ClawHub request to ${pathname}`);
    };

    const plan = await collectPluginClawHubReleasePlan({
      rootDir: repoDir,
      selection: ["@openclaw/demo-plugin"],
      fetchImpl,
      registryBaseUrl: "https://clawhub.ai",
      sleep: async (ms) => {
        retryDelays.push(ms);
      },
    });

    expect(trustedPublisherRequests).toBe(2);
    expect(rateLimitedBodyCanceled).toBe(true);
    expect(retryDelays).toEqual([1_000]);
    expect(plan.candidates.map((plugin) => plugin.packageName)).toEqual(["@openclaw/demo-plugin"]);
  });

  it("retries a transient package lookup and cancels the discarded response", async () => {
    const repoDir = createTempPluginRepo();
    let packageRequests = 0;
    let transientBodyCanceled = false;
    const retryDelays: number[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const pathname = new URL(requestUrl).pathname;
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin") {
        packageRequests += 1;
        if (packageRequests === 1) {
          return new Response(
            new ReadableStream({
              cancel() {
                transientBodyCanceled = true;
              },
            }),
            {
              status: 503,
              headers: { "retry-after": "1" },
            },
          );
        }
        return new Response("{}", { status: 200 });
      }
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin/trusted-publisher") {
        return new Response(
          JSON.stringify({
            trustedPublisher: {
              repository: "openclaw/openclaw",
              workflowFilename: "plugin-clawhub-release.yml",
            },
          }),
          { status: 200 },
        );
      }
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin/versions/2026.4.1") {
        return new Response("", { status: 404 });
      }
      throw new Error(`Unexpected ClawHub request to ${pathname}`);
    };

    const plan = await collectPluginClawHubReleasePlan({
      rootDir: repoDir,
      selection: ["@openclaw/demo-plugin"],
      fetchImpl,
      registryBaseUrl: "https://clawhub.ai",
      sleep: async (ms) => {
        retryDelays.push(ms);
      },
    });

    expect(packageRequests).toBe(2);
    expect(transientBodyCanceled).toBe(true);
    expect(retryDelays).toEqual([1_000]);
    expect(plan.candidates.map((plugin) => plugin.packageName)).toEqual(["@openclaw/demo-plugin"]);
  });

  it("retries a transient transport failure during version lookup", async () => {
    const repoDir = createTempPluginRepo();
    let versionRequests = 0;
    const retryDelays: number[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const pathname = new URL(requestUrl).pathname;
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin") {
        return new Response("{}", { status: 200 });
      }
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin/trusted-publisher") {
        return new Response(
          JSON.stringify({
            trustedPublisher: {
              repository: "openclaw/openclaw",
              workflowFilename: "plugin-clawhub-release.yml",
            },
          }),
          { status: 200 },
        );
      }
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin/versions/2026.4.1") {
        versionRequests += 1;
        if (versionRequests === 1) {
          throw new TypeError("fetch failed");
        }
        return new Response("", { status: 404 });
      }
      throw new Error(`Unexpected ClawHub request to ${pathname}`);
    };

    const plan = await collectPluginClawHubReleasePlan({
      rootDir: repoDir,
      selection: ["@openclaw/demo-plugin"],
      fetchImpl,
      registryBaseUrl: "https://clawhub.ai",
      sleep: async (ms) => {
        retryDelays.push(ms);
      },
    });

    expect(versionRequests).toBe(2);
    expect(retryDelays).toEqual([1_000]);
    expect(plan.candidates.map((plugin) => plugin.packageName)).toEqual(["@openclaw/demo-plugin"]);
  });

  it("preserves ClawHub response details after package retries are exhausted", async () => {
    const repoDir = createTempPluginRepo();
    let packageRequests = 0;
    await expect(
      collectPluginClawHubReleasePlan({
        rootDir: repoDir,
        selection: ["@openclaw/demo-plugin"],
        registryBaseUrl: "https://clawhub.ai",
        fetchImpl: async () => {
          packageRequests += 1;
          return new Response("Rate limit temporarily unavailable", {
            status: 503,
            headers: {
              "Retry-After": "1",
              "x-request-id": "request-123",
            },
          });
        },
        sleep: async () => {},
      }),
    ).rejects.toThrow(
      "Failed to query ClawHub package @openclaw/demo-plugin: 503 Rate limit temporarily unavailable [retry-after=1; x-request-id=request-123]",
    );
    expect(packageRequests).toBe(4);
  });

  it("honors an HTTP-date Retry-After header", async () => {
    const repoDir = createTempPluginRepo();
    const retryAfter = "Wed, 21 Oct 2030 07:28:00 GMT";
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse(retryAfter) - 1_000);
    let trustedPublisherRequests = 0;
    const retryDelays: number[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const pathname = new URL(requestUrl).pathname;
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin") {
        return new Response("{}", { status: 200 });
      }
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin/trusted-publisher") {
        trustedPublisherRequests += 1;
        if (trustedPublisherRequests === 1) {
          return new Response("", { status: 429, headers: { "retry-after": retryAfter } });
        }
        return new Response(
          JSON.stringify({
            trustedPublisher: {
              repository: "openclaw/openclaw",
              workflowFilename: "plugin-clawhub-release.yml",
            },
          }),
          { status: 200 },
        );
      }
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin/versions/2026.4.1") {
        return new Response("", { status: 404 });
      }
      throw new Error(`Unexpected ClawHub request to ${pathname}`);
    };

    try {
      await collectPluginClawHubReleasePlan({
        rootDir: repoDir,
        selection: ["@openclaw/demo-plugin"],
        fetchImpl,
        registryBaseUrl: "https://clawhub.ai",
        sleep: async (ms) => {
          retryDelays.push(ms);
        },
      });
    } finally {
      nowSpy.mockRestore();
    }

    expect(trustedPublisherRequests).toBe(2);
    expect(retryDelays).toEqual([1_000]);
  });

  it("falls back to the bounded retry schedule for an excessive Retry-After header", async () => {
    const repoDir = createTempPluginRepo();
    let trustedPublisherRequests = 0;
    const retryDelays: number[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const pathname = new URL(requestUrl).pathname;
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin") {
        return new Response("{}", { status: 200 });
      }
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin/trusted-publisher") {
        trustedPublisherRequests += 1;
        if (trustedPublisherRequests === 1) {
          return new Response("", { status: 429, headers: { "retry-after": "999999999999" } });
        }
        return new Response(
          JSON.stringify({
            trustedPublisher: {
              repository: "openclaw/openclaw",
              workflowFilename: "plugin-clawhub-release.yml",
            },
          }),
          { status: 200 },
        );
      }
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin/versions/2026.4.1") {
        return new Response("", { status: 404 });
      }
      throw new Error(`Unexpected ClawHub request to ${pathname}`);
    };

    await collectPluginClawHubReleasePlan({
      rootDir: repoDir,
      selection: ["@openclaw/demo-plugin"],
      fetchImpl,
      registryBaseUrl: "https://clawhub.ai",
      sleep: async (ms) => {
        retryDelays.push(ms);
      },
    });

    expect(trustedPublisherRequests).toBe(2);
    expect(retryDelays).toEqual([1_000]);
  });

  it("routes missing package rows to bootstrap candidates instead of normal candidates", async () => {
    const repoDir = createTempPluginRepo();
    const { fetchImpl } = createClawHubPlanFetch({
      packages: {
        "@openclaw/demo-plugin": {
          status: 404,
        },
      },
    });

    const plan = await collectPluginClawHubReleasePlan({
      rootDir: repoDir,
      selection: ["@openclaw/demo-plugin"],
      fetchImpl,
      registryBaseUrl: "https://clawhub.ai",
    });

    expect(plan.candidates).toStrictEqual([]);
    expect(plan.bootstrapCandidates.map((plugin) => plugin.packageName)).toEqual([
      "@openclaw/demo-plugin",
    ]);
    expect(plan.bootstrapCandidates[0]).toMatchObject({
      alreadyPublished: false,
      artifactName: "clawhub-package-openclaw-demo-plugin-2026.4.1",
      packageName: "@openclaw/demo-plugin",
      version: "2026.4.1",
    });
    expect(plan.missingTrustedPublisher).toStrictEqual([]);
  });

  it("routes existing packages without trusted publisher config out of normal candidates", async () => {
    const repoDir = createTempPluginRepo();
    const { fetchImpl } = createClawHubPlanFetch({
      packages: {
        "@openclaw/demo-plugin": {
          status: 200,
          body: {
            package: {},
            owner: {},
          },
        },
      },
      trustedPublishers: {
        "@openclaw/demo-plugin": {
          status: 200,
          body: {
            trustedPublisher: null,
          },
        },
      },
      versions: {
        "@openclaw/demo-plugin@2026.4.1": 404,
      },
    });

    const plan = await collectPluginClawHubReleasePlan({
      rootDir: repoDir,
      selection: ["@openclaw/demo-plugin"],
      fetchImpl,
      registryBaseUrl: "https://clawhub.ai",
    });

    expect(plan.candidates).toStrictEqual([]);
    expect(plan.bootstrapCandidates).toStrictEqual([]);
    expect(plan.missingTrustedPublisher.map((plugin) => plugin.packageName)).toEqual([
      "@openclaw/demo-plugin",
    ]);
    expect(plan.missingTrustedPublisher[0]).toMatchObject({
      alreadyPublished: false,
      artifactName: "clawhub-package-openclaw-demo-plugin-2026.4.1",
      packageName: "@openclaw/demo-plugin",
      version: "2026.4.1",
    });
  });

  it("keeps ClawHub trusted publisher timeouts active while reading response bodies", async () => {
    const repoDir = createTempPluginRepo();
    const fetchImpl: typeof fetch = async (input) => {
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(requestUrl);
      if (url.pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin") {
        return new Response("{}", { status: 200 });
      }
      if (url.pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin/trusted-publisher") {
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
      }
      throw new Error(`Unexpected ClawHub request to ${url.pathname}`);
    };

    await expect(
      collectPluginClawHubReleasePlan({
        rootDir: repoDir,
        selection: ["@openclaw/demo-plugin"],
        fetchImpl,
        registryBaseUrl: "https://clawhub.ai",
        requestTimeoutMs: 5,
      }),
    ).rejects.toThrow("ClawHub request timed out after 5ms");
  });

  it("routes environment-pinned trusted publisher config out of normal candidates", async () => {
    const repoDir = createTempPluginRepo();
    const { fetchImpl } = createClawHubPlanFetch({
      packages: {
        "@openclaw/demo-plugin": {
          status: 200,
          body: {
            package: {},
            owner: {},
          },
        },
      },
      trustedPublishers: {
        "@openclaw/demo-plugin": {
          status: 200,
          body: {
            trustedPublisher: {
              repository: "openclaw/openclaw",
              workflowFilename: "plugin-clawhub-release.yml",
              environment: "clawhub-plugin-release",
            },
          },
        },
      },
      versions: {
        "@openclaw/demo-plugin@2026.4.1": 404,
      },
    });

    const plan = await collectPluginClawHubReleasePlan({
      rootDir: repoDir,
      selection: ["@openclaw/demo-plugin"],
      fetchImpl,
      registryBaseUrl: "https://clawhub.ai",
    });

    expect(plan.candidates).toStrictEqual([]);
    expect(plan.bootstrapCandidates).toStrictEqual([]);
    expect(plan.missingTrustedPublisher.map((plugin) => plugin.packageName)).toEqual([
      "@openclaw/demo-plugin",
    ]);
  });

  it("skips versions that already exist on ClawHub", async () => {
    const repoDir = createTempPluginRepo();
    const { fetchImpl } = createClawHubPlanFetch({
      packages: {
        "@openclaw/demo-plugin": {
          status: 200,
          body: {
            package: {},
            owner: {},
          },
        },
      },
      trustedPublishers: {
        "@openclaw/demo-plugin": {
          status: 200,
          body: {
            trustedPublisher: null,
          },
        },
      },
      versions: {
        "@openclaw/demo-plugin@2026.4.1": 200,
      },
    });

    const plan = await collectPluginClawHubReleasePlan({
      rootDir: repoDir,
      selection: ["@openclaw/demo-plugin"],
      fetchImpl,
      registryBaseUrl: "https://clawhub.ai",
    });

    expect(plan.candidates).toStrictEqual([]);
    expect(plan.bootstrapCandidates).toStrictEqual([]);
    expect(plan.missingTrustedPublisher.map((plugin) => plugin.packageName)).toEqual([
      "@openclaw/demo-plugin",
    ]);
    expect(plan.missingTrustedPublisher[0]).toMatchObject({
      alreadyPublished: true,
      artifactName: "clawhub-package-openclaw-demo-plugin-2026.4.1",
      packageName: "@openclaw/demo-plugin",
      version: "2026.4.1",
    });
    expect(plan.skippedPublished).toHaveLength(1);
    expect(plan.skippedPublished[0]).toEqual({
      alreadyPublished: true,
      artifactName: "clawhub-package-openclaw-demo-plugin-2026.4.1",
      channel: "stable",
      extensionId: "demo-plugin",
      packageDir: "extensions/demo-plugin",
      packageName: "@openclaw/demo-plugin",
      publishTag: "latest",
      version: "2026.4.1",
    });
  });

  it("plans selected packages without validating unrelated publishable packages", async () => {
    const repoDir = createTempPluginRepo({
      extraExtensionIds: ["broken-plugin"],
    });
    writeFileSync(
      join(repoDir, "extensions", "broken-plugin", "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/broken-plugin",
          version: "2026.4.1",
          openclaw: {
            extensions: ["./index.ts"],
            release: {
              publishToClawHub: true,
            },
          },
        },
        null,
        2,
      ),
    );

    const plan = await collectPluginClawHubReleasePlan({
      rootDir: repoDir,
      selection: ["@openclaw/demo-plugin"],
      fetchImpl: createClawHubPlanFetch({
        packages: {
          "@openclaw/demo-plugin": {
            status: 200,
            body: {
              package: {},
              owner: {},
            },
          },
        },
        trustedPublishers: {
          "@openclaw/demo-plugin": {
            status: 200,
            body: {
              trustedPublisher: {
                repository: "openclaw/openclaw",
                workflowFilename: "plugin-clawhub-release.yml",
              },
            },
          },
        },
        versions: {
          "@openclaw/demo-plugin@2026.4.1": 404,
        },
      }).fetchImpl,
      registryBaseUrl: "https://clawhub.ai",
    });

    expect(plan.candidates.map((plugin) => plugin.packageName)).toEqual(["@openclaw/demo-plugin"]);
    expect(plan.candidates.map((plugin) => plugin.artifactName)).toEqual([
      "clawhub-package-openclaw-demo-plugin-2026.4.1",
    ]);
  });
});

describe("buildOpenClawReleaseClawHubPlan", () => {
  it("emits a dispatch plan that keeps ClawHub children on the release tag", async () => {
    const repoDir = createTempPluginRepo({
      extraExtensionIds: ["demo-two", "demo-three"],
    });
    const { fetchImpl } = createClawHubPlanFetch({
      packages: {
        "@openclaw/demo-plugin": {
          status: 200,
          body: {
            package: {},
            owner: {},
          },
        },
        "@openclaw/demo-two": {
          status: 404,
        },
        "@openclaw/demo-three": {
          status: 200,
          body: {
            package: {},
            owner: {},
          },
        },
      },
      trustedPublishers: {
        "@openclaw/demo-plugin": {
          status: 200,
          body: {
            trustedPublisher: {
              repository: "openclaw/openclaw",
              workflowFilename: "plugin-clawhub-release.yml",
            },
          },
        },
        "@openclaw/demo-three": {
          status: 200,
          body: {
            trustedPublisher: null,
          },
        },
      },
      versions: {
        "@openclaw/demo-plugin@2026.4.1": 404,
        "@openclaw/demo-three@2026.4.1": 404,
      },
    });

    const plan = await buildOpenClawReleaseClawHubPlan(
      {
        bootstrapWorkflowSha: "d".repeat(40),
        releaseTag: "v2026.4.1-beta.1",
        releaseSha: "a".repeat(40),
        releasePublishBranch: "main",
        releasePublishRunAttempt: "2",
        releasePublishRunId: "12345",
        pluginPublishScope: "all-publishable",
        plugins: [],
      },
      {
        rootDir: repoDir,
        fetchImpl,
        registryBaseUrl: "https://clawhub.ai",
      },
    );

    expect(plan.clawHubWorkflowRef).toBe("v2026.4.1-beta.1");
    expect(plan.bootstrapWorkflowSha).toBe("d".repeat(40));
    expect(plan.releasePublishBranch).toBe("main");
    expect(plan.normal).toEqual({
      workflow: "plugin-clawhub-release.yml",
      ref: "v2026.4.1-beta.1",
      shouldDispatch: true,
      packages: ["@openclaw/demo-plugin"],
      inputs: {
        publish_scope: "selected",
        plugins: "@openclaw/demo-plugin",
        release_publish_run_id: "12345",
        release_publish_branch: "main",
      },
    });
    expect(plan.bootstrap).toEqual({
      workflow: "plugin-clawhub-new.yml",
      ref: "main",
      shouldDispatch: true,
      packages: ["@openclaw/demo-two", "@openclaw/demo-three"],
      inputs: {
        bootstrap_workflow_sha: "d".repeat(40),
        ref: "a".repeat(40),
        release_tag: "v2026.4.1-beta.1",
        plugins: "@openclaw/demo-two,@openclaw/demo-three",
        release_publish_run_attempt: "2",
        release_publish_run_id: "12345",
        release_publish_branch: "main",
      },
    });
    expect(new Set([...plan.normal.packages, ...plan.bootstrap.packages]).size).toBe(3);
    expect(plan.summary).toEqual({
      normalCount: 1,
      bootstrapCount: 2,
      missingTrustedPublisherCount: 1,
      normalPlugins: "@openclaw/demo-plugin",
      bootstrapPlugins: "@openclaw/demo-two,@openclaw/demo-three",
      missingTrustedPlugins: "@openclaw/demo-three",
    });
    expect(plan.verifier).toEqual({
      clawHubWorkflowRef: "v2026.4.1-beta.1",
    });
  });

  it("routes already-published packages missing trusted publisher config to bootstrap repair", async () => {
    const repoDir = createTempPluginRepo();
    const { fetchImpl } = createClawHubPlanFetch({
      packages: {
        "@openclaw/demo-plugin": {
          status: 200,
          body: {
            package: {},
            owner: {},
          },
        },
      },
      trustedPublishers: {
        "@openclaw/demo-plugin": {
          status: 200,
          body: {
            trustedPublisher: null,
          },
        },
      },
      versions: {
        "@openclaw/demo-plugin@2026.4.1": 200,
      },
    });

    const plan = await buildOpenClawReleaseClawHubPlan(
      {
        bootstrapWorkflowSha: "d".repeat(40),
        releaseTag: "v2026.4.1-beta.1",
        releaseSha: "b".repeat(40),
        releasePublishBranch: "release/2026.4.1",
        releasePublishRunAttempt: "3",
        releasePublishRunId: "12345",
        pluginPublishScope: "selected",
        plugins: ["@openclaw/demo-plugin"],
      },
      {
        rootDir: repoDir,
        fetchImpl,
        registryBaseUrl: "https://clawhub.ai",
      },
    );

    expect(plan.normal.shouldDispatch).toBe(false);
    expect(plan.bootstrap).toMatchObject({
      workflow: "plugin-clawhub-new.yml",
      ref: "main",
      shouldDispatch: true,
      packages: ["@openclaw/demo-plugin"],
      inputs: {
        bootstrap_workflow_sha: "d".repeat(40),
        ref: "b".repeat(40),
        release_tag: "v2026.4.1-beta.1",
        plugins: "@openclaw/demo-plugin",
        release_publish_run_attempt: "3",
        release_publish_run_id: "12345",
        release_publish_branch: "release/2026.4.1",
      },
    });
    expect(plan.summary).toMatchObject({
      normalCount: 0,
      bootstrapCount: 1,
      missingTrustedPublisherCount: 1,
      bootstrapPlugins: "@openclaw/demo-plugin",
      missingTrustedPlugins: "@openclaw/demo-plugin",
    });
  });

  it("rejects incompatible all-publishable plugin selection args", () => {
    expect(() =>
      parseOpenClawReleaseClawHubPlanArgs([
        "--bootstrap-workflow-sha",
        "d".repeat(40),
        "--release-tag",
        "v2026.4.1-beta.1",
        "--release-sha",
        "c".repeat(40),
        "--release-publish-branch",
        "main",
        "--release-publish-run-attempt",
        "1",
        "--release-publish-run-id",
        "12345",
        "--plugin-publish-scope",
        "all-publishable",
        "--plugins",
        "@openclaw/demo-plugin",
      ]),
    ).toThrow("plugin-publish-scope=all-publishable must not be combined with --plugins.");
  });

  it("requires an exact lowercase release SHA for bootstrap targeting", () => {
    const baseArgs = [
      "--bootstrap-workflow-sha",
      "d".repeat(40),
      "--release-tag",
      "v2026.4.1-beta.1",
      "--release-publish-branch",
      "release/2026.4.1",
      "--release-publish-run-attempt",
      "1",
      "--release-publish-run-id",
      "12345",
    ];
    expect(() => parseOpenClawReleaseClawHubPlanArgs(baseArgs)).toThrow(
      "--release-sha is required.",
    );
    expect(() =>
      parseOpenClawReleaseClawHubPlanArgs([...baseArgs, "--release-sha", "ABCDEF"]),
    ).toThrow("--release-sha must be a full 40-character lowercase commit SHA.");
  });

  it("requires an exact parent release run attempt for bootstrap approval binding", () => {
    const args = [
      "--bootstrap-workflow-sha",
      "d".repeat(40),
      "--release-tag",
      "v2026.4.1-beta.1",
      "--release-sha",
      "c".repeat(40),
      "--release-publish-branch",
      "main",
      "--release-publish-run-id",
      "12345",
    ];
    expect(() => parseOpenClawReleaseClawHubPlanArgs(args)).toThrow(
      "--release-publish-run-attempt is required.",
    );
    expect(() =>
      parseOpenClawReleaseClawHubPlanArgs([...args, "--release-publish-run-attempt", "0"]),
    ).toThrow("--release-publish-run-attempt must be a positive integer.");
  });
});

describe("runPluginClawHubReleaseCheck", () => {
  it("rejects stale required dependencies", async () => {
    const repoDir = createTempPluginRepo({
      requiredLatestDependencyVersion: "1.2.3",
    });

    await expect(
      runPluginClawHubReleaseCheck(["--plugins", "@openclaw/demo-plugin"], {
        rootDir: repoDir,
        resolveLatestVersion: () => "1.2.4",
      }),
    ).rejects.toThrow(
      '@openclaw/demo-plugin@2026.4.1: demo-runtime must match npm latest for release; found "1.2.3", latest is "1.2.4".',
    );
  });

  it("accepts required dependencies matching npm latest", async () => {
    const repoDir = createTempPluginRepo({
      requiredLatestDependencyVersion: "1.2.3",
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await expect(
        runPluginClawHubReleaseCheck(["--plugins", "@openclaw/demo-plugin"], {
          rootDir: repoDir,
          resolveLatestVersion: () => "1.2.3",
        }),
      ).resolves.toBeUndefined();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("fails closed when npm latest cannot be resolved", async () => {
    const repoDir = createTempPluginRepo({
      requiredLatestDependencyVersion: "1.2.3",
    });

    await expect(
      runPluginClawHubReleaseCheck(["--plugins", "@openclaw/demo-plugin"], {
        rootDir: repoDir,
        resolveLatestVersion: () => {
          throw new Error("registry unavailable");
        },
      }),
    ).rejects.toThrow(
      "@openclaw/demo-plugin@2026.4.1: could not resolve npm latest for demo-runtime: registry unavailable",
    );
  });
});

describe("buildOpenClawReleaseClawHubRuntimeState", () => {
  it("includes the normal ClawHub run in verifier args when the release waits for it", () => {
    const state = buildOpenClawReleaseClawHubRuntimeState({
      repository: "openclaw/openclaw",
      waitForClawHub: true,
      forceSkipClawHub: false,
      normalRunId: "111",
      bootstrapRunId: "",
      bootstrapCompleted: false,
    });

    expect(state.verifierArgs).toEqual(["--plugin-clawhub-run", "111"]);
    expect(state.proofLines.normal).toBe(
      "- plugin ClawHub publish: https://github.com/openclaw/openclaw/actions/runs/111",
    );
    expect(state.proofLines.bootstrap).toBe("- plugin ClawHub bootstrap: not needed");
  });

  it("includes a completed bootstrap run even when there is no normal ClawHub run", () => {
    const state = buildOpenClawReleaseClawHubRuntimeState({
      repository: "openclaw/openclaw",
      waitForClawHub: false,
      forceSkipClawHub: false,
      normalRunId: "",
      bootstrapRunId: "222",
      bootstrapCompleted: true,
    });

    expect(state.verifierArgs).toEqual(["--plugin-clawhub-bootstrap-run", "222"]);
    expect(state.proofLines.normal).toBe("- plugin ClawHub publish: no normal OIDC candidates");
    expect(state.proofLines.bootstrap).toBe(
      "- plugin ClawHub bootstrap: https://github.com/openclaw/openclaw/actions/runs/222",
    );
  });

  it("skips ClawHub verification for non-awaited incomplete runs while keeping proof links", () => {
    const state = buildOpenClawReleaseClawHubRuntimeState({
      repository: "openclaw/openclaw",
      waitForClawHub: false,
      forceSkipClawHub: false,
      normalRunId: "111",
      bootstrapRunId: "222",
      bootstrapCompleted: false,
    });

    expect(state.verifierArgs).toEqual(["--skip-clawhub"]);
    expect(state.proofLines.normal).toBe(
      "- plugin ClawHub publish: dispatched separately, not awaited by this proof: https://github.com/openclaw/openclaw/actions/runs/111",
    );
    expect(state.proofLines.bootstrap).toBe(
      "- plugin ClawHub bootstrap: dispatched separately, not awaited by this proof: https://github.com/openclaw/openclaw/actions/runs/222",
    );
  });

  it("keeps completed bootstrap run evidence when the normal ClawHub run is not awaited", () => {
    const state = buildOpenClawReleaseClawHubRuntimeState({
      repository: "openclaw/openclaw",
      waitForClawHub: false,
      forceSkipClawHub: false,
      normalRunId: "111",
      bootstrapRunId: "222",
      bootstrapCompleted: true,
    });

    expect(state.verifierArgs).toEqual(["--skip-clawhub", "--plugin-clawhub-bootstrap-run", "222"]);
    expect(state.proofLines.normal).toBe(
      "- plugin ClawHub publish: dispatched separately, not awaited by this proof: https://github.com/openclaw/openclaw/actions/runs/111",
    );
    expect(state.proofLines.bootstrap).toBe(
      "- plugin ClawHub bootstrap: https://github.com/openclaw/openclaw/actions/runs/222",
    );
  });

  it("forces skip-clawhub after a failed child run even if ClawHub runs completed", () => {
    const state = buildOpenClawReleaseClawHubRuntimeState({
      repository: "openclaw/openclaw",
      waitForClawHub: true,
      forceSkipClawHub: true,
      normalRunId: "111",
      bootstrapRunId: "222",
      bootstrapCompleted: true,
    });

    expect(state.verifierArgs).toEqual(["--skip-clawhub"]);
    expect(state.proofLines.normal).toBe(
      "- plugin ClawHub publish: https://github.com/openclaw/openclaw/actions/runs/111",
    );
    expect(state.proofLines.bootstrap).toBe(
      "- plugin ClawHub bootstrap: https://github.com/openclaw/openclaw/actions/runs/222",
    );
  });
});

describe("plugin-clawhub-publish.sh", () => {
  it("rejects ambiguous packed identities before invoking the pinned ClawHub CLI", () => {
    const source = readFileSync("scripts/plugin-clawhub-publish.sh", "utf8");
    const localIdentityIndex = source.indexOf("clawhub-bootstrap-artifact.mjs");
    const clawHubDryRunIndex = source.indexOf("local dry_run_json");

    expect(localIdentityIndex).toBeGreaterThan(0);
    expect(localIdentityIndex).toBeLessThan(clawHubDryRunIndex);
  });

  it("probes GNU timeout capabilities and leaves pack-only mode portable", () => {
    const source = readFileSync("scripts/plugin-clawhub-publish.sh", "utf8");
    const packExitIndex = source.indexOf('if [[ "${mode}" == "--pack" ]]');
    const timeoutProbeIndex = source.indexOf("for timeout_candidate in timeout gtimeout");

    expect(timeoutProbeIndex).toBeGreaterThan(packExitIndex);
    expect(source).toContain("--signal=TERM --kill-after=1s 1s true");
    expect(source).toContain("with --signal and --kill-after support is required");
  });

  it("prints help before package or ClawHub checks", () => {
    const output = execFileSync(
      "bash",
      [join(process.cwd(), "scripts/plugin-clawhub-publish.sh"), "--help"],
      {
        encoding: "utf8",
      },
    );

    expect(output.trim()).toBe(
      [
        "usage: bash scripts/plugin-clawhub-publish.sh [--dry-run|--publish|--pack] <package-dir>",
        "       bash scripts/plugin-clawhub-publish.sh [--validate-packed|--publish-packed] <clawpack.tgz>",
      ].join("\n"),
    );
  });

  it("rejects option-like package dirs before package or ClawHub checks", () => {
    expect(() =>
      execFileSync(
        "bash",
        [join(process.cwd(), "scripts/plugin-clawhub-publish.sh"), "--dry-run", "--wat"],
        {
          encoding: "utf8",
        },
      ),
    ).toThrow("unexpected plugin ClawHub package-dir option: --wat");
  });

  it("rejects extra arguments before package or ClawHub checks", () => {
    expect(() =>
      execFileSync(
        "bash",
        [
          join(process.cwd(), "scripts/plugin-clawhub-publish.sh"),
          "--dry-run",
          "extensions/demo-plugin",
          "extra",
        ],
        {
          encoding: "utf8",
        },
      ),
    ).toThrow("unexpected plugin ClawHub publish argument: extra");
  });

  it("previews the publish command through the ClawHub CLI dry-run preflight", () => {
    const repoDir = createTempPluginRepo();
    const binDir = join(repoDir, "bin");
    const markerPath = join(repoDir, "clawhub-invoked");
    mkdirSync(binDir, { recursive: true });
    const clawhubPath = join(binDir, "clawhub");
    writeFileSync(
      clawhubPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(markerPath)}
if [[ "\${1:-}" == "--workdir" ]]; then
  shift 2
fi
if [[ "\${1:-}" == "package" && "\${2:-}" == "pack" ]]; then
  pack_destination=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --pack-destination)
        pack_destination="\${2:-}"
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done
  mkdir -p "$pack_destination"
  pack_path="$pack_destination/openclaw-demo-plugin-2026.4.1.tgz"
  printf 'fake tgz\\n' > "$pack_path"
  printf '{"path":"%s","name":"@openclaw/demo-plugin","version":"2026.4.1"}\\n' "$pack_path"
fi
exit 0
`,
    );
    chmodSync(clawhubPath, 0o755);

    const output = execFileSync(
      "bash",
      [
        join(process.cwd(), "scripts/plugin-clawhub-publish.sh"),
        "--dry-run",
        "extensions/demo-plugin",
      ],
      {
        cwd: repoDir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(output).toContain("Publish command: CLAWHUB_WORKDIR=");
    expect(output).toContain("Resolved ClawPack:");
    const invocations = readFileSync(markerPath, "utf8");
    const resolvedRepoDir = realpathSync(repoDir);
    expect(invocations).toContain(`--workdir ${resolvedRepoDir}`);
    expect(invocations).toContain(
      `package pack ${join(resolvedRepoDir, "extensions/demo-plugin")}`,
    );
    expect(invocations).toContain("package publish ");
    expect(invocations).toContain(".tgz --tags latest");
    expect(invocations).toContain("--dry-run");
  });

  it("passes a manual override reason when trusted publisher repair requires one", () => {
    const repoDir = createTempPluginRepo();
    const binDir = join(repoDir, "bin");
    const markerPath = join(repoDir, "clawhub-invoked");
    mkdirSync(binDir, { recursive: true });
    const clawhubPath = join(binDir, "clawhub");
    writeFileSync(
      clawhubPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(markerPath)}
if [[ "\${1:-}" == "--workdir" ]]; then
  shift 2
fi
if [[ "\${1:-}" == "package" && "\${2:-}" == "pack" ]]; then
  pack_destination=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --pack-destination)
        pack_destination="\${2:-}"
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done
  mkdir -p "$pack_destination"
  pack_path="$pack_destination/openclaw-demo-plugin-2026.4.1.tgz"
  printf 'fake tgz\\n' > "$pack_path"
  printf '{"path":"%s","name":"@openclaw/demo-plugin","version":"2026.4.1"}\\n' "$pack_path"
fi
exit 0
`,
    );
    chmodSync(clawhubPath, 0o755);

    execFileSync(
      "bash",
      [
        join(process.cwd(), "scripts/plugin-clawhub-publish.sh"),
        "--publish",
        "extensions/demo-plugin",
      ],
      {
        cwd: repoDir,
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_CLAWHUB_MANUAL_OVERRIDE_REASON:
            "GitHub Actions trusted publisher repair before OIDC migration",
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    const invocations = readFileSync(markerPath, "utf8");
    expect(invocations).toContain("package publish ");
    expect(invocations).toContain(
      "--manual-override-reason GitHub Actions trusted publisher repair before OIDC migration",
    );
  });

  it("packs a reusable workflow artifact without publishing", () => {
    const repoDir = createTempPluginRepo();
    const binDir = join(repoDir, "bin");
    const markerPath = join(repoDir, "clawhub-invoked");
    const outputDir = join(repoDir, "clawhub-artifacts");
    mkdirSync(binDir, { recursive: true });
    const clawhubPath = join(binDir, "clawhub");
    writeFileSync(
      clawhubPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(markerPath)}
if [[ "\${1:-}" == "--workdir" ]]; then
  shift 2
fi
if [[ "\${1:-}" == "package" && "\${2:-}" == "pack" ]]; then
  pack_destination=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --pack-destination)
        pack_destination="\${2:-}"
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done
  mkdir -p "$pack_destination"
  pack_path="$pack_destination/openclaw-demo-plugin-2026.4.1.tgz"
  printf 'fake tgz\\n' > "$pack_path"
  printf '{"path":"%s","name":"@openclaw/demo-plugin","version":"2026.4.1"}\\n' "$pack_path"
fi
exit 0
`,
    );
    chmodSync(clawhubPath, 0o755);

    const output = execFileSync(
      "bash",
      [
        join(process.cwd(), "scripts/plugin-clawhub-publish.sh"),
        "--pack",
        "extensions/demo-plugin",
      ],
      {
        cwd: repoDir,
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_CLAWHUB_PACK_OUTPUT_DIR: outputDir,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(output).toContain("Packed ClawPack:");
    expect(existsSync(join(outputDir, "openclaw-demo-plugin-2026.4.1.tgz"))).toBe(true);
    const invocations = readFileSync(markerPath, "utf8");
    expect(invocations).toContain("package pack ");
    expect(invocations).not.toContain("package publish ");
  });

  it("rejects duplicate normalized paths before invoking the ClawHub CLI", () => {
    const repoDir = createTempPluginRepo();
    const binDir = join(repoDir, "bin");
    const markerPath = join(repoDir, "clawhub-invoked");
    const tgzPath = join(repoDir, "ambiguous.tgz");
    const tgzBytes = createClawPackBytes("@openclaw/demo-plugin", "2026.4.1", {
      duplicateNormalizedPackageJson: true,
    });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(tgzPath, tgzBytes);
    writeFileSync(
      join(binDir, "clawhub"),
      `#!/usr/bin/env bash
set -euo pipefail
touch ${JSON.stringify(markerPath)}
exit 99
`,
    );
    chmodSync(join(binDir, "clawhub"), 0o755);

    expect(() =>
      execFileSync(
        "bash",
        [join(process.cwd(), "scripts/plugin-clawhub-publish.sh"), "--validate-packed", tgzPath],
        {
          cwd: repoDir,
          encoding: "utf8",
          env: {
            ...process.env,
            EXPECTED_CLAWHUB_ARTIFACT_SHA256: createHash("sha256").update(tgzBytes).digest("hex"),
            EXPECTED_CLAWHUB_ARTIFACT_SIZE: String(tgzBytes.byteLength),
            EXPECTED_CLAWHUB_PACKAGE_NAME: "@openclaw/demo-plugin",
            EXPECTED_CLAWHUB_PACKAGE_VERSION: "2026.4.1",
            PACKAGE_DIR: "extensions/demo-plugin",
            PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
          },
        },
      ),
    ).toThrow("Duplicate or aliased plugin tar entry: package/package.json");
    expect(existsSync(markerPath)).toBe(false);
  });

  it("publishes the exact validated tgz and retries transient failures", () => {
    const repoDir = createTempPluginRepo();
    const binDir = join(repoDir, "bin");
    const markerPath = join(repoDir, "clawhub-invoked");
    const attemptsPath = join(repoDir, "publish-attempts");
    const tgzPath = join(repoDir, "immutable.tgz");
    const tgzBytes = createClawPackBytes("@openclaw/demo-plugin", "2026.4.1");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(tgzPath, tgzBytes);
    writeFileSync(
      join(binDir, "sleep"),
      `#!/usr/bin/env bash
exit 0
`,
    );
    chmodSync(join(binDir, "sleep"), 0o755);
    writeFileSync(
      join(binDir, "clawhub"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(markerPath)}
if [[ "\${1:-}" == "--workdir" ]]; then
  shift 2
fi
if [[ " $* " == *" --dry-run "* ]]; then
  printf '{"name":"@openclaw/demo-plugin","version":"2026.4.1"}\\n'
  exit 0
fi
attempts=0
if [[ -f ${JSON.stringify(attemptsPath)} ]]; then
  attempts="$(cat ${JSON.stringify(attemptsPath)})"
fi
attempts=$((attempts + 1))
printf '%s' "$attempts" > ${JSON.stringify(attemptsPath)}
if [[ "$attempts" == "1" ]]; then
  echo "HTTP 503 temporarily unavailable" >&2
  exit 1
fi
exit 0
`,
    );
    chmodSync(join(binDir, "clawhub"), 0o755);

    execFileSync(
      "bash",
      [join(process.cwd(), "scripts/plugin-clawhub-publish.sh"), "--publish-packed", tgzPath],
      {
        cwd: repoDir,
        encoding: "utf8",
        env: {
          ...process.env,
          EXPECTED_CLAWHUB_ARTIFACT_SHA256: createHash("sha256").update(tgzBytes).digest("hex"),
          EXPECTED_CLAWHUB_ARTIFACT_SIZE: String(tgzBytes.byteLength),
          EXPECTED_CLAWHUB_PACKAGE_NAME: "@openclaw/demo-plugin",
          EXPECTED_CLAWHUB_PACKAGE_VERSION: "2026.4.1",
          OPENCLAW_CLAWHUB_PUBLISH_ATTEMPTS: "2",
          OPENCLAW_CLAWHUB_PUBLISH_RETRY_DELAY_SECONDS: "1",
          PACKAGE_DIR: "extensions/demo-plugin",
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    const invocations = readFileSync(markerPath, "utf8");
    expect(invocations).not.toContain("package pack");
    expect(invocations.match(/immutable\.tgz/gu)).toHaveLength(3);
    expect(readFileSync(attemptsPath, "utf8")).toBe("2");
  });

  it("bounds each packed publish attempt and retries a timed-out CLI", () => {
    const repoDir = createTempPluginRepo();
    const binDir = join(repoDir, "bin");
    const attemptsPath = join(repoDir, "publish-attempts");
    const tgzPath = join(repoDir, "immutable.tgz");
    const tgzBytes = createClawPackBytes("@openclaw/demo-plugin", "2026.4.1");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(tgzPath, tgzBytes);
    writeFileSync(
      join(binDir, "clawhub"),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "--workdir" ]]; then
  shift 2
fi
if [[ " $* " == *" --dry-run "* ]]; then
  printf '{"name":"@openclaw/demo-plugin","version":"2026.4.1"}\\n'
  exit 0
fi
attempts=0
if [[ -f ${JSON.stringify(attemptsPath)} ]]; then
  attempts="$(cat ${JSON.stringify(attemptsPath)})"
fi
attempts=$((attempts + 1))
printf '%s' "$attempts" > ${JSON.stringify(attemptsPath)}
if [[ "$attempts" == "1" ]]; then
  sleep 60
fi
exit 0
`,
    );
    chmodSync(join(binDir, "clawhub"), 0o755);

    const startedAt = Date.now();
    execFileSync(
      "bash",
      [join(process.cwd(), "scripts/plugin-clawhub-publish.sh"), "--publish-packed", tgzPath],
      {
        cwd: repoDir,
        encoding: "utf8",
        env: {
          ...process.env,
          EXPECTED_CLAWHUB_ARTIFACT_SHA256: createHash("sha256").update(tgzBytes).digest("hex"),
          EXPECTED_CLAWHUB_ARTIFACT_SIZE: String(tgzBytes.byteLength),
          EXPECTED_CLAWHUB_PACKAGE_NAME: "@openclaw/demo-plugin",
          EXPECTED_CLAWHUB_PACKAGE_VERSION: "2026.4.1",
          OPENCLAW_CLAWHUB_PUBLISH_ATTEMPTS: "2",
          OPENCLAW_CLAWHUB_PUBLISH_ATTEMPT_TIMEOUT_SECONDS: "1",
          OPENCLAW_CLAWHUB_PUBLISH_RETRY_DELAY_SECONDS: "1",
          PACKAGE_DIR: "extensions/demo-plugin",
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(readFileSync(attemptsPath, "utf8")).toBe("2");
  });
});

describe("collectPluginClawHubReleasePathsFromGitRange", () => {
  it("rejects unsafe git refs", () => {
    const repoDir = createTempPluginRepo();
    const headRef = git(repoDir, ["rev-parse", "HEAD"]);

    expect(() =>
      collectPluginClawHubReleasePathsFromGitRange({
        rootDir: repoDir,
        gitRange: {
          baseRef: "--not-a-ref",
          headRef,
        },
      }),
    ).toThrow("baseRef must be a normal git ref or commit SHA.");
  });
});

function createTempPluginRepo(
  options: {
    extensionId?: string;
    extraExtensionIds?: string[];
    publishToClawHub?: boolean;
    includeClawHubContract?: boolean;
    requiredLatestDependencyVersion?: string;
  } = {},
) {
  const repoDir = makeTempRepoRoot(tempDirs, "openclaw-clawhub-release-");
  const extensionId = options.extensionId ?? "demo-plugin";
  const extensionIds = [extensionId, ...(options.extraExtensionIds ?? [])];

  writeFileSync(
    join(repoDir, "package.json"),
    JSON.stringify({ name: "openclaw-test-root", type: "module" }, null, 2),
  );
  writeFileSync(join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  for (const currentExtensionId of extensionIds) {
    mkdirSync(join(repoDir, "extensions", currentExtensionId), { recursive: true });
    writeFileSync(
      join(repoDir, "extensions", currentExtensionId, "package.json"),
      JSON.stringify(
        {
          name: `@openclaw/${currentExtensionId}`,
          version: "2026.4.1",
          type: "module",
          repository: {
            type: "git",
            url: OPENCLAW_PLUGIN_NPM_REPOSITORY_URL,
          },
          ...(options.requiredLatestDependencyVersion
            ? {
                dependencies: {
                  "demo-runtime": options.requiredLatestDependencyVersion,
                },
              }
            : {}),
          openclaw: {
            extensions: ["./index.ts"],
            ...(options.includeClawHubContract === false
              ? {}
              : {
                  compat: {
                    pluginApi: ">=2026.4.1",
                  },
                  build: {
                    openclawVersion: "2026.4.1",
                  },
                }),
            install: {
              npmSpec: `@openclaw/${currentExtensionId}`,
            },
            release: {
              publishToClawHub: options.publishToClawHub ?? true,
              ...(options.requiredLatestDependencyVersion
                ? {
                    requireLatestDependencies: ["demo-runtime"],
                  }
                : {}),
            },
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(repoDir, "extensions", currentExtensionId, "index.ts"),
      `export const ${currentExtensionId.replaceAll(/[-.]/g, "_")} = 1;\n`,
    );
    writeFileSync(join(repoDir, "extensions", currentExtensionId, "README.md"), "# Demo plugin\n");
  }

  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["add", "."]);
  git(repoDir, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "init",
  ]);

  return repoDir;
}

function commitSharedReleaseToolingChange(repoDir: string) {
  const baseRef = git(repoDir, ["rev-parse", "HEAD"]);

  mkdirSync(join(repoDir, "scripts"), { recursive: true });
  writeFileSync(join(repoDir, "scripts", "plugin-clawhub-publish.sh"), "#!/usr/bin/env bash\n");
  git(repoDir, ["add", "."]);
  git(repoDir, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "shared tooling",
  ]);
  const headRef = git(repoDir, ["rev-parse", "HEAD"]);

  return { baseRef, headRef };
}

function createClawHubPlanFetch(config: {
  packages: Record<
    string,
    {
      status: number;
      body?: unknown;
    }
  >;
  trustedPublishers?: Record<
    string,
    {
      status: number;
      body?: unknown;
    }
  >;
  versions?: Record<string, number>;
}) {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const requestUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(requestUrl);
    requests.push(url.pathname);

    const packageMatch = url.pathname.match(/^\/api\/v1\/packages\/([^/]+)$/u);
    const encodedPackageName = packageMatch?.[1];
    if (encodedPackageName !== undefined) {
      const packageName = decodeURIComponent(encodedPackageName);
      const packageResponse = config.packages[packageName];
      if (!packageResponse) {
        throw new Error(`Unexpected package detail request for ${packageName}`);
      }
      return new Response(JSON.stringify(packageResponse.body ?? {}), {
        status: packageResponse.status,
      });
    }

    const trustedPublisherMatch = url.pathname.match(
      /^\/api\/v1\/packages\/([^/]+)\/trusted-publisher$/u,
    );
    const encodedTrustedPublisherPackageName = trustedPublisherMatch?.[1];
    if (encodedTrustedPublisherPackageName !== undefined) {
      const packageName = decodeURIComponent(encodedTrustedPublisherPackageName);
      const trustedPublisherResponse = config.trustedPublishers?.[packageName];
      if (!trustedPublisherResponse) {
        throw new Error(`Unexpected trusted-publisher request for ${packageName}`);
      }
      return new Response(JSON.stringify(trustedPublisherResponse.body ?? {}), {
        status: trustedPublisherResponse.status,
      });
    }

    const versionMatch = url.pathname.match(/^\/api\/v1\/packages\/([^/]+)\/versions\/([^/]+)$/u);
    const encodedVersionPackageName = versionMatch?.[1];
    const encodedVersion = versionMatch?.[2];
    if (encodedVersionPackageName !== undefined && encodedVersion !== undefined) {
      const packageName = decodeURIComponent(encodedVersionPackageName);
      const version = decodeURIComponent(encodedVersion);
      const status = config.versions?.[`${packageName}@${version}`];
      if (!status) {
        throw new Error(`Unexpected version detail request for ${packageName}@${version}`);
      }
      return new Response("{}", { status });
    }

    throw new Error(`Unexpected ClawHub request to ${url.pathname}`);
  };

  return { fetchImpl, requests };
}

function git(cwd: string, args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
