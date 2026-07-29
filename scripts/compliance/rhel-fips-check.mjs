#!/usr/bin/env node

// Reports runtime evidence for the Red Hat FIPS deployment profile.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import process from "node:process";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const PROFILE = "rhel-fips";
const SCHEMA_VERSION = 1;

function parseOsRelease(raw) {
  const values = {};
  for (const line of raw.split(/\r?\n/u)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/u);
    if (!match) {
      continue;
    }
    const [, key, encoded] = match;
    values[key] = encoded.replace(/^"(.*)"$/u, "$1").replace(/\\"/gu, '"');
  }
  return values;
}

function readTextFile(path, fsImpl = fs) {
  try {
    return fsImpl.readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function isTruthyBuildFlag(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function probe(name, fn) {
  try {
    fn();
    return { name, ok: true };
  } catch (error) {
    return {
      name,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function check(params) {
  return {
    required: true,
    remediation: undefined,
    ...params,
  };
}

function isSupportedNodeVersion(version) {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)/u);
  if (!match) {
    return false;
  }
  const [, majorRaw, minorRaw, patchRaw] = match;
  const major = Number.parseInt(majorRaw, 10);
  const minor = Number.parseInt(minorRaw, 10);
  const patch = Number.parseInt(patchRaw, 10);
  if (major === 22) {
    return minor > 22 || (minor === 22 && patch >= 3);
  }
  if (major === 24) {
    return minor >= 15;
  }
  if (major === 25) {
    return minor >= 9;
  }
  return major >= 26;
}

export function evaluateRhelFipsChecks(evidence) {
  const redHatVersionMatch = (evidence.osRelease.VERSION_ID ?? "").match(/^(\d+)(?:\.(\d+))?/u);
  const redHatMajor = Number.parseInt(redHatVersionMatch?.[1] ?? "", 10);
  const redHatMinor = Number.parseInt(redHatVersionMatch?.[2] ?? "0", 10);
  const supportedRedHatVersion =
    Number.isFinite(redHatMajor) &&
    Number.isFinite(redHatMinor) &&
    redHatMajor === 9 &&
    redHatMinor >= 7;
  const requiredAlgorithms = new Set(evidence.crypto.hashes);
  const requiredCiphers = new Set(evidence.crypto.ciphers);
  const requiredCurves = new Set(evidence.crypto.curves);
  const algorithmFailures = [
    ...["sha256", "sha384", "sha512"].filter((name) => !requiredAlgorithms.has(name)),
    ...["aes-256-gcm"].filter((name) => !requiredCiphers.has(name)),
    ...["prime256v1", "secp384r1"].filter((name) => !requiredCurves.has(name)),
    ...evidence.crypto.primitiveProbes.filter((entry) => !entry.ok).map((entry) => entry.name),
  ];

  return [
    check({
      id: "runtime.red_hat_enterprise_linux",
      status:
        evidence.platform === "linux" && evidence.osRelease.ID === "rhel" && supportedRedHatVersion
          ? "pass"
          : "fail",
      detail: `${evidence.osRelease.PRETTY_NAME ?? evidence.platform} (${evidence.arch})`,
      remediation:
        "Run the profile on RHEL 9.7 or a later RHEL 9 release, or a supported Red Hat UBI 9 Node.js image.",
    }),
    check({
      id: "runtime.node_shared_openssl",
      status: evidence.node.sharedOpenSsl ? "pass" : "fail",
      detail: `Node ${evidence.node.version} uses OpenSSL ${evidence.node.openSslVersion}; shared=${String(evidence.node.sharedOpenSsl)}`,
      remediation: "Use the Red Hat build of Node.js linked to the RHEL system OpenSSL.",
    }),
    check({
      id: "runtime.node_supported_version",
      status: isSupportedNodeVersion(evidence.node.version) ? "pass" : "fail",
      detail: `Node ${evidence.node.version}`,
      remediation: "Install a supported Red Hat Node.js release; this profile ships Node.js 24.",
    }),
    check({
      id: "runtime.kernel_fips_enabled",
      status:
        evidence.fips.kernelIndicator === "1"
          ? "pass"
          : evidence.fips.kernelIndicator === "0"
            ? "fail"
            : "skip",
      detail: `/proc/sys/crypto/fips_enabled=${evidence.fips.kernelIndicator ?? "unavailable"}`,
      remediation:
        "Install or boot the RHEL/OpenShift host in FIPS mode and retain host-level evidence; containers may not expose this kernel indicator.",
    }),
    check({
      id: "runtime.node_fips_enabled",
      status: evidence.fips.nodeEnabled ? "pass" : "fail",
      detail: `crypto.getFips()=${evidence.fips.nodeEnabled ? "1" : "0"}`,
      remediation:
        "Verify the Red Hat Node.js build, system OpenSSL configuration, and host FIPS mode.",
    }),
    check({
      id: "runtime.openssl_cli",
      status: evidence.openSslCli.ok ? "pass" : "warn",
      required: false,
      detail: evidence.openSslCli.ok
        ? evidence.openSslCli.version
        : `openssl CLI unavailable: ${evidence.openSslCli.error}`,
      remediation:
        "Install the RHEL openssl package when certificate inspection or local tooling needs the CLI.",
    }),
    check({
      id: "runtime.node_sqlite",
      status: evidence.node.sqliteAvailable ? "pass" : "fail",
      detail: evidence.node.sqliteAvailable ? "node:sqlite available" : evidence.node.sqliteError,
      remediation: "Use a supported Red Hat Node.js 24 build with node:sqlite enabled.",
    }),
    check({
      id: "crypto.required_primitives",
      status: algorithmFailures.length === 0 ? "pass" : "fail",
      detail:
        algorithmFailures.length === 0
          ? "SHA-2, HMAC-SHA-256, AES-256-GCM, approved EC curves, and CSPRNG available"
          : `missing or failed: ${algorithmFailures.join(", ")}`,
      remediation: "Repair the active OpenSSL FIPS provider and system cryptographic policy.",
    }),
    check({
      id: "crypto.tls13_secure_context",
      status: evidence.crypto.tls13.ok ? "pass" : "fail",
      detail: evidence.crypto.tls13.ok
        ? "TLS 1.3 secure context available"
        : evidence.crypto.tls13.error,
      remediation: "Use the supported RHEL system OpenSSL and DEFAULT or FIPS crypto policy.",
    }),
    check({
      id: "crypto.legacy_md4_unavailable",
      status: evidence.crypto.md4Available ? "warn" : "pass",
      required: false,
      detail: evidence.crypto.md4Available
        ? "MD4 remains available in the active provider set"
        : "MD4 unavailable",
      remediation: "Check for accidental legacy-provider activation in OpenSSL configuration.",
    }),
    check({
      id: "compat.openclaw_ed25519",
      status: "warn",
      required: false,
      detail: evidence.crypto.ed25519.ok
        ? "Ed25519 is available; inventory device identity and browser crypto as outside-boundary paths"
        : `Ed25519 unavailable: ${evidence.crypto.ed25519.error}`,
      remediation:
        "Approve, isolate, disable, or replace OpenClaw features whose cryptography is outside the validated module boundary.",
    }),
  ];
}

export async function collectRhelFipsEvidence(options = {}) {
  const fsImpl = options.fsImpl ?? fs;
  const execFileSyncImpl = options.execFileSyncImpl ?? execFileSync;
  const cryptoImpl = options.cryptoImpl ?? crypto;
  const tlsImpl = options.tlsImpl ?? tls;
  const osRelease = parseOsRelease(readTextFile("/etc/os-release", fsImpl) ?? "");
  const primitiveProbes = [
    probe("sha256", () => cryptoImpl.createHash("sha256").update("openclaw").digest()),
    probe("hmac-sha256", () =>
      cryptoImpl.createHmac("sha256", Buffer.alloc(32, 1)).update("openclaw").digest(),
    ),
    probe("aes-256-gcm", () =>
      cryptoImpl.createCipheriv("aes-256-gcm", Buffer.alloc(32), Buffer.alloc(12)),
    ),
    probe("random-bytes", () => cryptoImpl.randomBytes(32)),
  ];
  const tls13 = probe("tls13", () => tlsImpl.createSecureContext({ minVersion: "TLSv1.3" }));
  const ed25519 = probe("ed25519", () => {
    const { privateKey, publicKey } = cryptoImpl.generateKeyPairSync("ed25519");
    const payload = Buffer.from("openclaw-rhel-fips-check", "utf8");
    const signature = cryptoImpl.sign(null, payload, privateKey);
    if (!cryptoImpl.verify(null, payload, publicKey, signature)) {
      throw new Error("sign/verify round trip failed");
    }
  });
  let md4Available;
  try {
    cryptoImpl.createHash("md4");
    md4Available = true;
  } catch {
    md4Available = false;
  }

  let openSslCli;
  try {
    openSslCli = {
      ok: true,
      version: execFileSyncImpl("openssl", ["version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
      }).trim(),
    };
  } catch (error) {
    openSslCli = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      version: "",
    };
  }

  let sqliteAvailable = false;
  let sqliteError = "";
  try {
    await import("node:sqlite");
    sqliteAvailable = true;
  } catch (error) {
    sqliteError = error instanceof Error ? error.message : String(error);
  }

  return {
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch,
    hostname: options.hostname ?? os.hostname(),
    osRelease,
    node: {
      version: process.version,
      openSslVersion: process.versions.openssl,
      sharedOpenSsl: isTruthyBuildFlag(process.config.variables.node_shared_openssl),
      sqliteAvailable,
      sqliteError,
    },
    fips: {
      kernelIndicator: readTextFile("/proc/sys/crypto/fips_enabled", fsImpl),
      systemMarkerPresent: fsImpl.existsSync("/etc/system-fips"),
      nodeEnabled: cryptoImpl.getFips() === 1,
    },
    openSslCli,
    crypto: {
      hashes: cryptoImpl.getHashes(),
      ciphers: cryptoImpl.getCiphers(),
      curves: cryptoImpl.getCurves(),
      primitiveProbes,
      tls13,
      md4Available,
      ed25519,
    },
  };
}

export function createRhelFipsReport(evidence, now = Date.now()) {
  const checks = evaluateRhelFipsChecks(evidence);
  const summary = {
    pass: checks.filter((entry) => entry.status === "pass").length,
    fail: checks.filter((entry) => entry.status === "fail").length,
    warn: checks.filter((entry) => entry.status === "warn").length,
    skip: checks.filter((entry) => entry.status === "skip").length,
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    profile: PROFILE,
    generatedAt: new Date(now).toISOString(),
    ok: !checks.some((entry) => entry.required && entry.status === "fail"),
    runtime: {
      platform: evidence.platform,
      arch: evidence.arch,
      hostname: evidence.hostname,
      os: evidence.osRelease.PRETTY_NAME ?? evidence.osRelease.ID ?? "unknown",
      node: evidence.node.version,
      openssl: evidence.node.openSslVersion,
    },
    summary,
    checks,
    limitations: [
      "This report is runtime evidence, not a FIPS 140 validation or FedRAMP authorization.",
      "Application, browser, plugin, native-addon, WASM, and child-process cryptography require separate inventory.",
      "Run final validation on the production RHEL/OpenShift host installed or booted in FIPS mode.",
      "A container may not expose the host kernel FIPS indicator; retain host or cluster installation evidence when this check is skipped.",
    ],
  };
}

export function formatRhelFipsReport(report) {
  const lines = [
    `OpenClaw ${report.profile} compliance preflight`,
    `runtime: ${report.runtime.os}; Node ${report.runtime.node}; OpenSSL ${report.runtime.openssl}`,
    `summary: ${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.warn} warn`,
  ];
  for (const entry of report.checks) {
    lines.push(`[${entry.status.toUpperCase()}] ${entry.id}: ${entry.detail}`);
    if (entry.status !== "pass" && entry.remediation) {
      lines.push(`  fix: ${entry.remediation}`);
    }
  }
  for (const limitation of report.limitations) {
    lines.push(`note: ${limitation}`);
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  let json = false;
  let help = false;
  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
    } else if (arg === "-h" || arg === "--help") {
      help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { help, json };
}

function printHelp() {
  console.log(`Usage: node scripts/compliance/rhel-fips-check.mjs [--json]

Reports Red Hat, shared-OpenSSL, kernel FIPS, Node FIPS, TLS, SQLite, and
application crypto-boundary evidence. Exits 1 when a required check fails.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }
  const report = createRhelFipsReport(await collectRhelFipsEvidence());
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatRhelFipsReport(report)}\n`);
  }
  return report.ok ? 0 : 1;
}

/** @param {unknown} error */
function reportFatalError(error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("[rhel-fips-check] FAILED (exit 2)");
  process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .then((exitCode) => {
      if (exitCode !== 0) {
        console.error(`[rhel-fips-check] FAILED (exit ${exitCode})`);
      }
      process.exitCode = exitCode;
    })
    .catch(reportFatalError);
}
