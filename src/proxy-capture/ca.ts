// Proxy capture CA helpers create and inspect local capture CA certificates.
import { createHash, createPrivateKey, randomBytes, X509Certificate } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseCanonicalIpAddress } from "@openclaw/net-policy/ip";
import { type FileLockOptions, withFileLock } from "../infra/file-lock.js";
import { resolveSystemBin } from "../infra/resolve-system-bin.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import { runExec } from "../process/exec.js";

const DEBUG_PROXY_CA_GENERATION_TIMEOUT_MS = 30_000;
const LOCAL_PROXY_CERT_GENERATION_TIMEOUT_MS = 30_000;
const LOCAL_PROXY_DIR_MODE = 0o700;
const LOCAL_PROXY_PRIVATE_KEY_MODE = 0o600;

function buildLocalProxyCaOpenSslConfig(commonName: string): string {
  return [
    "[req]",
    "distinguished_name = subject",
    "prompt = no",
    "",
    "[subject]",
    `CN = ${commonName}`,
    "",
    "[v3_ca]",
    "basicConstraints = critical, CA:TRUE",
    "keyUsage = critical, keyCertSign, cRLSign",
    "",
  ].join("\n");
}
const DEBUG_PROXY_CA_LOCK_OPTIONS: FileLockOptions = {
  retries: {
    // About 36s of minimum backoff covers one full 30s OpenSSL deadline.
    retries: 80,
    factor: 1.3,
    minTimeout: 25,
    maxTimeout: 500,
    randomize: true,
  },
  stale: 60_000,
  staleRecovery: "remove-if-unchanged",
};
const debugProxyCaGenerationQueue = new KeyedAsyncQueue();

function isValidDebugProxyCaPair(certPath: string, keyPath: string): boolean {
  try {
    const certStat = fs.lstatSync(certPath);
    const keyStat = fs.lstatSync(keyPath);
    if (!certStat.isFile() || !keyStat.isFile() || certStat.size === 0 || keyStat.size === 0) {
      return false;
    }
    const cert = new X509Certificate(fs.readFileSync(certPath));
    const key = createPrivateKey(fs.readFileSync(keyPath));
    return cert.ca && cert.checkPrivateKey(key);
  } catch {
    return false;
  }
}

function removeStagingDirBestEffort(stagingDir: string): void {
  try {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  } catch {
    // Cleanup failure must not replace a successful publication result.
  }
}

type LocalProxyCaOptions = {
  commonName: string;
  purpose: string;
  validityDays: number;
};

type LocalProxyCaPair = {
  certPath: string;
  keyPath: string;
};

async function ensureLocalProxyCa(
  certDir: string,
  options: LocalProxyCaOptions,
): Promise<LocalProxyCaPair> {
  fs.mkdirSync(certDir, { recursive: true, mode: LOCAL_PROXY_DIR_MODE });
  fs.chmodSync(certDir, LOCAL_PROXY_DIR_MODE);
  const certPath = path.join(certDir, "root-ca.pem");
  const keyPath = path.join(certDir, "root-ca-key.pem");
  const canonicalKeyPath = path.join(fs.realpathSync(certDir), "root-ca-key.pem");
  return await debugProxyCaGenerationQueue.enqueue(canonicalKeyPath, async () =>
    withFileLock(canonicalKeyPath, DEBUG_PROXY_CA_LOCK_OPTIONS, async () => {
      if (isValidDebugProxyCaPair(certPath, keyPath)) {
        return { certPath, keyPath };
      }
      const openssl = resolveSystemBin("openssl");
      if (!openssl) {
        throw new Error(`openssl is required to generate ${options.purpose} certificates`);
      }
      const stagingDir = fs.mkdtempSync(path.join(certDir, ".root-ca-"));
      const stagedConfigPath = path.join(stagingDir, "openssl.cnf");
      const stagedCertPath = path.join(stagingDir, "root-ca.pem");
      const stagedKeyPath = path.join(stagingDir, "root-ca-key.pem");
      try {
        fs.writeFileSync(stagedConfigPath, buildLocalProxyCaOpenSslConfig(options.commonName), {
          mode: LOCAL_PROXY_PRIVATE_KEY_MODE,
        });
        await runExec(
          openssl,
          [
            "req",
            "-config",
            stagedConfigPath,
            "-extensions",
            "v3_ca",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-sha256",
            "-days",
            String(options.validityDays),
            "-nodes",
            "-keyout",
            stagedKeyPath,
            "-out",
            stagedCertPath,
          ],
          { logOutput: false, timeoutMs: DEBUG_PROXY_CA_GENERATION_TIMEOUT_MS },
        );
        if (!isValidDebugProxyCaPair(stagedCertPath, stagedKeyPath)) {
          throw new Error(`openssl generated invalid ${options.purpose} certificate material`);
        }
        fs.chmodSync(stagedKeyPath, LOCAL_PROXY_PRIVATE_KEY_MODE);
        fs.chmodSync(stagedCertPath, 0o644);
        // All OpenClaw writers hold this lock. Same-directory renames replace each
        // file atomically; validation repairs a pair interrupted between renames.
        fs.renameSync(stagedKeyPath, keyPath);
        fs.renameSync(stagedCertPath, certPath);
        return { certPath, keyPath };
      } finally {
        removeStagingDirBestEffort(stagingDir);
      }
    }),
  );
}

// Ensure a short-lived root CA for local MITM debug proxy runs. Existing certs
// are reused within the cert dir so repeated starts do not prompt regeneration.
export async function ensureDebugProxyCa(certDir: string): Promise<{
  certPath: string;
  keyPath: string;
}> {
  return await ensureLocalProxyCa(certDir, {
    commonName: "OpenClaw Debug Proxy",
    purpose: "debug proxy",
    validityDays: 7,
  });
}

/** Generates the root CA for one Gateway-lifetime secret egress proxy. */
export async function ensureSecretEgressProxyCa(certDir: string): Promise<LocalProxyCaPair> {
  return await ensureLocalProxyCa(certDir, {
    commonName: "OpenClaw Secret Egress Proxy",
    purpose: "secret egress proxy",
    validityDays: 1,
  });
}

function isValidLeafPair(params: { certPath: string; keyPath: string; hostname: string }): boolean {
  try {
    const cert = new X509Certificate(fs.readFileSync(params.certPath));
    const key = createPrivateKey(fs.readFileSync(params.keyPath));
    const hostMatches = parseCanonicalIpAddress(params.hostname)
      ? cert.checkIP(params.hostname) === params.hostname
      : cert.checkHost(params.hostname) === params.hostname;
    return !cert.ca && cert.checkPrivateKey(key) && hostMatches;
  } catch {
    return false;
  }
}

async function generateLocalProxyLeafQueued(params: {
  certDir: string;
  ca: LocalProxyCaPair;
  hostname: string;
}): Promise<{ cert: Buffer; key: Buffer }> {
  const openssl = resolveSystemBin("openssl");
  if (!openssl) {
    throw new Error("openssl is required to generate local proxy certificates");
  }
  const leafKeyPath = path.join(params.certDir, "leaf-key.pem");
  if (!fs.existsSync(leafKeyPath)) {
    await runExec(openssl, ["genrsa", "-out", leafKeyPath, "2048"], {
      logOutput: false,
      timeoutMs: LOCAL_PROXY_CERT_GENERATION_TIMEOUT_MS,
    });
    fs.chmodSync(leafKeyPath, LOCAL_PROXY_PRIVATE_KEY_MODE);
  }
  const leafId = createHash("sha256").update(params.hostname).digest("hex");
  const stagingDir = fs.mkdtempSync(path.join(params.certDir, `.leaf-${leafId.slice(0, 12)}-`));
  const csrPath = path.join(stagingDir, "leaf.csr");
  const certPath = path.join(stagingDir, "leaf.pem");
  const extPath = path.join(stagingDir, "leaf.ext");
  try {
    const sanKind = parseCanonicalIpAddress(params.hostname) ? "IP" : "DNS";
    fs.writeFileSync(
      extPath,
      `subjectAltName=${sanKind}:${params.hostname}\nextendedKeyUsage=serverAuth\n`,
      { mode: LOCAL_PROXY_PRIVATE_KEY_MODE },
    );
    await runExec(
      openssl,
      ["req", "-new", "-key", leafKeyPath, "-subj", `/CN=${params.hostname}`, "-out", csrPath],
      { logOutput: false, timeoutMs: LOCAL_PROXY_CERT_GENERATION_TIMEOUT_MS },
    );
    await runExec(
      openssl,
      [
        "x509",
        "-req",
        "-in",
        csrPath,
        "-CA",
        params.ca.certPath,
        "-CAkey",
        params.ca.keyPath,
        "-set_serial",
        `0x${randomBytes(16).toString("hex")}`,
        "-out",
        certPath,
        "-days",
        "1",
        "-sha256",
        "-extfile",
        extPath,
      ],
      { logOutput: false, timeoutMs: LOCAL_PROXY_CERT_GENERATION_TIMEOUT_MS },
    );
    if (!isValidLeafPair({ certPath, keyPath: leafKeyPath, hostname: params.hostname })) {
      throw new Error("openssl generated invalid local proxy leaf certificate material");
    }
    return {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(leafKeyPath),
    };
  } finally {
    removeStagingDirBestEffort(stagingDir);
  }
}

/** Mints one on-demand TLS leaf signed by a local proxy CA. */
export async function generateLocalProxyLeaf(params: {
  certDir: string;
  ca: LocalProxyCaPair;
  hostname: string;
}): Promise<{ cert: Buffer; key: Buffer }> {
  const queueKey = path.join(fs.realpathSync(params.certDir), "leaf-key.pem");
  return await debugProxyCaGenerationQueue.enqueue(queueKey, () =>
    generateLocalProxyLeafQueued(params),
  );
}
