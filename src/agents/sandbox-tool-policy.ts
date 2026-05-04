import type { SandboxToolPolicy } from "./sandbox/types.js";

export const IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW = Symbol.for(
  "openclaw.toolPolicy.implicitAllowAllFromAlsoAllow",
);

type SandboxToolPolicyConfig = {
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
};

function unionAllow(base?: string[], extra?: string[]): string[] | undefined {
  if (!Array.isArray(extra) || extra.length === 0) {
    return base;
  }
  if (!Array.isArray(base)) {
    return Array.from(new Set(["*", ...extra]));
  }
  if (base.length === 0) {
    return Array.from(new Set(["*", ...extra]));
  }
  return Array.from(new Set([...base, ...extra]));
}

function hasExplicitAllowAll(list?: string[]): boolean {
  return Array.isArray(list) && list.some((entry) => entry.trim() === "*");
}

export function pickSandboxToolPolicy(
  config?: SandboxToolPolicyConfig,
): SandboxToolPolicy | undefined {
  if (!config) {
    return undefined;
  }
  const allowFromAlsoAllowOnly =
    !Array.isArray(config.allow) &&
    Array.isArray(config.alsoAllow) &&
    config.alsoAllow.length > 0 &&
    !hasExplicitAllowAll(config.alsoAllow);
  const allow = Array.isArray(config.allow)
    ? unionAllow(config.allow, config.alsoAllow)
    : Array.isArray(config.alsoAllow) && config.alsoAllow.length > 0
      ? unionAllow(undefined, config.alsoAllow)
      : undefined;
  const deny = Array.isArray(config.deny) ? config.deny : undefined;
  if (!allow && !deny) {
    return undefined;
  }
  const policy = { allow, deny } as SandboxToolPolicy & {
    [IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW]?: true;
  };
  if (allowFromAlsoAllowOnly) {
    Object.defineProperty(policy, IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW, {
      value: true,
    });
  }
  return policy;
}
