/**
 * JSON schema for the Browser agent tool.
 *
 * The schema stays intentionally flat because provider function-tool validators
 * reject several nested union shapes that TypeBox can otherwise emit.
 */
import {
  optionalFiniteNumberSchema,
  optionalNonNegativeIntegerSchema,
  optionalPositiveIntegerSchema,
  optionalStringEnum,
  stringEnum,
} from "openclaw/plugin-sdk/channel-actions";
import { Type } from "typebox";
import { BROWSER_TAB_BOUND_ACTIONS } from "./browser-tool-binding.js";
import { ACT_MAX_VIEWPORT_DIMENSION } from "./browser/constants.js";
import type { BrowserProfileCapabilities } from "./browser/profile-capabilities.js";

const BROWSER_ACT_KINDS = [
  "batch",
  "click",
  "clickCoords",
  "type",
  "press",
  "hover",
  "scrollIntoView",
  "drag",
  "select",
  "fill",
  "resize",
  "wait",
  "evaluate",
  "close",
] as const;

const BROWSER_TOOL_ACTIONS = [
  "doctor",
  "status",
  "start",
  "stop",
  "profiles",
  "importprofile",
  "tabs",
  "open",
  "focus",
  "close",
  "snapshot",
  "screenshot",
  "navigate",
  "console",
  "pdf",
  "download",
  "waitfordownload",
  "upload",
  "dialog",
  "act",
] as const;

const BROWSER_TARGETS = ["sandbox", "host", "node"] as const;

const BROWSER_SNAPSHOT_FORMATS = ["aria", "ai"] as const;
const BROWSER_SNAPSHOT_MODES = ["efficient"] as const;
const BROWSER_SNAPSHOT_REFS = ["role", "aria"] as const;

const BROWSER_IMAGE_TYPES = ["png", "jpeg"] as const;

const TAB_REFERENCE_DESCRIPTION =
  "Tab reference. Prefer suggestedTargetId, tabId, or label from tabs output; raw CDP targetId and unique raw prefixes remain supported for compatibility.";

// NOTE: Using a flattened object schema instead of Type.Union([Type.Object(...), ...])
// because Claude API on Vertex AI rejects nested anyOf schemas as invalid JSON Schema.
// The discriminator (kind) determines which properties are relevant; runtime validates.
export type BrowserToolCapabilities = {
  actions: readonly (typeof BROWSER_TOOL_ACTIONS)[number][];
  actKinds: readonly (typeof BROWSER_ACT_KINDS)[number][];
  tabBound: boolean;
};

export function resolveBrowserToolCapabilities(params?: {
  tabBound?: boolean;
  evaluateEnabled?: boolean;
  profileCapabilities?: Pick<
    BrowserProfileCapabilities,
    "supportsBatchActions" | "supportsDownloads" | "supportsPdf"
  >;
}): BrowserToolCapabilities {
  const evaluateEnabled = params?.evaluateEnabled !== false;
  const profileCapabilities = params?.profileCapabilities;
  const actions = params?.tabBound ? BROWSER_TAB_BOUND_ACTIONS : BROWSER_TOOL_ACTIONS;
  return {
    actions: actions.filter(
      (action) =>
        (profileCapabilities?.supportsPdf !== false || action !== "pdf") &&
        (profileCapabilities?.supportsDownloads !== false ||
          (action !== "download" && action !== "waitfordownload")),
    ),
    actKinds: BROWSER_ACT_KINDS.filter(
      (kind) =>
        (evaluateEnabled || kind !== "evaluate") &&
        (profileCapabilities?.supportsBatchActions !== false || kind !== "batch"),
    ),
    tabBound: params?.tabBound === true,
  };
}

function createBrowserActProperties(capabilities: BrowserToolCapabilities) {
  return {
    // Common fields
    targetId: Type.Optional(Type.String({ description: TAB_REFERENCE_DESCRIPTION })),
    ref: Type.Optional(Type.String()),
    // batch - permissive children keep the provider schema flat; runtime validates each action.
    actions: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }))),
    stopOnError: Type.Optional(Type.Boolean()),
    // click
    doubleClick: Type.Optional(Type.Boolean()),
    button: Type.Optional(Type.String()),
    modifiers: Type.Optional(Type.Array(Type.String())),
    x: optionalFiniteNumberSchema(),
    y: optionalFiniteNumberSchema(),
    // type
    text: Type.Optional(Type.String()),
    submit: Type.Optional(Type.Boolean()),
    slowly: Type.Optional(Type.Boolean()),
    // press
    key: Type.Optional(Type.String()),
    delayMs: optionalNonNegativeIntegerSchema(),
    // drag
    startRef: Type.Optional(Type.String()),
    endRef: Type.Optional(Type.String()),
    // select
    values: Type.Optional(Type.Array(Type.String())),
    // fill - use permissive array of objects
    fields: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }))),
    // resize
    width: optionalPositiveIntegerSchema({ maximum: ACT_MAX_VIEWPORT_DIMENSION }),
    height: optionalPositiveIntegerSchema({ maximum: ACT_MAX_VIEWPORT_DIMENSION }),
    // wait
    timeMs: optionalNonNegativeIntegerSchema(),
    selector: Type.Optional(Type.String()),
    url: Type.Optional(Type.String()),
    loadState: Type.Optional(Type.String()),
    textGone: Type.Optional(Type.String()),
    timeoutMs: optionalPositiveIntegerSchema(),
    // evaluate
    ...(capabilities.actKinds.includes("evaluate") ? { fn: Type.Optional(Type.String()) } : {}),
  };
}

// IMPORTANT: OpenAI function tool schemas must have a top-level `type: "object"`.
// A root-level `Type.Union([...])` compiles to `{ anyOf: [...] }` (no `type`),
// which OpenAI rejects ("Invalid schema ... type: None"). Keep this schema an object.
/** Provider-compatible Browser tool argument schema. */
export function createBrowserToolSchema(capabilities: BrowserToolCapabilities) {
  const actProperties = createBrowserActProperties(capabilities);
  const BrowserActSchema = Type.Object({
    kind: stringEnum(capabilities.actKinds),
    ...actProperties,
  });
  return Type.Object({
    action: stringEnum(capabilities.actions),
    target: optionalStringEnum(BROWSER_TARGETS),
    node: Type.Optional(Type.String()),
    profile: Type.Optional(Type.String()),
    browser: Type.Optional(Type.String()),
    systemProfile: Type.Optional(Type.String()),
    into: Type.Optional(Type.String()),
    domains: Type.Optional(Type.Array(Type.String())),
    targetUrl: Type.Optional(Type.String()),
    label: Type.Optional(Type.String()),
    limit: optionalPositiveIntegerSchema(),
    maxChars: optionalNonNegativeIntegerSchema(),
    mode: optionalStringEnum(BROWSER_SNAPSHOT_MODES),
    snapshotFormat: optionalStringEnum(BROWSER_SNAPSHOT_FORMATS),
    refs: optionalStringEnum(BROWSER_SNAPSHOT_REFS),
    interactive: Type.Optional(Type.Boolean()),
    compact: Type.Optional(Type.Boolean()),
    depth: optionalNonNegativeIntegerSchema(),
    frame: Type.Optional(Type.String()),
    labels: Type.Optional(Type.Boolean()),
    urls: Type.Optional(Type.Boolean()),
    fullPage: Type.Optional(Type.Boolean()),
    path: Type.Optional(Type.String()),
    element: Type.Optional(Type.String()),
    type: optionalStringEnum(BROWSER_IMAGE_TYPES),
    level: Type.Optional(Type.String()),
    paths: Type.Optional(Type.Array(Type.String())),
    inputRef: Type.Optional(Type.String()),
    dialogId: Type.Optional(Type.String()),
    accept: Type.Optional(Type.Boolean()),
    promptText: Type.Optional(Type.String()),
    // Legacy flattened act params (preferred: request={...})
    kind: Type.Optional(stringEnum(capabilities.actKinds)),
    ...actProperties,
    request: Type.Optional(BrowserActSchema),
  });
}

const BrowserSnapshotStatsSchema = Type.Object(
  {
    lines: Type.Number(),
    chars: Type.Number(),
    refs: Type.Number(),
    interactive: Type.Number(),
  },
  { additionalProperties: false },
);

const BrowserBatchAbortSchema = Type.Object(
  {
    reason: stringEnum(["navigation", "closed"] as const),
    afterAction: Type.Number(),
    url: Type.String(),
    skipped: Type.Number(),
  },
  { additionalProperties: false },
);

/** Common structured result fields returned across Browser tool actions. */
export const BrowserToolOutputSchema = Type.Object(
  {
    ok: Type.Optional(Type.Boolean()),
    targetId: Type.Optional(Type.String()),
    url: Type.Optional(Type.String()),
    format: Type.Optional(stringEnum(BROWSER_SNAPSHOT_FORMATS)),
    snapshot: Type.Optional(Type.String()),
    refs: Type.Optional(Type.Union([Type.Number(), Type.Record(Type.String(), Type.Unknown())])),
    stats: Type.Optional(BrowserSnapshotStatsSchema),
    truncated: Type.Optional(Type.Boolean()),
    newElements: Type.Optional(Type.Number()),
    tabs: Type.Optional(
      Type.Array(
        Type.Object(
          {
            suggestedTargetId: Type.Optional(Type.String()),
            tabId: Type.Optional(Type.String()),
            label: Type.Optional(Type.String()),
            targetId: Type.Optional(Type.String()),
            title: Type.Optional(Type.String()),
            url: Type.Optional(Type.String()),
            type: Type.Optional(Type.String()),
          },
          { additionalProperties: true },
        ),
      ),
    ),
    tabCount: Type.Optional(Type.Number()),
    results: Type.Optional(
      Type.Array(
        Type.Object(
          {
            ok: Type.Boolean(),
            error: Type.Optional(Type.String()),
            navigated: Type.Optional(Type.Literal(true)),
            url: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    aborted: Type.Optional(BrowserBatchAbortSchema),
    pageState: Type.Optional(
      Type.Object(
        {},
        {
          additionalProperties: true,
          description:
            "Inline snapshot details attached when the action changed the page document.",
        },
      ),
    ),
    enabled: Type.Optional(Type.Boolean()),
    running: Type.Optional(Type.Boolean()),
    profile: Type.Optional(Type.String()),
    driver: Type.Optional(Type.String()),
    transport: Type.Optional(Type.String()),
    pid: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    cdpPort: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    cdpUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: true },
);
