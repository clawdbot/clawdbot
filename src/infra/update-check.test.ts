// Covers update version resolution, Git install labels, and registry fetch helpers.
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { useMockHttp } from "../test-utils/mock-http.js";
import { fetchNpmPackageTargetStatus } from "./update-check-package-target.js";
import {
  checkUpdateStatus,
  compareSemverStrings,
  fetchNpmTagVersion,
  formatGitInstallLabel,
  resolveExtendedStablePackage,
  resolveNpmChannelTag,
} from "./update-check.js";

const mockHttp = useMockHttp();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("compareSemverStrings", () => {
  it("orders real stable, prerelease, and legacy dot-beta versions", () => {
    expect(compareSemverStrings("2026.6.5", "2026.6.6-beta.1")).toBe(-1);
    expect(compareSemverStrings("2026.6.6", "2026.6.6-beta.1")).toBe(1);
    expect(compareSemverStrings("2026.6.6-beta.2", "2026.6.6-beta.1")).toBe(1);
    expect(compareSemverStrings("v2026.6.6", "2026.6.6")).toBe(0);
    expect(compareSemverStrings("2026.6.6.beta.2", "2026.6.6-beta.1")).toBe(1);
  });

  it("treats OpenClaw stable correction releases as newer than their base release", () => {
    expect(compareSemverStrings("2026.5.3", "2026.5.3-1")).toBe(-1);
    expect(compareSemverStrings("2026.5.3-1", "2026.5.3")).toBe(1);
    expect(compareSemverStrings("2026.5.3-2", "2026.5.3-1")).toBe(1);
  });

  it("returns null for invalid inputs", () => {
    expect(compareSemverStrings("1.0", "1.0.0")).toBeNull();
    expect(compareSemverStrings("latest", "1.0.0")).toBeNull();
  });
});

describe("resolveNpmChannelTag", () => {
  type NpmMetadataCommandRunner = NonNullable<
    Parameters<typeof fetchNpmPackageTargetStatus>[0]["runCommand"]
  >;

  let versionByTag: Record<string, string | null>;
  let runCommand: NpmMetadataCommandRunner;
  let runCommandMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    versionByTag = {};
    runCommandMock = vi.fn(async (argv: string[]) => {
      const spec = argv[2] ?? "";
      const tag = spec.slice(spec.lastIndexOf("@") + 1);
      const version = versionByTag[tag] ?? null;
      return {
        stdout:
          version == null
            ? ""
            : JSON.stringify({
                version,
                "engines.node": ">=22.19.0",
              }),
        stderr: version == null ? "npm ERR! 404 Not Found" : "",
        code: version == null ? 1 : 0,
      };
    });
    runCommand = runCommandMock as unknown as NpmMetadataCommandRunner;
  });

  it("delegates package target metadata to npm view with global config scope", async () => {
    versionByTag.latest = "1.0.4";
    const env = { ...process.env, NPM_CONFIG_USERCONFIG: "/tmp/openclaw-user-npmrc" };

    await expect(
      fetchNpmPackageTargetStatus({
        target: "latest",
        spec: "openclaw@latest",
        command: "/opt/openclaw/node/bin/npm",
        timeoutMs: 1000,
        cwd: "/tmp/openclaw-project",
        env,
        runCommand,
      }),
    ).resolves.toEqual({
      target: "latest",
      version: "1.0.4",
      nodeEngine: ">=22.19.0",
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      [
        "/opt/openclaw/node/bin/npm",
        "view",
        "openclaw@latest",
        "version",
        "engines.node",
        "openclaw.schemaVersions",
        "--json",
        "--global",
      ],
      expect.objectContaining({
        timeoutMs: 1000,
        cwd: "/tmp/openclaw-project",
        env,
      }),
    );
  });

  it("normalizes npm 12 singleton-array metadata", async () => {
    const npm12RunCommand = vi.fn(async () => ({
      stdout: JSON.stringify([
        {
          version: "2026.7.1",
          engines: { node: ">=22.22.3" },
          openclaw: { schemaVersions: { state: 3, agent: 11 } },
        },
      ]),
      stderr: "",
      code: 0,
    }));

    await expect(
      fetchNpmPackageTargetStatus({
        target: "latest",
        timeoutMs: 1000,
        runCommand: npm12RunCommand,
      }),
    ).resolves.toEqual({
      target: "latest",
      version: "2026.7.1",
      nodeEngine: ">=22.22.3",
      schemaVersions: { state: 3, agent: 11 },
    });
  });

  it("uses npm global scope, user config auth, and ignores project npmrc for real metadata", async () => {
    await withTestDir({ prefix: "openclaw-update-check-npm-view-" }, async (base) => {
      const requests: Array<{ url: string; authorization?: string }> = [];
      const server = http.createServer((req, res) => {
        requests.push({
          url: req.url ?? "",
          authorization: req.headers.authorization,
        });
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            name: "openclaw",
            "dist-tags": { latest: "2026.6.6" },
            versions: {
              "2026.6.6": {
                name: "openclaw",
                version: "2026.6.6",
                engines: { node: ">=22.19.0" },
                dist: {
                  tarball: "http://example.invalid/openclaw-2026.6.6.tgz",
                  shasum: "0".repeat(40),
                },
              },
            },
          }),
        );
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      try {
        const address = server.address() as AddressInfo;
        const registry = `http://127.0.0.1:${address.port}/user/`;
        const project = path.join(base, "project");
        const home = path.join(base, "home");
        const userConfig = path.join(home, ".npmrc");
        await fs.mkdir(project, { recursive: true });
        await fs.mkdir(home, { recursive: true });
        await fs.writeFile(path.join(project, ".npmrc"), "registry=http://127.0.0.1:9/project/\n");
        await fs.writeFile(
          userConfig,
          [`registry=${registry}`, `//127.0.0.1:${address.port}/user/:_authToken=test-token`].join(
            "\n",
          ),
        );

        await expect(
          fetchNpmPackageTargetStatus({
            target: "latest",
            command: "npm",
            timeoutMs: 10_000,
            cwd: project,
            env: {
              ...process.env,
              HOME: home,
              NPM_CONFIG_USERCONFIG: userConfig,
            },
          }),
        ).resolves.toEqual({
          target: "latest",
          version: "2026.6.6",
          nodeEngine: ">=22.19.0",
        });

        expect(requests.some((request) => request.url.startsWith("/user/openclaw"))).toBe(true);
        expect(requests.some((request) => request.url.startsWith("/project/"))).toBe(false);
        expect(requests.some((request) => request.authorization === "Bearer test-token")).toBe(
          true,
        );
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });
  });

  it("uses the public registry when no npm command is available", async () => {
    mockHttp.intercept({
      url: "https://registry.npmjs.org/openclaw/latest",
      reply: {
        json: {
          version: "2026.6.8",
          engines: { node: ">=22.19.0" },
        },
      },
    });

    await expect(
      fetchNpmPackageTargetStatus({ target: "latest", timeoutMs: 1000 }),
    ).resolves.toEqual({
      target: "latest",
      version: "2026.6.8",
      nodeEngine: ">=22.19.0",
    });
  });

  it("times out when the public registry response body stalls after headers", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
        const signal = init?.signal;
        if (!signal) {
          throw new Error("missing registry request signal");
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              signal.addEventListener("abort", () => controller.error(signal.reason), {
                once: true,
              });
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const resultPromise = Promise.race([
        fetchNpmPackageTargetStatus({ target: "latest", timeoutMs: 50 }),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("registry response body exceeded timeoutMs")), 2000);
        }),
      ]);
      await vi.advanceTimersByTimeAsync(2000);

      await expect(resultPromise).resolves.toMatchObject({
        target: "latest",
        version: null,
        nodeEngine: null,
        error: "TimeoutError: request timed out",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://registry.npmjs.org/openclaw/latest",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("cancels public registry HTTP failure bodies", async () => {
    const cancel = vi.spyOn(ReadableStream.prototype, "cancel");
    mockHttp.intercept({
      url: "https://registry.npmjs.org/openclaw/latest",
      reply: { status: 503, body: "unavailable" },
    });

    await expect(
      fetchNpmPackageTargetStatus({ target: "latest", timeoutMs: 1000 }),
    ).resolves.toEqual({
      target: "latest",
      version: null,
      nodeEngine: null,
      error: "HTTP 503",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("returns error on oversized public registry response exceeding 16 MiB", async () => {
    const ONE_MIB = 1024 * 1024;
    mockHttp.intercept({
      url: "https://registry.npmjs.org/openclaw/latest",
      reply: {
        body: Buffer.alloc(16 * ONE_MIB + 1, 0x41),
        headers: { "content-type": "application/json" },
      },
    });

    const result = await fetchNpmPackageTargetStatus({ target: "latest", timeoutMs: 5000 });
    expect(result.version).toBeNull();
    expect(result.nodeEngine).toBeNull();
    expect(result.error).toContain("JSON response exceeds");
    expect(result.error).toContain("16777216");
  });

  it("parses a valid public registry response just under 16 MiB", async () => {
    const targetSize = 16 * 1024 * 1024 - 1024; // just under 16 MiB
    const innerLen = targetSize - 14; // '{"version":"'.length(12) + '"}"'.length(2)
    const body = `{"version":"${"0".repeat(innerLen)}"}`;

    mockHttp.intercept({
      url: "https://registry.npmjs.org/openclaw/latest",
      reply: { body, headers: { "content-type": "application/json" } },
    });

    const result = await fetchNpmPackageTargetStatus({ target: "latest", timeoutMs: 5000 });
    // The version field is a giant string — it exists, confirming parse succeeded
    expect(result.version).toContain("0");
    expect(result.nodeEngine).toBeNull();
    expect(result.error).toBeUndefined();
  });

  it("returns error on malformed JSON from registry", async () => {
    mockHttp.intercept({
      url: "https://registry.npmjs.org/openclaw/latest",
      reply: {
        body: "not-json-at-all{{{",
        headers: { "content-type": "application/json" },
      },
    });

    const result = await fetchNpmPackageTargetStatus({ target: "latest", timeoutMs: 1000 });
    expect(result.version).toBeNull();
    expect(result.error).toContain("malformed JSON");
  });

  it("returns error on non-200 status from registry", async () => {
    mockHttp.intercept({
      url: "https://registry.npmjs.org/openclaw/latest",
      reply: { status: 404 },
    });

    const result = await fetchNpmPackageTargetStatus({ target: "latest", timeoutMs: 1000 });
    expect(result.version).toBeNull();
    expect(result.error).toBe("HTTP 404");
  });

  it("falls back to latest when beta is older", async () => {
    versionByTag.beta = "1.0.0-beta.1";
    versionByTag.latest = "1.0.1-1";

    const resolved = await resolveNpmChannelTag({ channel: "beta", timeoutMs: 1000, runCommand });

    expect(resolved).toEqual({ tag: "latest", version: "1.0.1-1" });
  });

  it("keeps beta when beta is not older", async () => {
    versionByTag.beta = "1.0.2-beta.1";
    versionByTag.latest = "1.0.1-1";

    const resolved = await resolveNpmChannelTag({ channel: "beta", timeoutMs: 1000, runCommand });

    expect(resolved).toEqual({ tag: "beta", version: "1.0.2-beta.1" });
  });

  it("falls back to latest when beta has same base as stable", async () => {
    versionByTag.beta = "1.0.1-beta.2";
    versionByTag.latest = "1.0.1";

    const resolved = await resolveNpmChannelTag({ channel: "beta", timeoutMs: 1000, runCommand });

    expect(resolved).toEqual({ tag: "latest", version: "1.0.1" });
  });

  it("keeps non-beta channels unchanged", async () => {
    versionByTag.latest = "1.0.3";

    await expect(
      resolveNpmChannelTag({ channel: "stable", timeoutMs: 1000, runCommand }),
    ).resolves.toEqual({
      tag: "latest",
      version: "1.0.3",
    });
  });

  it("fetches registry tag versions and reports missing tags", async () => {
    versionByTag.latest = "1.0.4";
    await expect(
      fetchNpmTagVersion({ tag: "latest", timeoutMs: 1000, runCommand }),
    ).resolves.toEqual({ tag: "latest", version: "1.0.4" });
    await expect(
      fetchNpmTagVersion({ tag: "missing", timeoutMs: 1000, runCommand }),
    ).resolves.toEqual({
      tag: "missing",
      version: null,
      error: "npm view failed: npm ERR! 404 Not Found",
    });
  });

  it("adds context to malformed npm view JSON errors", async () => {
    const badRunCommand = vi.fn(async () => ({
      stdout: "not valid json {",
      stderr: "",
      code: 0,
    }));

    const result = await fetchNpmPackageTargetStatus({
      target: "openclaw",
      timeoutMs: 1000,
      runCommand: badRunCommand as unknown as typeof runCommandWithTimeout,
    });

    expect(result.version).toBeNull();
    expect(result.nodeEngine).toBeNull();
    expect(result.error).toContain("npm view returned invalid JSON");
    expect(result.error).toContain("SyntaxError");
  });
});

describe("resolveExtendedStablePackage", () => {
  it("resolves and verifies an exact public package without falling back", async () => {
    mockHttp.intercept({
      url: "https://registry.npmjs.org/openclaw/extended-stable",
      reply: { json: { version: "2026.6.33" } },
    });
    mockHttp.intercept({
      url: "https://registry.npmjs.org/openclaw/2026.6.33",
      reply: { json: { version: "2026.6.33" } },
    });

    await expect(
      resolveExtendedStablePackage({ installKind: "package", timeoutMs: 1000, env: {} }),
    ).resolves.toEqual({
      status: "resolved",
      selector: "extended-stable",
      version: "2026.6.33",
      packageSpec: "openclaw@2026.6.33",
    });
  });

  it("supports an explicit scoped-package override on a loopback test registry", async () => {
    mockHttp.intercept({
      url: "http://127.0.0.1:4873/%40kevins8%2Fopenclaw/extended-stable",
      reply: { json: { version: "2000.4.34" } },
    });
    mockHttp.intercept({
      url: "http://127.0.0.1:4873/%40kevins8%2Fopenclaw/2000.4.34",
      reply: { json: { version: "2000.4.34" } },
    });

    await expect(
      resolveExtendedStablePackage({
        installKind: "package",
        timeoutMs: 1000,
        packageName: "@kevins8/openclaw",
        env: {
          OPENCLAW_UPDATE_PACKAGE_SPEC: "@kevins8/openclaw",
          NPM_CONFIG_REGISTRY: "http://127.0.0.1:4873/",
        },
      }),
    ).resolves.toEqual({
      status: "resolved",
      selector: "extended-stable",
      version: "2000.4.34",
      packageSpec: "@kevins8/openclaw@2000.4.34",
    });
  });

  it("ignores package overrides that do not use a loopback registry", async () => {
    mockHttp.intercept({
      url: "https://registry.npmjs.org/openclaw/extended-stable",
      reply: { json: { version: "2026.6.33" } },
    });
    mockHttp.intercept({
      url: "https://registry.npmjs.org/openclaw/2026.6.33",
      reply: { json: { version: "2026.6.33" } },
    });

    await expect(
      resolveExtendedStablePackage({
        installKind: "package",
        timeoutMs: 1000,
        packageName: "@kevins8/openclaw",
        env: {
          OPENCLAW_UPDATE_PACKAGE_SPEC: "@kevins8/openclaw",
          NPM_CONFIG_REGISTRY: "https://registry.example.com/",
        },
      }),
    ).resolves.toMatchObject({
      status: "resolved",
      packageSpec: "openclaw@2026.6.33",
    });
  });

  it("returns selector_missing for an absent public selector", async () => {
    mockHttp.intercept({
      url: "https://registry.npmjs.org/openclaw/extended-stable",
      reply: { status: 404, body: "not found" },
    });

    await expect(
      resolveExtendedStablePackage({ installKind: "package", timeoutMs: 1000 }),
    ).resolves.toEqual({ status: "failed", reason: "selector_missing" });
  });

  it("returns selector_query_failed for unusable selector metadata", async () => {
    mockHttp.intercept({
      url: "https://registry.npmjs.org/openclaw/extended-stable",
      reply: { body: "{", headers: { "content-type": "application/json" } },
    });

    await expect(
      resolveExtendedStablePackage({ installKind: "package", timeoutMs: 1000 }),
    ).resolves.toEqual({ status: "failed", reason: "selector_query_failed" });
  });

  it("returns exact_package_mismatch when exact readback differs", async () => {
    mockHttp.intercept({
      url: "https://registry.npmjs.org/openclaw/extended-stable",
      reply: { json: { version: "2026.6.33" } },
    });
    mockHttp.intercept({
      url: "https://registry.npmjs.org/openclaw/2026.6.33",
      reply: { json: { version: "2026.6.34" } },
    });

    await expect(
      resolveExtendedStablePackage({ installKind: "package", timeoutMs: 1000 }),
    ).resolves.toEqual({ status: "failed", reason: "exact_package_mismatch" });
    expect(mockHttp.requests().map((request) => request.fullUrl)).not.toContain(
      "https://registry.npmjs.org/openclaw/latest",
    );
  });

  it("rejects Git installs before making a registry request", async () => {
    await expect(
      resolveExtendedStablePackage({ installKind: "git", timeoutMs: 1000 }),
    ).resolves.toEqual({ status: "failed", reason: "unsupported_git_channel" });
    expect(mockHttp.requests()).toHaveLength(0);
  });
});

describe("formatGitInstallLabel", () => {
  it("formats branch, detached tag, and non-git installs", () => {
    expect(
      formatGitInstallLabel({
        root: "/repo",
        installKind: "git",
        packageManager: "pnpm",
        git: {
          root: "/repo",
          sha: "1234567890abcdef",
          tag: null,
          branch: "main",
          upstream: "origin/main",
          dirty: false,
          ahead: 0,
          behind: 0,
          fetchOk: true,
        },
      }),
    ).toBe("main · @ 12345678");

    expect(
      formatGitInstallLabel({
        root: "/repo",
        installKind: "git",
        packageManager: "pnpm",
        git: {
          root: "/repo",
          sha: "abcdef1234567890",
          tag: "v1.2.3",
          branch: "HEAD",
          upstream: null,
          dirty: false,
          ahead: 0,
          behind: 0,
          fetchOk: null,
        },
      }),
    ).toBe("detached · tag v1.2.3 · @ abcdef12");

    expect(
      formatGitInstallLabel({
        root: null,
        installKind: "package",
        packageManager: "pnpm",
      }),
    ).toBeNull();
  });
});

describe("checkUpdateStatus registry behavior", () => {
  it.each([
    { channel: "stable", tag: "latest" },
    { channel: "beta", tag: "beta" },
    { channel: "dev", tag: "dev" },
  ] as const)("preserves $channel registry failures in status", async ({ channel, tag }) => {
    for (const queryTag of channel === "beta" ? ["beta", "latest"] : [tag]) {
      mockHttp.intercept({
        url: `https://registry.npmjs.org/openclaw/${queryTag}`,
        reply: { status: 503, body: "unavailable" },
      });
    }

    const status = await checkUpdateStatus({
      root: null,
      includeRegistry: true,
      registryChannel: channel,
      timeoutMs: 1000,
    });

    expect(status.registry).toEqual({ latestVersion: null, tag, error: "HTTP 503" });
  });

  it.each(["beta", "latest"])(
    "uses the available beta-channel target when %s fails",
    async (failedTag) => {
      const selectedTag = failedTag === "beta" ? "latest" : "beta";
      for (const tag of ["beta", "latest"]) {
        mockHttp.intercept({
          url: `https://registry.npmjs.org/openclaw/${tag}`,
          reply:
            tag === failedTag
              ? { status: 503, body: "unavailable" }
              : { json: { version: "2026.6.6" } },
        });
      }

      const status = await checkUpdateStatus({
        root: null,
        includeRegistry: true,
        registryChannel: "beta",
        timeoutMs: 1000,
      });

      expect(status.registry).toEqual({ latestVersion: "2026.6.6", tag: selectedTag });
    },
  );

  it("reports unsupported_git_channel for Git status without querying npm", async () => {
    await withTestDir({ prefix: "openclaw-update-check-git-channel-" }, async (root) => {
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", packageManager: "pnpm@12.0.0" }),
        "utf8",
      );
      await runCommandWithTimeout(["git", "init"], { cwd: root, timeoutMs: 1000 });
      const status = await checkUpdateStatus({
        root,
        includeRegistry: true,
        registryChannel: "extended-stable",
        fetchGit: false,
        timeoutMs: 1000,
      });

      expect(status.registry).toEqual({
        latestVersion: null,
        tag: "extended-stable",
        error: "unsupported_git_channel",
        reason: "unsupported_git_channel",
      });
      expect(mockHttp.requests()).toHaveLength(0);
    });
  });
});
