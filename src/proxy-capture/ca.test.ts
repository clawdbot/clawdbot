// Proxy capture CA tests cover bounded certificate generation.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";

const { resolveSystemBinMock, runExecMock } = vi.hoisted(() => ({
  resolveSystemBinMock: vi.fn(() => "/usr/bin/openssl"),
  runExecMock: vi.fn(),
}));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const parseMarker = (value: Buffer, prefix: string): string => {
    const text = value.toString("utf8");
    if (!text.startsWith(prefix)) {
      throw new Error("invalid certificate material");
    }
    return text.slice(prefix.length);
  };
  const cryptoMock = { ...actual } as typeof actual;
  Object.defineProperties(cryptoMock, {
    createPrivateKey: {
      value: (value: Buffer) => ({ marker: parseMarker(value, "ca-material-marker:") }),
    },
    X509Certificate: {
      value: class {
        readonly ca: boolean;
        readonly marker: string;

        constructor(value: Buffer) {
          this.marker = parseMarker(value, "ca-cert-marker:");
          this.ca = this.marker !== "not-ca";
        }

        checkPrivateKey(key: { marker?: string }): boolean {
          return key.marker === this.marker;
        }
      },
    },
  });
  return cryptoMock;
});
vi.mock("../infra/resolve-system-bin.js", () => ({ resolveSystemBin: resolveSystemBinMock }));
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runExec: runExecMock,
}));

import { ensureDebugProxyCa } from "./ca.js";

const tempDirs = createTrackedTempDirs();

function outputPath(args: string[], flag: "-config" | "-keyout" | "-out"): string {
  const index = args.indexOf(flag);
  const value = args[index + 1];
  if (!value) {
    throw new Error(`missing ${flag} output path`);
  }
  return value;
}

function writeGeneratedPair(args: string[], marker: string): void {
  fs.writeFileSync(outputPath(args, "-out"), `ca-cert-marker:${marker}`);
  fs.writeFileSync(outputPath(args, "-keyout"), `ca-material-marker:${marker}`);
}

async function makeCertPaths() {
  const certDir = await tempDirs.make("openclaw-proxy-ca-");
  return {
    certDir,
    certPath: path.join(certDir, "root-ca.pem"),
    keyPath: path.join(certDir, "root-ca-key.pem"),
  };
}

function generatePair(marker: string): void {
  runExecMock.mockImplementationOnce(async (_command: string, args: string[]) => {
    writeGeneratedPair(args, marker);
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  runExecMock.mockReset();
  await tempDirs.cleanup();
});

describe("ensureDebugProxyCa", () => {
  it("regenerates after partial output timeout without reusing stale final files", async () => {
    const { certDir, certPath, keyPath } = await makeCertPaths();
    fs.writeFileSync(certPath, "stale partial cert");
    fs.writeFileSync(keyPath, "stale partial key");
    let generatedConfig = "";
    runExecMock
      .mockImplementationOnce(async (_command: string, args: string[]) => {
        generatedConfig = fs.readFileSync(outputPath(args, "-config"), "utf8");
        fs.writeFileSync(outputPath(args, "-out"), "partial cert");
        fs.writeFileSync(outputPath(args, "-keyout"), "partial key");
        throw new Error("openssl timed out");
      })
      .mockImplementationOnce(async (_command: string, args: string[]) => {
        writeGeneratedPair(args, "retry");
      });

    await expect(ensureDebugProxyCa(certDir)).rejects.toThrow("openssl timed out");
    expect(fs.readFileSync(certPath, "utf8")).toBe("stale partial cert");
    expect(fs.readFileSync(keyPath, "utf8")).toBe("stale partial key");
    expect(fs.readdirSync(certDir).toSorted()).toEqual(["root-ca-key.pem", "root-ca.pem"]);

    await expect(
      Promise.all([ensureDebugProxyCa(certDir), ensureDebugProxyCa(certDir)]),
    ).resolves.toEqual([
      { certPath, keyPath },
      { certPath, keyPath },
    ]);
    expect(runExecMock).toHaveBeenCalledTimes(2);
    const [command, args, options] = runExecMock.mock.calls[0] as [string, string[], object];
    expect(command).toBe("/usr/bin/openssl");
    expect(args).toEqual(expect.arrayContaining(["req", "-extensions", "v3_ca", "-x509"]));
    expect(path.dirname(outputPath(args, "-config"))).toBe(path.dirname(outputPath(args, "-out")));
    expect(path.dirname(outputPath(args, "-out")).startsWith(`${certDir}${path.sep}`)).toBe(true);
    expect(options).toEqual({ logOutput: false, timeoutMs: 30_000 });
    expect(generatedConfig).toContain("CN = OpenClaw Debug Proxy");
    expect(generatedConfig).toContain("basicConstraints = critical, CA:TRUE");
    expect(generatedConfig).toContain("keyUsage = critical, keyCertSign, cRLSign");
  });

  it("rejects matching certificate material that is not a CA", async () => {
    const { certDir } = await makeCertPaths();
    generatePair("not-ca");

    await expect(ensureDebugProxyCa(certDir)).rejects.toThrow(
      "openssl generated invalid debug proxy certificate material",
    );

    expect(fs.readdirSync(certDir)).toEqual([]);
  });

  it("waits for a live lock owner before generating", async () => {
    const { certDir, certPath, keyPath } = await makeCertPaths();
    const lockPath = `${keyPath}.lock`;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date() }));
    generatePair("live-owner-retry");
    const releaseOwner = setTimeout(() => fs.rmSync(lockPath, { force: true }), 150);

    try {
      await expect(ensureDebugProxyCa(certDir)).resolves.toEqual({ certPath, keyPath });
    } finally {
      clearTimeout(releaseOwner);
    }

    expect(runExecMock).toHaveBeenCalledTimes(1);
  });

  it("recovers when publication is interrupted between the two renames", async () => {
    const { certDir, certPath, keyPath } = await makeCertPaths();
    fs.writeFileSync(certPath, "stale cert");
    fs.writeFileSync(keyPath, "stale key");
    runExecMock
      .mockImplementationOnce(async (_command: string, args: string[]) => {
        writeGeneratedPair(args, "failed-publication");
      })
      .mockImplementationOnce(async (_command: string, args: string[]) => {
        writeGeneratedPair(args, "retry-after-publication");
      });

    const renameSync = fs.renameSync.bind(fs);
    let rejectedPublishedCert = false;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      const sourcePath = source.toString();
      if (
        !rejectedPublishedCert &&
        destination.toString() === certPath &&
        sourcePath.includes(`${path.sep}.root-ca-`)
      ) {
        rejectedPublishedCert = true;
        throw Object.assign(new Error("certificate publication failed"), { code: "EACCES" });
      }
      renameSync(source, destination);
    });

    await expect(ensureDebugProxyCa(certDir)).rejects.toThrow("certificate publication failed");

    expect(fs.readFileSync(certPath, "utf8")).toBe("stale cert");
    expect(fs.readFileSync(keyPath, "utf8")).toBe("ca-material-marker:failed-publication");
    expect(fs.readdirSync(certDir).toSorted()).toEqual(["root-ca-key.pem", "root-ca.pem"]);

    renameSpy.mockRestore();
    await expect(ensureDebugProxyCa(certDir)).resolves.toEqual({ certPath, keyPath });

    expect(fs.readFileSync(certPath, "utf8")).toBe("ca-cert-marker:retry-after-publication");
    expect(fs.readFileSync(keyPath, "utf8")).toBe("ca-material-marker:retry-after-publication");
    expect(runExecMock).toHaveBeenCalledTimes(2);
  });
});
