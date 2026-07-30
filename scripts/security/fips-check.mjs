#!/usr/bin/env node

// Reports whether the active Node.js process is using FIPS mode.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import process from "node:process";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = 1;

function readTextFile(path, fsImpl = fs) {
  try {
    return fsImpl.readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
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

function parseNodeOptions(nodeOptions) {
  const argv = [];
  let inString = false;
  let startsNewArg = true;

  // Match Node's ParseNodeOptionsEnvVar contract: spaces delimit arguments,
  // double quotes group them, and backslashes escape only inside quotes.
  for (let index = 0; index < nodeOptions.length; index += 1) {
    let character = nodeOptions[index];
    if (character === "\\" && inString) {
      index += 1;
      if (index === nodeOptions.length) {
        return null;
      }
      character = nodeOptions[index];
    } else if (character === " " && !inString) {
      startsNewArg = true;
      continue;
    } else if (character === '"') {
      inString = !inString;
      continue;
    }

    if (startsNewArg) {
      argv.push(character);
      startsNewArg = false;
    } else {
      argv[argv.length - 1] += character;
    }
  }

  return inString ? null : argv;
}

function normalizeNodeOptionName(arg) {
  const valueSeparator = arg.indexOf("=");
  const name = valueSeparator === -1 ? arg : arg.slice(0, valueSeparator);
  const normalizedName = name.replaceAll("_", "-");
  return valueSeparator === -1 ? normalizedName : normalizedName + arg.slice(valueSeparator);
}

function hasNodeOption(nodeOptionsArgv, execArgv, option) {
  return (
    Boolean(nodeOptionsArgv?.some((arg) => normalizeNodeOptionName(arg) === option)) ||
    execArgv.some((arg) => normalizeNodeOptionName(arg) === option)
  );
}

function hasValuedOption(argv, option) {
  return argv.some((arg, index) => {
    const normalizedArg = normalizeNodeOptionName(arg);
    if (normalizedArg.startsWith(`${option}=`)) {
      return normalizedArg.length > option.length + 1;
    }
    return normalizedArg === option && Boolean(argv[index + 1]?.trim());
  });
}

function hasValuedNodeOption(nodeOptionsArgv, execArgv, option) {
  return (
    Boolean(nodeOptionsArgv && hasValuedOption(nodeOptionsArgv, option)) ||
    hasValuedOption(execArgv, option)
  );
}

export function evaluateFipsChecks(evidence) {
  const probesByName = new Map(evidence.crypto.primitiveProbes.map((entry) => [entry.name, entry]));
  const requiredProbeNames = [
    "sha256",
    "sha384",
    "sha512",
    "hmac-sha256",
    "aes-256-gcm",
    "ecdh-prime256v1",
    "ecdh-secp384r1",
    "random-bytes",
  ];
  const algorithmFailures = requiredProbeNames.filter((name) => !probesByName.get(name)?.ok);
  const activationConfigured =
    evidence.activation.enableFipsFlag ||
    evidence.activation.forceFipsFlag ||
    evidence.activation.opensslConfig ||
    evidence.activation.opensslModules;

  return [
    check({
      id: "runtime.node_supported_version",
      status: isSupportedNodeVersion(evidence.node.version) ? "pass" : "fail",
      detail: `Node ${evidence.node.version}`,
      remediation: "Use a Node.js release supported by OpenClaw.",
    }),
    check({
      id: "runtime.node_fips_enabled",
      status: evidence.node.fipsEnabled ? "pass" : "fail",
      detail: `crypto.getFips()=${evidence.node.fipsEnabled ? "1" : "0"}`,
      remediation:
        "Activate a validated OpenSSL provider before Node starts, then rerun this check in the final runtime.",
    }),
    check({
      id: "runtime.fips_activation",
      status: evidence.node.fipsEnabled ? "pass" : activationConfigured ? "warn" : "skip",
      required: false,
      detail: evidence.node.fipsEnabled
        ? "FIPS mode is active"
        : activationConfigured
          ? "FIPS startup inputs are present, but Node did not enter FIPS mode"
          : "No FIPS startup input was detected",
      remediation:
        "Verify the runtime's OpenSSL configuration, provider module path, and Node FIPS startup flags.",
    }),
    check({
      id: "runtime.kernel_fips_indicator",
      status:
        evidence.kernelIndicator === "1"
          ? "pass"
          : evidence.kernelIndicator === "0"
            ? "warn"
            : "skip",
      required: false,
      detail: `/proc/sys/crypto/fips_enabled=${evidence.kernelIndicator ?? "unavailable"}`,
      remediation:
        "Retain platform-level FIPS evidence when the container cannot expose the host indicator.",
    }),
    check({
      id: "runtime.openssl_cli",
      status: evidence.openSslCli.ok ? "pass" : "skip",
      required: false,
      detail: evidence.openSslCli.ok
        ? evidence.openSslCli.version
        : `openssl CLI unavailable: ${evidence.openSslCli.error}`,
      remediation: "Add the OpenSSL CLI only when runtime diagnostics require it.",
    }),
    check({
      id: "crypto.required_primitives",
      status: algorithmFailures.length === 0 ? "pass" : "fail",
      detail:
        algorithmFailures.length === 0
          ? "SHA-2, HMAC-SHA-256, AES-256-GCM, approved EC curves, and CSPRNG available"
          : `missing or failed: ${algorithmFailures.join(", ")}`,
      remediation: "Verify the active provider configuration and approved algorithm policy.",
    }),
    check({
      id: "crypto.tls13_secure_context",
      status: evidence.crypto.tls13.ok ? "pass" : "fail",
      detail: evidence.crypto.tls13.ok
        ? "TLS 1.3 secure context available"
        : evidence.crypto.tls13.error,
      remediation: "Use a FIPS-capable Node/OpenSSL runtime with TLS 1.3 enabled.",
    }),
    check({
      id: "crypto.legacy_md4_unavailable",
      status: evidence.crypto.md4Available ? "warn" : "pass",
      required: false,
      detail: evidence.crypto.md4Available
        ? "MD4 remains available in the active provider set"
        : "MD4 unavailable",
      remediation: "Check for accidental legacy-provider activation.",
    }),
    check({
      id: "inventory.ed25519",
      status: evidence.crypto.ed25519.ok ? "warn" : "skip",
      required: false,
      detail: evidence.crypto.ed25519.ok
        ? "Ed25519 is available; availability does not establish validated-module coverage"
        : `Ed25519 unavailable: ${evidence.crypto.ed25519.error}`,
      remediation:
        "Inventory protocol, plugin, browser, native-addon, WASM, and child-process cryptography separately.",
    }),
  ];
}

export function collectFipsEvidence(options = {}) {
  const fsImpl = options.fsImpl ?? fs;
  const execFileSyncImpl = options.execFileSyncImpl ?? execFileSync;
  const cryptoImpl = options.cryptoImpl ?? crypto;
  const tlsImpl = options.tlsImpl ?? tls;
  const env = options.env ?? process.env;
  const execArgv = options.execArgv ?? process.execArgv;
  const nodeOptionsArgv = parseNodeOptions(env.NODE_OPTIONS ?? "");
  const primitiveProbes = [
    probe("sha256", () => cryptoImpl.createHash("sha256").update("openclaw").digest()),
    probe("sha384", () => cryptoImpl.createHash("sha384").update("openclaw").digest()),
    probe("sha512", () => cryptoImpl.createHash("sha512").update("openclaw").digest()),
    probe("hmac-sha256", () =>
      cryptoImpl.createHmac("sha256", Buffer.alloc(32, 1)).update("openclaw").digest(),
    ),
    probe("aes-256-gcm", () => {
      const cipher = cryptoImpl.createCipheriv("aes-256-gcm", Buffer.alloc(32), Buffer.alloc(12));
      cipher.update("openclaw");
      cipher.final();
      cipher.getAuthTag();
    }),
    probe("ecdh-prime256v1", () => cryptoImpl.createECDH("prime256v1").generateKeys()),
    probe("ecdh-secp384r1", () => cryptoImpl.createECDH("secp384r1").generateKeys()),
    probe("random-bytes", () => cryptoImpl.randomBytes(32)),
  ];
  const tls13 = probe("tls13", () => tlsImpl.createSecureContext({ minVersion: "TLSv1.3" }));
  const ed25519 = probe("ed25519", () => {
    const { privateKey, publicKey } = cryptoImpl.generateKeyPairSync("ed25519");
    const payload = Buffer.from("openclaw-fips-check", "utf8");
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
    const output = execFileSyncImpl("openssl", ["version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    }).trim();
    openSslCli = {
      ok: true,
      version: output.split(/\r?\n/u)[0] ?? output,
    };
  } catch (error) {
    openSslCli = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      version: "",
    };
  }

  return {
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch,
    hostname: options.hostname ?? os.hostname(),
    node: {
      version: options.nodeVersion ?? process.version,
      openSslVersion: options.openSslVersion ?? process.versions.openssl,
      fipsEnabled: cryptoImpl.getFips() === 1,
    },
    activation: {
      enableFipsFlag: hasNodeOption(nodeOptionsArgv, execArgv, "--enable-fips"),
      forceFipsFlag: hasNodeOption(nodeOptionsArgv, execArgv, "--force-fips"),
      opensslConfig:
        Boolean(env.OPENSSL_CONF?.trim()) ||
        hasValuedNodeOption(nodeOptionsArgv, execArgv, "--openssl-config"),
      opensslModules: Boolean(env.OPENSSL_MODULES?.trim()),
    },
    kernelIndicator: readTextFile("/proc/sys/crypto/fips_enabled", fsImpl),
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

export function createFipsReport(evidence, now = Date.now()) {
  const checks = evaluateFipsChecks(evidence);
  const summary = {
    pass: checks.filter((entry) => entry.status === "pass").length,
    fail: checks.filter((entry) => entry.status === "fail").length,
    warn: checks.filter((entry) => entry.status === "warn").length,
    skip: checks.filter((entry) => entry.status === "skip").length,
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "openclaw-fips-runtime-report",
    generatedAt: new Date(now).toISOString(),
    ok: !checks.some((entry) => entry.required && entry.status === "fail"),
    runtime: {
      platform: evidence.platform,
      arch: evidence.arch,
      hostname: evidence.hostname,
      node: evidence.node.version,
      openssl: evidence.node.openSslVersion,
    },
    activation: evidence.activation,
    summary,
    checks,
    limitations: [
      "This report is runtime evidence, not a FIPS validation or certification.",
      "Protocol, plugin, browser, native-addon, WASM, and child-process cryptography require separate inventory.",
      "A passing report does not prove that every enabled OpenClaw feature stays inside one validated cryptographic module boundary.",
      "Post-quantum algorithm availability and migration policy are separate from FIPS runtime activation.",
    ],
  };
}

export function formatFipsReport(report) {
  const lines = [
    "OpenClaw FIPS runtime check",
    `runtime: ${report.runtime.platform}/${report.runtime.arch}; Node ${report.runtime.node}; OpenSSL ${report.runtime.openssl}`,
    `summary: ${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.warn} warn, ${report.summary.skip} skip`,
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
  console.log(`Usage: node scripts/security/fips-check.mjs [--json]

Reports Node FIPS state, startup wiring, TLS capability, and selected
cryptographic runtime evidence. Exits 1 when a required check fails.`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }
  const report = createFipsReport(collectFipsEvidence());
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatFipsReport(report)}\n`);
  }
  return report.ok ? 0 : 1;
}

/** @param {unknown} error */
function reportFatalError(error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("[fips-check] FAILED (exit 2)");
  process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const exitCode = main();
    if (exitCode !== 0) {
      console.error(`[fips-check] FAILED (exit ${exitCode})`);
    }
    process.exitCode = exitCode;
  } catch (error) {
    reportFatalError(error);
  }
}
