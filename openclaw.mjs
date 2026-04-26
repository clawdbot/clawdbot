#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import module from "node:module";
import { fileURLToPath } from "node:url";

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 12;
const MIN_NODE_VERSION = `${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}`;

const parseNodeVersion = (rawVersion) => {
  const [majorRaw = "0", minorRaw = "0"] = rawVersion.split(".");
  return {
    major: Number(majorRaw),
    minor: Number(minorRaw),
  };
};

const isSupportedNodeVersion = (version) =>
  version.major > MIN_NODE_MAJOR ||
  (version.major === MIN_NODE_MAJOR && version.minor >= MIN_NODE_MINOR);

const ensureSupportedNodeVersion = () => {
  if (isSupportedNodeVersion(parseNodeVersion(process.versions.node))) {
    return;
  }

  process.stderr.write(
    `openclaw: Node.js v${MIN_NODE_VERSION}+ is required (current: v${process.versions.node}).\n` +
      "If you use nvm, run:\n" +
      `  nvm install ${MIN_NODE_MAJOR}\n` +
      `  nvm use ${MIN_NODE_MAJOR}\n` +
      `  nvm alias default ${MIN_NODE_MAJOR}\n`,
  );
  process.exit(1);
};

ensureSupportedNodeVersion();

// https://nodejs.org/api/module.html#module-compile-cache
if (module.enableCompileCache && !process.env.NODE_DISABLE_COMPILE_CACHE) {
  try {
    module.enableCompileCache();
  } catch {
    // Ignore errors
  }
}

const isModuleNotFoundError = (err) =>
  err && typeof err === "object" && "code" in err && err.code === "ERR_MODULE_NOT_FOUND";

const isDirectModuleNotFoundError = (err, specifier) => {
  if (!isModuleNotFoundError(err)) {
    return false;
  }

  const expectedUrl = new URL(specifier, import.meta.url);
  if ("url" in err && err.url === expectedUrl.href) {
    return true;
  }

  const message = "message" in err && typeof err.message === "string" ? err.message : "";
  const expectedPath = fileURLToPath(expectedUrl);
  return (
    message.includes(`Cannot find module '${expectedPath}'`) ||
    message.includes(`Cannot find module "${expectedPath}"`)
  );
};

const installProcessWarningFilter = async () => {
  // Keep bootstrap warnings consistent with the TypeScript runtime.
  for (const specifier of ["./dist/warning-filter.js", "./dist/warning-filter.mjs"]) {
    try {
      const mod = await import(specifier);
      if (typeof mod.installProcessWarningFilter === "function") {
        mod.installProcessWarningFilter();
        return;
      }
    } catch (err) {
      if (isDirectModuleNotFoundError(err, specifier)) {
        continue;
      }
      throw err;
    }
  }
};

const tryImport = async (specifier) => {
  try {
    await import(specifier);
    return true;
  } catch (err) {
    // Only swallow direct entry misses; rethrow transitive resolution failures.
    if (isDirectModuleNotFoundError(err, specifier)) {
      return false;
    }
    throw err;
  }
};

const exists = async (specifier) => {
  try {
    await access(new URL(specifier, import.meta.url));
    return true;
  } catch {
    return false;
  }
};

const buildMissingEntryErrorMessage = async () => {
  const lines = ["openclaw: missing dist/entry.(m)js (build output)."];
  if (!(await exists("./src/entry.ts"))) {
    return lines.join("\n");
  }

  lines.push("This install looks like an unbuilt source tree or GitHub source archive.");
  lines.push(
    "Build locally with `pnpm install && pnpm build`, or install a built package instead.",
  );
  lines.push(
    "For pinned GitHub installs, use `npm install -g github:openclaw/openclaw#<ref>` instead of a raw `/archive/<ref>.tar.gz` URL.",
  );
  lines.push("For releases, use `npm install -g openclaw@latest`.");
  return lines.join("\n");
};

const isBareRootHelpInvocation = (argv) =>
  argv.length === 3 && (argv[2] === "--help" || argv[2] === "-h");

const isBrowserHelpInvocation = (argv) =>
  argv.length === 4 && argv[2] === "browser" && (argv[3] === "--help" || argv[3] === "-h");

const isHelpFastPathDisabled = () =>
  process.env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH === "1";

const loadPrecomputedHelpText = (key) => {
  try {
    const raw = readFileSync(new URL("./dist/cli-startup-metadata.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw);
    const value = parsed?.[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
};

const tryOutputBareRootHelp = async () => {
  if (!isBareRootHelpInvocation(process.argv)) {
    return false;
  }
  const precomputed = loadPrecomputedHelpText("rootHelpText");
  if (precomputed) {
    process.stdout.write(precomputed);
    return true;
  }
  for (const specifier of ["./dist/cli/program/root-help.js", "./dist/cli/program/root-help.mjs"]) {
    try {
      const mod = await import(specifier);
      if (typeof mod.outputRootHelp === "function") {
        mod.outputRootHelp();
        return true;
      }
    } catch (err) {
      if (isDirectModuleNotFoundError(err, specifier)) {
        continue;
      }
      throw err;
    }
  }
  return false;
};

const tryOutputBrowserHelp = () => {
  if (!isBrowserHelpInvocation(process.argv)) {
    return false;
  }
  const precomputed = loadPrecomputedHelpText("browserHelpText");
  if (!precomputed) {
    return false;
  }
  process.stdout.write(precomputed);
  return true;
};

if (!isHelpFastPathDisabled() && (await tryOutputBareRootHelp())) {
  // OK
} else if (!isHelpFastPathDisabled() && tryOutputBrowserHelp()) {
  // OK
} else {
  await installProcessWarningFilter();
  if (await tryImport("./dist/entry.js")) {
    // OK
  } else if (await tryImport("./dist/entry.mjs")) {
    // OK
  } else {
    throw new Error(await buildMissingEntryErrorMessage());
  }
}
