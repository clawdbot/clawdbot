#!/usr/bin/env node

import fs from "node:fs";

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function requirePaths(command, configPath, snapshotPath) {
  if (!configPath || !snapshotPath) {
    throw new Error(`${command} requires <config-path> <snapshot-path>`);
  }
}

function replaceFileAtomically(filePath, contents) {
  const tempPath = `${filePath}.tmp.${process.pid}`;
  const mode = fs.statSync(filePath).mode;
  try {
    fs.writeFileSync(tempPath, contents, { mode });
    fs.renameSync(tempPath, filePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function snapshotAndReplace(configPath, snapshotPath, authoredConfig, parkedConfig) {
  fs.writeFileSync(snapshotPath, authoredConfig, { mode: 0o600 });
  fs.chmodSync(snapshotPath, 0o600);
  replaceFileAtomically(
    configPath,
    Buffer.from(`${JSON.stringify(parkedConfig, null, 2)}\n`, "utf8"),
  );
}

function parkRestartProbe(configPath, snapshotPath, rawPort) {
  requirePaths("park-restart-probe", configPath, snapshotPath);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("park-restart-probe requires a valid port");
  }
  const authoredConfig = fs.readFileSync(configPath);
  requireObject(JSON.parse(authoredConfig.toString("utf8")), "restart probe config");
  snapshotAndReplace(configPath, snapshotPath, authoredConfig, {
    plugins: { enabled: false },
    gateway: {
      port,
      mode: "local",
      bind: "loopback",
      controlUi: { enabled: false },
      auth: {
        mode: "token",
        token: {
          source: "env",
          provider: "default",
          id: "GATEWAY_AUTH_TOKEN_REF",
        },
      },
      reload: { mode: "off" },
    },
  });
}

function parkCompanionInstall(configPath, snapshotPath) {
  requirePaths("park-companion-install", configPath, snapshotPath);
  const authoredConfig = fs.readFileSync(configPath);
  requireObject(JSON.parse(authoredConfig.toString("utf8")), "companion install config");
  snapshotAndReplace(configPath, snapshotPath, authoredConfig, {
    plugins: { enabled: false },
  });
}

function restore(configPath, snapshotPath) {
  requirePaths("restore", configPath, snapshotPath);
  const authoredConfig = fs.readFileSync(snapshotPath);
  replaceFileAtomically(configPath, authoredConfig);
  if (!fs.readFileSync(configPath).equals(authoredConfig)) {
    throw new Error("restored config did not match authored bytes");
  }
  fs.rmSync(snapshotPath);
}

const [command, configPath, snapshotPath, port] = process.argv.slice(2);

try {
  switch (command) {
    case "park-restart-probe":
      parkRestartProbe(configPath, snapshotPath, port);
      break;
    case "park-companion-install":
      parkCompanionInstall(configPath, snapshotPath);
      break;
    case "restore":
      restore(configPath, snapshotPath);
      break;
    default:
      throw new Error(
        "usage: config-parking.mjs <park-restart-probe|park-companion-install|restore> <config-path> <snapshot-path> [port]",
      );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
