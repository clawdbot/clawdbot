import { t } from "../../i18n/index.ts";

export type LabFeature = {
  id: string;
  title: () => string;
  description: () => string;
  docsUrl: string;
  configPath: readonly [string, ...string[]];
  restartHint: (() => string) | null;
};

export const LAB_FEATURES = [
  {
    id: "codeMode",
    title: () => t("labsPage.codeMode.title"),
    description: () => t("labsPage.codeMode.description"),
    docsUrl: "https://docs.openclaw.ai/tools/code-mode",
    configPath: ["tools", "codeMode", "enabled"],
    restartHint: null,
  },
  {
    id: "swarm",
    title: () => t("labsPage.swarm.title"),
    description: () => t("labsPage.swarm.description"),
    docsUrl: "https://docs.openclaw.ai/tools/swarm",
    configPath: ["tools", "swarm", "enabled"],
    restartHint: null,
  },
] as const satisfies readonly LabFeature[];

function recordAtPath(config: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = config;
  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function isLabFeatureEnabled(
  config: Record<string, unknown> | null,
  feature: LabFeature,
): boolean {
  if (!config) {
    return false;
  }
  const parentPath = feature.configPath.slice(0, -1);
  const key = feature.configPath.at(-1);
  const parent = recordAtPath(config, parentPath);
  // Feature gates accept the shipped boolean shorthand as well as the object
  // form. A registry path ending in `enabled` must reflect either shape.
  if (key === "enabled" && typeof parent === "boolean") {
    return parent;
  }
  if (!parent || typeof parent !== "object" || Array.isArray(parent) || !key) {
    return false;
  }
  return (parent as Record<string, unknown>)[key] === true;
}

export function labFeatureMergePatch(
  feature: LabFeature,
  enabled: boolean,
): Record<string, unknown> {
  let patch: unknown = enabled;
  for (const segment of feature.configPath.toReversed()) {
    patch = { [segment]: patch };
  }
  return patch as Record<string, unknown>;
}
