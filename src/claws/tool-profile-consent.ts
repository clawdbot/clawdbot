import { isToolAllowedByPolicyName } from "../agents/tool-policy-match.js";
import { expandToolGroups, resolveToolProfilePolicy } from "../agents/tool-policy-shared.js";
import type { ClawOpenClawProfile } from "./types.js";

type ClawToolSettings = NonNullable<ClawOpenClawProfile["agent"]["tools"]>;

export function resolveClawToolProfileSnapshot(
  tools: Pick<ClawToolSettings, "profile" | "allow" | "alsoAllow" | "deny">,
): { allow: string[]; deny: string[] } | undefined {
  if (!tools.profile) {
    return undefined;
  }
  const profile = resolveToolProfilePolicy(tools.profile);
  if (!profile) {
    return undefined;
  }
  const profileAllow = expandToolGroups(profile.allow);
  const explicitAllow = tools.allow
    ? profileAllow.includes("*")
      ? expandToolGroups(tools.allow)
      : profileAllow.filter((tool) => isToolAllowedByPolicyName(tool, { allow: tools.allow }))
    : undefined;
  return {
    allow:
      explicitAllow ?? expandToolGroups([...(profile.allow ?? []), ...(tools.alsoAllow ?? [])]),
    deny: expandToolGroups([...(profile.deny ?? []), ...(tools.deny ?? [])]),
  };
}

export function materializeClawToolProfile(
  settings: ClawOpenClawProfile["agent"],
): ClawOpenClawProfile["agent"] {
  const tools = settings.tools;
  if (!tools) {
    return settings;
  }
  if (!tools.profile) {
    const deny = expandToolGroups(tools.deny);
    return {
      ...settings,
      tools: {
        ...(tools.allow ? { allow: expandToolGroups(tools.allow) } : {}),
        ...(tools.alsoAllow ? { alsoAllow: expandToolGroups(tools.alsoAllow) } : {}),
        ...(deny.length > 0 ? { deny } : {}),
        ...(tools.fs ? { fs: tools.fs } : {}),
      },
    };
  }
  const snapshot = resolveClawToolProfileSnapshot(tools);
  if (!snapshot) {
    return settings;
  }
  if (tools.profile === "full" && !tools.allow) {
    throw new Error("Claw full tool profile requires a bounded explicit allowlist.");
  }
  if (tools.allow && snapshot.allow.length === 0) {
    throw new Error("Claw tool allowlist does not overlap the selected profile.");
  }
  return {
    ...settings,
    tools: {
      profile: "full",
      ...(snapshot.allow.length > 0 ? { allow: snapshot.allow } : {}),
      ...(snapshot.deny.length > 0 ? { deny: snapshot.deny } : {}),
      ...(tools.fs ? { fs: tools.fs } : {}),
    },
  };
}
