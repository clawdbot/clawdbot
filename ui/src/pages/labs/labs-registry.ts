import { t } from "../../i18n/index.ts";

/** What a lab row writes at its gate. Most gates are booleans; some are modes. */
export type LabFeatureValue = boolean | string;

export type LabFeature = {
  id: string;
  title: () => string;
  description: () => string;
  docsUrl: string;
  /** Leaf whose value decides whether the row reads as on. */
  configPath: readonly [string, ...string[]];
  /**
   * Values written at `configPath`. Required rather than defaulted to `true` and
   * `false` so a setting that spells its on/off state as a mode has to say so
   * here instead of silently writing a boolean the runtime would ignore.
   */
  onValue: LabFeatureValue;
  offValue: LabFeatureValue;
  /**
   * Extra keys written beside the gate when enabling, relative to the gate's
   * parent. Labs pins the variant we actually recommend rather than inheriting
   * whatever a bare enable defaults to.
   */
  enableAlso: Readonly<Record<string, LabFeatureValue>> | null;
  restartHint: (() => string) | null;
};

export const LAB_FEATURES = [
  {
    id: "codeMode",
    title: () => t("labsPage.codeMode.title"),
    description: () => t("labsPage.codeMode.description"),
    docsUrl: "https://docs.openclaw.ai/tools/code-mode",
    configPath: ["tools", "codeMode", "enabled"],
    onValue: true,
    offValue: false,
    enableAlso: null,
    restartHint: null,
  },
  {
    id: "swarm",
    title: () => t("labsPage.swarm.title"),
    description: () => t("labsPage.swarm.description"),
    docsUrl: "https://docs.openclaw.ai/tools/swarm",
    configPath: ["tools", "swarm", "enabled"],
    onValue: true,
    offValue: false,
    enableAlso: null,
    restartHint: null,
  },
  {
    id: "toolSearch",
    title: () => t("labsPage.toolSearch.title"),
    description: () => t("labsPage.toolSearch.description"),
    docsUrl: "https://docs.openclaw.ai/tools/tool-search",
    configPath: ["tools", "toolSearch", "enabled"],
    onValue: true,
    offValue: false,
    // resolveToolSearchConfig defaults an unset mode to "code" even in object
    // form, which is the surface with the weakest recall. Pin the bounded
    // directory instead, so enabling from Labs is the variant we recommend.
    enableAlso: { mode: "directory" },
    restartHint: null,
  },
  {
    id: "localModelLean",
    title: () => t("labsPage.localModelLean.title"),
    description: () => t("labsPage.localModelLean.description"),
    docsUrl: "https://docs.openclaw.ai/gateway/local-models",
    configPath: ["agents", "defaults", "experimental", "localModelLean"],
    onValue: true,
    offValue: false,
    enableAlso: null,
    restartHint: null,
  },
  {
    id: "auditMessages",
    title: () => t("labsPage.auditMessages.title"),
    description: () => t("labsPage.auditMessages.description"),
    docsUrl: "https://docs.openclaw.ai/gateway/audit",
    // Not a boolean: `off` | `direct` | `all`. Labs offers the conservative
    // `direct`, so turning it on cannot start recording group or unknown
    // conversations that the operator never opted into.
    configPath: ["logging", "audit", "messages"],
    onValue: "direct",
    offValue: "off",
    enableAlso: null,
    // startGatewayEventSubscriptions resolves the mode once and bakes it into
    // the recorder, so this outlives the reload plan's `logging: none` rule.
    restartHint: () => t("labsPage.restartRequired"),
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
  return (parent as Record<string, unknown>)[key] === feature.onValue;
}

export function labFeatureMergePatch(
  feature: LabFeature,
  enabled: boolean,
): Record<string, unknown> {
  const key = feature.configPath.at(-1) as string;
  // Companion keys ride in the same patch as the gate so one save cannot leave
  // the feature on in a variant Labs never offered.
  let patch: unknown = {
    [key]: enabled ? feature.onValue : feature.offValue,
    ...(enabled ? feature.enableAlso : null),
  };
  for (const segment of feature.configPath.slice(0, -1).toReversed()) {
    patch = { [segment]: patch };
  }
  return patch as Record<string, unknown>;
}
