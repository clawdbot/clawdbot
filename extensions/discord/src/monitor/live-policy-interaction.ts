import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import type { DiscordLivePolicy, DiscordLivePolicyReader } from "./live-policy.js";

const INTERACTION_POLICY_WAIT_MS = 1_000;

export async function readDiscordInteractionPolicy(
  readPolicy: DiscordLivePolicyReader,
): Promise<DiscordLivePolicy | null> {
  const timeout = new Error("Discord interaction access policy resolution timed out");
  try {
    // Autocomplete and modal-opening callbacks cannot defer. Bound only their
    // policy wait; shared resolution stays observed for subsequent interactions.
    return await withTimeout(readPolicy(), INTERACTION_POLICY_WAIT_MS, {
      createError: () => timeout,
    });
  } catch (error) {
    if (error !== timeout) {
      throw error;
    }
    return null;
  }
}
