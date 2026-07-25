// Gateway TLS runtime loads configured certificates or generates a local
// self-signed pair, returning server-ready options plus client fingerprint.
import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import tls from "node:tls";
import type { GatewayTlsConfig } from "../../config/types.gateway.js";
import { runExec } from "../../process/exec.js";
import { CONFIG_DIR, ensureDir, resolveUserPath, shortenHomeInString } from "../../utils.js";
import { pathExists } from "../fs-safe.js";
import { resolveSystemBin } from "../resolve-system-bin.js";
import { normalizeFingerprint } from "./fingerprint.js";

const GATEWAY_TLS_CERT_GENERATION_TIMEOUT_MS = 30_000;

type GatewayTlsLog = {
  info?: (message: string) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
};

type GatewayTlsDegradation = {
  event: "gateway.tls.degraded";
  ownerKind: "gateway";
  ownerId: "tls";
  reason: "atomic hard-link publication unavailable";
  state: "best-effort";
};

const GATEWAY_TLS_DEGRADATION: GatewayTlsDegradation = {
  event: "gateway.tls.degraded",
  ownerKind: "gateway",
  ownerId: "tls",
  reason: "atomic hard-link publication unavailable",
  state: "best-effort",
};

function isHardLinkUnsupportedError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EPERM";
}

async function publishGeneratedTlsOutput(
  stagedPath: string,
  finalPath: string,
  contents: string,
): Promise<boolean> {
  try {
    await fs.link(stagedPath, finalPath);
    return false;
  } catch (error) {
    if (!isHardLinkUnsupportedError(error)) {
      throw error;
    }
  }

  // Some supported filesystems cannot publish with hard links. An exclusive handle keeps
  // no-overwrite semantics without pathname cleanup that could delete concurrent output;
  // a failed best-effort write may leave this attempt's partial file for operator cleanup.
  const handle = await fs.open(finalPath, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

// Gateway TLS runtime carries loaded cert material plus the normalized SHA-256
// fingerprint advertised to clients.
export type GatewayTlsRuntime = {
  enabled: boolean;
  required: boolean;
  certPath?: string;
  keyPath?: string;
  caPath?: string;
  fingerprintSha256?: string;
  tlsOptions?: tls.TlsOptions;
  error?: string;
};

async function generateSelfSignedCert(params: {
  certPath: string;
  keyPath: string;
  log?: GatewayTlsLog;
}): Promise<void> {
  const certDir = path.dirname(params.certPath);
  const keyDir = path.dirname(params.keyPath);
  await ensureDir(certDir);
  if (keyDir !== certDir) {
    await ensureDir(keyDir);
  }
  const opensslBin = resolveSystemBin("openssl");
  if (!opensslBin) {
    throw new Error(
      "openssl not found in trusted system directories. Install it in an OS-managed location.",
    );
  }
  const certStageDir = await fs.mkdtemp(path.join(certDir, ".openclaw-gateway-tls-cert-"));
  const stagedCertPath = path.join(certStageDir, "cert.pem");
  let keyStageDir: string | undefined;
  try {
    keyStageDir = await fs.mkdtemp(path.join(keyDir, ".openclaw-gateway-tls-key-"));
    const stagedKeyPath = path.join(keyStageDir, "key.pem");
    await Promise.all([fs.chmod(certStageDir, 0o700), fs.chmod(keyStageDir, 0o700)]);
    // OpenSSL never sees the configured final paths, so timeout and generation
    // failures cannot strand a half-written certificate pair there.
    await runExec(
      opensslBin,
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-days",
        "3650",
        "-nodes",
        "-keyout",
        stagedKeyPath,
        "-out",
        stagedCertPath,
        "-subj",
        "/CN=openclaw-gateway",
      ],
      {
        logOutput: false,
        timeoutMs: GATEWAY_TLS_CERT_GENERATION_TIMEOUT_MS,
      },
    );
    await Promise.all([fs.chmod(stagedKeyPath, 0o600), fs.chmod(stagedCertPath, 0o600)]);
    const [cert, key] = await Promise.all([
      fs.readFile(stagedCertPath, "utf8"),
      fs.readFile(stagedKeyPath, "utf8"),
    ]);
    tls.createSecureContext({ cert, key, minVersion: "TLSv1.3" });
    let usedBestEffortPublication = await publishGeneratedTlsOutput(
      stagedCertPath,
      params.certPath,
      cert,
    );
    usedBestEffortPublication =
      (await publishGeneratedTlsOutput(stagedKeyPath, params.keyPath, key)) ||
      usedBestEffortPublication;
    if (usedBestEffortPublication) {
      params.log?.warn?.(
        `[GATEWAY_TLS_DEGRADED] best-effort gateway:tls: ${GATEWAY_TLS_DEGRADATION.reason}.`,
        GATEWAY_TLS_DEGRADATION,
      );
    }
    params.log?.info?.(
      `gateway tls: generated self-signed cert at ${shortenHomeInString(params.certPath)}`,
    );
  } finally {
    await Promise.allSettled(
      [certStageDir, keyStageDir]
        .filter((dir): dir is string => Boolean(dir))
        .map((dir) => fs.rm(dir, { force: true, recursive: true })),
    );
  }
}

/** Load or generate gateway TLS material and return server-ready TLS options. */
export async function loadGatewayTlsRuntime(
  cfg: GatewayTlsConfig | undefined,
  log?: GatewayTlsLog,
): Promise<GatewayTlsRuntime> {
  if (!cfg || cfg.enabled !== true) {
    return { enabled: false, required: false };
  }

  const autoGenerate = cfg.autoGenerate !== false;
  const baseDir = path.join(CONFIG_DIR, "gateway", "tls");
  // Only blank/whitespace values fall back to the default. Any non-empty path is
  // passed through verbatim so resolveUserPath owns all normalization (it trims
  // and expands ~); trimming here would duplicate it and silently rewrite paths
  // that contain leading/trailing spaces.
  const certPath = resolveUserPath(
    typeof cfg.certPath === "string" && cfg.certPath.trim()
      ? cfg.certPath
      : path.join(baseDir, "gateway-cert.pem"),
  );
  const keyPath = resolveUserPath(
    typeof cfg.keyPath === "string" && cfg.keyPath.trim()
      ? cfg.keyPath
      : path.join(baseDir, "gateway-key.pem"),
  );
  const caPath = cfg.caPath ? resolveUserPath(cfg.caPath) : undefined;

  const hasCert = await pathExists(certPath);
  const hasKey = await pathExists(keyPath);

  if (!hasCert && !hasKey && autoGenerate) {
    try {
      await generateSelfSignedCert({ certPath, keyPath, log });
    } catch (err) {
      return {
        enabled: false,
        required: true,
        certPath,
        keyPath,
        error: `gateway tls: failed to generate cert (${String(err)})`,
      };
    }
  }

  if (!(await pathExists(certPath)) || !(await pathExists(keyPath))) {
    return {
      enabled: false,
      required: true,
      certPath,
      keyPath,
      error: "gateway tls: cert/key missing",
    };
  }

  try {
    const cert = await fs.readFile(certPath, "utf8");
    const key = await fs.readFile(keyPath, "utf8");
    const ca = caPath ? await fs.readFile(caPath, "utf8") : undefined;
    const x509 = new X509Certificate(cert);
    const fingerprintSha256 = normalizeFingerprint(x509.fingerprint256 ?? "");

    if (!fingerprintSha256) {
      return {
        enabled: false,
        required: true,
        certPath,
        keyPath,
        caPath,
        error: "gateway tls: unable to compute certificate fingerprint",
      };
    }

    return {
      enabled: true,
      required: true,
      certPath,
      keyPath,
      caPath,
      fingerprintSha256,
      tlsOptions: {
        cert,
        key,
        ca,
        minVersion: "TLSv1.3",
      },
    };
  } catch (err) {
    return {
      enabled: false,
      required: true,
      certPath,
      keyPath,
      caPath,
      error: `gateway tls: failed to load cert (${String(err)})`,
    };
  }
}
