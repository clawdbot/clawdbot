// Doctor repairs delegate both missing and stale dashboard assets to their owner.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const mocks = vi.hoisted(() => ({
  root: "",
  ensureControlUiAssetsBuilt: vi.fn(),
  note: vi.fn(),
  runCommandWithTimeout: vi.fn(),
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));
vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: vi.fn(async () => mocks.root),
  resolveOpenClawPackageRootSync: vi.fn(() => mocks.root),
}));
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: mocks.runCommandWithTimeout }));
vi.mock("../infra/control-ui-assets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/control-ui-assets.js")>()),
  ensureControlUiAssetsBuilt: mocks.ensureControlUiAssetsBuilt,
}));

import { maybeRepairUiProtocolFreshness } from "./doctor-ui.js";

const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

function createPrompter(): DoctorPrompter {
  return {
    confirmAutoFix: vi.fn(async () => true),
    confirmAggressiveAutoFix: vi.fn(async () => true),
  } as unknown as DoctorPrompter;
}

describe("Control UI doctor repair owner", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-ui-repair-"));
    await fs.mkdir(path.join(mocks.root, "ui"), { recursive: true });
    await fs.writeFile(path.join(mocks.root, "ui", "package.json"), "{}");
    mocks.ensureControlUiAssetsBuilt.mockImplementation(async (_runtime, opts) => {
      opts.onBuildStart?.();
      return { ok: true, built: true };
    });
    mocks.runCommandWithTimeout.mockResolvedValue({
      stdout: "abc123 protocol schema changed\n",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });
  });

  afterEach(async () => {
    await fs.rm(mocks.root, { recursive: true, force: true });
  });

  it("uses the canonical asset owner for missing UI assets", async () => {
    const prompter = createPrompter();

    await maybeRepairUiProtocolFreshness(runtime, prompter);

    expect(prompter.confirmAutoFix).toHaveBeenCalledOnce();
    expect(prompter.confirmAggressiveAutoFix).not.toHaveBeenCalled();
    expect(mocks.ensureControlUiAssetsBuilt).toHaveBeenCalledWith(runtime, {
      root: mocks.root,
      force: false,
      onBuildStart: expect.any(Function),
    });
    expect(mocks.note).toHaveBeenCalledWith("UI build complete.", "UI");
  });

  it("repairs an existing dashboard whose startup JavaScript is missing", async () => {
    const indexPath = path.join(mocks.root, "dist", "control-ui", "index.html");
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.writeFile(indexPath, '<script src="./assets/startup.js"></script>');
    const prompter = createPrompter();

    await maybeRepairUiProtocolFreshness(runtime, prompter);

    expect(prompter.confirmAutoFix).toHaveBeenCalledOnce();
    expect(mocks.ensureControlUiAssetsBuilt).toHaveBeenCalledWith(runtime, {
      root: mocks.root,
      force: false,
      onBuildStart: expect.any(Function),
    });
    expect(mocks.runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("advises reinstalling incomplete packaged bundles without attempting a source build", async () => {
    const indexPath = path.join(mocks.root, "dist", "control-ui", "index.html");
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.writeFile(indexPath, '<script src="./assets/startup.js"></script>');
    await fs.rm(path.join(mocks.root, "ui", "package.json"));

    await maybeRepairUiProtocolFreshness(runtime, createPrompter());

    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Reinstall OpenClaw to restore bundled Control UI assets."),
      "UI",
    );
    expect(mocks.ensureControlUiAssetsBuilt).not.toHaveBeenCalled();
  });

  it("forces the canonical owner to rebuild stale existing assets", async () => {
    const indexPath = path.join(mocks.root, "dist", "control-ui", "index.html");
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.writeFile(indexPath, "<html></html>");
    const prompter = createPrompter();

    await maybeRepairUiProtocolFreshness(runtime, prompter);

    expect(prompter.confirmAutoFix).not.toHaveBeenCalled();
    expect(prompter.confirmAggressiveAutoFix).toHaveBeenCalledOnce();
    expect(mocks.ensureControlUiAssetsBuilt).toHaveBeenCalledWith(runtime, {
      root: mocks.root,
      force: true,
      onBuildStart: expect.any(Function),
    });
    expect(mocks.note).toHaveBeenCalledWith("UI rebuild complete.", "UI");
  });

  it("reports owner-normalized build failures instead of claiming repair success", async () => {
    mocks.ensureControlUiAssetsBuilt.mockResolvedValueOnce({
      ok: false,
      built: false,
      message: "Control UI build failed: spawn ENOENT",
    });

    await maybeRepairUiProtocolFreshness(runtime, createPrompter());

    expect(mocks.note).toHaveBeenCalledWith("Control UI build failed: spawn ENOENT", "UI");
    expect(mocks.note).not.toHaveBeenCalledWith("UI build complete.", "UI");
  });
});
