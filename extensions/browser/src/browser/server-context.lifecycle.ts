/**
 * Browser profile lifecycle helpers shared by availability, reset, and runtime
 * teardown.
 */
import type { ResolvedBrowserProfile } from "./config.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import { getPwAiModule } from "./pw-ai-module.js";

/** Resolves how an idle stop should behave for local, remote, or attach-only profiles. */
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

/** Closes cached Playwright CDP connections for one profile without requiring the module. */
export async function closePlaywrightBrowserConnectionForProfile(cdpUrl?: string): Promise<void> {
  try {
    const mod = await getPwAiModule({ mode: "soft" });
    await mod?.closePlaywrightBrowserConnection(cdpUrl ? { cdpUrl } : undefined);
  } catch {
    // ignore
  }
}
