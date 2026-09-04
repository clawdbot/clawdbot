import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { installFromValidatedNpmSpecArchive } from "./install-from-npm-spec.js";
import { packNpmSpecToArchive, withInstallWorkspace } from "./install-source-utils.js";
import type { NpmIntegrityDriftPayload } from "./npm-integrity.js";

vi.mock("./install-source-utils.js", async () => {
  const actual = await vi.importActual<typeof import("./install-source-utils.js")>(
    "./install-source-utils.js",
  );
  return {
    ...actual,
    withInstallWorkspace: vi.fn(
      async (_prefix: string, fn: (tmpDir: string) => Promise<unknown>) => {
        return await fn("/tmp/openclaw-npm-pack-install-test");
      },
    ),
    packNpmSpecToArchive: vi.fn(),
  };
});

describe("installFromValidatedNpmSpecArchive", () => {
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
    spec?: string;
    expectedIntegrity?: string;
    onIntegrityDrift?: (payload: NpmIntegrityDriftPayload) => boolean | Promise<boolean>;
    warn?: (message: string) => void;
    installFromArchive: (params: {
      archivePath: string;
    }) => Promise<
      { ok: true; target?: string; id?: string; pluginId?: string } | { ok: false; error: string }
    >;
  }) =>
    await installFromValidatedNpmSpecArchive({
      tempDirPrefix: "openclaw-test-",
      spec: overrides.spec ?? baseSpec,
      timeoutMs: 1000,
      expectedIntegrity: overrides.expectedIntegrity,
      onIntegrityDrift: overrides.onIntegrityDrift,
      warn: overrides.warn,
      installFromArchive: overrides.installFromArchive,
      archiveInstallParams: {},
    });

  const expectOkResult = (
    result: Awaited<ReturnType<typeof runInstall>>,
    installResult: Record<string, unknown>,
  ) => {
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok result");
    }
    expect(result).toMatchObject(installResult);
    return result;
  };

  beforeEach(() => {
    vi.mocked(packNpmSpecToArchive).mockClear();
    vi.mocked(withInstallWorkspace).mockClear();
  });

  it("returns pack errors without invoking installer", async () => {
    vi.mocked(packNpmSpecToArchive).mockResolvedValue({ ok: false, error: "pack failed" });
    const installFromArchive = vi.fn(async () => ({ ok: true as const }));

    const result = await runInstall({ installFromArchive });

    expect(result).toEqual({ ok: false, error: "pack failed" });
    expect(installFromArchive).not.toHaveBeenCalled();
    expect(withInstallWorkspace).toHaveBeenCalledWith("openclaw-test-", expect.any(Function));
  });

  it("rejects unsupported npm specs before packing", async () => {
    const installFromArchive = vi.fn(async () => ({ ok: true as const }));

    const result = await runInstall({
      spec: "file:/tmp/openclaw.tgz",
      installFromArchive,
    });

    expect(result).toEqual({
      ok: false,
      error: "unsupported npm spec: protocol specs are not allowed",
    });
    expect(packNpmSpecToArchive).not.toHaveBeenCalled();
    expect(withInstallWorkspace).not.toHaveBeenCalled();
    expect(installFromArchive).not.toHaveBeenCalled();
  });

  it("returns resolution metadata and installer result on success", async () => {
    mockPackedSuccess({ name: "@openclaw/test", version: "1.0.0" });
    const installFromArchive = vi.fn(async () => ({ ok: true as const, target: "done" }));

    const result = await runInstall({
      spec: `  ${baseSpec}  `,
      expectedIntegrity: "sha512-same",
      installFromArchive,
    });

    expect(packNpmSpecToArchive).toHaveBeenCalledWith(expect.objectContaining({ spec: baseSpec }));
    const okResult = expectOkResult(result, { ok: true, target: "done" });
    expect(okResult.integrityDrift).toBeUndefined();
    expect(okResult.npmResolution.resolvedSpec).toBe(baseSpec);
    const resolvedAt = okResult.npmResolution.resolvedAt;
    if (!resolvedAt) {
      throw new Error("expected npm resolution timestamp");
    }
    expect(Date.parse(resolvedAt)).not.toBeNaN();
    expect(installFromArchive).toHaveBeenCalledWith({ archivePath: baseArchivePath });
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

    const okResult = expectOkResult(result, { ok: true, id: "plugin-accept" });
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
    const installFromArchive = vi.fn(async () => ({ ok: true as const }));

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

  it("returns installer failures for domain-specific handling", async () => {
    mockPackedSuccess();
    const installFromArchive = vi.fn(async () => ({ ok: false as const, error: "install failed" }));

    const result = await runInstall({
      expectedIntegrity: "sha512-same",
      installFromArchive,
    });

    expect(result).toEqual({ ok: false, error: "install failed" });
  });

  it("rejects prerelease resolutions unless explicitly requested", async () => {
    mockPackedSuccess({
      resolvedSpec: "@openclaw/test@latest",
      version: "1.1.0-beta.1",
    });
    const installFromArchive = vi.fn(async () => ({ ok: true as const }));

    const result = await runInstall({
      spec: "@openclaw/test@latest",
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
    mockPackedSuccess({
      resolvedSpec: "@openclaw/test@beta",
      version: "1.1.0-beta.1",
    });
    const installFromArchive = vi.fn(async () => ({ ok: true as const, pluginId: "beta-plugin" }));

    const result = await runInstall({
      spec: "@openclaw/test@beta",
      installFromArchive,
    });

    const okResult = expectOkResult(result, { ok: true, pluginId: "beta-plugin" });
    expect(okResult.npmResolution.version).toBe("1.1.0-beta.1");
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

    const result = await installFromValidatedNpmSpecArchive({
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
    expect(result).toMatchObject({ ok: true, pluginId: "voice-call" });
  });
});

describe("archive workspace lifetime", () => {
  it.each(["success", "failure", "throw"] as const)(
    "cleans the archive workspace before exposing %s",
    async (outcome) => {
      await withTestDir({ prefix: "openclaw-npm-archive-" }, async (rootDir) => {
        const actual = await vi.importActual<typeof import("./install-source-utils.js")>(
          "./install-source-utils.js",
        );
        vi.mocked(withInstallWorkspace).mockImplementationOnce((prefix, callback) =>
          actual.withInstallWorkspace(prefix, callback, { rootDir }),
        );
        let workspace = "";
        vi.mocked(packNpmSpecToArchive).mockImplementationOnce(async ({ cwd }) => {
          workspace = cwd;
          const archivePath = path.join(cwd, "package.tgz");
          await fs.writeFile(archivePath, "owned archive");
          return { ok: true, archivePath, metadata: { version: "1.0.0" } };
        });
        const transactionKey = Symbol.for("openclaw.packageDirInstallTransaction");
        const transaction = { commit: vi.fn(), rollback: vi.fn() };
        const failure = {
          ok: false as const,
          error: "policy refused",
          code: "security_scan_blocked",
        };
        const thrown = new Error("installer failed");
        const result = installFromValidatedNpmSpecArchive({
          spec: "audit-hooks@1.0.0",
          timeoutMs: 1000,
          tempDirPrefix: "archive-",
          archiveInstallParams: {},
          installFromArchive: async ({ archivePath }) => {
            expect(await fs.readFile(archivePath, "utf8")).toBe("owned archive");
            if (outcome === "throw") {
              throw thrown;
            }
            if (outcome === "failure") {
              return failure;
            }
            return {
              ok: true as const,
              [transactionKey]: transaction,
              get pluginId() {
                expect(existsSync(workspace)).toBe(false);
                return "audit-hooks";
              },
            };
          },
        });
        if (outcome === "throw") {
          await expect(result).rejects.toBe(thrown);
        } else if (outcome === "failure") {
          await expect(result).resolves.toBe(failure);
        } else {
          await expect(result).resolves.toMatchObject({
            pluginId: "audit-hooks",
            [transactionKey]: transaction,
            npmResolution: { version: "1.0.0" },
          });
        }
        expect(workspace).not.toBe("");
        expect(existsSync(workspace)).toBe(false);
      });
    },
  );
});
