import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { asRecord } from "../record-shared.js";
import {
  type BrowserNativeBootstrapResponse,
  decodeBrowserNativeFrame,
  encodeBrowserNativeResponse,
  readBrowserNativeFrame,
} from "./extension-native-protocol.js";

export const BROWSER_NATIVE_HOST_NAME = "ai.openclaw.browser_bootstrap";
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

type NativeHostManifest = {
  name: string;
  description: string;
  path: string;
  type: string;
  allowed_origins: string[];
};

async function validateOwnedFile(filePath: string, executable: boolean): Promise<string> {
  const resolved = path.resolve(filePath);
  const info = await fs.lstat(resolved);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("unsafe file type");
  }
  if (process.platform !== "win32") {
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid) {
      throw new Error("foreign file owner");
    }
    const mode = info.mode & 0o777;
    if ((mode & 0o077) !== 0 || (executable && (mode & 0o100) === 0)) {
      throw new Error("unsafe file mode");
    }
  }
  const canonical = await fs.realpath(resolved);
  if (canonical !== resolved) {
    throw new Error("non-canonical file path");
  }
  return canonical;
}

async function validateNativeManifest(params: {
  manifestPath: string;
  launcherPath: string;
  callerOrigin: string;
  stateDir?: string;
}): Promise<void> {
  const manifestPath = await validateOwnedFile(params.manifestPath, false);
  const launcherPath = await validateOwnedFile(params.launcherPath, true);
  const managedRoot = path.resolve(
    params.stateDir ?? resolveStateDir(),
    "browser",
    "native-messaging",
  );
  if (launcherPath !== managedRoot && !launcherPath.startsWith(`${managedRoot}${path.sep}`)) {
    throw new Error("launcher is outside the managed root");
  }
  const parsed: unknown = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (!asRecord(parsed)) {
    throw new Error("invalid manifest");
  }
  const manifest = parsed as NativeHostManifest;
  const keys = ["name", "description", "path", "type", "allowed_origins"];
  if (
    Object.keys(manifest).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(manifest, key)) ||
    manifest.name !== BROWSER_NATIVE_HOST_NAME ||
    manifest.type !== "stdio" ||
    manifest.path !== launcherPath ||
    !Array.isArray(manifest.allowed_origins) ||
    manifest.allowed_origins.length === 0 ||
    !manifest.allowed_origins.every(
      (origin) =>
        typeof origin === "string" &&
        origin === `chrome-extension://${origin.slice(19, -1)}/` &&
        EXTENSION_ID_PATTERN.test(origin.slice(19, -1)),
    )
  ) {
    throw new Error("invalid manifest");
  }
  if (!manifest.allowed_origins.includes(params.callerOrigin)) {
    throw new Error("origin forbidden");
  }
}

/** Run one request/response native host process. */
export async function runBrowserNativeHost(params: {
  manifestPath: string;
  launcherPath: string;
  callerOrigin: string;
  input: AsyncIterable<Buffer>;
  write: (frame: Buffer) => void;
  buildPairing: () => Promise<{ pairingString: string; topology: string }>;
  stateDir?: string;
  platform?: NodeJS.Platform;
}): Promise<BrowserNativeBootstrapResponse> {
  let response: BrowserNativeBootstrapResponse;
  try {
    const decoded = decodeBrowserNativeFrame(await readBrowserNativeFrame(params.input));
    if (!decoded.ok) {
      response = { v: 1, ok: false, code: decoded.code };
    } else if ((params.platform ?? process.platform) === "win32") {
      response = { v: 1, ok: false, code: "manual_required" };
    } else {
      try {
        await validateNativeManifest(params);
      } catch (error) {
        response = {
          v: 1,
          ok: false,
          code:
            error instanceof Error && error.message === "origin forbidden"
              ? "origin_forbidden"
              : "manifest_invalid",
        };
        params.write(encodeBrowserNativeResponse(response));
        return response;
      }
      try {
        const pairing = await params.buildPairing();
        response =
          pairing.topology === "direct-remote"
            ? { v: 1, ok: false, code: "manual_required" }
            : {
                v: 1,
                ok: true,
                nonce: decoded.request.nonce,
                pairingString: pairing.pairingString,
              };
      } catch (error) {
        response = {
          v: 1,
          ok: false,
          code:
            error instanceof Error && error.message.includes("--gateway-url")
              ? "manual_required"
              : "pairing_unavailable",
        };
      }
    }
  } catch {
    response = { v: 1, ok: false, code: "invalid_frame" };
  }
  params.write(encodeBrowserNativeResponse(response));
  return response;
}
