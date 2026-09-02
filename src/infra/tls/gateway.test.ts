// Covers gateway TLS loading, fingerprint reporting, generated certificate
// paths, and error handling for missing or invalid material.
import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeTlsFingerprint } from "../../../packages/gateway-client/src/client-address-utils.js";
import {
  TEST_TLS_CERT_PEM as CERT_PEM,
  TEST_TLS_KEY_PEM as KEY_PEM,
} from "../../../test/helpers/tls-fixture.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";

const { durabilityTestState, resolveSystemBinMock, runExecMock } = vi.hoisted(() => ({
  durabilityTestState: {
    syncOutcome: undefined as
      | { status: "synced" }
      | { status: "unsupported"; code?: string }
      | undefined,
  },
  resolveSystemBinMock: vi.fn(() => "/usr/bin/openssl"),
  runExecMock: vi.fn(),
}));

vi.mock("@openclaw/fs-safe/durability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/durability")>();
  return {
    ...actual,
    publishFileExclusive: async (...args: Parameters<typeof actual.publishFileExclusive>) => {
      const result = await actual.publishFileExclusive(...args);
      return {
        ...result,
        directorySync: durabilityTestState.syncOutcome ?? result.directorySync,
      };
    },
    syncDirectory: async (...args: Parameters<typeof actual.syncDirectory>) =>
      durabilityTestState.syncOutcome ?? (await actual.syncDirectory(...args)),
  };
});

vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runExec: runExecMock,
}));

vi.mock("../resolve-system-bin.js", () => ({ resolveSystemBin: resolveSystemBinMock }));

import { loadGatewayTlsServerRuntime } from "./gateway.js";

const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("openclaw-gateway-tls-test-");

function resolveOpenSslOutput(args: string[], flag: "-keyout" | "-out"): string {
  const outputPath = args.at(args.indexOf(flag) + 1);
  if (!outputPath) {
    throw new Error(`missing ${flag} output path`);
  }
  return outputPath;
}

async function writeGeneratedTlsPair(args: string[]): Promise<void> {
  await Promise.all([
    fs.writeFile(resolveOpenSslOutput(args, "-out"), CERT_PEM, "utf8"),
    fs.writeFile(resolveOpenSslOutput(args, "-keyout"), KEY_PEM, "utf8"),
  ]);
}

afterEach(async () => {
  durabilityTestState.syncOutcome = undefined;
  resolveSystemBinMock.mockClear();
  runExecMock.mockReset();
  vi.restoreAllMocks();
  await tempDirs.cleanup();
});

describe("loadGatewayTlsServerRuntime", () => {
  it("disables tls when config is absent or disabled", async () => {
    await expect(loadGatewayTlsServerRuntime(undefined)).resolves.toEqual({
      enabled: false,
      required: false,
    });
    await expect(loadGatewayTlsServerRuntime({ enabled: false })).resolves.toEqual({
      enabled: false,
      required: false,
    });
  });

  it("loads existing cert, key, and optional ca files", async () => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "gateway-cert.pem");
    const keyPath = path.join(dir, "gateway-key.pem");
    const caPath = path.join(dir, "gateway-ca.pem");
    await fs.writeFile(certPath, CERT_PEM, "utf8");
    await fs.writeFile(keyPath, KEY_PEM, "utf8");
    await fs.writeFile(caPath, CERT_PEM, "utf8");

    const result = await loadGatewayTlsServerRuntime({
      enabled: true,
      certPath,
      keyPath,
      caPath,
      autoGenerate: false,
    });

    expect(result.enabled).toBe(true);
    expect(result.required).toBe(true);
    expect(result.certPath).toBe(certPath);
    expect(result.keyPath).toBe(keyPath);
    expect(result.caPath).toBe(caPath);
    expect(result.fingerprintSha256).toBe(
      normalizeTlsFingerprint(new X509Certificate(CERT_PEM).fingerprint256 ?? ""),
    );
    expect(result.tlsOptions?.cert).toBe(CERT_PEM);
    expect(result.tlsOptions?.key).toBe(KEY_PEM);
    expect(result.tlsOptions?.ca).toBe(CERT_PEM);
    expect(result.tlsOptions?.minVersion).toBe("TLSv1.3");
    expect(result.error).toBeUndefined();
  });

  it("fails closed when cert/key are missing and auto generation is disabled", async () => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "missing-cert.pem");
    const keyPath = path.join(dir, "missing-key.pem");

    const result = await loadGatewayTlsServerRuntime({
      enabled: true,
      certPath,
      keyPath,
      autoGenerate: false,
    });

    expect(result.enabled).toBe(false);
    expect(result.required).toBe(true);
    expect(result.certPath).toBe(certPath);
    expect(result.keyPath).toBe(keyPath);
    expect(result.error).toBe("gateway tls: cert/key missing");
  });

  it.each(["key", "cert"] as const)(
    "does not replace an existing %s or generate its missing counterpart",
    async (existing) => {
      const dir = await createTempDir();
      const certPath = path.join(dir, "gateway-cert.pem");
      const keyPath = path.join(dir, "gateway-key.pem");
      const existingPath = existing === "cert" ? certPath : keyPath;
      await fs.writeFile(existingPath, "existing material");

      const result = await loadGatewayTlsServerRuntime({ enabled: true, certPath, keyPath });

      expect(result).toMatchObject({
        enabled: false,
        required: true,
        error: "gateway tls: cert/key missing",
      });
      expect(runExecMock).not.toHaveBeenCalled();
      await expect(fs.readFile(existingPath, "utf8")).resolves.toBe("existing material");
      await expect(fs.readdir(dir)).resolves.toEqual([path.basename(existingPath)]);
    },
  );

  it.each(["key", "cert"] as const)(
    "bounds generation and cleans a partial staged %s",
    async (partialOutput) => {
      const dir = await createTempDir();
      const certPath = path.join(dir, "gateway-cert.pem");
      const keyPath = path.join(dir, "gateway-key.pem");
      runExecMock.mockImplementationOnce(async (_command: string, args: string[]) => {
        const outputPath = resolveOpenSslOutput(args, partialOutput === "key" ? "-keyout" : "-out");
        await fs.writeFile(outputPath, partialOutput === "key" ? KEY_PEM : CERT_PEM, "utf8");
        throw new Error("openssl timed out");
      });

      const result = await loadGatewayTlsServerRuntime({ enabled: true, certPath, keyPath });

      expect(runExecMock).toHaveBeenCalledOnce();
      const [command, args, options] = runExecMock.mock.calls[0] as [
        string,
        string[],
        { logOutput: boolean; timeoutMs: number },
      ];
      expect(command).toBe("/usr/bin/openssl");
      expect(resolveOpenSslOutput(args, "-keyout")).not.toBe(keyPath);
      expect(resolveOpenSslOutput(args, "-out")).not.toBe(certPath);
      expect(options).toEqual({ logOutput: false, timeoutMs: 30_000 });
      expect(result).toMatchObject({ enabled: false, required: true, certPath, keyPath });
      expect(result.error).toContain("openssl timed out");
      await expect(fs.access(certPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(keyPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readdir(dir)).resolves.toEqual([]);
    },
  );

  it("validates and publishes a generated pair with private modes", async () => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "gateway-cert.pem");
    const keyPath = path.join(dir, "gateway-key.pem");
    runExecMock.mockImplementation(async (_command: string, args: string[]) => {
      await writeGeneratedTlsPair(args);
    });

    const result = await loadGatewayTlsServerRuntime({ enabled: true, certPath, keyPath });

    expect(result.enabled).toBe(true);
    await expect(fs.readFile(certPath, "utf8")).resolves.toBe(CERT_PEM);
    await expect(fs.readFile(keyPath, "utf8")).resolves.toBe(KEY_PEM);
    await expect(fs.readdir(dir).then((entries) => entries.toSorted())).resolves.toEqual([
      "gateway-cert.pem",
      "gateway-key.pem",
    ]);
    if (process.platform !== "win32") {
      expect((await fs.stat(certPath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(keyPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("syncs generated certificate data before linking final paths", async () => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "gateway-cert.pem");
    const keyPath = path.join(dir, "gateway-key.pem");
    const events: string[] = [];
    runExecMock.mockImplementation(async (_command: string, args: string[]) => {
      await writeGeneratedTlsPair(args);
    });
    const originalOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      const handle = await originalOpen(filePath, flags, mode);
      if (flags === "r+" && ["cert.pem", "key.pem"].includes(path.basename(String(filePath)))) {
        const originalSync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          events.push(`sync:${path.basename(String(filePath))}`);
          await originalSync();
        });
      }
      return handle;
    });
    const originalLink = fs.link.bind(fs);
    const linkSpy = vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
      events.push(`link:${path.basename(String(source))}`);
      await originalLink(source, target);
    });

    try {
      await expect(
        loadGatewayTlsServerRuntime({ enabled: true, certPath, keyPath }),
      ).resolves.toMatchObject({ enabled: true });
    } finally {
      openSpy.mockRestore();
      linkSpy.mockRestore();
    }

    expect(events).toEqual(
      expect.arrayContaining(["sync:cert.pem", "link:cert.pem", "sync:key.pem", "link:key.pem"]),
    );
    expect(events.indexOf("sync:cert.pem")).toBeLessThan(events.indexOf("link:cert.pem"));
    expect(events.indexOf("sync:key.pem")).toBeLessThan(events.indexOf("link:key.pem"));
  });

  it("creates nested TLS directories before publishing generated material", async () => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "nested", "tls", "gateway-cert.pem");
    const keyPath = path.join(dir, "nested", "tls", "gateway-key.pem");
    runExecMock.mockImplementation(async (_command: string, args: string[]) => {
      await writeGeneratedTlsPair(args);
    });

    const result = await loadGatewayTlsServerRuntime({ enabled: true, certPath, keyPath });

    expect(result.enabled).toBe(true);
    await expect(fs.readFile(certPath, "utf8")).resolves.toBe(CERT_PEM);
    await expect(fs.readFile(keyPath, "utf8")).resolves.toBe(KEY_PEM);
  });

  it("preserves the published certificate when key publication loses a race", async () => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "gateway-cert.pem");
    const keyPath = path.join(dir, "gateway-key.pem");
    runExecMock.mockImplementation(async (_command: string, args: string[]) => {
      await writeGeneratedTlsPair(args);
    });
    const originalLink = fs.link.bind(fs);
    let linkCount = 0;
    vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
      linkCount += 1;
      if (linkCount === 2) {
        await fs.writeFile(keyPath, "foreign key material", "utf8");
        throw Object.assign(new Error("key destination appeared"), { code: "EEXIST" });
      }
      await originalLink(source, target);
    });

    const result = await loadGatewayTlsServerRuntime({ enabled: true, certPath, keyPath });

    expect(result.enabled).toBe(false);
    expect(result.error).toContain("key destination appeared");
    await expect(fs.readFile(certPath, "utf8")).resolves.toBe(CERT_PEM);
    await expect(fs.readFile(keyPath, "utf8")).resolves.toBe("foreign key material");
  });

  it.runIf(process.platform !== "win32")(
    "publishes through the pinned canonical directory after a symlink retarget",
    async () => {
      const root = await createTempDir();
      const firstDirectory = path.join(root, "first");
      const secondDirectory = path.join(root, "second");
      const requestedDirectory = path.join(root, "requested");
      await fs.mkdir(firstDirectory);
      await fs.mkdir(secondDirectory);
      await fs.symlink(firstDirectory, requestedDirectory);
      const certPath = path.join(requestedDirectory, "gateway-cert.pem");
      const keyPath = path.join(requestedDirectory, "gateway-key.pem");
      runExecMock.mockImplementation(async (_command: string, args: string[]) => {
        await writeGeneratedTlsPair(args);
      });
      const originalLink = fs.link.bind(fs);
      let retargeted = false;
      vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
        if (!retargeted) {
          retargeted = true;
          await fs.unlink(requestedDirectory);
          await fs.symlink(secondDirectory, requestedDirectory);
          await originalLink(source, target);
          await fs.unlink(requestedDirectory);
          await fs.symlink(firstDirectory, requestedDirectory);
          return;
        }
        await originalLink(source, target);
      });

      await expect(
        loadGatewayTlsServerRuntime({ enabled: true, certPath, keyPath }),
      ).resolves.toMatchObject({
        enabled: true,
      });
      await expect(
        fs.readdir(firstDirectory).then((entries) => entries.toSorted()),
      ).resolves.toEqual(["gateway-cert.pem", "gateway-key.pem"]);
      await expect(fs.readdir(secondDirectory)).resolves.toEqual([]);
    },
  );

  it("publishes best-effort and warns once when hard links are unavailable", async () => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "gateway-cert.pem");
    const keyPath = path.join(dir, "gateway-key.pem");
    const warn = vi.fn();
    runExecMock.mockImplementation(async (_command: string, args: string[]) => {
      await writeGeneratedTlsPair(args);
    });
    const linkSpy = vi
      .spyOn(fs, "link")
      .mockRejectedValue(Object.assign(new Error("hard links unsupported"), { code: "ENOTSUP" }));

    let result: Awaited<ReturnType<typeof loadGatewayTlsServerRuntime>> | undefined;
    try {
      result = await loadGatewayTlsServerRuntime({ enabled: true, certPath, keyPath }, { warn });
    } finally {
      linkSpy.mockRestore();
    }

    expect(result?.enabled).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[GATEWAY_TLS_DEGRADED]"), {
      event: "gateway.tls.degraded",
      ownerKind: "gateway",
      ownerId: "tls",
      reason: "atomic hard-link publication unavailable",
      state: "best-effort",
    });
    await expect(fs.readFile(certPath, "utf8")).resolves.toBe(CERT_PEM);
    await expect(fs.readFile(keyPath, "utf8")).resolves.toBe(KEY_PEM);
    await expect(fs.readdir(dir).then((entries) => entries.toSorted())).resolves.toEqual([
      "gateway-cert.pem",
      "gateway-key.pem",
    ]);
    if (process.platform !== "win32") {
      expect((await fs.stat(certPath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(keyPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("reports degraded durability when Windows cannot flush the publication directory", async () => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "gateway-cert.pem");
    const keyPath = path.join(dir, "gateway-key.pem");
    const warn = vi.fn();
    runExecMock.mockImplementation(async (_command: string, args: string[]) => {
      await writeGeneratedTlsPair(args);
    });
    durabilityTestState.syncOutcome = { status: "unsupported", code: "EISDIR" };

    const result = await loadGatewayTlsServerRuntime(
      { enabled: true, certPath, keyPath },
      { warn },
    );

    expect(result.enabled).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[GATEWAY_TLS_DEGRADED]"), {
      event: "gateway.tls.degraded",
      ownerKind: "gateway",
      ownerId: "tls",
      reason: "directory durability unavailable",
      state: "best-effort",
    });
  });

  it("reports atomic and durability degradations independently", async () => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "gateway-cert.pem");
    const keyPath = path.join(dir, "gateway-key.pem");
    const warn = vi.fn();
    runExecMock.mockImplementation(async (_command: string, args: string[]) => {
      await writeGeneratedTlsPair(args);
    });
    vi.spyOn(fs, "link").mockRejectedValue(
      Object.assign(new Error("hard links unsupported"), { code: "ENOTSUP" }),
    );
    durabilityTestState.syncOutcome = { status: "unsupported", code: "EISDIR" };

    const result = await loadGatewayTlsServerRuntime(
      { enabled: true, certPath, keyPath },
      { warn },
    );

    expect(result.enabled).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      event: "gateway.tls.degraded",
      ownerKind: "gateway",
      ownerId: "tls",
      reason: "atomic hard-link publication unavailable",
      state: "best-effort",
    });
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      event: "gateway.tls.degraded",
      ownerKind: "gateway",
      ownerId: "tls",
      reason: "directory durability unavailable",
      state: "best-effort",
    });
  });

  it("reports load failures for invalid pem files", async () => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "gateway-cert.pem");
    const keyPath = path.join(dir, "gateway-key.pem");
    await fs.writeFile(certPath, "not a certificate\n", "utf8");
    await fs.writeFile(keyPath, KEY_PEM, "utf8");

    const result = await loadGatewayTlsServerRuntime({
      enabled: true,
      certPath,
      keyPath,
      autoGenerate: false,
    });

    expect(result.enabled).toBe(false);
    expect(result.required).toBe(true);
    expect(result.certPath).toBe(certPath);
    expect(result.keyPath).toBe(keyPath);
    expect(result.error).toContain("gateway tls: failed to load cert");
  });

  it("falls back to default paths when certPath and keyPath are empty strings", async () => {
    const result = await loadGatewayTlsServerRuntime({
      enabled: true,
      certPath: "",
      keyPath: "",
      autoGenerate: false,
    });

    // Empty paths must not reach downstream — they must be replaced with defaults.
    expect(result.certPath).toBeTruthy();
    expect(result.certPath).not.toBe("");
    expect(result.keyPath).toBeTruthy();
    expect(result.keyPath).not.toBe("");
  });

  it("falls back to default paths when certPath and keyPath are whitespace-only", async () => {
    const result = await loadGatewayTlsServerRuntime({
      enabled: true,
      certPath: "   ",
      keyPath: "\t",
      autoGenerate: false,
    });

    expect(result.certPath).toBeTruthy();
    expect(result.certPath).not.toBe("   ");
    expect(result.keyPath).toBeTruthy();
    expect(result.keyPath).not.toBe("\t");
  });

  it("does not fall back for non-empty paths with leading/trailing spaces", async () => {
    const result = await loadGatewayTlsServerRuntime({
      enabled: true,
      certPath: "  /etc/ssl/cert.pem  ",
      keyPath: "  /etc/ssl/private/server.key  ",
      autoGenerate: false,
    });

    // Non-empty paths are passed through verbatim; resolveUserPath owns
    // normalization (it trims), so they must not fall back to default names.
    expect(result.certPath).not.toContain("gateway-cert.pem");
    expect(result.keyPath).not.toContain("gateway-key.pem");
  });
});
