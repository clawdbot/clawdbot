import { beforeEach, describe, expect, it, vi } from "vitest";
import { packNpmSpecToArchive, withTempDir } from "./install-source-utils.js";
import type { NpmIntegrityDriftPayload } from "./npm-integrity.js";
import {
  finalizeNpmSpecArchiveInstall,
  installFromNpmSpecArchive,
  installFromNpmSpecArchiveWithInstaller,
} from "./npm-pack-install.js";

vi.mock("./install-source-utils.js", async () => {
  const actual = await vi.importActual<typeof import("./install-source-utils.js")>(
    "./install-source-utils.js",
  );
  return {
    ...actual,
    withTempDir: vi.fn(async (_prefix: string, fn: (tmpDir: string) => Promise<unknown>) => {
      return await fn("/tmp/openclaw-npm-pack-install-test");
    }),
    packNpmSpecToArchive: vi.fn(),
  };
});

describe("installFromNpmSpecArchive", () => {
  const baseSpec = "@openclaw/test@1.0.0";
  const baseArchivePath = "/tmp/openclaw-test.tgz";

  const mockPackedSuccess = (overrides?: {
    resolvedSpec?: string;
    integrity?: string;
    name?: string;
    version?: string;
  }) => {
    vi.mocked(packNpmSpecToArchive).mockResolvedValue({
      ok: true,
      archivePath: baseArchivePath,
      metadata: {
        resolvedSpec: overrides?.resolvedSpec ?? baseSpec,
        integrity: overrides?.integrity ?? "sha512-same",
        ...(overrides?.name ? { name: overrides.name } : {}),
        ...(overrides?.version ? { version: overrides.version } : {}),
      },
    });
  };

  const runInstall = async (overrides: {
    expectedIntegrity?: string;
    onIntegrityDrift?: (payload: NpmIntegrityDriftPayload) => boolean | Promise<boolean>;
    warn?: (message: string) => void;
    installFromArchive: (params: {
      archivePath: string;
    }) => Promise<{ ok: boolean; [k: string]: unknown }>;
  }) =>
    await installFromNpmSpecArchive({
      tempDirPrefix: "openclaw-test-",
      spec: baseSpec,
      timeoutMs: 1000,
      expectedIntegrity: overrides.expectedIntegrity,
      onIntegrityDrift: overrides.onIntegrityDrift,
      warn: overrides.warn,
      installFromArchive: overrides.installFromArchive,
    });

  const expectWrappedOkResult = (
    result: Awaited<ReturnType<typeof runInstall>>,
    installResult: Record<string, unknown>,
  ) => {
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok result");
    }
    expect(result.installResult).toEqual(installResult);
    return result;
  };

  beforeEach(() => {
    vi.mocked(packNpmSpecToArchive).mockClear();
    vi.mocked(withTempDir).mockClear();
  });

  it("returns pack errors without invoking installer", async () => {
    vi.mocked(packNpmSpecToArchive).mockResolvedValue({ ok: false, error: "pack failed" });
    const installFromArchive = vi.fn(async () => ({ ok: true as const }));

    const result = await installFromNpmSpecArchive({
      tempDirPrefix: "openclaw-test-",
      spec: "@openclaw/test@1.0.0",
      timeoutMs: 1000,
      installFromArchive,
    });

    expect(result).toEqual({ ok: false, error: "pack failed" });
    expect(installFromArchive).not.toHaveBeenCalled();
    const withTempDirMock = vi.mocked(withTempDir);
    expect(withTempDirMock).toHaveBeenCalledTimes(1);
    const tempDirCall = withTempDirMock.mock.calls[0];
    if (tempDirCall === undefined) {
      throw new Error("expected temp dir call");
    }
    const [tempDirPrefix, tempDirCallback] = tempDirCall;
    expect(tempDirPrefix).toBe("openclaw-test-");
    expect(tempDirCallback).toBeTypeOf("function");
  });

  it("rejects unsupported npm specs before packing", async () => {
    const installFromArchive = vi.fn(async () => ({ ok: true as const }));

    const result = await installFromNpmSpecArchive({
      tempDirPrefix: "openclaw-test-",
      spec: "file:/tmp/openclaw.tgz",
      timeoutMs: 1000,
      installFromArchive,
    });

    expect(result).toEqual({
      ok: false,
      error: "unsupported npm spec",
    });
    expect(packNpmSpecToArchive).not.toHaveBeenCalled();
    expect(installFromArchive).not.toHaveBeenCalled();
  });

  it("returns resolution metadata and installer result on success", async () => {
    mockPackedSuccess({ name: "@openclaw/test", version: "1.0.0" });
    const installFromArchive = vi.fn(async () => ({ ok: true as const, target: "done" }));

    const result = await runInstall({
      expectedIntegrity: "sha512-same",
      installFromArchive,
    });

    const okResult = expectWrappedOkResult(result, { ok: true, target: "done" });
    expect(okResult.integrityDrift).toBeUndefined();
    expect(okResult.npmResolution.resolvedSpec).toBe("@openclaw/test@1.0.0");
    const resolvedAt = okResult.npmResolution.resolvedAt;
    if (!resolvedAt) {
      throw new Error("expected npm resolution timestamp");
    }
    expect(Date.parse(resolvedAt)).not.toBeNaN();
    expect(installFromArchive).toHaveBeenCalledWith({ archivePath: "/tmp/openclaw-test.tgz" });
  });

  it("proceeds when integrity drift callback accepts drift", async () => {
    mockPackedSuccess({ integrity: "sha512-new" });
    const onIntegrityDrift = vi.fn(async () => true);
    const installFromArchive = vi.fn(async () => ({ ok: true as const, id: "plugin-accept" }));

    const result = await runInstall({
      expectedIntegrity: "sha512-old",
      onIntegrityDrift,
      installFromArchive,
    });

    const okResult = expectWrappedOkResult(result, { ok: true, id: "plugin-accept" });
    expect(okResult.integrityDrift).toEqual({
      expectedIntegrity: "sha512-old",
      actualIntegrity: "sha512-new",
    });
    expect(onIntegrityDrift).toHaveBeenCalledTimes(1);
  });

  it("aborts when integrity drift callback rejects drift", async () => {
    mockPackedSuccess({ integrity: "sha512-new" });
    const installFromArchive = vi.fn(async () => ({ ok: true as const }));

    const result = await runInstall({
      expectedIntegrity: "sha512-old",
      onIntegrityDrift: async () => false,
      installFromArchive,
    });

    expect(result).toEqual({
      ok: false,
      error: "aborted: npm package integrity drift detected for @openclaw/test@1.0.0",
    });
    expect(installFromArchive).not.toHaveBeenCalled();
  });

  it("warns and aborts on drift when no callback is configured", async () => {
    mockPackedSuccess({ integrity: "sha512-new" });
    const warn = vi.fn();
    const installFromArchive = vi.fn(async () => ({ ok: true as const, id: "plugin-1" }));

    const result = await runInstall({
      expectedIntegrity: "sha512-old",
      warn,
      installFromArchive,
    });

    expect(result).toEqual({
      ok: false,
      error: "aborted: npm package integrity drift detected for @openclaw/test@1.0.0",
    });
    expect(warn).toHaveBeenCalledWith(
      "Integrity drift detected for @openclaw/test@1.0.0: expected sha512-old, got sha512-new",
    );
    expect(installFromArchive).not.toHaveBeenCalled();
  });

  it("returns installer failures to callers for domain-specific handling", async () => {
    mockPackedSuccess({ integrity: "sha512-same" });
    const installFromArchive = vi.fn(async () => ({ ok: false as const, error: "install failed" }));

    const result = await runInstall({
      expectedIntegrity: "sha512-same",
      installFromArchive,
    });

    const okResult = expectWrappedOkResult(result, { ok: false, error: "install failed" });
    expect(okResult.integrityDrift).toBeUndefined();
  });

  it("rejects prerelease resolutions unless explicitly requested", async () => {
    vi.mocked(packNpmSpecToArchive).mockResolvedValue({
      ok: true,
      archivePath: baseArchivePath,
      metadata: {
        resolvedSpec: "@openclaw/test@latest",
        integrity: "sha512-same",
        version: "1.1.0-beta.1",
      },
    });
    const installFromArchive = vi.fn(async () => ({ ok: true as const }));

    const result = await installFromNpmSpecArchive({
      tempDirPrefix: "openclaw-test-",
      spec: "@openclaw/test@latest",
      timeoutMs: 1000,
      installFromArchive,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected prerelease rejection");
    }
    expect(result.error).toContain("prerelease version 1.1.0-beta.1");
    expect(installFromArchive).not.toHaveBeenCalled();
  });

  it("allows prerelease resolutions when explicitly requested by tag", async () => {
    vi.mocked(packNpmSpecToArchive).mockResolvedValue({
      ok: true,
      archivePath: baseArchivePath,
      metadata: {
        resolvedSpec: "@openclaw/test@beta",
        integrity: "sha512-same",
        version: "1.1.0-beta.1",
      },
    });
    const installFromArchive = vi.fn(async () => ({ ok: true as const, pluginId: "beta-plugin" }));

    const result = await installFromNpmSpecArchive({
      tempDirPrefix: "openclaw-test-",
      spec: "@openclaw/test@beta",
      timeoutMs: 1000,
      installFromArchive,
    });

    const okResult = expectWrappedOkResult(result, { ok: true, pluginId: "beta-plugin" });
    expect(okResult.npmResolution.version).toBe("1.1.0-beta.1");
  });
});

describe("installFromNpmSpecArchiveWithInstaller", () => {
  beforeEach(() => {
    vi.mocked(packNpmSpecToArchive).mockClear();
  });

  it("passes archive path and installer params to installFromArchive", async () => {
    vi.mocked(packNpmSpecToArchive).mockResolvedValue({
      ok: true,
      archivePath: "/tmp/openclaw-plugin.tgz",
      metadata: {
        resolvedSpec: "@openclaw/voice-call@1.0.0",
        integrity: "sha512-same",
      },
    });
    const installFromArchive = vi.fn(
      async (_params: { archivePath: string; pluginId: string }) =>
        ({ ok: true as const, pluginId: "voice-call" }) as const,
    );

    const result = await installFromNpmSpecArchiveWithInstaller({
      tempDirPrefix: "openclaw-test-",
      spec: "@openclaw/voice-call@1.0.0",
      timeoutMs: 1000,
      installFromArchive,
      archiveInstallParams: { pluginId: "voice-call" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(installFromArchive).toHaveBeenCalledWith({
      archivePath: "/tmp/openclaw-plugin.tgz",
      pluginId: "voice-call",
    });
    expect(result.installResult).toEqual({ ok: true, pluginId: "voice-call" });
  });
});

describe("finalizeNpmSpecArchiveInstall", () => {
  it("returns top-level flow errors unchanged", () => {
    const result = finalizeNpmSpecArchiveInstall<{ ok: true } | { ok: false; error: string }>({
      ok: false,
      error: "pack failed",
    });

    expect(result).toEqual({ ok: false, error: "pack failed" });
  });

  it("returns install errors unchanged", () => {
    const result = finalizeNpmSpecArchiveInstall<{ ok: true } | { ok: false; error: string }>({
      ok: true,
      installResult: { ok: false, error: "install failed" },
      npmResolution: {
        resolvedSpec: "@openclaw/test@1.0.0",
        integrity: "sha512-same",
        resolvedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(result).toEqual({ ok: false, error: "install failed" });
  });

  it("attaches npm metadata to successful install results", () => {
    const result = finalizeNpmSpecArchiveInstall<
      { ok: true; pluginId: string } | { ok: false; error: string }
    >({
      ok: true,
      installResult: { ok: true, pluginId: "voice-call" },
      npmResolution: {
        resolvedSpec: "@openclaw/voice-call@1.0.0",
        integrity: "sha512-same",
        resolvedAt: "2026-01-01T00:00:00.000Z",
      },
      integrityDrift: {
        expectedIntegrity: "sha512-old",
        actualIntegrity: "sha512-same",
      },
    });

    expect(result).toEqual({
      ok: true,
      pluginId: "voice-call",
      npmResolution: {
        resolvedSpec: "@openclaw/voice-call@1.0.0",
        integrity: "sha512-same",
        resolvedAt: "2026-01-01T00:00:00.000Z",
      },
      integrityDrift: {
        expectedIntegrity: "sha512-old",
        actualIntegrity: "sha512-same",
      },
    });
  });
});
