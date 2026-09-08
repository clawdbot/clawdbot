import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { t } from "../../i18n/index.ts";

/** What a lab row writes at its gate. Most gates are booleans; some are modes. */
type LabFeatureValue = boolean | string;
type LabFeatureResetScope = "gate" | "parent";

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
   * Every value that reads as on, which is not always just `onValue`. A mode can
   * have settings broader than the one Labs offers, and those must render as
   * enabled — otherwise the row shows off, and clicking it narrows a choice the
   * operator made deliberately somewhere else.
   */
  activeValues: readonly LabFeatureValue[];
  /**
   * Replaces the leaf read when the runtime decides enablement from more than
   * one key. Receives the value at the gate's parent, which may be the boolean
   * shorthand. Must mirror the runtime resolver it cites, or the row will
   * misreport a config the runtime considers on.
   */
  readEnabled: ((raw: unknown) => boolean) | null;
  /**
   * Extra keys written beside the gate when enabling, relative to the gate's
   * parent. Labs pins the variant we actually recommend rather than inheriting
   * whatever a bare enable defaults to.
   */
  enableAlso: Readonly<Record<string, LabFeatureValue>> | null;
  /**
   * Ownership boundary for default provenance and reset. Most rows own only
   * their gate; features whose runtime default depends on any parent config
   * own and reset that parent as a unit.
   */
  resetScope: LabFeatureResetScope;
  restartHint: (() => string) | null;
};

type LabFeatureState = {
  enabled: boolean;
  defaultEnabled: boolean;
  overridden: boolean;
};

function readConfiguredFeatureEnabled(
  raw: unknown,
  activeValues: readonly LabFeatureValue[],
): boolean {
  if (typeof raw === "boolean" || typeof raw === "string") {
    return activeValues.includes(raw);
  }
  if (!isRecord(raw)) {
    return false;
  }
  const enabled = raw.enabled;
  return typeof enabled === "boolean" || typeof enabled === "string"
    ? activeValues.includes(enabled)
    : Object.keys(raw).some((key) => key !== "enabled");
}

export const LAB_FEATURES = [
  {
    id: "codeMode",
    title: () => t("labsPage.codeMode.title"),
    description: () => t("labsPage.codeMode.description"),
    docsUrl: "https://docs.openclaw.ai/tools/code-mode",
    configPath: ["tools", "codeMode", "enabled"],
    // The on position writes the "auto" tier, never `true`: Labs offers
    // Auto/Off, and force-on for unevaluated models stays a config-only choice.
    onValue: "auto",
    offValue: false,
    activeValues: [true, "auto"],
    readEnabled: null,
    enableAlso: null,
    resetScope: "gate",
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
    activeValues: [true],
    // Mirrors resolveSwarmConfig: only an explicit false opts out; limits-only
    // objects inherit the enabled default without owning the gate.
    readEnabled: (raw) => raw !== false && (!isRecord(raw) || raw.enabled !== false),
    enableAlso: null,
    resetScope: "gate",
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
    activeValues: [true],
    // Mirrors resolveToolSearchConfig: the boolean shorthand decides directly,
    // and an object configuring anything besides `enabled` is already on.
    // Reading only the `enabled` leaf would show `{ mode: "tools" }` as off and
    // let a click replace that operator's mode with ours.
    readEnabled: (raw) => readConfiguredFeatureEnabled(raw, [true]),
    // resolveToolSearchConfig defaults an unset mode to "code" even in object
    // form, which is the surface with the weakest recall. Pin the bounded
    // directory instead, so enabling from Labs is the variant we recommend.
    enableAlso: { mode: "directory" },
    resetScope: "parent",
    restartHint: null,
  },
  {
    id: "loopDetection",
    title: () => t("labsPage.loopDetection.title"),
    description: () => t("labsPage.loopDetection.description"),
    docsUrl: "https://docs.openclaw.ai/tools/loop-detection",
    configPath: ["tools", "loopDetection", "enabled"],
    onValue: true,
    offValue: false,
    activeValues: [true],
    // ToolLoopDetectionSchema accepts object form only, and
    // resolveToolLoopDetectionConfig reads this enabled leaf directly.
    readEnabled: null,
    enableAlso: null,
    resetScope: "gate",
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
    activeValues: [true],
    readEnabled: null,
    enableAlso: null,
    resetScope: "gate",
    restartHint: null,
  },
  {
    id: "cliAgents",
    title: () => t("labsPage.cliAgents.title"),
    description: () => t("labsPage.cliAgents.description"),
    docsUrl: "https://docs.openclaw.ai/gateway/configuration-reference#gateway",
    configPath: ["gateway", "cliAgents", "enabled"],
    onValue: true,
    offValue: false,
    activeValues: [true],
    readEnabled: (raw) => !isRecord(raw) || raw.enabled !== false,
    enableAlso: null,
    resetScope: "gate",
    restartHint: null,
  },
  {
    id: "customPluginUi",
    title: () => t("labsPage.customPluginUi.title"),
    description: () => t("labsPage.customPluginUi.description"),
    docsUrl: "https://docs.openclaw.ai/plugins/feature-plugins",
    configPath: ["gateway", "controlUi", "experimental", "customPlugins"],
    onValue: true,
    offValue: false,
    activeValues: [true],
    readEnabled: null,
    enableAlso: null,
    resetScope: "gate",
    restartHint: () => t("labsPage.customPluginUi.restartRequired"),
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
    activeValues: ["direct", "all"],
    readEnabled: null,
    enableAlso: null,
    resetScope: "gate",
    // startGatewayEventSubscriptions resolves the mode once and bakes it into
    // the recorder, so this outlives the reload plan's `logging: none` rule.
    restartHint: () => t("labsPage.restartRequired"),
  },
  {
    id: "hostDesktop",
    title: () => t("labsPage.hostDesktop.title"),
    description: () => t("labsPage.hostDesktop.description"),
    docsUrl: "https://docs.openclaw.ai/gateway/configuration-reference#desktop",
    configPath: ["desktop", "host", "enabled"],
    onValue: true,
    offValue: false,
    activeValues: [true],
    readEnabled: null,
    enableAlso: null,
    resetScope: "gate",
    // Method advertisement is resolved at Gateway startup, so the panel appears after restart.
    restartHint: () => t("labsPage.restartRequired"),
  },
  {
    id: "workerDesktop",
    title: () => t("labsPage.workerDesktop.title"),
    description: () => t("labsPage.workerDesktop.description"),
    docsUrl: "https://docs.openclaw.ai/gateway/cloud-workers#desktop-interactive",
    configPath: ["cloudWorkers", "desktop"],
    onValue: true,
    offValue: false,
    activeValues: [true],
    readEnabled: null,
    enableAlso: null,
    resetScope: "gate",
    // Method advertisement is resolved at Gateway startup, so the panel appears after restart.
    restartHint: () => t("labsPage.restartRequired"),
  },
] as const satisfies readonly LabFeature[];

function recordAtPath(config: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = config;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function readEnabledFromParent(feature: LabFeature, parent: unknown): boolean {
  const key = feature.configPath.at(-1);
  if (feature.readEnabled) {
    return feature.readEnabled(parent);
  }
  // Feature gates can accept a boolean or mode shorthand as well as the object
  // form. A registry path ending in `enabled` must reflect every active shape.
  if (key === "enabled" && (typeof parent === "boolean" || typeof parent === "string")) {
    return feature.activeValues.includes(parent);
  }
  if (!isRecord(parent) || !key) {
    return false;
  }
  return feature.activeValues.includes(parent[key] as LabFeatureValue);
}

function labFeatureOverridePath(
  config: Record<string, unknown>,
  feature: LabFeature,
): readonly string[] | null {
  const parentPath = feature.configPath.slice(0, -1);
  const key = feature.configPath.at(-1);
  const parent = recordAtPath(config, parentPath);
  if (!key) {
    return null;
  }
  if (feature.resetScope === "parent") {
    return parent === undefined ? null : parentPath;
  }
  // Boolean/string shorthands own the parent node rather than an `enabled`
  // child. Resetting the child would replace the shorthand with an empty object.
  if (
    key === "enabled" &&
    parent !== undefined &&
    (typeof parent !== "object" || parent === null)
  ) {
    return parentPath;
  }
  if (isRecord(parent) && Object.hasOwn(parent, key)) {
    return feature.configPath;
  }
  return null;
}

export function resolveLabFeatureState(
  config: Record<string, unknown> | null,
  feature: LabFeature,
): LabFeatureState {
  const source = config ?? {};
  const parentPath = feature.configPath.slice(0, -1);
  const key = feature.configPath.at(-1);
  const parent = recordAtPath(source, parentPath);
  const overridePath = labFeatureOverridePath(source, feature);
  let defaultParent = parent;
  if (overridePath?.length === parentPath.length) {
    defaultParent = undefined;
  } else if (overridePath && key && isRecord(parent)) {
    defaultParent = { ...(parent as Record<string, unknown>) };
    delete (defaultParent as Record<string, unknown>)[key];
  }
  return {
    enabled: readEnabledFromParent(feature, parent),
    defaultEnabled: readEnabledFromParent(feature, defaultParent),
    overridden: overridePath !== null,
  };
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

export function labFeatureResetPatch(
  config: Record<string, unknown> | null,
  feature: LabFeature,
): Record<string, unknown> | null {
  const path = labFeatureOverridePath(config ?? {}, feature);
  if (!path?.length) {
    return null;
  }
  let patch: unknown = null;
  for (const segment of path.toReversed()) {
    patch = { [segment]: patch };
  }
  return patch as Record<string, unknown>;
}
