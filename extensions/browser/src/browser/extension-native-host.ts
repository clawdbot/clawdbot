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
const EXTENSION_ORIGIN_PATTERN = /^chrome-extension:\/\/[a-p]{32}\/$/;

type NativeHostManifest = {
  name: string;
  description: string;
  path: string;
  type: string;
  allowed_origins: string[];
};

function validateExpectedOrigins(origins: string[]): string[] {
  const canonical = [...new Set(origins)].toSorted();
  if (
    origins.length === 0 ||
    origins.length !== canonical.length ||
    origins.some((origin, index) => origin !== canonical[index]) ||
    origins.some((origin) => !EXTENSION_ORIGIN_PATTERN.test(origin))
  ) {
    throw new Error("invalid expected origins");
  }
  return canonical;
}

export function parseBrowserNativeHostOrigins(argv: string[]): {
  expectedOrigins: string[];
  callerOrigin: string;
} {
  const expectedOrigins: string[] = [];
  let callerOrigin = "";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--expected-origin") {
      const value = argv[index + 1];
      if (!value || callerOrigin) {
        throw new Error("invalid expected-origin arguments");
      }
      expectedOrigins.push(value);
      index += 1;
    } else if (argument?.startsWith("chrome-extension://")) {
      if (callerOrigin) {
        throw new Error("multiple Chrome extension origins");
      }
      callerOrigin = argument;
    }
  }
  validateExpectedOrigins(expectedOrigins);
  if (!EXTENSION_ORIGIN_PATTERN.test(callerOrigin)) {
    throw new Error("missing Chrome extension origin");
  }
  return { expectedOrigins, callerOrigin };
}

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
  expectedOrigins: string[];
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
  const expectedOrigins = validateExpectedOrigins(params.expectedOrigins);
  const keys = ["name", "description", "path", "type", "allowed_origins"];
  if (
    Object.keys(manifest).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(manifest, key)) ||
    manifest.name !== BROWSER_NATIVE_HOST_NAME ||
    manifest.type !== "stdio" ||
    manifest.path !== launcherPath ||
    !Array.isArray(manifest.allowed_origins) ||
    JSON.stringify(manifest.allowed_origins) !== JSON.stringify(expectedOrigins)
  ) {
    throw new Error("invalid manifest");
  }
  if (!expectedOrigins.includes(params.callerOrigin)) {
    throw new Error("origin forbidden");
  }
}

/** Run one request/response native host process. */
export async function runBrowserNativeHost(params: {
  manifestPath: string;
  launcherPath: string;
  callerOrigin: string;
  expectedOrigins: string[];
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
