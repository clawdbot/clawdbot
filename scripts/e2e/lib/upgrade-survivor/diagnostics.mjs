import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Capture and snapshot validation stay plain Node. The host entrypoint owns
// the redactor; neither candidate code nor raw fixture data owns uploads.
const inputLimit = 256 * 1024;
const outputLimit = 16 * 1024;
const privateLimit = 8 * 1024 * 1024;
const publicLimit = 512 * 1024;
const logNames = [
  "baseline-install.log",
  "install.log",
  "update.json",
  "update.err",
  "post-update-validate.json",
  "post-update-validate.err",
  "doctor.log",
  "baseline-doctor.log",
  "gateway.log",
  "gateway.log.doctor",
  "baseline-service-install.err",
  "systemctl-shim.log",
  "systemctl-shim-gateway.log",
  "systemctl-shim-gateway.log.bootstrap.log",
  "gateway-restart.log",
];
const reasons = [
  "missing or unsafe file",
  "input exceeds cap; omitted whole",
  "input changed while reading; omitted whole",
  "invalid observation; omitted",
];
const omissions = {};

function readOwned(root, relative, label, limit = inputLimit) {
  try {
    if (!root || fs.lstatSync(root).isSymbolicLink()) {
      throw new Error();
    }
    let file = fs.realpathSync(root);
    for (const part of relative.split(path.sep)) {
      if (!part || part === "." || part === "..") {
        throw new Error();
      }
      file = path.join(file, part);
      if (fs.lstatSync(file).isSymbolicLink()) {
        throw new Error();
      }
    }
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) {
        throw new Error();
      }
      // Never truncate before redaction, including a short read or growing log.
      const bytes = Buffer.alloc(limit + 1);
      const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
      if (length > limit || stat.size > limit) {
        omissions[label] = reasons[1];
        return null;
      }
      if (length !== stat.size || fs.fstatSync(fd).size !== length) {
        omissions[label] = reasons[2];
        return null;
      }
      return bytes.subarray(0, length).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    omissions[label] = reasons[0];
    return null;
  }
}

function phaseResult(phase, exitStatus, signal) {
  if (
    typeof phase !== "string" ||
    !/^[a-z0-9-]{1,80}$/.test(phase) ||
    !Number.isInteger(exitStatus) ||
    exitStatus < 0 ||
    exitStatus > 255 ||
    ![null, "SIGHUP", "SIGINT", "SIGTERM"].includes(signal)
  ) {
    throw new Error();
  }
  return { phase, outcome: "failed", exitStatus, signal };
}

function childExit(event) {
  if (
    !(
      event?.code === null ||
      (Number.isInteger(event?.code) && event.code >= 0 && event.code <= 255)
    ) ||
    !(
      event.signal === null ||
      (typeof event.signal === "string" && /^SIG[A-Z0-9]{1,16}$/.test(event.signal))
    ) ||
    typeof event.at !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(event.at)
  ) {
    throw new Error();
  }
  return { code: event.code, signal: event.signal, at: event.at };
}

function environmentKeys(keys = []) {
  if (
    !Array.isArray(keys) ||
    keys.length > 128 ||
    keys.some((key) => typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key))
  ) {
    throw new Error();
  }
  return [...new Set(keys)].toSorted((left, right) => left.localeCompare(right));
}

function writeReport(artifactRoot, directory, name, report, limit) {
  if (fs.lstatSync(artifactRoot).isSymbolicLink()) {
    throw new Error();
  }
  fs.mkdirSync(directory, { recursive: true });
  if (fs.lstatSync(directory).isSymbolicLink()) {
    throw new Error();
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > limit) {
    throw new Error();
  }
  // Root-managed containers must leave the private snapshot readable by the
  // host runner. Its directory stays outside the workflow's upload roots.
  fs.writeFileSync(path.join(directory, name), serialized, { flag: "wx", mode: 0o644 });
}

function capture(artifactRoot, phase, exitStatus, signal = "") {
  const report = {
    ...phaseResult(phase, Number(exitStatus), signal || null),
    logs: {},
    service: {},
    config: {},
    omissions,
  };
  for (const name of logNames) {
    report.logs[name] =
      name === "gateway-restart.log"
        ? readOwned(process.env.OPENCLAW_STATE_DIR, "logs/gateway-restart.log", name)
        : readOwned(artifactRoot, name, name);
  }
  const stateRoot = process.env.OPENCLAW_STATE_DIR;
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (stateRoot && configPath) {
    const config = readOwned(stateRoot, path.relative(stateRoot, configPath), "config");
    if (config !== null) {
      report.config.sha256 = createHash("sha256").update(config).digest("hex");
    }
  }
  const unit = readOwned(
    process.env.HOME,
    ".config/systemd/user/openclaw-gateway.service",
    "service unit",
  );
  if (unit !== null) {
    const lines = unit.split("\n");
    for (const field of ["ExecStart", "WorkingDirectory"]) {
      report.service[field] =
        lines.findLast((line) => line.startsWith(`${field}=`))?.slice(field.length + 1) ?? null;
    }
    report.service.environmentKeys = environmentKeys(
      lines.flatMap((line) => {
        const match = /^Environment="?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
        return match ? [match[1]] : [];
      }),
    );
  }
  // Never follow EnvironmentFile paths supplied by a service unit.
  const envFile = readOwned(stateRoot, "gateway.systemd.env", "service environment");
  if (envFile !== null) {
    report.service.environmentFileKeys = environmentKeys(
      [...envFile.matchAll(/^(?:export )?([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((match) => match[1]),
    );
  }
  const observed = readOwned(artifactRoot, "systemctl-shim-gateway.log.exit.json", "child exit");
  if (observed !== null) {
    try {
      const value = JSON.parse(observed);
      report.service.childExits = [childExit(value.first), childExit(value.last)];
      report.service.supervisorWorkingDirectory = value.cwd;
    } catch {
      omissions["child exit"] = reasons[3];
    }
  }
  writeReport(
    artifactRoot,
    path.join(artifactRoot, "diagnostics"),
    "raw.json",
    report,
    privateLimit,
  );
}

export function publishDiagnostics(artifactRoot, destination, redactSensitiveText) {
  const raw = readOwned(artifactRoot, "diagnostics/raw.json", "private snapshot", privateLimit);
  if (raw === null) {
    throw new Error();
  }
  const snapshot = JSON.parse(raw);
  const report = {
    ...phaseResult(snapshot.phase, snapshot.exitStatus, snapshot.signal),
    limits: {
      inputBytesPerFile: inputLimit,
      outputBytesPerLog: outputLimit,
      reportBytes: publicLimit,
    },
    logs: {},
    service: {},
    config: {},
    omissions,
  };
  // Re-project the allowlist: the container cannot add upload fields or supply
  // arbitrary omission text. Redact every permitted free-text field on the host.
  for (const label of [
    ...logNames,
    "config",
    "service unit",
    "service environment",
    "child exit",
  ]) {
    if (reasons.includes(snapshot.omissions?.[label])) {
      omissions[label] = snapshot.omissions[label];
    }
  }
  function sanitize(text, label) {
    if (text === null || text === undefined) {
      return null;
    }
    if (typeof text !== "string" || Buffer.byteLength(text) > inputLimit) {
      throw new Error();
    }
    const redacted = redactSensitiveText(text, { mode: "tools" });
    let result = "";
    for (const line of redacted.split(/(?<=\n)/u)) {
      if (Buffer.byteLength(JSON.stringify(result + line)) > outputLimit) {
        omissions[label] = "redacted output truncated at a complete line (16 KiB)";
        break;
      }
      result += line;
    }
    return result;
  }
  for (const name of logNames) {
    report.logs[name] = sanitize(snapshot.logs?.[name], name);
  }
  for (const field of ["ExecStart", "WorkingDirectory", "supervisorWorkingDirectory"]) {
    report.service[field] = sanitize(snapshot.service?.[field], field);
  }
  for (const field of ["environmentKeys", "environmentFileKeys"]) {
    report.service[field] = environmentKeys(snapshot.service?.[field]);
  }
  if (snapshot.service?.childExits !== undefined) {
    if (!Array.isArray(snapshot.service.childExits) || snapshot.service.childExits.length !== 2) {
      throw new Error();
    }
    report.service.childExits = snapshot.service.childExits.map(childExit);
  }
  if (snapshot.config?.sha256 !== undefined) {
    if (
      typeof snapshot.config.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(snapshot.config.sha256)
    ) {
      throw new Error();
    }
    report.config.sha256 = snapshot.config.sha256;
  }
  writeReport(artifactRoot, destination, "failure.json", report, publicLimit);
  if (Object.keys(omissions).length) {
    process.stderr.write(
      "Upgrade survivor diagnostics: some inputs omitted; see failure.json omissions.\n",
    );
  }
}

if (import.meta.main) {
  try {
    const [mode, artifactRoot, phase, exitStatus, signal] = process.argv.slice(2);
    if (mode !== "capture") {
      throw new Error();
    }
    capture(artifactRoot, phase, exitStatus, signal);
  } catch {
    process.stderr.write("Upgrade survivor diagnostics missing: safe capture failed.\n");
    process.exitCode = 1;
  }
}
