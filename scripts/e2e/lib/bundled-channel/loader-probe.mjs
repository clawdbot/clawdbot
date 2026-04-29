#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function usage() {
  console.error("Usage: loader-probe.mjs <setup-entries|load-failure> <package-root> [channel...]");
  process.exit(2);
}

function findBundledLoader(root) {
  const distDir = path.join(root, "dist");
  const bundledPath = fs
    .readdirSync(distDir)
    .filter((entry) => /^bundled-[A-Za-z0-9_-]+\.js$/.test(entry))
    .map((entry) => path.join(distDir, entry))
    .find((entry) => fs.readFileSync(entry, "utf8").includes("src/channels/plugins/bundled.ts"));
  if (!bundledPath) {
    throw new Error("missing packaged bundled channel loader artifact");
  }
  return bundledPath;
}

function namedExport(module, name) {
  const fn = Object.values(module).find(
    (value) => typeof value === "function" && value.name === name,
  );
  if (typeof fn !== "function") {
    throw new Error(
      `missing packaged bundled loader export ${name}; exports=${Object.keys(module).join(",")}`,
    );
  }
  return fn;
}

async function importBundled(root) {
  return import(pathToFileURL(findBundledLoader(root)));
}

function loadCounts() {
  return {
    plugin: globalThis.__loadFailurePlugin,
    setup: globalThis.__loadFailureSetup,
    secrets: globalThis.__loadFailureSecrets,
    setupSecrets: globalThis.__loadFailureSetupSecrets,
  };
}

function exerciseLoaders(loaders, id) {
  for (const [name, fn] of loaders) {
    try {
      fn(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("synthetic")) {
        throw new Error(`bundled export ${name} leaked synthetic load failure: ${message}`, {
          cause: error,
        });
      }
    }
  }
}

const [command, root, ...args] = process.argv.slice(2);
if (!command || !root) {
  usage();
}

if (command === "load-failure") {
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.join(root, "dist/extensions");
}

const bundled = await importBundled(root);

if (command === "setup-entries") {
  const channels = args.length > 0 ? args : ["feishu", "whatsapp"];
  const setupPluginLoader = namedExport(bundled, "getBundledChannelSetupPlugin");
  for (const channel of channels) {
    const plugin = setupPluginLoader(channel);
    if (!plugin) {
      throw new Error(`${channel} setup plugin did not load pre-config`);
    }
    if (plugin.id !== channel) {
      throw new Error(`${channel} setup plugin id mismatch: ${plugin.id}`);
    }
    console.log(`${channel} setup plugin loaded pre-config`);
  }
} else if (command === "load-failure") {
  const id = args[0] || "load-failure-alpha";
  const loaderNames = [
    "getBundledChannelPlugin",
    "getBundledChannelSetupPlugin",
    "getBundledChannelSecrets",
    "getBundledChannelSetupSecrets",
  ];
  const loaders = loaderNames.map((name) => [name, namedExport(bundled, name)]);

  exerciseLoaders(loaders, id);
  const firstCounts = loadCounts();
  exerciseLoaders(loaders, id);
  const secondCounts = loadCounts();
  for (const key of ["plugin", "setup", "setupSecrets"]) {
    const first = firstCounts[key];
    if (!Number.isInteger(first) || first < 1) {
      throw new Error(`expected ${key} failure to be exercised at least once, got ${first}`);
    }
    if (secondCounts[key] !== first) {
      throw new Error(
        `expected ${key} failure to be cached after first pass, got ${first} then ${secondCounts[key]}`,
      );
    }
  }
  if (firstCounts.secrets !== undefined && secondCounts.secrets !== firstCounts.secrets) {
    throw new Error(
      `expected secrets failure to be cached after first pass, got ${firstCounts.secrets} then ${secondCounts.secrets}`,
    );
  }
  console.log("synthetic bundled channel load failures were isolated and cached");
} else {
  usage();
}
