import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  cleanupTrackedTempDirsAsync,
  makeTrackedTempDirAsync,
} from "./test-helpers/fs-fixtures.js";

const installPluginFromPathMock = vi.fn();
const fetchWithSsrFGuardMock = vi.hoisted(() =>
  vi.fn(async (params: { url: string; init?: RequestInit }) => {
    // Keep unit tests focused on guarded call sites, not AbortSignal timer behavior.
    const { signal: _signal, ...init } = params.init ?? {};
    const response = await fetch(params.url, init);
    return {
      response,
      finalUrl: params.url,
      release: async () => {
        await response.body?.cancel().catch(() => undefined);
      },
    };
  }),
);
const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());
let installPluginFromMarketplace: typeof import("./marketplace.js").installPluginFromMarketplace;
let listMarketplacePlugins: typeof import("./marketplace.js").listMarketplacePlugins;
let resolveMarketplaceInstallShortcut: typeof import("./marketplace.js").resolveMarketplaceInstallShortcut;
const tempOutsideDirs: string[] = [];

vi.mock("./install.js", () => ({
  installPluginFromPath: (...args: unknown[]) => installPluginFromPathMock(...args),
}));

vi.mock("../infra/net/fetch-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/net/fetch-guard.js")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (params: { url: string; init?: RequestInit }) =>
      fetchWithSsrFGuardMock(params),
  };
});

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

beforeAll(async () => {
  ({ installPluginFromMarketplace, listMarketplacePlugins, resolveMarketplaceInstallShortcut } =
    await import("./marketplace.js"));
});

async function listMarketplaceDownloadTempDirs(): Promise<string[]> {
  const entries = await fs.readdir(os.tmpdir(), { withFileTypes: true });
  return entries
    .filter(
      (entry) => entry.isDirectory() && entry.name.startsWith("openclaw-marketplace-download-"),
    )
    .map((entry) => entry.name)
    .toSorted();
}

async function writeMarketplaceManifest(rootDir: string, manifest: unknown): Promise<string> {
  const manifestPath = path.join(rootDir, ".claude-plugin", "marketplace.json");
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  return manifestPath;
}

async function writeRemoteMarketplaceFixture(params: {
  repoDir: string;
  manifest: unknown;
  pluginDir?: string;
  pluginFile?: string;
}) {
  await fs.mkdir(path.join(params.repoDir, ".claude-plugin"), { recursive: true });
  if (params.pluginDir) {
    await fs.mkdir(path.join(params.repoDir, params.pluginDir), { recursive: true });
  }
  if (params.pluginFile) {
    const pluginFilePath = path.join(params.repoDir, params.pluginFile);
    await fs.mkdir(path.dirname(pluginFilePath), { recursive: true });
    await fs.writeFile(pluginFilePath, "plugin fixture");
  }
  await fs.writeFile(
    path.join(params.repoDir, ".claude-plugin", "marketplace.json"),
    JSON.stringify(params.manifest),
  );
}

async function writeLocalMarketplaceFixture(params: {
  rootDir: string;
  manifest: unknown;
  pluginDir?: string;
}) {
  if (params.pluginDir) {
    await fs.mkdir(params.pluginDir, { recursive: true });
  }
  return writeMarketplaceManifest(params.rootDir, params.manifest);
}

function mockRemoteMarketplaceClone(params: {
  manifest: unknown;
  pluginDir?: string;
  pluginFile?: string;
}) {
  runCommandWithTimeoutMock.mockImplementationOnce(async (argv: string[]) => {
    const repoDir = argv.at(-1);
    expect(typeof repoDir).toBe("string");
    await writeRemoteMarketplaceFixture({
      repoDir: repoDir as string,
      manifest: params.manifest,
      ...(params.pluginDir ? { pluginDir: params.pluginDir } : {}),
      ...(params.pluginFile ? { pluginFile: params.pluginFile } : {}),
    });
    return { code: 0, stdout: "", stderr: "", killed: false };
  });
}

function mockRemoteMarketplaceCloneWithOutsideSymlink(params: {
  manifest: unknown;
  symlinkPath: string;
}) {
  runCommandWithTimeoutMock.mockImplementationOnce(async (argv: string[]) => {
    const repoDir = argv.at(-1);
    expect(typeof repoDir).toBe("string");
    await writeRemoteMarketplaceFixture({
      repoDir: repoDir as string,
      manifest: params.manifest,
    });
    const outsideDir = await makeTrackedTempDirAsync(
      "openclaw-marketplace-outside",
      tempOutsideDirs,
    );
    await fs.mkdir(path.dirname(path.join(repoDir as string, params.symlinkPath)), {
      recursive: true,
    });
    await fs.symlink(outsideDir, path.join(repoDir as string, params.symlinkPath));
    return { code: 0, stdout: "", stderr: "", killed: false };
  });
}

async function expectRemoteMarketplaceError(params: { manifest: unknown; expectedError: string }) {
  mockRemoteMarketplaceClone({ manifest: params.manifest });

  const result = await listMarketplacePlugins({ marketplace: "owner/repo" });

  expect(result).toEqual({
    ok: false,
    error: params.expectedError,
  });
  expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
}

function installPluginInput(callIndex = 0): Record<string, unknown> {
  const input = installPluginFromPathMock.mock.calls[callIndex]?.[0];
  expect(typeof input).toBe("object");
  expect(input).not.toBeNull();
  return input as Record<string, unknown>;
}

function fetchGuardInput(callIndex = 0): Record<string, unknown> {
  const input = fetchWithSsrFGuardMock.mock.calls[callIndex]?.[0];
  expect(typeof input).toBe("object");
  expect(input).not.toBeNull();
  return input as Record<string, unknown>;
}

function expectMarketplaceInstallSuccess(
  result: unknown,
  params: {
    pluginId?: string;
    marketplacePlugin?: string;
    marketplaceSource?: string;
  },
) {
  expect(typeof result).toBe("object");
  expect(result).not.toBeNull();
  const record = result as Record<string, unknown>;
  expect(record.ok).toBe(true);
  expect(record.pluginId).toBe(params.pluginId ?? "frontend-design");
  if (params.marketplacePlugin) {
    expect(record.marketplacePlugin).toBe(params.marketplacePlugin);
  }
  if (params.marketplaceSource) {
    expect(record.marketplaceSource).toBe(params.marketplaceSource);
  }
}

function expectRemoteCloneCommand() {
  expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
  const [argv, options] = runCommandWithTimeoutMock.mock.calls[0] ?? [];
  expect(Array.isArray(argv)).toBe(true);
  expect((argv as unknown[]).slice(0, 5)).toEqual([
    "git",
    "clone",
    "--depth",
    "1",
    "https://github.com/owner/repo.git",
  ]);
  expect(typeof (argv as unknown[])[5]).toBe("string");
  expect(options).toEqual({ timeoutMs: 120_000 });
}

function expectFetchDownloadCall(url = "https://example.com/frontend-design.tgz") {
  const input = fetchGuardInput();
  expect(input.url).toBe(url);
  expect(input.timeoutMs).toBe(120_000);
  expect(input.auditContext).toBe("marketplace-plugin-download");
}

function expectRemoteMarketplaceInstallResult(result: unknown) {
  expectRemoteCloneCommand();
  expect(String(installPluginInput().path)).toMatch(/[\\/]repo[\\/]plugins[\\/]frontend-design$/);
  expectMarketplaceInstallSuccess(result, {
    marketplacePlugin: "frontend-design",
    marketplaceSource: "owner/repo",
  });
}

function expectMarketplaceManifestListing(
  result: Awaited<ReturnType<typeof import("./marketplace.js").listMarketplacePlugins>>,
) {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("expected marketplace listing to succeed");
  }
  expect(result.sourceLabel.replaceAll("\\", "/")).toContain(".claude-plugin/marketplace.json");
  expect(result.manifest).toEqual({
    name: "Example Marketplace",
    version: "1.0.0",
    plugins: [
      {
        name: "frontend-design",
        version: "0.1.0",
        description: "Design system bundle",
        source: { kind: "path", path: "./plugins/frontend-design" },
      },
    ],
  });
}

function expectLocalMarketplaceInstallResult(params: {
  result: unknown;
  pluginDir: string;
  marketplaceSource: string;
}) {
  expect(installPluginInput().path).toBe(params.pluginDir);
  expectMarketplaceInstallSuccess(params.result, {
    marketplacePlugin: "frontend-design",
    marketplaceSource: params.marketplaceSource,
  });
}

describe("marketplace plugins", () => {
  afterEach(async () => {
    fetchWithSsrFGuardMock.mockClear();
    installPluginFromPathMock.mockReset();
    runCommandWithTimeoutMock.mockReset();
    vi.unstubAllGlobals();
    await cleanupTrackedTempDirsAsync(tempOutsideDirs);
  });

  it("lists plugins from a local marketplace root", async () => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      await writeMarketplaceManifest(rootDir, {
        name: "Example Marketplace",
        version: "1.0.0",
        plugins: [
          {
            name: "frontend-design",
            version: "0.1.0",
            description: "Design system bundle",
            source: "./plugins/frontend-design",
          },
        ],
      });

      expectMarketplaceManifestListing(await listMarketplacePlugins({ marketplace: rootDir }));
    });
  });

  it("resolves relative plugin paths against the marketplace root", async () => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      const pluginDir = path.join(rootDir, "plugins", "frontend-design");
      const manifestPath = await writeLocalMarketplaceFixture({
        rootDir,
        pluginDir,
        manifest: {
          plugins: [
            {
              name: "frontend-design",
              source: "./plugins/frontend-design",
            },
          ],
        },
      });
      installPluginFromPathMock.mockResolvedValue({
        ok: true,
        pluginId: "frontend-design",
        targetDir: "/tmp/frontend-design",
        version: "0.1.0",
        extensions: ["index.ts"],
      });

      const result = await installPluginFromMarketplace({
        marketplace: manifestPath,
        plugin: "frontend-design",
      });

      expectLocalMarketplaceInstallResult({
        result,
        pluginDir,
        marketplaceSource: path.join(rootDir, ".claude-plugin", "marketplace.json"),
      });
    });
  });

  it("preserves the logical local install path instead of canonicalizing it", async () => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      const canonicalRootDir = await fs.realpath(rootDir);
      const pluginDir = path.join(rootDir, "plugins", "frontend-design");
      const canonicalPluginDir = path.join(canonicalRootDir, "plugins", "frontend-design");
      const manifestPath = await writeLocalMarketplaceFixture({
        rootDir,
        pluginDir,
        manifest: {
          plugins: [
            {
              name: "frontend-design",
              source: "./plugins/frontend-design",
            },
          ],
        },
      });
      installPluginFromPathMock.mockResolvedValue({
        ok: true,
        pluginId: "frontend-design",
        targetDir: "/tmp/frontend-design",
        version: "0.1.0",
        extensions: ["index.ts"],
      });

      const result = await installPluginFromMarketplace({
        marketplace: manifestPath,
        plugin: "frontend-design",
      });

      expectLocalMarketplaceInstallResult({
        result,
        pluginDir,
        marketplaceSource: manifestPath,
      });
      if (canonicalPluginDir !== pluginDir) {
        expect(
          installPluginFromPathMock.mock.calls.some(
            ([input]) => (input as { path?: unknown } | undefined)?.path === canonicalPluginDir,
          ),
        ).toBe(false);
      }
    });
  });

  it("passes dangerous force unsafe install through to marketplace path installs", async () => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      const pluginDir = path.join(rootDir, "plugins", "frontend-design");
      const manifestPath = await writeLocalMarketplaceFixture({
        rootDir,
        pluginDir,
        manifest: {
          plugins: [
            {
              name: "frontend-design",
              source: "./plugins/frontend-design",
            },
          ],
        },
      });
      installPluginFromPathMock.mockResolvedValue({
        ok: true,
        pluginId: "frontend-design",
        targetDir: "/tmp/frontend-design",
        version: "0.1.0",
        extensions: ["index.ts"],
      });

      await installPluginFromMarketplace({
        marketplace: manifestPath,
        plugin: "frontend-design",
        dangerouslyForceUnsafeInstall: true,
      });

      expect(installPluginInput().path).toBe(pluginDir);
      expect(installPluginInput().dangerouslyForceUnsafeInstall).toBe(true);
    });
  });

  it("resolves Claude-style plugin@marketplace shortcuts from known_marketplaces.json", async () => {
    await withTempDir("openclaw-marketplace-test-", async (homeDir) => {
      const openClawHome = path.join(homeDir, "openclaw-home");
      await fs.mkdir(path.join(homeDir, ".claude", "plugins"), { recursive: true });
      await fs.mkdir(openClawHome, { recursive: true });
      await fs.writeFile(
        path.join(homeDir, ".claude", "plugins", "known_marketplaces.json"),
        JSON.stringify({
          "claude-plugins-official": {
            source: {
              source: "github",
              repo: "anthropics/claude-plugins-official",
            },
            installLocation: path.join(homeDir, ".claude", "plugins", "marketplaces", "official"),
          },
        }),
      );

      const shortcut = await withEnvAsync(
        { HOME: homeDir, OPENCLAW_HOME: openClawHome },
        async () => await resolveMarketplaceInstallShortcut("superpowers@claude-plugins-official"),
      );

      expect(shortcut).toEqual({
        ok: true,
        plugin: "superpowers",
        marketplaceName: "claude-plugins-official",
        marketplaceSource: "claude-plugins-official",
      });
    });
  });

  it("installs remote marketplace plugins from relative paths inside the cloned repo", async () => {
    mockRemoteMarketplaceClone({
      pluginDir: path.join("plugins", "frontend-design"),
      manifest: {
        plugins: [
          {
            name: "frontend-design",
            source: "./plugins/frontend-design",
          },
        ],
      },
    });
    installPluginFromPathMock.mockResolvedValue({
      ok: true,
      pluginId: "frontend-design",
      targetDir: "/tmp/frontend-design",
      version: "0.1.0",
      extensions: ["index.ts"],
    });

    const result = await installPluginFromMarketplace({
      marketplace: "owner/repo",
      plugin: "frontend-design",
    });

    expectRemoteMarketplaceInstallResult(result);
  });

  it("preserves remote marketplace file path sources inside the cloned repo", async () => {
    mockRemoteMarketplaceClone({
      pluginFile: path.join("plugins", "frontend-design.tgz"),
      manifest: {
        plugins: [
          {
            name: "frontend-design",
            source: "./plugins/frontend-design.tgz",
          },
        ],
      },
    });
    installPluginFromPathMock.mockResolvedValue({
      ok: true,
      pluginId: "frontend-design",
      targetDir: "/tmp/frontend-design",
      version: "0.1.0",
      extensions: ["index.ts"],
    });

    const result = await installPluginFromMarketplace({
      marketplace: "owner/repo",
      plugin: "frontend-design",
    });

    expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
    expect(String(installPluginInput().path)).toMatch(
      /[\\/]repo[\\/]plugins[\\/]frontend-design\.tgz$/,
    );
    expectMarketplaceInstallSuccess(result, {
      marketplacePlugin: "frontend-design",
      marketplaceSource: "owner/repo",
    });
  });

  it("lists remote marketplace file path sources inside the cloned repo", async () => {
    mockRemoteMarketplaceClone({
      pluginFile: path.join("plugins", "frontend-design.tgz"),
      manifest: {
        plugins: [
          {
            name: "frontend-design",
            source: "./plugins/frontend-design.tgz",
          },
        ],
      },
    });

    const result = await listMarketplacePlugins({ marketplace: "owner/repo" });

    expect(result).toEqual({
      ok: true,
      manifest: {
        name: undefined,
        version: undefined,
        plugins: [
          {
            name: "frontend-design",
            description: undefined,
            version: undefined,
            source: {
              kind: "path",
              path: "./plugins/frontend-design.tgz",
            },
          },
        ],
      },
      sourceLabel: "owner/repo",
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects remote marketplace plugin paths that resolve through symlinks outside the cloned repo",
    async () => {
      mockRemoteMarketplaceCloneWithOutsideSymlink({
        symlinkPath: "plugins/evil-link",
        manifest: {
          plugins: [
            {
              name: "frontend-design",
              source: "./plugins/evil-link",
            },
          ],
        },
      });

      const result = await installPluginFromMarketplace({
        marketplace: "owner/repo",
        plugin: "frontend-design",
      });

      expect(result).toEqual({
        ok: false,
        error:
          'invalid marketplace entry "frontend-design" in owner/repo: ' +
          "plugin source escapes marketplace root: ./plugins/evil-link",
      });
      expect(installPluginFromPathMock).not.toHaveBeenCalled();
    },
  );

  it("returns a structured error for archive downloads with an empty response body", async () => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      const release = vi.fn(async () => undefined);
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: new Response(null, { status: 200 }),
        finalUrl: "https://example.com/frontend-design.tgz",
        release,
      });
      const manifestPath = await writeMarketplaceManifest(rootDir, {
        plugins: [
          {
            name: "frontend-design",
            source: "https://example.com/frontend-design.tgz",
          },
        ],
      });

      const result = await installPluginFromMarketplace({
        marketplace: manifestPath,
        plugin: "frontend-design",
      });

      expect(result).toEqual({
        ok: false,
        error: "failed to download https://example.com/frontend-design.tgz: empty response body",
      });
      expectFetchDownloadCall();
      expect(installPluginFromPathMock).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
    });
  });

  it("returns a structured error for invalid archive URLs", async () => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      const manifestPath = await writeMarketplaceManifest(rootDir, {
        plugins: [
          {
            name: "frontend-design",
            source: "https://%/frontend-design.tgz",
          },
        ],
      });

      const result = await installPluginFromMarketplace({
        marketplace: manifestPath,
        plugin: "frontend-design",
      });

      expect(result).toEqual({
        ok: false,
        error: "failed to download https://%/frontend-design.tgz: Invalid URL",
      });
      expect(installPluginFromPathMock).not.toHaveBeenCalled();
      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    });
  });

  it("rejects Windows drive-relative archive filenames from redirects", async () => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: new Response(new Blob([Buffer.from("tgz-bytes")]), {
          status: 200,
        }),
        finalUrl: "https://cdn.example.com/C:plugin.tgz",
        release: vi.fn(async () => undefined),
      });
      const manifestPath = await writeMarketplaceManifest(rootDir, {
        plugins: [
          {
            name: "frontend-design",
            source: "https://example.com/frontend-design.tgz",
          },
        ],
      });

      const result = await installPluginFromMarketplace({
        marketplace: manifestPath,
        plugin: "frontend-design",
      });

      expect(result).toEqual({
        ok: false,
        error:
          "failed to download https://example.com/frontend-design.tgz: invalid download filename",
      });
      expect(installPluginFromPathMock).not.toHaveBeenCalled();
    });
  });

  it("falls back to the default archive timeout when the caller passes NaN", async () => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: new Response(new Blob([Buffer.from("tgz-bytes")]), {
          status: 200,
        }),
        finalUrl: "https://cdn.example.com/releases/12345",
        release: vi.fn(async () => undefined),
      });
      installPluginFromPathMock.mockResolvedValue({
        ok: true,
        pluginId: "frontend-design",
        targetDir: "/tmp/frontend-design",
        version: "0.1.0",
        extensions: ["index.ts"],
      });
      const manifestPath = await writeMarketplaceManifest(rootDir, {
        plugins: [
          {
            name: "frontend-design",
            source: "https://example.com/frontend-design.tgz",
          },
        ],
      });

      const result = await installPluginFromMarketplace({
        marketplace: manifestPath,
        plugin: "frontend-design",
        timeoutMs: Number.NaN,
      });

      expectMarketplaceInstallSuccess(result, {
        pluginId: "frontend-design",
      });
      expectFetchDownloadCall();
    });
  });

  it("downloads archive plugin sources through the SSRF guard", async () => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      const release = vi.fn(async () => {
        throw new Error("dispatcher close failed");
      });
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: new Response(new Blob([Buffer.from("tgz-bytes")]), {
          status: 200,
        }),
        finalUrl: "https://cdn.example.com/releases/12345",
        release,
      });
      installPluginFromPathMock.mockResolvedValue({
        ok: true,
        pluginId: "frontend-design",
        targetDir: "/tmp/frontend-design",
        version: "0.1.0",
        extensions: ["index.ts"],
      });
      const manifestPath = await writeMarketplaceManifest(rootDir, {
        plugins: [
          {
            name: "frontend-design",
            source: "https://example.com/frontend-design.tgz",
          },
        ],
      });

      const result = await installPluginFromMarketplace({
        marketplace: manifestPath,
        plugin: "frontend-design",
      });

      expectMarketplaceInstallSuccess(result, {
        marketplacePlugin: "frontend-design",
        marketplaceSource: manifestPath,
      });
      expectFetchDownloadCall();
      expect(String(installPluginInput().path)).toMatch(/[\\/]frontend-design\.tgz$/);
      expect(release).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects non-streaming archive responses before buffering them", async () => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      const arrayBuffer = vi.fn(async () => new Uint8Array([1, 2, 3]).buffer);
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: {
          ok: true,
          status: 200,
          body: {} as Response["body"],
          headers: new Headers(),
          arrayBuffer,
        } as unknown as Response,
        finalUrl: "https://cdn.example.com/releases/frontend-design.tgz",
        release: vi.fn(async () => undefined),
      });
      const manifestPath = await writeMarketplaceManifest(rootDir, {
        plugins: [
          {
            name: "frontend-design",
            source: "https://example.com/frontend-design.tgz",
          },
        ],
      });

      const result = await installPluginFromMarketplace({
        marketplace: manifestPath,
        plugin: "frontend-design",
      });

      expect(result).toEqual({
        ok: false,
        error:
          "failed to download https://example.com/frontend-design.tgz: " +
          "streaming response body unavailable",
      });
      expect(arrayBuffer).not.toHaveBeenCalled();
      expect(installPluginFromPathMock).not.toHaveBeenCalled();
    });
  });

  it("rejects oversized streamed archive responses without falling back to arrayBuffer", async () => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      const arrayBuffer = vi.fn(async () => new Uint8Array([1, 2, 3]).buffer);
      const reader = {
        read: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: {
              length: 256 * 1024 * 1024 + 1,
            } as Uint8Array,
          })
          .mockResolvedValueOnce({ done: true, value: undefined }),
        cancel: vi.fn(async () => undefined),
        releaseLock: vi.fn(),
      };
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: {
          ok: true,
          status: 200,
          body: {
            getReader: () => reader,
          } as unknown as Response["body"],
          headers: new Headers(),
          arrayBuffer,
        } as unknown as Response,
        finalUrl: "https://cdn.example.com/releases/frontend-design.tgz",
        release: vi.fn(async () => undefined),
      });
      const manifestPath = await writeMarketplaceManifest(rootDir, {
        plugins: [
          {
            name: "frontend-design",
            source: "https://example.com/frontend-design.tgz",
          },
        ],
      });

      const result = await installPluginFromMarketplace({
        marketplace: manifestPath,
        plugin: "frontend-design",
      });

      expect(result).toEqual({
        ok: false,
        error:
          "failed to download https://example.com/frontend-design.tgz: " +
          "download too large: 268435457 bytes (limit: 268435456 bytes)",
      });
      expect(arrayBuffer).not.toHaveBeenCalled();
      expect(installPluginFromPathMock).not.toHaveBeenCalled();
    });
  });

  it("cleans up a partial download temp dir when streaming the archive fails", async () => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      const beforeTempDirs = await listMarketplaceDownloadTempDirs();
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: new Response("x".repeat(1024), {
          status: 200,
          headers: {
            "content-length": String(300 * 1024 * 1024),
          },
        }),
        finalUrl: "https://cdn.example.com/releases/frontend-design.tgz",
        release: vi.fn(async () => undefined),
      });
      const manifestPath = await writeMarketplaceManifest(rootDir, {
        plugins: [
          {
            name: "frontend-design",
            source: "https://example.com/frontend-design.tgz",
          },
        ],
      });

      const result = await installPluginFromMarketplace({
        marketplace: manifestPath,
        plugin: "frontend-design",
      });

      expect(result).toEqual({
        ok: false,
        error:
          "failed to download https://example.com/frontend-design.tgz: " +
          "download too large: 314572800 bytes (limit: 268435456 bytes)",
      });
      expect(await listMarketplaceDownloadTempDirs()).toEqual(beforeTempDirs);
      expect(installPluginFromPathMock).not.toHaveBeenCalled();
    });
  });

  it("sanitizes archive download errors before returning them", async () => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      fetchWithSsrFGuardMock.mockRejectedValueOnce(
        new Error(
          "blocked\n\u001b[31mAuthorization: Bearer sk-1234567890abcdefghijklmnop\u001b[0m",
        ),
      );
      const manifestPath = await writeMarketplaceManifest(rootDir, {
        plugins: [
          {
            name: "frontend-design",
            source: "https://user:pass@example.com/frontend-design.tgz",
          },
        ],
      });

      const result = await installPluginFromMarketplace({
        marketplace: manifestPath,
        plugin: "frontend-design",
      });

      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.error).toContain(
        "failed to download https://***:***@example.com/frontend-design.tgz:",
      );
      expect(result.error).toContain("Authorization: Bearer sk-123…mnop");
      expect(result.error).not.toContain("user:pass@");
      let hasControlChars = false;
      for (const char of result.error) {
        const codePoint = char.codePointAt(0);
        if (codePoint != null && (codePoint < 0x20 || codePoint === 0x7f)) {
          hasControlChars = true;
          break;
        }
      }
      expect(hasControlChars).toBe(false);
      expect(installPluginFromPathMock).not.toHaveBeenCalled();
    });
  });

  it("returns a structured error when the SSRF guard rejects an archive URL", async () => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      fetchWithSsrFGuardMock.mockRejectedValueOnce(
        new Error("Blocked hostname (not in allowlist): 169.254.169.254"),
      );
      const manifestPath = await writeMarketplaceManifest(rootDir, {
        plugins: [
          {
            name: "frontend-design",
            source: "https://example.com/frontend-design.tgz",
          },
        ],
      });

      const result = await installPluginFromMarketplace({
        marketplace: manifestPath,
        plugin: "frontend-design",
      });

      expect(result).toEqual({
        ok: false,
        error:
          "failed to download https://example.com/frontend-design.tgz: " +
          "Blocked hostname (not in allowlist): 169.254.169.254",
      });
      expect(installPluginFromPathMock).not.toHaveBeenCalled();
    });
  });

  it.each([
    {
      name: "rejects remote marketplace git plugin sources before cloning nested remotes",
      manifest: {
        plugins: [
          {
            name: "frontend-design",
            source: {
              type: "git",
              url: "https://evil.example/repo.git",
            },
          },
        ],
      },
      expectedError:
        'invalid marketplace entry "frontend-design" in owner/repo: ' +
        "remote marketplaces may not use git plugin sources",
    },
    {
      name: "rejects remote marketplace absolute plugin paths",
      manifest: {
        plugins: [
          {
            name: "frontend-design",
            source: {
              type: "path",
              path: "/tmp/frontend-design",
            },
          },
        ],
      },
      expectedError:
        'invalid marketplace entry "frontend-design" in owner/repo: ' +
        "remote marketplaces may only use relative plugin paths",
    },
    {
      name: "rejects remote marketplace HTTP plugin paths",
      manifest: {
        plugins: [
          {
            name: "frontend-design",
            source: {
              type: "path",
              path: "https://evil.example/plugin.tgz",
            },
          },
        ],
      },
      expectedError:
        'invalid marketplace entry "frontend-design" in owner/repo: ' +
        "remote marketplaces may not use HTTP(S) plugin paths",
    },
  ] as const)("$name", async ({ manifest, expectedError }) => {
    await expectRemoteMarketplaceError({ manifest, expectedError });
  });

  it.runIf(process.platform !== "win32")(
    "rejects remote marketplace symlink plugin paths during manifest validation",
    async () => {
      mockRemoteMarketplaceCloneWithOutsideSymlink({
        symlinkPath: "evil-link",
        manifest: {
          plugins: [
            {
              name: "frontend-design",
              source: {
                type: "path",
                path: "evil-link",
              },
            },
          ],
        },
      });

      const result = await listMarketplacePlugins({ marketplace: "owner/repo" });

      expect(result).toEqual({
        ok: false,
        error:
          'invalid marketplace entry "frontend-design" in owner/repo: ' +
          "plugin source escapes marketplace root: evil-link",
      });
    },
  );

  it("reports missing remote marketplace paths as not found instead of escapes", async () => {
    mockRemoteMarketplaceClone({
      manifest: {
        plugins: [
          {
            name: "frontend-design",
            source: {
              type: "path",
              path: "plugins/missing-plugin",
            },
          },
        ],
      },
    });

    const result = await listMarketplacePlugins({ marketplace: "owner/repo" });

    expect(result).toEqual({
      ok: false,
      error:
        'invalid marketplace entry "frontend-design" in owner/repo: ' +
        "plugin source not found in marketplace root: plugins/missing-plugin",
    });
  });
});
