import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** Wrap schema-parsed channel data through the host config boundary without projecting fields. */
export async function validateTestChannelConfig(
  channelId: string,
  channelConfig: unknown,
): Promise<OpenClawConfig> {
  const { validateConfigObjectRaw } = await import("../../config/validation-core.js");
  const result = validateConfigObjectRaw({ channels: { [channelId]: channelConfig } });
  if (!result.ok) {
    const issues = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
    throw new Error(`Invalid ${channelId} channel fixture:\n${issues}`);
  }
  return result.config;
}
