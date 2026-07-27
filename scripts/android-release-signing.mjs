#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultManifestPath = path.join(rootDir, "apps", "android", "Config", "ReleaseSigning.json");
const requiredPropertyNames = [
  "OPENCLAW_ANDROID_STORE_FILE",
  "OPENCLAW_ANDROID_STORE_PASSWORD",
  "OPENCLAW_ANDROID_KEY_ALIAS",
  "OPENCLAW_ANDROID_KEY_PASSWORD",
];
const sourceRequiredPropertyNames = requiredPropertyNames.filter(
  (name) => name !== "OPENCLAW_ANDROID_STORE_FILE",
);

function usage() {
  process.stdout.write(`Usage:
  scripts/android-release-signing.mjs --mode plan
  scripts/android-release-signing.mjs --mode check
  scripts/android-release-signing.mjs --mode materialize
  scripts/android-release-signing.mjs --mode sync-pull
  scripts/android-release-signing.mjs --mode sync-push --keystore PATH --properties PATH

Options:
  --manifest PATH          Defaults to apps/android/Config/ReleaseSigning.json.
  --workspace PATH         Defaults to <materializedRoot>/apps-signing.
  --materialized-dir PATH  Defaults to materializedRoot from the manifest.
  --keystore PATH          Upload keystore source for --mode sync-push.
  --properties PATH        Signing properties source for --mode sync-push.

sync-pull and sync-push use MATCH_PASSWORD to decrypt/encrypt Android release
signing assets in the shared apps-signing repository.
`);
}

function parseArgs(argv) {
  const options = {
    mode: "",
    manifestPath: defaultManifestPath,
    workspace: "",
    materializedDir: "",
    keystorePath: process.env.OPENCLAW_ANDROID_UPLOAD_KEYSTORE || "",
    propertiesPath: process.env.OPENCLAW_ANDROID_SIGNING_PROPERTIES || "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode") {
      options.mode = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--manifest") {
      options.manifestPath = path.resolve(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--workspace") {
      options.workspace = path.resolve(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--materialized-dir") {
      options.materializedDir = path.resolve(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--keystore") {
      options.keystorePath = path.resolve(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--properties") {
      options.propertiesPath = path.resolve(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.mode) {
    throw new Error("Missing required --mode.");
  }

  return options;
}

function readOptionValue(argv, index, option) {
  const value = argv[index + 1] ?? "";
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${option}.`);
  }
  return value;
}

function requireString(value, key) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Android release signing manifest missing ${key}.`);
  }
  return value.trim();
}

function readManifest(manifestPath) {
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const manifest = {
    signingRepo: requireString(parsed.signingRepo, "signingRepo"),
    signingBranch: requireString(parsed.signingBranch, "signingBranch"),
    assetPath: requireString(parsed.assetPath, "assetPath"),
    uploadKeystoreEncryptedFile: requireString(
      parsed.uploadKeystoreEncryptedFile,
      "uploadKeystoreEncryptedFile",
    ),
    gradlePropertiesEncryptedFile: requireString(
      parsed.gradlePropertiesEncryptedFile,
      "gradlePropertiesEncryptedFile",
    ),
    apkCertificateSha256: requireString(parsed.apkCertificateSha256, "apkCertificateSha256"),
    materializedRoot: requireString(parsed.materializedRoot, "materializedRoot"),
    gradlePropertyNames: parsed.gradlePropertyNames,
  };

  if (
    !Array.isArray(manifest.gradlePropertyNames) ||
    manifest.gradlePropertyNames.length !== requiredPropertyNames.length ||
    !requiredPropertyNames.every((name) => manifest.gradlePropertyNames.includes(name))
  ) {
    throw new Error(
      `Android release signing manifest must list Gradle properties: ${requiredPropertyNames.join(", ")}.`,
    );
  }
  if (!/^[a-f0-9]{64}$/u.test(manifest.apkCertificateSha256)) {
    throw new Error(
      "Android release signing manifest apkCertificateSha256 must be 64 lowercase hex digits.",
    );
  }

  return manifest;
}

function relativePath(filePath) {
  const relative = path.relative(rootDir, filePath);
  return relative && !relative.startsWith("..") ? relative : filePath;
}

function resolveMaterializedDir(manifest, options) {
  return options.materializedDir || path.resolve(rootDir, manifest.materializedRoot);
}

function resolveWorkspace(manifest, options) {
  return options.workspace || path.join(resolveMaterializedDir(manifest, options), "apps-signing");
}

function assertWorkspaceInsideMaterialized(workspace, materializedDir) {
  const resolvedWorkspace = path.resolve(workspace);
  const resolvedMaterializedDir = path.resolve(materializedDir);
  const relative = path.relative(resolvedMaterializedDir, resolvedWorkspace);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Android signing workspace must be inside ${relativePath(resolvedMaterializedDir)}.`,
    );
  }
}

function assetDir(workspace, manifest) {
  return path.join(workspace, manifest.assetPath);
}

function encryptedKeystorePath(workspace, manifest) {
  return path.join(assetDir(workspace, manifest), manifest.uploadKeystoreEncryptedFile);
}

function encryptedPropertiesPath(workspace, manifest) {
  return path.join(assetDir(workspace, manifest), manifest.gradlePropertiesEncryptedFile);
}

function materializedKeystorePath(materializedDir) {
  return path.join(materializedDir, "upload-keystore.jks");
}

function materializedPropertiesPath(materializedDir) {
  return path.join(materializedDir, "gradle.properties");
}

function requireMatchPassword() {
  if (!process.env.MATCH_PASSWORD || process.env.MATCH_PASSWORD.trim() === "") {
    throw new Error("MATCH_PASSWORD is required for Android release signing sync.");
  }
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    stdio: options.stdio || "pipe",
  });
}

function runText(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function cloneSigningRepo(manifest, workspace, materializedDir) {
  assertWorkspaceInsideMaterialized(workspace, materializedDir);
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(workspace), { recursive: true });
  run("git", ["clone", "--branch", manifest.signingBranch, manifest.signingRepo, workspace]);
}

function opensslCrypt({ decrypt, inputPath, outputPath }) {
  requireMatchPassword();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (decrypt) {
    fs.rmSync(outputPath, { force: true });
  }
  const args = [
    "enc",
    "-aes-256-cbc",
    "-pbkdf2",
    "-md",
    "sha256",
    ...(decrypt ? ["-d"] : ["-salt"]),
    "-in",
    inputPath,
    "-out",
    outputPath,
    "-pass",
    "env:MATCH_PASSWORD",
  ];
  const previousUmask = decrypt ? process.umask(0o077) : undefined;
  try {
    run("openssl", args);
  } finally {
    if (previousUmask !== undefined) {
      process.umask(previousUmask);
    }
  }
  if (decrypt) {
    fs.chmodSync(outputPath, 0o600);
  }
}

function readProperties(filePath) {
  const properties = new Map();
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new Error(`Invalid signing properties line in ${relativePath(filePath)}.`);
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key || !value) {
      throw new Error(`Invalid empty signing property in ${relativePath(filePath)}.`);
    }
    properties.set(key, value);
  }
  return properties;
}

function requireProperties(properties, names, filePath) {
  const missing = names.filter((name) => !properties.get(name));
  if (missing.length > 0) {
    throw new Error(
      `${relativePath(filePath)} is missing Android signing properties: ${missing.join(", ")}.`,
    );
  }
}

function writeMaterializedProperties(materializedDir, sourceProperties) {
  const keystorePath = materializedKeystorePath(materializedDir);
  const propertiesPath = materializedPropertiesPath(materializedDir);
  const tempPath = `${propertiesPath}.${process.pid}.tmp`;
  const properties = new Map(sourceProperties);
  properties.set("OPENCLAW_ANDROID_STORE_FILE", keystorePath);
  requireProperties(properties, requiredPropertyNames, propertiesPath);

  const content = [
    "# Generated by scripts/android-release-signing.mjs.",
    "# Contains decrypted Android release signing values. Do not commit.",
    ...requiredPropertyNames.map((name) => `${name}=${properties.get(name)}`),
    "",
  ].join("\n");
  try {
    fs.writeFileSync(tempPath, content, { mode: 0o600 });
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, propertiesPath);
    fs.chmodSync(propertiesPath, 0o600);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function validateMaterializedSigning(materializedDir) {
  const keystorePath = materializedKeystorePath(materializedDir);
  const propertiesPath = materializedPropertiesPath(materializedDir);

  if (!fs.existsSync(keystorePath) || fs.statSync(keystorePath).size === 0) {
    throw new Error(
      `Missing materialized Android upload keystore at ${relativePath(keystorePath)}.`,
    );
  }
  if (!fs.existsSync(propertiesPath)) {
    throw new Error(
      `Missing materialized Android signing properties at ${relativePath(propertiesPath)}.`,
    );
  }

  const properties = readProperties(propertiesPath);
  requireProperties(properties, requiredPropertyNames, propertiesPath);
  if (properties.get("OPENCLAW_ANDROID_STORE_FILE") !== keystorePath) {
    throw new Error(
      `${relativePath(propertiesPath)} must point OPENCLAW_ANDROID_STORE_FILE at ${relativePath(keystorePath)}.`,
    );
  }
}

function writePlan(manifest, options) {
  const materializedDir = resolveMaterializedDir(manifest, options);
  process.stdout.write(`Android release signing plan
Signing repo: ${manifest.signingRepo}
Signing branch: ${manifest.signingBranch}
Signing assets: ${manifest.assetPath}
Encrypted upload keystore: ${manifest.uploadKeystoreEncryptedFile}
Encrypted Gradle properties: ${manifest.gradlePropertiesEncryptedFile}
Pinned APK certificate SHA-256: ${manifest.apkCertificateSha256}
Materialized output: ${relativePath(materializedDir)}
Gradle bridge: Fastlane exports ORG_GRADLE_PROJECT_* values from the materialized properties file.
`);
}

function writeSigningRepoManifest(workspace, manifest) {
  const signingManifestPath = path.join(assetDir(workspace, manifest), "manifest.json");
  const signingManifest = {
    version: 1,
    assetPath: manifest.assetPath,
    uploadKeystoreEncryptedFile: manifest.uploadKeystoreEncryptedFile,
    gradlePropertiesEncryptedFile: manifest.gradlePropertiesEncryptedFile,
    apkCertificateSha256: manifest.apkCertificateSha256,
    gradlePropertyNames: requiredPropertyNames,
  };
  fs.writeFileSync(signingManifestPath, `${JSON.stringify(signingManifest, null, 2)}\n`);
}

function materialize(manifest, options) {
  const workspace = resolveWorkspace(manifest, options);
  const materializedDir = resolveMaterializedDir(manifest, options);
  const tempPropertiesPath = path.join(materializedDir, ".gradle.properties.decrypted.tmp");

  assertWorkspaceInsideMaterialized(workspace, materializedDir);
  if (!fs.existsSync(encryptedKeystorePath(workspace, manifest))) {
    throw new Error(
      `Missing encrypted Android upload keystore in signing repo at ${manifest.assetPath}/${manifest.uploadKeystoreEncryptedFile}.`,
    );
  }
  if (!fs.existsSync(encryptedPropertiesPath(workspace, manifest))) {
    throw new Error(
      `Missing encrypted Android signing properties in signing repo at ${manifest.assetPath}/${manifest.gradlePropertiesEncryptedFile}.`,
    );
  }

  fs.mkdirSync(materializedDir, { recursive: true });
  opensslCrypt({
    decrypt: true,
    inputPath: encryptedKeystorePath(workspace, manifest),
    outputPath: materializedKeystorePath(materializedDir),
  });
  try {
    opensslCrypt({
      decrypt: true,
      inputPath: encryptedPropertiesPath(workspace, manifest),
      outputPath: tempPropertiesPath,
    });
    const properties = readProperties(tempPropertiesPath);
    requireProperties(properties, sourceRequiredPropertyNames, tempPropertiesPath);
    writeMaterializedProperties(materializedDir, properties);
  } finally {
    fs.rmSync(tempPropertiesPath, { force: true });
  }

  validateMaterializedSigning(materializedDir);
  process.stdout.write(
    `Materialized Android release signing assets in ${relativePath(materializedDir)}.\n`,
  );
}

function syncPull(manifest, options) {
  const workspace = resolveWorkspace(manifest, options);
  const materializedDir = resolveMaterializedDir(manifest, options);
  cloneSigningRepo(manifest, workspace, materializedDir);
  materialize(manifest, options);
}

function requirePushSources(options) {
  if (!options.keystorePath) {
    throw new Error(
      "Missing Android upload keystore source. Pass --keystore or set OPENCLAW_ANDROID_UPLOAD_KEYSTORE.",
    );
  }
  if (!options.propertiesPath) {
    throw new Error(
      "Missing Android signing properties source. Pass --properties or set OPENCLAW_ANDROID_SIGNING_PROPERTIES.",
    );
  }
  if (!fs.existsSync(options.keystorePath) || fs.statSync(options.keystorePath).size === 0) {
    throw new Error(
      `Android upload keystore source is missing or empty: ${relativePath(options.keystorePath)}.`,
    );
  }
  if (!fs.existsSync(options.propertiesPath)) {
    throw new Error(
      `Android signing properties source is missing: ${relativePath(options.propertiesPath)}.`,
    );
  }
  const properties = readProperties(options.propertiesPath);
  requireProperties(properties, sourceRequiredPropertyNames, options.propertiesPath);
}

function syncPush(manifest, options) {
  requireMatchPassword();
  requirePushSources(options);

  const workspace = resolveWorkspace(manifest, options);
  cloneSigningRepo(manifest, workspace, resolveMaterializedDir(manifest, options));
  fs.mkdirSync(assetDir(workspace, manifest), { recursive: true });
  opensslCrypt({
    decrypt: false,
    inputPath: options.keystorePath,
    outputPath: encryptedKeystorePath(workspace, manifest),
  });
  opensslCrypt({
    decrypt: false,
    inputPath: options.propertiesPath,
    outputPath: encryptedPropertiesPath(workspace, manifest),
  });
  writeSigningRepoManifest(workspace, manifest);

  run("git", ["add", manifest.assetPath], { cwd: workspace });
  const status = runText("git", ["status", "--porcelain"], { cwd: workspace }).trim();
  if (!status) {
    process.stdout.write("Android release signing assets were already up to date.\n");
    return;
  }

  run("git", ["commit", "-m", "Update Android release signing assets"], { cwd: workspace });
  run("git", ["push", "origin", manifest.signingBranch], { cwd: workspace });
  process.stdout.write("Pushed encrypted Android release signing assets.\n");
}

try {
  const options = parseArgs(process.argv.slice(2));
  const manifest = readManifest(options.manifestPath);

  if (options.mode === "plan") {
    writePlan(manifest, options);
  } else if (options.mode === "check") {
    validateMaterializedSigning(resolveMaterializedDir(manifest, options));
    process.stdout.write("Android release signing materialization is valid.\n");
  } else if (options.mode === "materialize") {
    materialize(manifest, options);
  } else if (options.mode === "sync-pull") {
    syncPull(manifest, options);
  } else if (options.mode === "sync-push") {
    syncPush(manifest, options);
  } else {
    throw new Error(`Unknown mode: ${options.mode}`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
