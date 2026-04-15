import path from "node:path";
import {
  createAsyncLock,
  pruneExpiredPending,
  readJsonFile,
  resolvePairingPaths,
  writeJsonAtomic,
} from "../infra/pairing-files.js";
import { verifyPairingToken } from "../infra/pairing-token.js";
import { issueDeviceBootstrapToken as issueCoreDeviceBootstrapToken } from "../infra/device-bootstrap.js";
import { approveDevicePairing, listDevicePairing } from "../infra/device-pairing.js";

type DeviceBootstrapTokenRecord = {
  token: string;
  ts: number;
  roles?: string[];
  scopes?: string[];
  issuedAtMs: number;
  lastUsedAtMs?: number;
};

type DeviceBootstrapStateFile = Record<string, DeviceBootstrapTokenRecord>;

const DEVICE_BOOTSTRAP_TOKEN_TTL_MS = 10 * 60 * 1000;
const withLock = createAsyncLock();

export type DeviceBootstrapProfile = {
  roles?: string[];
  scopes?: string[];
};

export const PAIRING_SETUP_BOOTSTRAP_PROFILE: DeviceBootstrapProfile = {
  roles: ["node"],
  scopes: [],
};

function resolveBootstrapPath(baseDir?: string): string {
  return path.join(resolvePairingPaths(baseDir, "devices").dir, "bootstrap.json");
}

async function loadBootstrapState(baseDir?: string): Promise<DeviceBootstrapStateFile> {
  const bootstrapPath = resolveBootstrapPath(baseDir);
  const rawState = (await readJsonFile<DeviceBootstrapStateFile>(bootstrapPath)) ?? {};
  const state: DeviceBootstrapStateFile = {};
  if (!rawState || typeof rawState !== "object" || Array.isArray(rawState)) {
    return state;
  }
  for (const [tokenKey, entry] of Object.entries(rawState)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    state[tokenKey] = {
      token: typeof entry.token === "string" && entry.token.trim() ? entry.token : tokenKey,
      ts: typeof entry.ts === "number" ? entry.ts : typeof entry.issuedAtMs === "number" ? entry.issuedAtMs : 0,
      roles: Array.isArray(entry.roles) ? entry.roles.filter((value) => typeof value === "string") : undefined,
      scopes: Array.isArray(entry.scopes) ? entry.scopes.filter((value) => typeof value === "string") : undefined,
      issuedAtMs: typeof entry.issuedAtMs === "number" ? entry.issuedAtMs : 0,
      lastUsedAtMs: typeof entry.lastUsedAtMs === "number" ? entry.lastUsedAtMs : undefined,
    };
  }
  pruneExpiredPending(state, Date.now(), DEVICE_BOOTSTRAP_TOKEN_TTL_MS);
  return state;
}

async function persistBootstrapState(state: DeviceBootstrapStateFile, baseDir?: string): Promise<void> {
  await writeJsonAtomic(resolveBootstrapPath(baseDir), state);
}

export { approveDevicePairing, listDevicePairing };

export async function issueDeviceBootstrapToken(params: {
  profile?: DeviceBootstrapProfile;
  baseDir?: string;
} = {}): Promise<{ token: string; expiresAtMs: number }> {
  const issued = await issueCoreDeviceBootstrapToken({ baseDir: params.baseDir });
  if (!params.profile) {
    return issued;
  }

  return await withLock(async () => {
    const state = await loadBootstrapState(params.baseDir);
    const entry = state[issued.token];
    if (entry) {
      state[issued.token] = {
        ...entry,
        roles: params.profile?.roles ? [...params.profile.roles] : entry.roles,
        scopes: params.profile?.scopes ? [...params.profile.scopes] : entry.scopes,
      };
      await persistBootstrapState(state, params.baseDir);
    }
    return issued;
  });
}

export async function clearDeviceBootstrapTokens(params: { baseDir?: string } = {}): Promise<{ removed: number }> {
  return await withLock(async () => {
    const state = await loadBootstrapState(params.baseDir);
    const removed = Object.keys(state).length;
    if (removed > 0) {
      await persistBootstrapState({}, params.baseDir);
    }
    return { removed };
  });
}

export async function revokeDeviceBootstrapToken(params: {
  token: string;
  baseDir?: string;
}): Promise<{ removed: boolean }> {
  return await withLock(async () => {
    const state = await loadBootstrapState(params.baseDir);
    let removed = false;
    for (const [tokenKey, entry] of Object.entries(state)) {
      if (verifyPairingToken(params.token, entry.token)) {
        delete state[tokenKey];
        removed = true;
      }
    }
    if (removed) {
      await persistBootstrapState(state, params.baseDir);
    }
    return { removed };
  });
}
