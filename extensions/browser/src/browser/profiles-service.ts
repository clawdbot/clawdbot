/**
 * Browser profile service.
 *
 * Implements profile listing, creation, and deletion using browser config
 * mutation helpers and route context runtime state.
 */
import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getRuntimeConfig, getRuntimeConfigSourceSnapshot } from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveUserPath } from "../utils.js";
import { assertCdpEndpointAllowed, redactCdpUrl } from "./cdp.helpers.js";
import { resolveOpenClawUserDataDir } from "./chrome.js";
import {
  createBrowserProfileConfig,
  deleteBrowserProfileConfig,
  setDefaultBrowserProfile,
} from "./config-mutations.js";
import {
  getOwnBrowserProfile,
  parseHttpUrl,
  resolveBrowserConfig,
  resolveProfile,
} from "./config.js";
import {
  BrowserConflictError,
  BrowserProfileNotFoundError,
  BrowserValidationError,
} from "./errors.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import { isValidProfileName } from "./profiles.js";
import type { BrowserRouteContext, ProfileStatus } from "./server-context.js";
import { beginProfileTransition, getOrCreateProfileRuntime } from "./server-context.lifecycle.js";
import {
  recordSystemProfileImport,
  readSystemProfileImportState,
  resolveSuggestedImportTarget,
} from "./system-profile-import-state.js";
import {
  importSystemProfileCookies,
  listSystemProfiles as discoverSystemProfiles,
  type ImportSystemProfileParams,
  type ImportSystemProfileResult,
  type SystemProfileInfo,
} from "./system-profiles.js";
import { movePathToTrash } from "./trash.js";

/** Input accepted when creating a browser profile. */
type CreateProfileParams = {
  name: string;
  color?: string;
  cdpUrl?: string;
  userDataDir?: string;
  driver?: "openclaw" | "existing-session";
};

/** Result returned after creating a browser profile. */
type CreateProfileResult = {
  ok: true;
  profile: string;
  transport: "cdp" | "chrome-mcp";
  cdpPort: number | null;
  cdpUrl: string | null;
  userDataDir: string | null;
  color: string;
  isRemote: boolean;
};

/** Result returned after deleting a browser profile. */
type DeleteProfileResult = {
  ok: true;
  profile: string;
  deleted: boolean;
};

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

/** Create a profile service bound to one browser route context. */
export function createBrowserProfilesService(ctx: BrowserRouteContext) {
  const listProfiles = async (): Promise<ProfileStatus[]> => {
    return await ctx.listProfiles();
  };

  const createProfile = async (params: CreateProfileParams): Promise<CreateProfileResult> => {
    const name = params.name.trim();
    const rawCdpUrl = normalizeOptionalString(params.cdpUrl);
    const rawUserDataDir = normalizeOptionalString(params.userDataDir);
    const normalizedUserDataDir = rawUserDataDir ? resolveUserPath(rawUserDataDir) : undefined;
    const driver = params.driver === "existing-session" ? "existing-session" : undefined;

    if (!isValidProfileName(name)) {
      throw new BrowserValidationError(
        "invalid profile name: use lowercase letters, numbers, and hyphens only",
      );
    }

    const state = ctx.state();
    const resolvedProfiles = state.resolved.profiles;
    if (getOwnBrowserProfile(resolvedProfiles, name)) {
      throw new BrowserConflictError(`profile "${name}" already exists`);
    }

    const cfg = getRuntimeConfig();
    const rawProfiles = cfg.browser?.profiles ?? {};
    if (getOwnBrowserProfile(rawProfiles, name)) {
      throw new BrowserConflictError(`profile "${name}" already exists`);
    }

    const explicitProfileColor =
      params.color && HEX_COLOR_RE.test(params.color) ? params.color : undefined;

    let parsedCdpUrl: string | undefined;
    if (normalizedUserDataDir && driver !== "existing-session") {
      throw new BrowserValidationError(
        "driver=existing-session is required when userDataDir is provided",
      );
    }
    if (normalizedUserDataDir && !fs.existsSync(normalizedUserDataDir)) {
      throw new BrowserValidationError(
        `browser user data directory not found: ${normalizedUserDataDir}`,
      );
    }

    if (rawCdpUrl) {
      let parsed: ReturnType<typeof parseHttpUrl>;
      try {
        parsed = parseHttpUrl(rawCdpUrl, "browser.profiles.cdpUrl");
        await assertCdpEndpointAllowed(parsed.normalized, state.resolved.ssrfPolicy);
      } catch (err) {
        throw new BrowserValidationError(formatErrorMessage(err));
      }
      parsedCdpUrl = parsed.normalized;
    }

    const profileConfig = await createBrowserProfileConfig({
      name,
      resolved: state.resolved,
      ...(explicitProfileColor ? { color: explicitProfileColor } : {}),
      ...(parsedCdpUrl ? { parsedCdpUrl } : {}),
      ...(normalizedUserDataDir ? { userDataDir: normalizedUserDataDir } : {}),
      ...(driver ? { driver } : {}),
    });
    if (!profileConfig) {
      throw new BrowserProfileNotFoundError(`profile "${name}" not found after creation`);
    }
    state.resolved.profiles[name] = profileConfig;
    const resolved = resolveProfile(state.resolved, name);
    if (!resolved) {
      throw new BrowserProfileNotFoundError(`profile "${name}" not found after creation`);
    }
    const capabilities = getBrowserProfileCapabilities(resolved);

    return {
      ok: true,
      profile: name,
      transport: capabilities.usesChromeMcp ? "chrome-mcp" : "cdp",
      cdpPort: capabilities.usesChromeMcp ? null : resolved.cdpPort,
      cdpUrl: resolved.cdpUrl ? (redactCdpUrl(resolved.cdpUrl) ?? null) : null,
      userDataDir: resolved.userDataDir ?? null,
      color: resolved.color,
      isRemote: !resolved.cdpIsLoopback,
    };
  };

  const listSystemProfiles = async (browser?: string): Promise<SystemProfileInfo[]> => {
    if (process.platform !== "darwin") {
      return [];
    }
    return discoverSystemProfiles(browser);
  };

  const importSystemProfile = async (
    params: ImportSystemProfileParams,
    options?: { signal?: AbortSignal },
  ): Promise<ImportSystemProfileResult> => {
    const state = ctx.state();
    return await importSystemProfileCookies(params, {
      ctx,
      createProfile,
      signal: options?.signal,
      finalize: async (result) => {
        if (result.cookies.imported === 0) {
          if (params.makeDefault) {
            throw new BrowserValidationError(
              "no cookies could be imported from the selected profile",
            );
          }
          return;
        }
        if (params.makeDefault) {
          await setDefaultBrowserProfile(result.into);
          state.resolved.defaultProfile = result.into;
        }
        await recordSystemProfileImport({
          browser: result.browser,
          systemProfile: result.systemProfile,
          targetProfile: result.into,
        });
      },
    });
  };

  const getSystemProfileImportStatus = async () => {
    const enabled =
      process.platform === "darwin" &&
      getRuntimeConfig().browser?.allowSystemProfileImport !== false;
    const [systemProfiles, state, profiles] = await Promise.all([
      enabled ? listSystemProfiles() : Promise.resolve([]),
      readSystemProfileImportState(),
      listProfiles(),
    ]);
    return {
      enabled,
      systemProfiles,
      state: state ?? null,
      suggestedTarget: resolveSuggestedImportTarget({
        profileNames: profiles.map((profile) => profile.name),
        state,
      }),
    };
  };

  const deleteProfile = async (nameRaw: string): Promise<DeleteProfileResult> => {
    const name = nameRaw.trim();
    if (!name) {
      throw new BrowserValidationError("profile name is required");
    }
    if (!isValidProfileName(name)) {
      throw new BrowserValidationError("invalid profile name");
    }

    const state = ctx.state();
    const cfg = getRuntimeConfig();
    const profiles = cfg.browser?.profiles ?? {};
    const defaultProfile = cfg.browser?.defaultProfile ?? state.resolved.defaultProfile;
    if (name === defaultProfile) {
      throw new BrowserValidationError(
        `cannot delete the default profile "${name}"; change browser.defaultProfile first`,
      );
    }
    const runtimeProfile = getOwnBrowserProfile(profiles, name);
    if (!runtimeProfile) {
      throw new BrowserProfileNotFoundError(`profile "${name}" not found`);
    }
    const sourceProfile = getOwnBrowserProfile(
      getRuntimeConfigSourceSnapshot()?.browser?.profiles,
      name,
    );
    const expected = structuredClone(sourceProfile ?? runtimeProfile);

    let deleted = false;
    const configuredProfile = resolveProfile(resolveBrowserConfig(cfg.browser, cfg), name);
    const resolved = configuredProfile ?? state.profiles.get(name)?.profile;
    const runtime = resolved ? getOrCreateProfileRuntime(state, resolved) : undefined;

    const persistDelete = async () => {
      await deleteBrowserProfileConfig({ name, expected });
      delete state.resolved.profiles[name];
      try {
        if (resolved?.cdpIsLoopback && resolved.driver === "openclaw" && !resolved.attachOnly) {
          const userDataDir = resolveOpenClawUserDataDir(name);
          const profileDir = path.dirname(userDataDir);
          if (fs.existsSync(profileDir)) {
            try {
              await movePathToTrash(profileDir);
              deleted = true;
            } catch {
              // Config deletion is already durable. Preserve user data and
              // report deleted=false instead of returning an unretryable
              // partial failure after the profile no longer exists.
            }
          }
        }
      } finally {
        if (!runtime || state.profiles.get(name) === runtime) {
          state.profiles.delete(name);
        }
      }
    };

    if (resolved && runtime) {
      await beginProfileTransition({
        state,
        runtime,
        reason: "profile deletion requested",
        terminal: "deleted",
        advanceConfigRevision: true,
        closeRelay: resolved.driver === "extension",
        afterCleanup: persistDelete,
        rollbackTerminalOnFailure: true,
      });
    } else {
      await persistDelete();
    }

    return { ok: true, profile: name, deleted };
  };

  return {
    listProfiles,
    listSystemProfiles,
    createProfile,
    importSystemProfile,
    getSystemProfileImportStatus,
    deleteProfile,
  };
}
