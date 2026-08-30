import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";

// Capture and snapshot validation stay plain Node. The host entrypoint owns
// the redactor; neither candidate code nor raw fixture data owns uploads.
const inputLimit = 256 * 1024;
const indexLimit = 1024 * 1024;
const outputLimit = 16 * 1024;
const privateLimit = 8 * 1024 * 1024;
const publicLimit = 512 * 1024;
const entryLimit = 128;
const logNames = [
  "baseline-install.log",
  "install.log",
  "update.json",
  "update.err",
  "repair.json",
  "repair.err",
  "recovery-update.json",
  "recovery-update.err",
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

function ownedPath(root, relative) {
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
  return file;
}

function openOwned(root, relative) {
  const file = ownedPath(root, relative);
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1) {
    fs.closeSync(fd);
    throw new Error();
  }
  return { fd, stat, file };
}

function sameFileIdentity(before, after) {
  return ["dev", "ino", "size", "nlink"].every((key) => before[key] === after[key]);
}

function unchangedFile(before, after) {
  return (
    sameFileIdentity(before, after) &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

function readOwned(root, relative, label, limit = inputLimit, binary = false) {
  try {
    const { fd, stat } = openOwned(root, relative);
    try {
      // Never truncate before redaction, including a short read or growing log.
      const bytes = Buffer.alloc(limit + 1);
      const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
      if (length > limit || stat.size > limit) {
        omissions[label] = reasons[1];
        return null;
      }
      if (length !== stat.size || !unchangedFile(stat, fs.fstatSync(fd))) {
        omissions[label] = reasons[2];
        return null;
      }
      const complete = bytes.subarray(0, length);
      return binary ? complete : complete.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    omissions[label] = reasons[0];
    return null;
  }
}

function boundedList(value) {
  if (!Array.isArray(value) || value.length > entryLimit) {
    throw new Error();
  }
  return value;
}

function textFields(value, fields, sanitize) {
  return Object.fromEntries(
    fields
      .filter((key) => value?.[key] !== undefined)
      .map((key) => {
        if (typeof value[key] !== "string") {
          throw new Error();
        }
        return [key, sanitize(value[key], "post-core/plugin identity")];
      }),
  );
}

function postCoreResult(value, sanitize = (text) => text) {
  if (
    !["ok", "warning", "skipped", "error"].includes(value?.status) ||
    typeof value.changed !== "boolean" ||
    typeof value.sync?.changed !== "boolean" ||
    typeof value.npm?.changed !== "boolean"
  ) {
    throw new Error();
  }
  const sync = { changed: value.sync.changed };
  for (const key of ["switchedToBundled", "switchedToNpm", "warnings", "errors"]) {
    sync[key] = boundedList(value.sync[key]).map(
      (text) => textFields({ text }, ["text"], sanitize).text,
    );
  }
  return {
    status: value.status,
    changed: value.changed,
    ...textFields(value, ["reason"], sanitize),
    sync,
    warnings: boundedList(value.warnings ?? []).map((warning) =>
      textFields(warning, ["pluginId", "reason", "message"], sanitize),
    ),
    npm: {
      changed: value.npm.changed,
      outcomes: boundedList(value.npm.outcomes).map((outcome) => {
        if (!["updated", "unchanged", "skipped", "error"].includes(outcome?.status)) {
          throw new Error();
        }
        const projected = textFields(
          outcome,
          ["pluginId", "message", "warning", "code", "currentVersion", "nextVersion"],
          sanitize,
        );
        projected.status = outcome.status;
        if (outcome.channelFallback) {
          projected.channelFallback = textFields(
            outcome.channelFallback,
            ["requestedSpec", "usedSpec", "reason", "message"],
            sanitize,
          );
        }
        return projected;
      }),
    },
    integrityDrifts: boundedList(value.integrityDrifts).map((drift) =>
      textFields(
        drift,
        [
          "pluginId",
          "spec",
          "expectedIntegrity",
          "actualIntegrity",
          "resolvedSpec",
          "resolvedVersion",
          "action",
        ],
        sanitize,
      ),
    ),
  };
}

export function readPostCoreSnapshot(artifactRoot) {
  try {
    ownedPath(artifactRoot, "diagnostics/post-core.json");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const raw = readOwned(artifactRoot, "diagnostics/post-core.json", "post-core", inputLimit + 1024);
  if (raw === null) {
    throw new Error("Post-core snapshot could not be read safely");
  }
  const snapshot = JSON.parse(raw);
  if (
    snapshot.artifactRoot !== fs.realpathSync(artifactRoot) ||
    !Number.isInteger(snapshot.childExitCode) ||
    snapshot.childExitCode < 0 ||
    snapshot.childExitCode > 255
  ) {
    throw new Error("Post-core snapshot does not belong to this update observation");
  }
  return { childExitCode: snapshot.childExitCode, result: postCoreResult(snapshot.result) };
}

function armPostCoreCapture() {
  if (
    !isMainThread ||
    process.argv[2] !== "update" ||
    process.env.OPENCLAW_UPDATE_POST_CORE !== "1"
  ) {
    return;
  }
  try {
    const tmp = process.env.TMPDIR;
    const resultPath = process.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH;
    const artifactRoot = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
    if (
      !tmp ||
      !resultPath ||
      !artifactRoot ||
      !path.isAbsolute(tmp) ||
      !path.isAbsolute(resultPath)
    ) {
      return;
    }
    const relative = path.relative(tmp, resultPath);
    if (!/^openclaw-update-post-core-[A-Za-z0-9_-]+\/plugins\.json$/.test(relative)) {
      return;
    }
    ownedPath(tmp, path.dirname(relative));
    if (fs.lstatSync(artifactRoot).isSymbolicLink()) {
      return;
    }
    // The old parent can SIGTERM and delete this file without joining. No signal
    // handler or keepalive: only a complete result at normal exit occupies the slot.
    process.once("exit", (code) => {
      try {
        const raw = readOwned(tmp, relative, "post-core");
        if (raw === null) {
          return;
        }
        const result = JSON.parse(raw);
        postCoreResult(result);
        writeReport(
          artifactRoot,
          path.join(artifactRoot, "diagnostics"),
          "post-core.json",
          { artifactRoot: fs.realpathSync(artifactRoot), childExitCode: code, result },
          inputLimit + 1024,
        );
      } catch {
        // Instrumentation must preserve stdout and the original process outcome.
      }
    });
  } catch {
    // Missing/unsafe context is unavailable evidence, never product failure.
  }
}

async function pluginIdentities(stateRoot, artifactRoot) {
  const unavailable = {
    availability: "unknown",
    evidence: "persisted index + current bytes; not observed loaded modules",
    reader: "SQLite or historical fallback; missing/error is not absence",
    plugins: [],
  };
  const handles = [];
  try {
    // The existing reader opens SQLite read-only. Fence every file it may read;
    // disable its config fallback rather than consulting failed-state CLI/config.
    for (const relative of [
      "state/openclaw.sqlite",
      "state/openclaw.sqlite-wal",
      "state/openclaw.sqlite-shm",
      "plugins/installs.json",
    ]) {
      try {
        const handle = openOwned(stateRoot, relative);
        handles.push(handle);
        if (handle.stat.size > (relative.endsWith(".json") ? indexLimit : 64 * 1024 * 1024)) {
          throw new Error();
        }
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }
    const { readPluginInstallIndex } = await import("../plugin-index-sqlite.mjs");
    const index = readPluginInstallIndex({ stateDir: stateRoot, configPath: null });
    for (const { fd, stat, file } of handles) {
      // SQLite readers update SHM read marks: its cache timestamps are not
      // durable index mutations. Keep file identity checks on every source.
      const matches = file.endsWith("-shm") ? sameFileIdentity : unchangedFile;
      if (!matches(stat, fs.fstatSync(fd)) || !matches(stat, fs.lstatSync(file))) {
        throw new Error();
      }
    }
    if (Buffer.byteLength(JSON.stringify(index)) > indexLimit || !Array.isArray(index.plugins)) {
      throw new Error();
    }
    const plugins = boundedList(index.plugins)
      .map((entry) => {
        const root = entry.rootDir;
        if (typeof root !== "string" || !path.isAbsolute(root)) {
          throw new Error();
        }
        const boundary = [stateRoot, artifactRoot].find(
          (base) =>
            base &&
            !path.relative(base, root).startsWith("..") &&
            !path.isAbsolute(path.relative(base, root)),
        );
        if (!boundary) {
          return { pluginId: entry.pluginId, observation: "root outside owned boundary" };
        }
        const rootRelative = path.relative(boundary, root);
        const recordOwner = entry.installOwnerAmbiguous
          ? null
          : (entry.installOwner ?? entry.pluginId);
        const identity = Object.assign(
          textFields(entry, ["pluginId", "packageVersion", "rootDir", "origin"], (text) => text),
          {
            enabled: typeof entry.enabled === "boolean" ? entry.enabled : null,
            recordOwner,
            recorded: textFields(
              recordOwner === null
                ? undefined
                : (index.installRecords?.[recordOwner] ?? entry.installRecord),
              ["version", "resolvedVersion", "integrity", "npmIntegrity"],
              (text) => text,
            ),
          },
        );
        const fingerprint = (relative, recordedSha256, jsonFields = []) => {
          const bytes = readOwned(
            boundary,
            path.join(rootRelative, relative),
            "plugin identity",
            inputLimit,
            true,
          );
          const sha256 = bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
          const result = {
            path: relative,
            sha256,
            recordedSha256: recordedSha256 ?? null,
            matchesRecorded: sha256 && recordedSha256 ? sha256 === recordedSha256 : null,
            observation: bytes === null ? "missing or unsafe current artifact" : "current bytes",
          };
          if (bytes !== null && jsonFields.length) {
            try {
              Object.assign(
                result,
                textFields(JSON.parse(bytes.toString("utf8")), jsonFields, (text) => text),
              );
            } catch {
              result.observation = "invalid JSON; identity unavailable";
            }
          }
          return result;
        };
        const packagePathMatches = entry.packageJson?.path === "package.json";
        const manifestPathMatches = entry.manifestPath === path.join(root, "openclaw.plugin.json");
        identity.package = fingerprint(
          "package.json",
          packagePathMatches ? entry.packageJson.hash : undefined,
          ["name", "version"],
        );
        identity.package.recordedPathMatches = entry.packageJson?.path ? packagePathMatches : null;
        identity.manifest = fingerprint(
          "openclaw.plugin.json",
          manifestPathMatches ? entry.manifestHash : undefined,
          ["id", "version"],
        );
        identity.manifest.recordedPathMatches = entry.manifestPath ? manifestPathMatches : null;
        identity.versionMatchesIndex =
          identity.package.version && entry.packageVersion
            ? identity.package.version === entry.packageVersion
            : null;
        identity.versionMatchesRecord =
          identity.package.version &&
          (identity.recorded.resolvedVersion ?? identity.recorded.version)
            ? identity.package.version ===
              (identity.recorded.resolvedVersion ?? identity.recorded.version)
            : null;
        identity.doctor = {
          path: null,
          sha256: null,
          recordedSha256: entry.doctorContractHash ?? null,
          matchesRecorded: null,
          observation: "no current artifact found",
        };
        // Packaged resolver order from src/plugins/doctor-contract-artifact.ts:
        // basename, JS before TS extension, then root before dist. Never import code.
        for (const basename of ["doctor-contract-api", "contract-api"]) {
          for (const extension of [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]) {
            for (const dir of ["", "dist"]) {
              const relative = path.join(dir, `${basename}${extension}`);
              try {
                ownedPath(boundary, path.join(rootRelative, relative));
              } catch (error) {
                if (error.code === "ENOENT") {
                  continue;
                }
                Object.assign(identity.doctor, {
                  path: relative,
                  observation: "unsafe artifact; selection unavailable",
                });
                return identity;
              }
              identity.doctor = fingerprint(relative, entry.doctorContractHash);
              return identity;
            }
          }
        }
        return entry.doctorContractHash ? identity : null;
      })
      .filter(Boolean);
    return { ...unavailable, availability: plugins.length ? "observed" : "unknown", plugins };
  } catch {
    omissions["plugin identity"] = reasons[3];
    return unavailable;
  } finally {
    for (const { fd } of handles) {
      fs.closeSync(fd);
    }
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
  // Publish the complete file exclusively; partial writes cannot take the
  // post-core slot from a later CLI respawn with a complete result.
  const temporary = path.join(directory, `.${name}.${process.pid}.tmp`);
  const fd = fs.openSync(temporary, "wx", 0o644);
  try {
    fs.writeFileSync(fd, serialized);
    fs.linkSync(temporary, path.join(directory, name));
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(temporary);
  }
}

async function capture(artifactRoot, phase, exitStatus, signal = "", observationRoot = "") {
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
  report.pluginIdentity = await pluginIdentities(stateRoot, artifactRoot);
  report.postCore = {
    availability: "unavailable",
    reason: "No complete exit snapshot; original outcome unknown",
  };
  try {
    const snapshot = readPostCoreSnapshot(observationRoot || artifactRoot);
    if (snapshot !== null) {
      report.postCore = { availability: "captured", ...snapshot };
    }
  } catch {
    omissions["post-core"] = reasons[3];
  }
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
      entriesPerCollection: entryLimit,
      indexJsonBytes: indexLimit,
      indexSourceBytesPerFile: 64 * 1024 * 1024,
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
    "post-core",
    "plugin identity",
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
  report.postCore = {
    availability: "unavailable",
    reason: "No complete exit snapshot; original outcome unknown",
  };
  if (snapshot.postCore?.availability === "captured") {
    try {
      const code = snapshot.postCore.childExitCode;
      if (!Number.isInteger(code) || code < 0 || code > 255) {
        throw new Error();
      }
      report.postCore = {
        availability: "captured",
        childExitCode: code,
        result: postCoreResult(snapshot.postCore.result, sanitize),
      };
    } catch {
      omissions["post-core"] = reasons[3];
    }
  }
  report.pluginIdentity = {
    availability: "unknown",
    evidence: "persisted index + current bytes; not observed loaded modules",
    reader: "SQLite or historical fallback; missing/error is not absence",
    plugins: [],
  };
  if (snapshot.pluginIdentity?.availability === "observed") {
    try {
      const plugins = boundedList(snapshot.pluginIdentity.plugins).map((entry) => {
        const identity = textFields(
          entry,
          ["pluginId", "packageVersion", "rootDir", "origin", "observation"],
          sanitize,
        );
        identity.recordOwner =
          entry.recordOwner == null ? null : sanitize(entry.recordOwner, "plugin identity");
        for (const key of ["enabled", "versionMatchesIndex", "versionMatchesRecord"]) {
          identity[key] = typeof entry[key] === "boolean" ? entry[key] : null;
        }
        identity.recorded = textFields(
          entry.recorded,
          ["version", "resolvedVersion", "integrity", "npmIntegrity"],
          sanitize,
        );
        for (const key of ["package", "manifest", "doctor"]) {
          const value = entry[key];
          identity[key] = textFields(value, ["id", "name", "version", "observation"], sanitize);
          identity[key].path = value?.path == null ? null : sanitize(value.path, "plugin identity");
          for (const field of ["sha256", "recordedSha256"]) {
            identity[key][field] =
              typeof value?.[field] === "string" && /^[a-f0-9]{64}$/.test(value[field])
                ? value[field]
                : null;
          }
          identity[key].matchesRecorded =
            typeof value?.matchesRecorded === "boolean" ? value.matchesRecorded : null;
          identity[key].recordedPathMatches =
            typeof value?.recordedPathMatches === "boolean" ? value.recordedPathMatches : null;
        }
        return identity;
      });
      report.pluginIdentity = { ...report.pluginIdentity, availability: "observed", plugins };
    } catch {
      omissions["plugin identity"] = reasons[3];
    }
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
    const [mode, artifactRoot, phase, exitStatus, signal, observationRoot] = process.argv.slice(2);
    if (mode !== "capture") {
      throw new Error();
    }
    await capture(artifactRoot, phase, exitStatus, signal, observationRoot);
  } catch {
    process.stderr.write("Upgrade survivor diagnostics missing: safe capture failed.\n");
    process.exitCode = 1;
  }
} else {
  armPostCoreCapture();
}
