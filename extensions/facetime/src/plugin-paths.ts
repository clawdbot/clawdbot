import { constants } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";

const NATIVE_PROTOCOL = "NATIVE_PROTOCOL_VERSION=1";
const NATIVE_DIRS = [
  "/opt/homebrew/opt/openclaw-facetime/libexec",
  "/usr/local/opt/openclaw-facetime/libexec",
] as const;
const INSTALL_COMMAND = "brew install openclaw/tap/openclaw-facetime";

function resolveHelperDylib(): string {
  return resolve(
    homedir(),
    "Library",
    "Containers",
    "com.apple.FaceTime",
    "Data",
    "tmp",
    "FaceTimeHelper.dylib",
  );
}

function resolveHelperIpcKey(): string {
  return resolve(
    homedir(),
    "Library",
    "Application Support",
    "OpenClaw",
    "FaceTime",
    "helper-ipc-key",
  );
}

function resolveHelperBuildStamp(): string {
  return resolve(
    homedir(),
    "Library",
    "Application Support",
    "OpenClaw",
    "FaceTime",
    "helper-build.sha256",
  );
}

async function resolveNativeInstall(params: {
  access?: typeof access;
  readFile?: typeof readFile;
}): Promise<{ buildId: string; capture: string; directory: string; helper: string }> {
  const checkAccess = params.access ?? access;
  const loadFile = params.readFile ?? readFile;
  for (const directory of NATIVE_DIRS) {
    const capture = resolve(directory, "facetime-audio-capture");
    const helper = resolve(directory, "FaceTimeHelper.dylib");
    const buildIdFile = resolve(directory, "FaceTimeHelper.build-id");
    const protocolFile = resolve(directory, "native-protocol.env");
    try {
      await Promise.all([
        checkAccess(capture, constants.X_OK),
        checkAccess(helper, constants.R_OK),
        checkAccess(buildIdFile, constants.R_OK),
        checkAccess(protocolFile, constants.R_OK),
      ]);
      const [buildId, protocol] = await Promise.all([
        loadFile(buildIdFile, "utf8").then((value) => value.trim()),
        loadFile(protocolFile, "utf8").then((value) => value.trim()),
      ]);
      if (!/^[\da-f]{64}$/u.test(buildId) || protocol !== NATIVE_PROTOCOL) {
        continue;
      }
      return { buildId, capture, directory, helper };
    } catch {
      // Try the other supported Homebrew prefix.
    }
  }
  throw new Error(`Compatible FaceTime native helpers are not installed. Run: ${INSTALL_COMMAND}`);
}

export async function inspectFaceTimeArtifacts(params: {
  access?: typeof access;
  readFile?: typeof readFile;
}): Promise<{
  nativeInstall: boolean;
  stagedHelper: boolean;
  helperKey: boolean;
  helperBuildStamp: boolean;
  stagedHelperDylibs: number;
  cachedDriver: boolean;
}> {
  const checkAccess = params.access ?? access;
  const readable = async (file: string, mode: number) => {
    try {
      await checkAccess(file, mode);
      return true;
    } catch {
      return false;
    }
  };
  const helperTempDirs = ["com.apple.FaceTime", "com.apple.mobilephone"].map((bundle) =>
    resolve(homedir(), "Library", "Containers", bundle, "Data", "tmp"),
  );
  const countHelpers = async (directory: string) => {
    try {
      return (await readdir(directory)).filter(
        (name) => name.startsWith("FaceTimeHelper") && name.endsWith(".dylib"),
      ).length;
    } catch {
      return 0;
    }
  };
  const [
    nativeInstall,
    stagedHelper,
    helperKey,
    helperBuildStamp,
    stagedHelperDylibs,
    cachedDriver,
  ] = await Promise.all([
    resolveNativeInstall(params).then(
      () => true,
      () => false,
    ),
    readable(resolveHelperDylib(), constants.R_OK),
    readable(resolveHelperIpcKey(), constants.R_OK),
    readable(resolveHelperBuildStamp(), constants.R_OK),
    Promise.all(helperTempDirs.map(countHelpers)).then((counts) =>
      counts.reduce((total, count) => total + count, 0),
    ),
    readable(
      resolve(
        homedir(),
        "Library",
        "Caches",
        "OpenClaw",
        "FaceTime",
        "driver",
        "OpenClawBridge.driver",
      ),
      constants.R_OK,
    ),
  ]);
  return {
    nativeInstall,
    stagedHelper,
    helperKey,
    helperBuildStamp,
    stagedHelperDylibs,
    cachedDriver,
  };
}

export async function ensureCaptureBinary(
  params: {
    access?: typeof access;
    readFile?: typeof readFile;
  } = {},
): Promise<string> {
  return (await resolveNativeInstall(params)).capture;
}

export async function ensureHelperArtifacts(params: {
  pluginRoot: string;
  runCommandWithTimeout: PluginRuntime["system"]["runCommandWithTimeout"];
  access?: typeof access;
  readFile?: typeof readFile;
}): Promise<{ buildId: string; dylib: string; ipcKey: string }> {
  const installation = await resolveNativeInstall(params);
  const stageScript = resolve(params.pluginRoot, "scripts", "stage-helper.sh");
  const result = await params.runCommandWithTimeout(["/bin/bash", stageScript, "--if-needed"], {
    timeoutMs: 120_000,
  });
  if (result.code !== 0) {
    throw new Error(
      `FaceTime native helper staging failed: ${result.stderr || result.stdout || `exit ${result.code}`}`,
    );
  }
  const checkAccess = params.access ?? access;
  const loadFile = params.readFile ?? readFile;
  const dylib = resolveHelperDylib();
  await checkAccess(dylib, constants.R_OK);
  const ipcKey = (await loadFile(resolveHelperIpcKey(), "utf8")).trim();
  const stagedBuildId = (await loadFile(resolveHelperBuildStamp(), "utf8")).trim();
  if (!/^[\da-f]{64}$/u.test(ipcKey)) {
    throw new Error("FaceTime helper produced an invalid IPC authentication key");
  }
  if (stagedBuildId !== installation.buildId) {
    throw new Error("Staged FaceTime helper does not match the installed native package");
  }
  return { buildId: installation.buildId, dylib, ipcKey };
}
