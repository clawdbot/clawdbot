import type { ResolvedBrowserProfile } from "./config.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";

export function resolveIdleProfileStopOutcome(profile: ResolvedBrowserProfile): {
  stopped: boolean;
  closePlaywright: boolean;
} {
  const capabilities = getBrowserProfileCapabilities(profile);
  if (profile.attachOnly || capabilities.isRemote) {
    return {
      stopped: true,
      closePlaywright: true,
    };
  }
  return {
    stopped: false,
    closePlaywright: false,
  };
}

export async function closePlaywrightBrowserConnectionForProfile(cdpUrl?: string): Promise<void> {
  try {
    const mod = await import("./pw-ai.js");
    await mod.closePlaywrightBrowserConnection(cdpUrl ? { cdpUrl } : undefined);
  } catch {
    // ignore
  }
}
