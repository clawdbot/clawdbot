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

export function createAccountPolicyInheritanceCases() {
  return [
    {
      name: "inherits explicit open channel policies",
      root: { groupPolicy: "open", dmPolicy: "open", allowFrom: ["*"] },
      account: {},
      expected: { groupPolicy: "open", dmPolicy: "open" },
    },
    {
      name: "keeps unset group access closed and DMs paired",
      root: {},
      account: {},
      expected: { groupPolicy: "allowlist", dmPolicy: "pairing" },
    },
    {
      name: "honors explicit account policies even when they equal the defaults",
      root: { groupPolicy: "open", dmPolicy: "open", allowFrom: ["*"] },
      account: { groupPolicy: "allowlist", dmPolicy: "pairing" },
      expected: { groupPolicy: "allowlist", dmPolicy: "pairing" },
    },
    {
      name: "honors explicit open account policies over disabled channel policies",
      root: { groupPolicy: "disabled", dmPolicy: "disabled" },
      account: { groupPolicy: "open", dmPolicy: "open", allowFrom: ["*"] },
      expected: { groupPolicy: "open", dmPolicy: "open" },
    },
  ] as const;
}
