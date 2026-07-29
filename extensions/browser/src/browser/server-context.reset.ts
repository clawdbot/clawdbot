/**
 * Browser profile reset operations for local managed profiles.
 */
import fs from "node:fs";
import type { ResolvedBrowserProfile } from "./config.js";
import { BrowserResetUnsupportedError } from "./errors.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import {
  assertProfileLifecycleContext,
  beginProfileTransition,
} from "./server-context.lifecycle.js";
import type { BrowserServerState } from "./server-context.types.js";
import type { ProfileRuntimeState } from "./server-context.types.js";
import { movePathToTrash } from "./trash.js";

type ResetDeps = {
  profile: ResolvedBrowserProfile;
  state: () => BrowserServerState;
  runtime: ProfileRuntimeState;
  configRevision: number;
  resolveOpenClawUserDataDir: (profileName: string) => string;
};

type ResetOps = {
  resetProfile: () => Promise<{ moved: boolean; from: string; to?: string }>;
};

/** Builds the reset-profile operation for one resolved browser profile. */
export function createProfileResetOps({
  profile,
  state,
  runtime,
  configRevision,
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
    assertProfileLifecycleContext({ state: state(), runtime, configRevision });
    runtime.managedLaunchFailure = undefined;
    let result: { moved: boolean; from: string; to?: string } = {
      moved: false,
      from: userDataDir,
    };
    await beginProfileTransition({
      state: state(),
      runtime,
      reason: "profile reset requested",
      afterCleanup: async () => {
        if (!fs.existsSync(userDataDir)) {
          return;
        }
        const moved = await movePathToTrash(userDataDir);
        result = { moved: true, from: userDataDir, to: moved };
      },
    });
    return result;
  };

  return { resetProfile };
}
