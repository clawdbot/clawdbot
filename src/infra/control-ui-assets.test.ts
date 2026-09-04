// Tests Control UI asset discovery and expected bundled files.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

type FakeFsEntry = { kind: "file"; content: string } | { kind: "dir" };

const state = vi.hoisted(() => ({
  entries: new Map<string, FakeFsEntry>(),
  realpaths: new Map<string, string>(),
  runCommandWithTimeout: vi.fn(),
}));

const abs = (p: string) => path.resolve(p);

function setFile(p: string, content = "") {
  state.entries.set(abs(p), { kind: "file", content });
}

function setDir(p: string) {
  state.entries.set(abs(p), { kind: "dir" });
}

vi.mock("./control-ui-assets.fs.runtime.js", async () => {
  const actual = await import("node:fs");
  const pathMod = await import("node:path");
  const absInMock = (p: string) => pathMod.resolve(p);
  const fixturesRoot = `${absInMock("fixtures")}${pathMod.sep}`;
  const isFixturePath = (p: string) => {
    const resolved = absInMock(p);
    return resolved === fixturesRoot.slice(0, -1) || resolved.startsWith(fixturesRoot);
  };
  const readFixtureEntry = (p: string) => state.entries.get(absInMock(p));

  const wrapped = {
    existsSync: (p: string) =>
      isFixturePath(p) ? state.entries.has(absInMock(p)) : actual.existsSync(p),
    readFileSync: (p: string, encoding?: BufferEncoding) => {
      if (!isFixturePath(p)) {
        return actual.readFileSync(p, encoding);
      }
      const entry = readFixtureEntry(p);
      if (entry?.kind === "file") {
        return entry.content;
      }
      throw new Error(`ENOENT: no such file, open '${p}'`);
    },
    statSync: (p: string) => {
      if (!isFixturePath(p)) {
        return actual.statSync(p);
      }
      const entry = readFixtureEntry(p);
      if (entry?.kind === "file") {
        return {
          isFile: () => true,
          isDirectory: () => false,
          size: Buffer.byteLength(entry.content),
        };
      }
      if (entry?.kind === "dir") {
        return { isFile: () => false, isDirectory: () => true };
      }
      throw new Error(`ENOENT: no such file or directory, stat '${p}'`);
    },
    realpathSync: (p: string) =>
      isFixturePath(p)
        ? (state.realpaths.get(absInMock(p)) ?? absInMock(p))
        : actual.realpathSync(p),
  };
  return wrapped;
});

vi.mock("./openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: vi.fn(async () => null),
  resolveOpenClawPackageRootSync: vi.fn(() => null),
}));
vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: state.runCommandWithTimeout,
}));

let ensureControlUiAssetsBuilt: typeof import("./control-ui-assets.js").ensureControlUiAssetsBuilt;
let isControlUiStartupAssetsReady: typeof import("./control-ui-assets.js").isControlUiStartupAssetsReady;
let resolveControlUiAssetHealth: typeof import("./control-ui-assets.js").resolveControlUiAssetHealth;
let isPackageProvenControlUiRootSync: typeof import("./control-ui-assets.js").isPackageProvenControlUiRootSync;
let resolveControlUiRootOverrideSync: typeof import("./control-ui-assets.js").resolveControlUiRootOverrideSync;
let resolveControlUiRootSync: typeof import("./control-ui-assets.js").resolveControlUiRootSync;
let openclawRoot: typeof import("./openclaw-root.js");

describe("control UI assets helpers (fs-mocked)", () => {
  beforeAll(async () => {
    ({
      ensureControlUiAssetsBuilt,
      isControlUiStartupAssetsReady,
      resolveControlUiAssetHealth,
      isPackageProvenControlUiRootSync,
      resolveControlUiRootOverrideSync,
      resolveControlUiRootSync,
    } = await import("./control-ui-assets.js"));
    openclawRoot = await import("./openclaw-root.js");
  });

  beforeEach(() => {
    state.entries.clear();
    state.realpaths.clear();
    state.runCommandWithTimeout.mockReset();
    vi.clearAllMocks();
    vi.mocked(openclawRoot.resolveOpenClawPackageRootSync).mockReset().mockReturnValue(null);
  });

  it("distinguishes unresolved, missing, incomplete, and ready startup bundles", async () => {
    const root = abs("fixtures/health");
    const indexPath = path.join(root, "dist", "control-ui", "index.html");

    await expect(resolveControlUiAssetHealth({ argv1: "" })).resolves.toEqual({
      kind: "missing-index",
      indexPath: null,
    });
    await expect(resolveControlUiAssetHealth({ root })).resolves.toEqual({
      kind: "missing-index",
      indexPath,
    });

    setFile(indexPath, '<script src="./assets/startup.js"></script>');
    await expect(resolveControlUiAssetHealth({ root })).resolves.toEqual({
      kind: "incomplete",
      indexPath,
      missingAsset: "assets/startup.js",
    });

    setFile(path.join(root, "dist", "control-ui", "assets", "startup.js"));
    await expect(resolveControlUiAssetHealth({ root })).resolves.toEqual({
      kind: "ready",
      indexPath,
    });
  });

  it("checks startup integrity against the actual effective first-party root", () => {
    const root = abs("fixtures/effective-resources");
    const indexPath = path.join(root, "index.html");

    expect(isControlUiStartupAssetsReady(root)).toBe(false);

    setFile(indexPath, '<script src="/configured/base/assets/startup.js"></script>');
    expect(isControlUiStartupAssetsReady(root)).toBe(false);

    setFile(path.join(root, "assets", "startup.js"));
    expect(isControlUiStartupAssetsReady(root)).toBe(true);
  });

  it("rejects traversing startup references without inspecting files outside the asset root", () => {
    const root = abs("fixtures/effective-traversal");
    const outsideAsset = path.join(root, "outside.js");
    const indexPath = path.join(root, "index.html");
    setFile(outsideAsset);
    setFile(path.join(root, "assets", "startup.js"));
    const exists = vi.spyOn(state.entries, "has");

    try {
      for (const reference of [
        "assets/../outside.js",
        "../assets/startup.js",
        "/base/../assets/startup.js",
      ]) {
        setFile(indexPath, `<script src="${reference}"></script>`);
        expect(isControlUiStartupAssetsReady(root)).toBe(false);
      }
      expect(exists).not.toHaveBeenCalledWith(outsideAsset);
    } finally {
      exists.mockRestore();
    }
  });

  it("accepts 128 startup references but rejects a larger startup fan-out", () => {
    const root = abs("fixtures/effective-reference-limit");
    const indexPath = path.join(root, "index.html");
    const reference = '<script src="./assets/startup.js"></script>';
    setFile(path.join(root, "assets", "startup.js"));
    setFile(indexPath, reference.repeat(128));
    expect(isControlUiStartupAssetsReady(root)).toBe(true);

    setFile(indexPath, reference.repeat(129));
    expect(isControlUiStartupAssetsReady(root)).toBe(false);
  });

  it("keeps a truncated build failure diagnostic within its UTF-16 limit", async () => {
    const root = abs("fixtures/build-failure");
    const argv1 = path.join(root, "src", "index.ts");
    const originalArgv1 = process.argv[1];
    setFile(path.join(root, "package.json"), '{"name":"openclaw"}\n');
    setFile(path.join(root, "ui", "vite.config.ts"), "export {};\n");
    setFile(path.join(root, "scripts", "ui.js"), "");
    vi.mocked(openclawRoot.resolveOpenClawPackageRootSync).mockReturnValue(root);
    state.runCommandWithTimeout.mockResolvedValueOnce({
      stdout: "",
      stderr: `${"y".repeat(238)}🚀xx`,
      code: 1,
      signal: null,
      killed: false,
      termination: "exit",
    });
    process.argv[1] = argv1;
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const onBuildStart = vi.fn();

    try {
      const result = await ensureControlUiAssetsBuilt(runtime, { root, onBuildStart });

      expect(result).toEqual({
        ok: false,
        built: false,
        message: `Control UI build failed: ${"y".repeat(238)}…`,
      });
      expect(onBuildStart).toHaveBeenCalledOnce();
      expect(runtime.log).not.toHaveBeenCalled();
    } finally {
      if (originalArgv1 === undefined) {
        process.argv.splice(1, 1);
      } else {
        process.argv[1] = originalArgv1;
      }
    }
  });

  it("recognizes macOS packaged assets without trying to build the unused dist root", async () => {
    const root = abs("fixtures/packaged-app");
    const execPath = path.join(root, "OpenClaw.app", "Contents", "MacOS", "OpenClaw");
    const bundledUiDir = path.join(root, "OpenClaw.app", "Contents", "Resources", "control-ui");
    state.realpaths.set(execPath, execPath);
    setFile(path.join(bundledUiDir, "index.html"), "<html>packaged</html>");

    await expect(
      ensureControlUiAssetsBuilt(undefined, {
        argv1: path.join(root, "entry.js"),
        cwd: root,
        execPath,
      }),
    ).resolves.toEqual({ ok: true, built: false });
    expect(state.runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("tells packaged installs to reinstall when their bundled assets are missing", async () => {
    const root = abs("fixtures/packaged-missing");
    const indexPath = path.join(root, "dist", "control-ui", "index.html");

    await expect(
      ensureControlUiAssetsBuilt(undefined, { root, argv1: path.join(root, "dist", "entry.js") }),
    ).resolves.toEqual({
      ok: false,
      built: false,
      message: `Missing Control UI assets at ${indexPath}. Reinstall OpenClaw to restore bundled Control UI assets.`,
    });
  });

  it("rejects a packaged index whose first-party startup asset is missing", async () => {
    const root = abs("fixtures/packaged-incomplete");
    const indexPath = path.join(root, "dist", "control-ui", "index.html");
    setFile(indexPath, '<html><script type="module" src="./assets/startup.js"></script></html>');

    await expect(ensureControlUiAssetsBuilt(undefined, { root })).resolves.toEqual({
      ok: false,
      built: false,
      message: `Incomplete Control UI assets at ${indexPath} (missing assets/startup.js). Reinstall OpenClaw to restore bundled Control UI assets.`,
    });
    expect(state.runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("ignores inline and external startup references in otherwise valid first-party HTML", async () => {
    const root = abs("fixtures/packaged-inline");
    setFile(
      path.join(root, "dist", "control-ui", "index.html"),
      [
        "<script>console.log('inline')</script>",
        '<script src="https://example.invalid/assets/external.js"></script>',
        '<script src="//example.invalid/assets/external.js"></script>',
        '<link href="data:text/css,body{}" rel="stylesheet">',
      ].join(""),
    );

    await expect(ensureControlUiAssetsBuilt(undefined, { root })).resolves.toEqual({
      ok: true,
      built: false,
    });
  });

  it("does not read oversized first-party index documents as healthy", async () => {
    const root = abs("fixtures/packaged-oversized");
    const uiRoot = path.join(root, "dist", "control-ui");
    setFile(path.join(uiRoot, "index.html"), "x".repeat(256 * 1024));
    expect(isControlUiStartupAssetsReady(uiRoot)).toBe(true);

    setFile(path.join(uiRoot, "index.html"), "x".repeat(256 * 1024 + 1));

    await expect(ensureControlUiAssetsBuilt(undefined, { root })).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        message: expect.stringContaining("index.html exceeds its size limit"),
      }),
    );
  });

  it("builds the source checkout selected by canonical package-root discovery", async () => {
    const packagedRoot = abs("fixtures/package-owner");
    const checkoutRoot = abs("fixtures/checkout-owner");
    const indexPath = path.join(checkoutRoot, "dist", "control-ui", "index.html");
    setFile(path.join(checkoutRoot, "ui", "vite.config.ts"));
    setFile(path.join(checkoutRoot, "scripts", "ui.js"));
    vi.mocked(openclawRoot.resolveOpenClawPackageRootSync).mockImplementation((options) =>
      options.moduleUrl ? packagedRoot : checkoutRoot,
    );
    state.runCommandWithTimeout.mockImplementationOnce(async () => {
      setFile(indexPath);
      return { stdout: "", stderr: "", code: 0, signal: null, killed: false, termination: "exit" };
    });

    const runtime = { log: vi.fn<RuntimeEnv["log"]>(), error: vi.fn(), exit: vi.fn() };
    await expect(
      ensureControlUiAssetsBuilt(runtime, {
        argv1: path.join(packagedRoot, "dist", "entry.js"),
        cwd: checkoutRoot,
      }),
    ).resolves.toEqual({ ok: true, built: true });
    const message = runtime.log.mock.calls.flat().join("\n");
    const commands = [...message.matchAll(/`(pnpm [^`]+)`/gu)].map((match) => match[1]);
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command).toContain(checkoutRoot);
      expect(command).not.toContain(packagedRoot);
    }
    expect(state.runCommandWithTimeout).toHaveBeenCalledWith(
      [process.execPath, path.join(checkoutRoot, "scripts", "ui.js"), "build"],
      expect.objectContaining({ cwd: checkoutRoot }),
    );
  });

  it("forces a rebuild of an existing source bundle and forwards cancellation", async () => {
    const root = abs("fixtures/force-build");
    const indexPath = path.join(root, "dist", "control-ui", "index.html");
    const controller = new AbortController();
    setFile(path.join(root, "ui", "vite.config.ts"));
    setFile(path.join(root, "scripts", "ui.js"));
    setFile(indexPath);
    state.runCommandWithTimeout.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });

    await expect(
      ensureControlUiAssetsBuilt(undefined, { root, force: true, signal: controller.signal }),
    ).resolves.toEqual({ ok: true, built: true });
    expect(state.runCommandWithTimeout).toHaveBeenCalledWith(
      [process.execPath, path.join(root, "scripts", "ui.js"), "build"],
      { cwd: root, timeoutMs: 600_000, signal: controller.signal },
    );
  });

  it("rebuilds a source index when a same-origin startup CSS or JavaScript asset is missing", async () => {
    const root = abs("fixtures/source-incomplete");
    const indexPath = path.join(root, "dist", "control-ui", "index.html");
    const scriptPath = path.join(root, "dist", "control-ui", "assets", "startup.js");
    const cssPath = path.join(root, "dist", "control-ui", "assets", "startup.css");
    setFile(path.join(root, "ui", "vite.config.ts"));
    setFile(path.join(root, "scripts", "ui.js"));
    setFile(
      indexPath,
      [
        '<script type="module" src="/configured/base/assets/startup.js?v=1"></script>',
        '<link rel="stylesheet" href="./assets/startup.css#theme">',
      ].join(""),
    );
    state.runCommandWithTimeout.mockImplementationOnce(async () => {
      setFile(scriptPath);
      setFile(cssPath);
      return { stdout: "", stderr: "", code: 0, signal: null, killed: false, termination: "exit" };
    });

    await expect(ensureControlUiAssetsBuilt(undefined, { root })).resolves.toEqual({
      ok: true,
      built: true,
    });
    expect(state.runCommandWithTimeout).toHaveBeenCalledOnce();
  });

  it("normalizes rejected build launches into a bounded failure", async () => {
    const root = abs("fixtures/build-rejection");
    setFile(path.join(root, "ui", "vite.config.ts"));
    setFile(path.join(root, "scripts", "ui.js"));
    state.runCommandWithTimeout.mockRejectedValueOnce(new Error("details\nspawn ENOENT"));

    await expect(ensureControlUiAssetsBuilt(undefined, { root })).resolves.toEqual({
      ok: false,
      built: false,
      message: "Control UI build failed: spawn ENOENT",
    });
  });

  it.each([
    { termination: "signal", message: "Control UI build canceled." },
    { termination: "timeout", message: "Control UI build timed out." },
    { termination: "no-output-timeout", message: "Control UI build timed out." },
  ] as const)("normalizes $termination build termination", async ({ termination, message }) => {
    const root = abs(`fixtures/build-${termination}`);
    setFile(path.join(root, "ui", "vite.config.ts"));
    setFile(path.join(root, "scripts", "ui.js"));
    state.runCommandWithTimeout.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      code: null,
      signal: termination === "signal" ? "SIGTERM" : null,
      killed: true,
      termination,
    });

    await expect(ensureControlUiAssetsBuilt(undefined, { root })).resolves.toEqual({
      ok: false,
      built: false,
      message,
    });
  });

  it("does not launch a build after its signal has already been canceled", async () => {
    const root = abs("fixtures/build-pre-aborted");
    const controller = new AbortController();
    controller.abort();
    setFile(path.join(root, "ui", "vite.config.ts"));
    setFile(path.join(root, "scripts", "ui.js"));

    await expect(
      ensureControlUiAssetsBuilt(undefined, { root, signal: controller.signal }),
    ).resolves.toEqual({ ok: false, built: false, message: "Control UI build canceled." });
    expect(state.runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("rejects a successful build that did not create its index", async () => {
    const root = abs("fixtures/build-without-output");
    setFile(path.join(root, "ui", "vite.config.ts"));
    setFile(path.join(root, "scripts", "ui.js"));
    state.runCommandWithTimeout.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });

    await expect(ensureControlUiAssetsBuilt(undefined, { root })).resolves.toEqual({
      ok: false,
      built: true,
      message: `Control UI build completed but ${path.join(root, "dist", "control-ui", "index.html")} is still missing.`,
    });
  });

  it("rejects a successful build that leaves a referenced startup asset missing", async () => {
    const root = abs("fixtures/build-missing-startup");
    const indexPath = path.join(root, "dist", "control-ui", "index.html");
    setFile(path.join(root, "ui", "vite.config.ts"));
    setFile(path.join(root, "scripts", "ui.js"));
    state.runCommandWithTimeout.mockImplementationOnce(async () => {
      setFile(indexPath, '<html><script src="./assets/main.js"></script></html>');
      return { stdout: "", stderr: "", code: 0, signal: null, killed: false, termination: "exit" };
    });

    await expect(ensureControlUiAssetsBuilt(undefined, { root })).resolves.toEqual({
      ok: false,
      built: true,
      message: "Control UI build completed but startup asset assets/main.js is missing.",
    });
  });

  it("resolves control-ui root from override file or directory", () => {
    const root = abs("fixtures/override");
    const uiDir = path.join(root, "dist", "control-ui");
    const indexPath = path.join(uiDir, "index.html");

    setDir(uiDir);
    setFile(indexPath, "<html></html>\n");

    expect(resolveControlUiRootOverrideSync(uiDir)).toBe(uiDir);
    expect(resolveControlUiRootOverrideSync(indexPath)).toBe(uiDir);
    expect(resolveControlUiRootOverrideSync(path.join(uiDir, "missing.html"))).toBeNull();
  });

  it("resolves control-ui root for dist bundle argv1 and moduleUrl candidates", () => {
    const pkgRoot = abs("fixtures/openclaw-bundle");
    (
      openclawRoot.resolveOpenClawPackageRootSync as unknown as ReturnType<typeof vi.fn>
    ).mockReturnValueOnce(pkgRoot);

    const uiDir = path.join(pkgRoot, "dist", "control-ui");
    setFile(path.join(uiDir, "index.html"), "<html></html>\n");

    // argv1Dir candidate: <argv1Dir>/control-ui
    expect(resolveControlUiRootSync({ argv1: path.join(pkgRoot, "dist", "bundle.js") })).toBe(
      uiDir,
    );

    // moduleUrl candidate: <moduleDir>/control-ui
    const moduleUrl = pathToFileURL(path.join(pkgRoot, "dist", "bundle.js")).toString();
    expect(resolveControlUiRootSync({ moduleUrl })).toBe(uiDir);
  });

  it("prefers packaged app Control UI assets in Contents/Resources", () => {
    const execPath = abs("fixtures/OpenClaw.app/Contents/MacOS/OpenClaw");
    const bundledUiDir = abs("fixtures/OpenClaw.app/Contents/Resources/control-ui");
    setFile(path.join(bundledUiDir, "index.html"), "<html></html>\n");

    state.realpaths.set(execPath, execPath);

    expect(resolveControlUiRootSync({ execPath })).toBe(bundledUiDir);
  });

  it("resolves control-ui root for symlinked argv1 via realpath", () => {
    const pkgRoot = abs("fixtures/bun-global/openclaw");
    const wrapperArgv1 = abs("fixtures/bin/openclaw");
    const realEntrypoint = path.join(pkgRoot, "dist", "index.js");
    const uiDir = path.join(pkgRoot, "dist", "control-ui");

    state.realpaths.set(wrapperArgv1, realEntrypoint);
    setFile(path.join(uiDir, "index.html"), "<html></html>\n");

    expect(resolveControlUiRootSync({ argv1: wrapperArgv1 })).toBe(uiDir);
  });

  it("detects package-proven control-ui roots", () => {
    const pkgRoot = abs("fixtures/openclaw-package-root");
    const uiDir = path.join(pkgRoot, "dist", "control-ui");
    setDir(uiDir);
    setFile(path.join(uiDir, "index.html"), "<html></html>\n");
    (
      openclawRoot.resolveOpenClawPackageRootSync as unknown as ReturnType<typeof vi.fn>
    ).mockReturnValueOnce(pkgRoot);

    expect(
      isPackageProvenControlUiRootSync(uiDir, {
        cwd: abs("fixtures/cwd"),
      }),
    ).toBe(true);
  });

  it("does not treat fallback roots as package-proven", () => {
    const pkgRoot = abs("fixtures/openclaw-package-root");
    const fallbackRoot = abs("fixtures/fallback-root/dist/control-ui");
    setDir(fallbackRoot);
    setFile(path.join(fallbackRoot, "index.html"), "<html></html>\n");
    (
      openclawRoot.resolveOpenClawPackageRootSync as unknown as ReturnType<typeof vi.fn>
    ).mockReturnValueOnce(pkgRoot);

    expect(
      isPackageProvenControlUiRootSync(fallbackRoot, {
        cwd: abs("fixtures/fallback-root"),
      }),
    ).toBe(false);
  });
});
