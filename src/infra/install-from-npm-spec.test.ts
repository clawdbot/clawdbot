// Tests package installation from npm registry specs.
import { describe, expect, it, vi } from "vitest";

const validateRegistryNpmSpecMock = vi.hoisted(() => vi.fn());
const installFromNpmSpecArchiveWithInstallerMock = vi.hoisted(() => vi.fn());
const finalizeNpmSpecArchiveInstallMock = vi.hoisted(() => vi.fn());

vi.mock("./npm-registry-spec.js", () => ({
  validateRegistryNpmSpec: (...args: unknown[]) => validateRegistryNpmSpecMock(...args),
}));

vi.mock("./npm-pack-install.js", () => ({
  installFromNpmSpecArchiveWithInstaller: (...args: unknown[]) =>
    installFromNpmSpecArchiveWithInstallerMock(...args),
  finalizeNpmSpecArchiveInstall: (...args: unknown[]) => finalizeNpmSpecArchiveInstallMock(...args),
}));

import { installFromValidatedNpmSpecArchive } from "./install-from-npm-spec.js";

describe("installFromValidatedNpmSpecArchive", () => {
  it("trims the spec and returns validation errors before running the installer", async () => {
    validateRegistryNpmSpecMock.mockReturnValueOnce("unsupported npm spec");

    await expect(
      installFromValidatedNpmSpecArchive({
        spec: "  nope  ",
        timeoutMs: 30_000,
        tempDirPrefix: "openclaw-npm-",
        installFromArchive: vi.fn(),
        archiveInstallParams: {},
      }),
    ).resolves.toEqual({ ok: false, error: "unsupported npm spec" });

    expect(validateRegistryNpmSpecMock).toHaveBeenCalledWith("nope");
    expect(installFromNpmSpecArchiveWithInstallerMock).not.toHaveBeenCalled();
    expect(finalizeNpmSpecArchiveInstallMock).not.toHaveBeenCalled();
  });

  it("passes the trimmed spec through the archive installer and finalizer", async () => {
    const installFromArchive = vi.fn();
    const warn = vi.fn();
    const onIntegrityDrift = vi.fn();
    const flowResult = {
      ok: true,
      installResult: { ok: true },
      npmResolution: { version: "1.2.3" },
    };
    const finalized = { ok: true, archivePath: "/tmp/pkg.tgz" };
    validateRegistryNpmSpecMock.mockReturnValueOnce(null);
    installFromNpmSpecArchiveWithInstallerMock.mockResolvedValueOnce(flowResult);
    finalizeNpmSpecArchiveInstallMock.mockReturnValueOnce(finalized);

    await expect(
      installFromValidatedNpmSpecArchive({
        spec: "  @openclaw/demo@beta  ",
        timeoutMs: 45_000,
        tempDirPrefix: "openclaw-npm-",
        expectedIntegrity: "sha512-demo",
        onIntegrityDrift,
        warn,
        installFromArchive,
        archiveInstallParams: { destination: "/tmp/demo" },
      }),
    ).resolves.toBe(finalized);

    expect(installFromNpmSpecArchiveWithInstallerMock).toHaveBeenCalledWith({
      tempDirPrefix: "openclaw-npm-",
      spec: "@openclaw/demo@beta",
      timeoutMs: 45_000,
      expectedIntegrity: "sha512-demo",
      onIntegrityDrift,
      warn,
      installFromArchive,
      archiveInstallParams: { destination: "/tmp/demo" },
    });
    expect(finalizeNpmSpecArchiveInstallMock).toHaveBeenCalledWith(flowResult);
  });
});
