import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getRuntimeConfig } from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveUserPath } from "../utils.js";
import { assertCdpEndpointAllowed } from "./cdp.helpers.js";
import { resolveOpenClawUserDataDir } from "./chrome.js";
import { createBrowserProfileConfig, deleteBrowserProfileConfig } from "./config-mutations.js";
import { parseHttpUrl, resolveProfile } from "./config.js";
import {
  BrowserConflictError,
  BrowserProfileNotFoundError,
  BrowserValidationError,
} from "./errors.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import { isValidProfileName } from "./profiles.js";
import type { BrowserRouteContext, ProfileStatus } from "./server-context.js";
import { movePathToTrash } from "./trash.js";

export type CreateProfileParams = {
  name: string;
  color?: string;
  cdpUrl?: string;
  userDataDir?: string;
  driver?: "openclaw" | "existing-session";
};

export type CreateProfileResult = {
  ok: true;
  profile: string;
  transport: "cdp" | "chrome-mcp";
  cdpPort: number | null;
  cdpUrl: string | null;
  userDataDir: string | null;
  color: string;
  isRemote: boolean;
};

export type DeleteProfileResult = {
  ok: true;
  profile: string;
  deleted: boolean;
};

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

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
    if (name in resolvedProfiles) {
      throw new BrowserConflictError(`profile "${name}" already exists`);
    }

    const cfg = getRuntimeConfig();
    const rawProfiles = cfg.browser?.profiles ?? {};
    if (name in rawProfiles) {
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
      if (driver === "existing-session") {
        throw new BrowserValidationError(
          "driver=existing-session does not accept cdpUrl; it attaches via the Chrome MCP auto-connect flow",
        );
      }
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
      cdpUrl: capabilities.usesChromeMcp ? null : resolved.cdpUrl,
      userDataDir: resolved.userDataDir ?? null,
      color: resolved.color,
      isRemote: !resolved.cdpIsLoopback,
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
    if (!(name in profiles)) {
      throw new BrowserProfileNotFoundError(`profile "${name}" not found`);
    }

    let deleted = false;
    const resolved = resolveProfile(state.resolved, name);

    if (resolved?.cdpIsLoopback && resolved.driver === "openclaw") {
      try {
        await ctx.forProfile(name).stopRunningBrowser();
      } catch {
        // ignore
      }

      const userDataDir = resolveOpenClawUserDataDir(name);
      const profileDir = path.dirname(userDataDir);
      if (fs.existsSync(profileDir)) {
        await movePathToTrash(profileDir);
        deleted = true;
      }
    }

    await deleteBrowserProfileConfig(name);

    delete state.resolved.profiles[name];
    state.profiles.delete(name);

    return { ok: true, profile: name, deleted };
  };

  return {
    listProfiles,
    createProfile,
    deleteProfile,
  };
}
