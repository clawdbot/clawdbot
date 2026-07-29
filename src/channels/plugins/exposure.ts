/**
 * Channel exposure helpers.
 *
 * Resolves whether channel metadata should appear in configured, setup, and docs views.
 */
import type { ChannelMeta } from "./types.core.js";

/**
 * Resolves where a channel should appear in configured, setup, and docs views.
 */
export function resolveChannelExposure(meta: Pick<ChannelMeta, "exposure">) {
  return {
    configured: meta.exposure?.configured ?? true,
    setup: meta.exposure?.setup ?? true,
    docs: meta.exposure?.docs ?? true,
  };
}

/**
 * Returns whether the channel should be listed for already configured agents.
 */
export function isChannelVisibleInConfiguredLists(meta: Pick<ChannelMeta, "exposure">): boolean {
  return resolveChannelExposure(meta).configured;
}

/**
 * Returns whether the channel should be offered during setup/onboarding.
 */
export function isChannelVisibleInSetup(meta: Pick<ChannelMeta, "exposure">): boolean {
  return resolveChannelExposure(meta).setup;
}
