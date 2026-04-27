import fs from "node:fs";
import type { ResolvedBrowserProfile } from "./config.js";
import { BrowserResetUnsupportedError } from "./errors.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import { closePlaywrightBrowserConnectionForProfile } from "./server-context.lifecycle.js";
import type { ProfileRuntimeState } from "./server-context.types.js";
import { movePathToTrash } from "./trash.js";

type ResetDeps = {
  profile: ResolvedBrowserProfile;
  getProfileState: () => ProfileRuntimeState;
  stopRunningBrowser: () => Promise<{ stopped: boolean }>;
  isHttpReachable: (timeoutMs?: number) => Promise<boolean>;
  resolveOpenClawUserDataDir: (profileName: string) => string;
};

type ResetOps = {
  resetProfile: () => Promise<{ moved: boolean; from: string; to?: string }>;
};

export function createProfileResetOps({
  profile,
  getProfileState,
  stopRunningBrowser,
  isHttpReachable,
  resolveOpenClawUserDataDir,
}: ResetDeps): ResetOps {
  const capabilities = getBrowserProfileCapabilities(profile);
  const resetProfile = async () => {
    if (!capabilities.supportsReset) {
      throw new BrowserResetUnsupportedError(
        `reset-profile is only supported for local profiles (profile "${profile.name}" is remote).`,
      );
    }

    const userDataDir = resolveOpenClawUserDataDir(profile.name);
    const profileState = getProfileState();
    profileState.managedLaunchFailure = undefined;
    profileState.ensureBrowserAvailable = null;
    const httpReachable = await isHttpReachable(300);
    if (httpReachable && !profileState.running) {
      // Port in use but not by us - kill it.
      await closePlaywrightBrowserConnectionForProfile(profile.cdpUrl);
    }

    if (profileState.running) {
      await stopRunningBrowser();
    }

    await closePlaywrightBrowserConnectionForProfile(profile.cdpUrl);

    if (!fs.existsSync(userDataDir)) {
      return { moved: false, from: userDataDir };
    }

    const moved = await movePathToTrash(userDataDir);
    return { moved: true, from: userDataDir, to: moved };
  };

  return { resetProfile };
}
