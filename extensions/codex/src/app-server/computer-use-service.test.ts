// Codex tests cover native Computer Use service provisioning.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureCodexComputerUseServiceApp } from "./computer-use-service.js";
import { resolveMacOSDesktopCodexComputerUseServiceAppCandidates } from "./desktop-app-paths.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";

const CLIENT_RELATIVE_PATH = path.join(
  "Contents",
  "SharedSupport",
  "SkyComputerUseClient.app",
  "Contents",
  "MacOS",
  "SkyComputerUseClient",
);

describe("Codex Computer Use native service", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("installs the official client beneath the isolated Codex home", async () => {
    const root = tempDirs.make("openclaw-computer-use-service-");
    const sourcePath = path.join(root, "source", "Codex Computer Use.app");
    const codexHome = path.join(root, "agent", "codex-home");
    await writeExecutableClient(sourcePath);

    const result = await ensureCodexComputerUseServiceApp({
      codexHome,
      platform: "darwin",
      sourceAppCandidates: [sourcePath],
      copyServiceApp: async (source, target) => await fs.cp(source, target, { recursive: true }),
    });

    expect(result).toMatchObject({ status: "installed", changed: true, sourcePath });
    await expect(
      fs.access(
        path.join(codexHome, "computer-use", "Codex Computer Use.app", CLIENT_RELATIVE_PATH),
      ),
    ).resolves.toBeUndefined();
  });

  it("reuses a complete home-owned client without consulting desktop sources", async () => {
    const root = tempDirs.make("openclaw-computer-use-service-");
    const codexHome = path.join(root, "codex-home");
    await writeExecutableClient(path.join(codexHome, "computer-use", "Codex Computer Use.app"));
    const copyServiceApp = vi.fn();

    const result = await ensureCodexComputerUseServiceApp({
      codexHome,
      platform: "darwin",
      sourceAppCandidates: [],
      copyServiceApp,
    });

    expect(result).toMatchObject({ status: "already_installed", changed: false });
    expect(copyServiceApp).not.toHaveBeenCalled();
  });

  it("reports a missing source without creating a partial target", async () => {
    const root = tempDirs.make("openclaw-computer-use-service-");
    const codexHome = path.join(root, "codex-home");

    const result = await ensureCodexComputerUseServiceApp({
      codexHome,
      platform: "darwin",
      sourceAppCandidates: [path.join(root, "missing.app")],
    });

    expect(result).toMatchObject({ status: "source_missing", changed: false });
    await expect(fs.access(path.join(codexHome, "computer-use"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("replaces an incomplete home-owned service app", async () => {
    const root = tempDirs.make("openclaw-computer-use-service-");
    const sourcePath = path.join(root, "source", "Codex Computer Use.app");
    const codexHome = path.join(root, "codex-home");
    const targetPath = path.join(codexHome, "computer-use", "Codex Computer Use.app");
    await writeExecutableClient(sourcePath);
    await fs.mkdir(targetPath, { recursive: true });
    await fs.writeFile(path.join(targetPath, "partial"), "incomplete");

    const result = await ensureCodexComputerUseServiceApp({
      codexHome,
      platform: "darwin",
      sourceAppCandidates: [sourcePath],
      copyServiceApp: async (source, target) => await fs.cp(source, target, { recursive: true }),
    });

    expect(result).toMatchObject({ status: "installed", changed: true });
    await expect(fs.access(path.join(targetPath, CLIENT_RELATIVE_PATH))).resolves.toBeUndefined();
    await expect(fs.access(path.join(targetPath, "partial"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not provision the macOS service on other platforms", async () => {
    const result = await ensureCodexComputerUseServiceApp({
      codexHome: "/tmp/codex-home",
      platform: "linux",
    });

    expect(result).toEqual({ status: "unsupported", changed: false });
  });

  it("prefers service assets owned by the selected desktop app-server", () => {
    expect(
      resolveMacOSDesktopCodexComputerUseServiceAppCandidates(
        "darwin",
        "/Applications/Codex.app/Contents/Resources/codex",
      )[0],
    ).toBe(
      "/Applications/Codex.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use/Codex Computer Use.app",
    );
  });
});

async function writeExecutableClient(appPath: string): Promise<void> {
  const clientPath = path.join(appPath, CLIENT_RELATIVE_PATH);
  await fs.mkdir(path.dirname(clientPath), { recursive: true });
  await fs.writeFile(clientPath, "client");
  await fs.chmod(clientPath, 0o755);
}
