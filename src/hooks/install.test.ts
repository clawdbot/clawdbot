// Hook install tests cover archive extraction, validation, and install records.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import * as tar from "tar";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { expectSingleNpmPackIgnoreScriptsCall } from "../test-utils/exec-assertions.js";
import {
  expectInstallUsesIgnoreScripts,
  expectIntegrityDriftRejected,
  expectUnsupportedNpmSpec,
  mockNpmPackMetadataResult,
} from "../test-utils/npm-spec-install-test-helpers.js";
import { isAddressInUseError } from "./gmail-watcher-errors.js";

type InstallHooksFromPath = typeof import("./install.js").installHooksFromPath;

const runCommandWithTimeoutMock = vi.fn();
const scanPackageInstallSourceMock = vi.fn();
const scanInstalledPackageDependencyTreeMock = vi.fn();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("../plugins/install-security-scan.js", () => ({
  scanPackageInstallSource: (...args: unknown[]) => scanPackageInstallSourceMock(...args),
  scanInstalledPackageDependencyTree: (...args: unknown[]) =>
    scanInstalledPackageDependencyTreeMock(...args),
}));

vi.resetModules();

const { HOOK_INSTALL_ERROR_CODE, installHooksFromNpmSpec, installHooksFromPath } =
  await import("./install.js");
const hookInstallRuntime = await import("./install.runtime.js");

const fixtureRoot = path.join(process.cwd(), ".tmp", `openclaw-hook-install-${randomUUID()}`);
const sharedArchiveDir = path.join(fixtureRoot, "_archives");
let tempDirIndex = 0;
const sharedArchivePathByName = new Map<string, string>();

const fixturesDir = path.resolve(process.cwd(), "test", "fixtures", "hooks-install");
const zipHooksBuffer = await createZipHookPackBuffer({
  packageName: "@openclaw/zip-hooks",
  hookName: "zip-hook",
  hookDescription: "Zip hook",
  heading: "Zip Hook",
});
const zipTraversalBuffer = await createZipBuffer([{ path: "../pwned.txt", contents: "pwned" }]);
const tarHooksBuffer = fs.readFileSync(path.join(fixturesDir, "tar-hooks.tar"));
const tarTraversalBuffer = fs.readFileSync(path.join(fixturesDir, "tar-traversal.tar"));
const tarEvilIdBuffer = fs.readFileSync(path.join(fixturesDir, "tar-evil-id.tar"));
const tarReservedIdBuffer = fs.readFileSync(path.join(fixturesDir, "tar-reserved-id.tar"));
const npmPackHooksBuffer = await createTarGzHookPackBuffer({
  packageName: "@openclaw/test-hooks",
  hookName: "one-hook",
  hookDescription: "One hook",
  heading: "One Hook",
});

function makeTempDir() {
  const dir = path.join(fixtureRoot, `case-${tempDirIndex++}`);
  fs.mkdirSync(dir);
  return dir;
}

afterAll(() => {
  try {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
});

beforeEach(() => {
  runCommandWithTimeoutMock.mockReset();
  scanPackageInstallSourceMock.mockReset();
  scanPackageInstallSourceMock.mockResolvedValue(undefined);
  scanInstalledPackageDependencyTreeMock.mockReset();
  scanInstalledPackageDependencyTreeMock.mockResolvedValue(undefined);
});

beforeAll(() => {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.mkdirSync(sharedArchiveDir, { recursive: true });
});

function writeArchiveFixture(params: { fileName: string; contents: Buffer }) {
  const stateDir = makeTempDir();
  const archiveHash = createHash("sha256").update(params.contents).digest("hex").slice(0, 12);
  const archiveKey = `${params.fileName}:${archiveHash}`;
  let archivePath = sharedArchivePathByName.get(archiveKey);
  if (!archivePath) {
    archivePath = path.join(sharedArchiveDir, `${archiveHash}-${params.fileName}`);
    fs.writeFileSync(archivePath, params.contents);
    sharedArchivePathByName.set(archiveKey, archivePath);
  }
  return {
    stateDir,
    archivePath,
    hooksDir: path.join(stateDir, "hooks"),
  };
}

function expectInstallFailureContains(
  result: Awaited<ReturnType<InstallHooksFromPath>>,
  snippets: string[],
) {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected install failure");
  }
  for (const snippet of snippets) {
    expect(result.error).toContain(snippet);
  }
}

function writeHookPackManifest(params: {
  pkgDir: string;
  hooks: string[];
  dependencies?: Record<string, string>;
  extensions?: string[];
}) {
  fs.writeFileSync(
    path.join(params.pkgDir, "package.json"),
    JSON.stringify({
      name: "@openclaw/test-hooks",
      version: "0.0.1",
      openclaw: {
        hooks: params.hooks,
        ...(params.extensions ? { extensions: params.extensions } : {}),
      },
      ...(params.dependencies ? { dependencies: params.dependencies } : {}),
    }),
    "utf-8",
  );
}

async function createZipBuffer(entries: Array<{ path: string; contents: string }>) {
  const zip = new JSZip();
  for (const entry of entries) {
    zip.file(entry.path, entry.contents);
  }
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer", compression: "STORE" }));
}

function writeHookPackFiles(params: {
  pkgDir: string;
  packageName: string;
  hookName: string;
  hookDescription: string;
  heading: string;
}) {
  writeHookPackManifest({
    pkgDir: params.pkgDir,
    hooks: [`./hooks/${params.hookName}`],
  });
  const hookDir = path.join(params.pkgDir, "hooks", params.hookName);
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(
    path.join(hookDir, "HOOK.md"),
    [
      "---",
      `name: ${params.hookName}`,
      `description: ${params.hookDescription}`,
      'metadata: {"openclaw":{"events":["command:new"]}}',
      "---",
      "",
      `# ${params.heading}`,
    ].join("\n"),
    "utf-8",
  );
  fs.writeFileSync(path.join(hookDir, "handler.ts"), "export default async () => {};\n", "utf-8");

  const manifestPath = path.join(params.pkgDir, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
  manifest.name = params.packageName;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf-8");
}

async function createZipHookPackBuffer(params: {
  packageName: string;
  hookName: string;
  hookDescription: string;
  heading: string;
}) {
  const packageJson = JSON.stringify({
    name: params.packageName,
    version: "0.0.1",
    openclaw: { hooks: [`./hooks/${params.hookName}`] },
  });
  return createZipBuffer([
    { path: "package/package.json", contents: packageJson },
    {
      path: `package/hooks/${params.hookName}/HOOK.md`,
      contents: [
        "---",
        `name: ${params.hookName}`,
        `description: ${params.hookDescription}`,
        'metadata: {"openclaw":{"events":["command:new"]}}',
        "---",
        "",
        `# ${params.heading}`,
      ].join("\n"),
    },
    {
      path: `package/hooks/${params.hookName}/handler.ts`,
      contents: "export default async () => {};\n",
    },
  ]);
}

async function createTarGzHookPackBuffer(params: {
  packageName: string;
  hookName: string;
  hookDescription: string;
  heading: string;
}) {
  const workDir = path.join(fixtureRoot, "_generated", `pack-${randomUUID()}`);
  const packageDir = path.join(workDir, "package");
  fs.mkdirSync(packageDir, { recursive: true });
  writeHookPackFiles({ pkgDir: packageDir, ...params });
  const archivePath = path.join(workDir, "pack.tgz");
  await tar.c({ cwd: workDir, file: archivePath, gzip: true }, ["package"]);
  return fs.readFileSync(archivePath);
}

async function installArchiveFixture(params: { fileName: string; contents: Buffer }) {
  const fixture = writeArchiveFixture(params);
  const result = await installHooksFromPath({
    path: fixture.archivePath,
    hooksDir: fixture.hooksDir,
  });
  return { fixture, result };
}

function expectPathInstallFailureContains(
  result: Awaited<ReturnType<InstallHooksFromPath>>,
  snippet: string,
) {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected install failure");
  }
  expect(result.error).toContain(snippet);
}

describe("installHooksFromPath archives", () => {
  it.each([
    {
      name: "zip",
      fileName: "hooks.zip",
      contents: zipHooksBuffer,
      expectedPackId: "zip-hooks",
      expectedHook: "zip-hook",
    },
    {
      name: "tar",
      fileName: "hooks.tar",
      contents: tarHooksBuffer,
      expectedPackId: "tar-hooks",
      expectedHook: "tar-hook",
    },
  ])("installs hook packs from $name archives", async (tc) => {
    const { fixture, result } = await installArchiveFixture({
      fileName: tc.fileName,
      contents: tc.contents,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.hookPackId).toBe(tc.expectedPackId);
    expect(result.hooks).toContain(tc.expectedHook);
    expect(result.targetDir).toBe(path.join(fixture.stateDir, "hooks", tc.expectedPackId));
    expect(fs.existsSync(path.join(result.targetDir, "hooks", tc.expectedHook, "HOOK.md"))).toBe(
      true,
    );
  });

  it.each([
    {
      name: "zip",
      fileName: "traversal.zip",
      contents: zipTraversalBuffer,
      expectedDetail: "archive entry",
    },
    {
      name: "tar",
      fileName: "traversal.tar",
      contents: tarTraversalBuffer,
      expectedDetail: "escapes destination",
    },
  ])("rejects $name archives with traversal entries", async (tc) => {
    const { result } = await installArchiveFixture({
      fileName: tc.fileName,
      contents: tc.contents,
    });
    expectInstallFailureContains(result, ["failed to extract archive", tc.expectedDetail]);
  });

  it.each([
    {
      name: "traversal-like ids",
      contents: tarEvilIdBuffer,
    },
    {
      name: "reserved ids",
      contents: tarReservedIdBuffer,
    },
  ])("rejects hook packs with $name", async (tc) => {
    const { result } = await installArchiveFixture({
      fileName: "hooks.tar",
      contents: tc.contents,
    });
    expectInstallFailureContains(result, ["reserved path segment"]);
  });
});

describe("installHooksFromPath", () => {
  it.each([
    {
      openclaw: {},
      error: "package.json missing openclaw.hooks",
      code: HOOK_INSTALL_ERROR_CODE.MISSING_OPENCLAW_HOOKS,
    },
    {
      openclaw: { hooks: [] },
      error: "package.json openclaw.hooks is empty",
      code: HOOK_INSTALL_ERROR_CODE.EMPTY_OPENCLAW_HOOKS,
    },
  ])("returns a stable code for $error", async ({ openclaw, error, code }) => {
    const pkgDir = makeTempDir();
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "@openclaw/test-hooks", openclaw }),
    );

    const result = await installHooksFromPath({ path: pkgDir, hooksDir: makeTempDir() });

    expect(result).toEqual({ ok: false, error, code });
  });

  it("uses --ignore-scripts for dependency install", async () => {
    const workDir = makeTempDir();
    const stateDir = makeTempDir();
    const pkgDir = path.join(workDir, "package");
    fs.mkdirSync(path.join(pkgDir, "hooks", "one-hook"), { recursive: true });
    writeHookPackManifest({
      pkgDir,
      hooks: ["./hooks/one-hook"],
      dependencies: { "left-pad": "1.3.0" },
    });
    fs.writeFileSync(
      path.join(pkgDir, "hooks", "one-hook", "HOOK.md"),
      [
        "---",
        "name: one-hook",
        "description: One hook",
        'metadata: {"openclaw":{"events":["command:new"]}}',
        "---",
        "",
        "# One Hook",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pkgDir, "hooks", "one-hook", "handler.ts"),
      "export default async () => {};\n",
      "utf-8",
    );

    const run = runCommandWithTimeoutMock;
    await expectInstallUsesIgnoreScripts({
      run,
      install: async () =>
        await installHooksFromPath({
          path: pkgDir,
          hooksDir: path.join(stateDir, "hooks"),
        }),
    });
  });

  it("installs a single hook directory", async () => {
    const stateDir = makeTempDir();
    const workDir = makeTempDir();
    const hookDir = path.join(workDir, "my-hook");
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(
      path.join(hookDir, "HOOK.md"),
      [
        "---",
        "name: my-hook",
        "description: My hook",
        'metadata: {"openclaw":{"events":["command:new"]}}',
        "---",
        "",
        "# My Hook",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(path.join(hookDir, "handler.ts"), "export default async () => {};\n");

    const hooksDir = path.join(stateDir, "hooks");
    const result = await installHooksFromPath({ path: hookDir, hooksDir });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.hookPackId).toBe("my-hook");
    expect(result.hooks).toEqual(["my-hook"]);
    expect(result.packageKind).toBe("hook-only");
    expect(result.targetDir).toBe(path.join(stateDir, "hooks", "my-hook"));
    expect(fs.existsSync(path.join(result.targetDir, "HOOK.md"))).toBe(true);
    expect(scanPackageInstallSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        packageDir: hookDir,
        pluginId: "my-hook",
        extensions: ["handler.ts"],
      }),
    );
  });

  it("blocks a staged single hook before publishing the target", async () => {
    const stateDir = makeTempDir();
    const workDir = makeTempDir();
    const hookDir = path.join(workDir, "my-hook");
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(path.join(hookDir, "HOOK.md"), "---\nname: my-hook\n---\n", "utf8");
    fs.writeFileSync(path.join(hookDir, "handler.ts"), "export default async () => {};\n");
    scanInstalledPackageDependencyTreeMock.mockResolvedValue({
      blocked: {
        code: "security_scan_blocked",
        reason: "blocked staged hook",
      },
    });

    const hooksDir = path.join(stateDir, "hooks");
    const result = await installHooksFromPath({ path: hookDir, hooksDir });

    expect(result).toEqual({
      ok: false,
      code: "security_scan_blocked",
      error: "blocked staged hook",
    });
    expect(scanInstalledPackageDependencyTreeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "install",
        pluginId: "my-hook",
        requestKind: "plugin-dir",
      }),
    );
    const scanCall = scanInstalledPackageDependencyTreeMock.mock.calls[0]?.[0] as {
      packageDir?: string;
    };
    expect(scanCall.packageDir).toContain(".openclaw-install-stage-");
    expect(fs.existsSync(path.join(hooksDir, "my-hook"))).toBe(false);
  });

  it("rejects an oversized HOOK.md to prevent OOM during frontmatter parsing", async () => {
    const stateDir = makeTempDir();
    const workDir = makeTempDir();
    const hookDir = path.join(workDir, "my-hook");
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(path.join(hookDir, "HOOK.md"), "x".repeat(1024 * 1024 + 1), "utf8");
    fs.writeFileSync(path.join(hookDir, "handler.ts"), "export default async () => {};\n");

    await expect(
      installHooksFromPath({ path: hookDir, hooksDir: path.join(stateDir, "hooks") }),
    ).rejects.toThrow(/File exceeds 1048576 bytes/);
  });

  it.runIf(process.platform !== "win32")("rejects a symlinked HOOK.md", async () => {
    const stateDir = makeTempDir();
    const workDir = makeTempDir();
    const hookDir = path.join(workDir, "my-hook");
    const externalHookMd = path.join(workDir, "external-HOOK.md");
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(externalHookMd, "---\nname: external\n---\n", "utf8");
    fs.symlinkSync(externalHookMd, path.join(hookDir, "HOOK.md"), "file");
    fs.writeFileSync(path.join(hookDir, "handler.ts"), "export default async () => {};\n");

    await expect(
      installHooksFromPath({ path: hookDir, hooksDir: path.join(stateDir, "hooks") }),
    ).rejects.toThrow(/path must be a regular file/);
  });

  it("classifies hook packages that also declare plugin extensions", async () => {
    const stateDir = makeTempDir();
    const pkgDir = makeTempDir();
    const hookDir = path.join(pkgDir, "hooks", "one-hook");
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(path.join(hookDir, "HOOK.md"), "---\nname: one-hook\n---\n", "utf8");
    fs.writeFileSync(path.join(hookDir, "handler.ts"), "export default async () => {};\n");
    writeHookPackManifest({
      pkgDir,
      hooks: ["./hooks/one-hook"],
      extensions: ["./dist/index.js"],
    });

    const result = await installHooksFromPath({
      path: pkgDir,
      hooksDir: path.join(stateDir, "hooks"),
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.packageKind).toBe("plugin-capable");
  });

  it.each([".codex-plugin/plugin.json", "hooks/hooks.json", "openclaw.plugin.json"])(
    "classifies hook packages with bundle marker %s as plugin-capable",
    async (bundleMarker) => {
      const stateDir = makeTempDir();
      const pkgDir = makeTempDir();
      const hookDir = path.join(pkgDir, "hooks", "one-hook");
      fs.mkdirSync(hookDir, { recursive: true });
      fs.writeFileSync(path.join(hookDir, "HOOK.md"), "---\nname: one-hook\n---\n", "utf8");
      fs.writeFileSync(path.join(hookDir, "handler.ts"), "export default async () => {};\n");
      writeHookPackManifest({
        pkgDir,
        hooks: ["./hooks/one-hook"],
      });
      const markerPath = path.join(pkgDir, bundleMarker);
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, "{}\n", "utf8");

      const hooksDir = path.join(stateDir, "hooks");
      const result = await installHooksFromPath({
        path: pkgDir,
        hooksDir,
        dryRun: true,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.packageKind).toBe("plugin-capable");
      const rejected = await installHooksFromPath({
        path: pkgDir,
        hooksDir,
        expectedPackageKind: "hook-only",
      });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) {
        return;
      }
      expect(rejected.error).toContain("hook package kind mismatch");
      expect(fs.existsSync(path.join(hooksDir, "test-hooks"))).toBe(false);
    },
  );

  it("enforces install policy with the validated hook identity before local install side effects", async () => {
    const stateDir = makeTempDir();
    const pkgDir = makeTempDir();
    writeHookPackFiles({
      pkgDir,
      packageName: "@acme/canonical-hooks",
      hookName: "one-hook",
      hookDescription: "One hook",
      heading: "One Hook",
    });
    scanPackageInstallSourceMock.mockResolvedValue({
      blocked: {
        code: "security_scan_blocked",
        reason: "blocked by operator install policy",
      },
    });

    const hooksDir = path.join(stateDir, "hooks");
    const result = await installHooksFromPath({
      path: pkgDir,
      hooksDir,
      config: { security: { installPolicy: { enabled: true } } },
      mode: "update",
    });

    expect(result).toEqual({
      ok: false,
      code: "security_scan_blocked",
      error: "blocked by operator install policy",
    });
    expect(scanPackageInstallSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        packageDir: pkgDir,
        pluginId: "canonical-hooks",
        packageName: "@acme/canonical-hooks",
        version: "0.0.1",
        extensions: ["./hooks/one-hook"],
        mode: "install",
        requestKind: "plugin-dir",
        requestedSpecifier: pkgDir,
        source: {
          kind: "local-path",
          authority: "user",
          mutable: true,
          network: false,
        },
      }),
    );
    expect(fs.existsSync(path.join(hooksDir, "canonical-hooks"))).toBe(false);
  });

  it("reports update policy mode only when the hook target already exists", async () => {
    const stateDir = makeTempDir();
    const pkgDir = makeTempDir();
    writeHookPackFiles({
      pkgDir,
      packageName: "@acme/canonical-hooks",
      hookName: "one-hook",
      hookDescription: "One hook",
      heading: "One Hook",
    });
    const hooksDir = path.join(stateDir, "hooks");
    fs.mkdirSync(path.join(hooksDir, "canonical-hooks"), { recursive: true });

    const result = await installHooksFromPath({
      path: pkgDir,
      hooksDir,
      mode: "update",
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(scanPackageInstallSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "update",
        pluginId: "canonical-hooks",
      }),
    );
  });

  it("inspects hook package kind without running install policy or target availability checks", async () => {
    const stateDir = makeTempDir();
    const pkgDir = makeTempDir();
    writeHookPackFiles({
      pkgDir,
      packageName: "@acme/canonical-hooks",
      hookName: "one-hook",
      hookDescription: "One hook",
      heading: "One Hook",
    });
    const hooksDir = path.join(stateDir, "hooks");
    const ensureInstallTargetAvailableSpy = vi.spyOn(
      hookInstallRuntime,
      "ensureInstallTargetAvailable",
    );

    try {
      const result = await installHooksFromPath({
        path: pkgDir,
        hooksDir,
        inspection: "package-kind",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.packageKind).toBe("hook-only");
      expect(scanPackageInstallSourceMock).not.toHaveBeenCalled();
      expect(ensureInstallTargetAvailableSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(hooksDir)).toBe(false);
    } finally {
      ensureInstallTargetAvailableSpy.mockRestore();
    }
  });

  it("inspects a bare hook package kind without creating the hooks directory", async () => {
    const stateDir = makeTempDir();
    const workDir = makeTempDir();
    const hookDir = path.join(workDir, "my-hook");
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(path.join(hookDir, "HOOK.md"), "---\nname: my-hook\n---\n", "utf8");
    fs.writeFileSync(path.join(hookDir, "handler.ts"), "export default async () => {};\n");
    const hooksDir = path.join(stateDir, "hooks");

    const result = await installHooksFromPath({
      path: hookDir,
      hooksDir,
      inspection: "package-kind",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.packageKind).toBe("hook-only");
    expect(result.targetDir).toBe(path.join(hooksDir, "my-hook"));
    expect(fs.existsSync(hooksDir)).toBe(false);
  });

  it("enforces archive install policy against the validated extracted hook package", async () => {
    const { stateDir, archivePath } = writeArchiveFixture({
      fileName: "policy-hooks.zip",
      contents: zipHooksBuffer,
    });
    let scannedExtractedPackage = false;
    scanPackageInstallSourceMock.mockImplementation(async (params: { packageDir: string }) => {
      scannedExtractedPackage =
        params.packageDir !== archivePath &&
        fs.existsSync(path.join(params.packageDir, "package.json"));
      return {
        blocked: {
          code: "security_scan_blocked",
          reason: "blocked extracted hook package",
        },
      };
    });

    const hooksDir = path.join(stateDir, "hooks");
    const result = await installHooksFromPath({
      path: archivePath,
      hooksDir,
    });

    expect(result).toEqual({
      ok: false,
      code: "security_scan_blocked",
      error: "blocked extracted hook package",
    });
    expect(scannedExtractedPackage).toBe(true);
    expect(scanPackageInstallSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "zip-hooks",
        requestKind: "plugin-archive",
        requestedSpecifier: archivePath,
        source: {
          kind: "archive",
          authority: "user",
          mutable: true,
          network: false,
        },
      }),
    );
    expect(fs.existsSync(path.join(hooksDir, "zip-hooks"))).toBe(false);
  });

  it("fails closed when hook install policy evaluation throws", async () => {
    const stateDir = makeTempDir();
    const pkgDir = makeTempDir();
    writeHookPackFiles({
      pkgDir,
      packageName: "@acme/canonical-hooks",
      hookName: "one-hook",
      hookDescription: "One hook",
      heading: "One Hook",
    });
    scanPackageInstallSourceMock.mockRejectedValue(new Error("policy runner unavailable"));

    const result = await installHooksFromPath({
      path: pkgDir,
      hooksDir: path.join(stateDir, "hooks"),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe("security_scan_failed");
    expect(result.error).toContain("policy runner unavailable");
  });

  it("blocks materialized hook dependencies before publishing the target", async () => {
    const stateDir = makeTempDir();
    const pkgDir = makeTempDir();
    writeHookPackFiles({
      pkgDir,
      packageName: "@acme/canonical-hooks",
      hookName: "one-hook",
      hookDescription: "One hook",
      heading: "One Hook",
    });
    const manifestPath = path.join(pkgDir, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.dependencies = { "blocked-transitive": "1.0.0" };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
    runCommandWithTimeoutMock.mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
      signal: null,
      killed: false,
      termination: "exit",
    });
    scanInstalledPackageDependencyTreeMock.mockResolvedValue({
      blocked: {
        code: "security_scan_blocked",
        reason: "blocked materialized dependency tree",
      },
    });

    const hooksDir = path.join(stateDir, "hooks");
    const result = await installHooksFromPath({
      path: pkgDir,
      hooksDir,
    });

    expect(result).toEqual({
      ok: false,
      code: "security_scan_blocked",
      error: "blocked materialized dependency tree",
    });
    expect(scanInstalledPackageDependencyTreeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "install",
        pluginId: "canonical-hooks",
        requestKind: "plugin-dir",
      }),
    );
    const scanCall = scanInstalledPackageDependencyTreeMock.mock.calls[0]?.[0] as {
      packageDir?: string;
    };
    expect(scanCall.packageDir).toContain(".openclaw-install-stage-");
    expect(fs.existsSync(path.join(hooksDir, "canonical-hooks"))).toBe(false);
  });

  it("rejects out-of-package hook entries", async () => {
    const cases = [
      {
        hooks: ["../outside"],
        setupLink: false,
        expected: "openclaw.hooks entry escapes package directory",
      },
      {
        hooks: ["./linked"],
        setupLink: true,
        expected: "openclaw.hooks entry resolves outside package directory",
      },
    ] as const;

    for (const testCase of cases) {
      const stateDir = makeTempDir();
      const workDir = makeTempDir();
      const pkgDir = path.join(workDir, "package");
      const outsideHookDir = path.join(workDir, "outside");
      const linkedDir = path.join(pkgDir, "linked");
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.mkdirSync(outsideHookDir, { recursive: true });
      fs.writeFileSync(path.join(outsideHookDir, "HOOK.md"), "---\nname: outside\n---\n", "utf-8");
      fs.writeFileSync(
        path.join(outsideHookDir, "handler.ts"),
        "export default async () => {};\n",
        "utf-8",
      );
      if (testCase.setupLink) {
        try {
          fs.symlinkSync(
            outsideHookDir,
            linkedDir,
            process.platform === "win32" ? "junction" : "dir",
          );
        } catch {
          continue;
        }
      }
      writeHookPackManifest({
        pkgDir,
        hooks: [...testCase.hooks],
      });

      const result = await installHooksFromPath({
        path: pkgDir,
        hooksDir: path.join(stateDir, "hooks"),
      });

      expectPathInstallFailureContains(result, testCase.expected);
    }
  });
});

describe("installHooksFromNpmSpec", () => {
  it("forwards npm install policy metadata through extracted archive validation", async () => {
    const installFromValidatedNpmSpecArchiveSpy = vi
      .spyOn(hookInstallRuntime, "installFromValidatedNpmSpecArchive")
      .mockImplementation(
        async (
          params: Parameters<typeof hookInstallRuntime.installFromValidatedNpmSpecArchive>[0],
        ) => {
          expect(
            (params.archiveInstallParams as Record<string, unknown>).dangerouslyForceUnsafeInstall,
          ).toBeUndefined();
          expect(params.archiveInstallParams).toEqual(
            expect.objectContaining({
              installPolicyRequest: {
                kind: "plugin-npm",
                requestedSpecifier: "@openclaw/test-hooks@0.0.1",
                source: {
                  kind: "npm",
                  authority: "third-party",
                  mutable: false,
                  network: true,
                },
              },
            }),
          );
          return {
            ok: true,
            hookPackId: "test-hooks",
            hooks: ["one-hook"],
            targetDir: "/tmp/hooks/test-hooks",
            version: "0.0.1",
          };
        },
      );

    try {
      const result = await installHooksFromNpmSpec({
        spec: "@openclaw/test-hooks@0.0.1",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.hookPackId).toBe("test-hooks");
    } finally {
      installFromValidatedNpmSpecArchiveSpy.mockRestore();
    }
  });

  it("uses --ignore-scripts for npm pack and cleans up temp dir", async () => {
    const stateDir = makeTempDir();

    const run = runCommandWithTimeoutMock;
    let packTmpDir = "";
    const packedName = "test-hooks-0.0.1.tgz";
    run.mockImplementation(async (argv, opts) => {
      if (argv[0] === "npm" && argv[1] === "pack") {
        packTmpDir = typeof opts === "number" ? "" : (opts.cwd ?? "");
        fs.writeFileSync(path.join(packTmpDir, packedName), npmPackHooksBuffer);
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              id: "@openclaw/test-hooks@0.0.1",
              name: "@openclaw/test-hooks",
              version: "0.0.1",
              filename: packedName,
              integrity: "sha512-hook-test",
              shasum: "hookshasum",
            },
          ]),
          stderr: "",
          signal: null,
          killed: false,
          termination: "exit",
        };
      }
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    });

    const hooksDir = path.join(stateDir, "hooks");
    const result = await installHooksFromNpmSpec({
      spec: "@openclaw/test-hooks@0.0.1",
      hooksDir,
      logger: { info: () => {}, warn: () => {} },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.hookPackId).toBe("test-hooks");
    expect(result.packageKind).toBe("hook-only");
    expect(result.npmResolution?.resolvedSpec).toBe("@openclaw/test-hooks@0.0.1");
    expect(result.npmResolution?.integrity).toBe("sha512-hook-test");
    expect(fs.existsSync(path.join(result.targetDir, "hooks", "one-hook", "HOOK.md"))).toBe(true);

    expectSingleNpmPackIgnoreScriptsCall({
      calls: run.mock.calls as Array<[unknown, unknown]>,
      expectedSpec: "@openclaw/test-hooks@0.0.1",
    });

    expect(packTmpDir).not.toBe("");
    expect(fs.existsSync(packTmpDir)).toBe(false);
  });

  it("aborts when integrity drift callback rejects the fetched artifact", async () => {
    const run = runCommandWithTimeoutMock;
    mockNpmPackMetadataResult(run, {
      id: "@openclaw/test-hooks@0.0.1",
      name: "@openclaw/test-hooks",
      version: "0.0.1",
      filename: "test-hooks-0.0.1.tgz",
      integrity: "sha512-new",
      shasum: "newshasum",
    });

    const onIntegrityDrift = vi.fn(async () => false);
    const result = await installHooksFromNpmSpec({
      spec: "@openclaw/test-hooks@0.0.1",
      expectedIntegrity: "sha512-old",
      onIntegrityDrift,
    });
    expectIntegrityDriftRejected({
      onIntegrityDrift,
      result,
      expectedIntegrity: "sha512-old",
      actualIntegrity: "sha512-new",
    });
  });

  it("rejects invalid npm spec shapes", async () => {
    await expectUnsupportedNpmSpec((spec) => installHooksFromNpmSpec({ spec }));

    const run = runCommandWithTimeoutMock;
    mockNpmPackMetadataResult(run, {
      id: "@openclaw/test-hooks@0.0.2-beta.1",
      name: "@openclaw/test-hooks",
      version: "0.0.2-beta.1",
      filename: "test-hooks-0.0.2-beta.1.tgz",
      integrity: "sha512-beta",
      shasum: "betashasum",
    });

    const result = await installHooksFromNpmSpec({
      spec: "@openclaw/test-hooks",
      logger: { info: () => {}, warn: () => {} },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("prerelease version 0.0.2-beta.1");
      expect(result.error).toContain('"@openclaw/test-hooks@beta"');
    }
  });
});

describe("gmail watcher", () => {
  it("detects address already in use errors", () => {
    expect(isAddressInUseError("listen tcp 127.0.0.1:8788: bind: address already in use")).toBe(
      true,
    );
    expect(isAddressInUseError("EADDRINUSE: address already in use")).toBe(true);
    expect(isAddressInUseError("some other error")).toBe(false);
  });
});
