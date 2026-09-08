const CHANNEL_KERNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);

/** Return whether a channel config key names a kernel-owned namespace. */
export function isKernelOwnedChannelConfigKey(key: string): boolean {
  return CHANNEL_KERNEL_CONFIG_KEYS.has(key);
}
