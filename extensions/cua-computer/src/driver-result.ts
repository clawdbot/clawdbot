import {
  COMPUTER_USE_V2_ACTION_NAMES,
  type ComputerActResult,
  type ComputerUseV2ActionName,
} from "openclaw/plugin-sdk/computer-use";
import { canonicalizeBase64 } from "openclaw/plugin-sdk/media-runtime";
import { z } from "zod";
import type { CuaDriverSession, CuaToolResult } from "./driver-client.js";
import {
  adoptGeneration,
  clearDialogRef,
  invalidateBrowserReferences,
  issueBrowserElementRef,
  issueBrowserObservation,
  issueBrowserRef,
  issueDialogRef,
  issuePageRef,
  issueAppRef,
  issueElementRef,
  issueObservation,
  issueWindowRef,
  type CuaFrameState,
} from "./frame.js";

const CUA_WIRE_ACTION_NAMES = COMPUTER_USE_V2_ACTION_NAMES.slice(1, 14);
const CUA_COMMON_ACTION_NAMES = [
  "screenshot",
  ...CUA_WIRE_ACTION_NAMES.filter((action) => action !== "hold_key"),
  "list_apps",
  "list_windows",
  "get_accessibility_tree",
  "get_cursor_position",
  "get_window_state",
  "launch_app",
  "kill_app",
  "bring_to_front",
  "set_value",
  "zoom",
  "get_browser_state",
  "browser_prepare",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_dialog",
  "browser_set_input_files",
  "browser_download",
  "browser_pointer",
  "escalate_scope",
  "get_recording_state",
  "start_recording",
  "stop_recording",
  "replay_trajectory",
  "invoke_menu",
] as const;

const NativeAppSchema = z.object({
  pid: z.number().int().nonnegative().nullable().optional(),
  bundle_id: z.string().nullable().optional(),
  name: z.string().min(1),
  running: z.boolean().nullable().optional(),
  active: z.boolean().optional(),
  kind: z.string().nullable().optional(),
  launch_path: z.string().nullable().optional(),
  last_used: z.string().nullable().optional(),
});
const NativeBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});
const NativeWindowSchema = z.object({
  window_id: z.number().int().nonnegative(),
  pid: z.number().int().positive().nullable().optional(),
  app_name: z.string().optional(),
  title: z.string().optional(),
  bounds: NativeBoundsSchema,
  is_on_screen: z.boolean().optional(),
  minimized: z.boolean().optional(),
  z_index: z.number().int().nullable().optional(),
});
const NativeElementSchema = z.object({
  element_index: z.number().int().nonnegative(),
  element_token: z.string().min(1).optional(),
  role: z.string().optional(),
  label: z.string().optional(),
  value: z.string().optional(),
  frame: z
    .object({
      x: z.number(),
      y: z.number(),
      w: z.number().nonnegative(),
      h: z.number().nonnegative(),
    })
    .optional(),
});
const NativeBrowserTabSchema = z.object({
  tab_id: z.string().min(1),
  title: z.string().optional(),
  url: z.string().optional(),
  active: z.boolean().optional(),
});
const NativeBrowserRefSchema = z.object({
  ref: z.string().min(1),
  node: z.string().optional(),
  role: z.string().optional(),
  label: z.string().optional(),
  name: z.string().optional(),
  value: z.string().optional(),
  states: z.array(z.string()).optional(),
  actions: z.array(z.string()).optional(),
  frame: z.string().optional(),
  visibility: z.string().optional(),
});
const MAX_DISCOVERY_ITEMS = 500;
const MAX_BROWSER_ELEMENTS = 2_000;
const PARTIAL_EFFECT = 1 as import("@trycua/cua-driver").ActionEffect;
const VALUE_READBACK_EVIDENCE = 0 as import("@trycua/cua-driver").ActionEvidenceKind;

export function platformActions(platform: NodeJS.Platform): ComputerUseV2ActionName[] {
  return CUA_COMMON_ACTION_NAMES.filter(
    (action) =>
      platform === "linux" || (action !== "left_mouse_down" && action !== "left_mouse_up"),
  ) as ComputerUseV2ActionName[];
}

function boundedItems<T>(items: T[]): { items: T[]; truncated: number } {
  return {
    items: items.slice(0, MAX_DISCOVERY_ITEMS),
    truncated: Math.max(0, items.length - MAX_DISCOVERY_ITEMS),
  };
}

function driverEffect(result: CuaToolResult): ComputerActResult["effect"] | undefined {
  switch (Number(result.action?.effect)) {
    case 0:
      return "confirmed";
    case 1:
    case 2:
      return "unverifiable";
    case 3:
      return "suspected_noop";
    case 4:
      throw new Error("COMPUTER_REFUSED_action_refused: CUA Driver refused the action");
    default:
      return undefined;
  }
}

function driverEscalation(result: CuaToolResult): ComputerActResult["escalation"] | undefined {
  const escalation = result.action?.escalation;
  if (!escalation) {
    return undefined;
  }
  const recommended = {
    0: "window-pixel",
    1: "foreground",
    2: "window-pixel",
    3: "desktop",
  }[escalation.target] as NonNullable<ComputerActResult["escalation"]>["recommended"] | undefined;
  const reasonCode = {
    0: "route_unavailable",
    1: "delivery_failed",
    2: "effect_unconfirmed",
    3: "suspected_noop",
    4: "permission_required",
  }[escalation.reason];
  if (!recommended || !reasonCode) {
    throw new Error("COMPUTER_DRIVER_ERROR: invalid CUA Driver action escalation");
  }
  return { recommended, reasonCode };
}

function driverActionDetails(result: CuaToolResult): Record<string, unknown> | undefined {
  const action = result.action;
  if (!action) {
    return undefined;
  }
  const details: Record<string, unknown> = {
    route: [
      "accessibility",
      "synthetic_events",
      "global_input",
      "system_api",
      "dom",
      "trusted_input",
    ][action.route],
  };
  if (action.effect === PARTIAL_EFFECT) {
    details.partial = true;
  }
  if (action.delivery) {
    details.deliveryMode = ["background", "foreground", "not_applicable", "unknown"][
      action.delivery.mode
    ];
    if (action.delivery.deliveredCount !== undefined) {
      details.deliveredCount = action.delivery.deliveredCount;
    }
  }
  if (action.evidence?.length) {
    details.evidence = action.evidence.map(({ kind }) =>
      kind === VALUE_READBACK_EVIDENCE ? "value_readback" : "window_change",
    );
  }
  return Object.values(details).some((value) => value !== undefined) ? details : undefined;
}

export function actionEnvelope(
  result: CuaToolResult,
  details?: Record<string, unknown>,
): ComputerActResult {
  const effect = driverEffect(result);
  const escalation = driverEscalation(result);
  const driverDetails = driverActionDetails(result);
  return {
    ok: true,
    ...(effect ? { effect } : {}),
    ...(escalation ? { escalation } : {}),
    ...(driverDetails || details ? { details: { ...driverDetails, ...details } } : {}),
  };
}

export async function callWindowTool(
  driver: CuaDriverSession,
  state: CuaFrameState,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CuaToolResult> {
  const callGeneration = driver.generation;
  const stateWasCurrent = state.generation === callGeneration;
  const result = await driver.callTool(name, args, signal);
  if (stateWasCurrent && driver.generation !== callGeneration) {
    adoptGeneration(state, driver.generation);
    throw new Error("COMPUTER_STALE_OBSERVATION: computer driver generation changed during action");
  }
  adoptGeneration(state, driver.generation);
  const refusalCode = result.errorCode ?? structuredRefusalCode(result);
  if (result.isError || refusalCode) {
    if (
      refusalCode &&
      [
        "browser_binding_stale",
        "browser_tab_not_found",
        "browser_ref_stale",
        "browser_reconnect_exhausted",
      ].includes(refusalCode)
    ) {
      invalidateBrowserReferences(state);
      throw new Error("COMPUTER_STALE_OBSERVATION: take a fresh browser observation and retry");
    }
    const code = refusalCode ? `COMPUTER_REFUSED_${refusalCode}` : "COMPUTER_DRIVER_ERROR";
    throw new Error(`${code}: ${result.text || `${name} failed`}`);
  }
  return result;
}

function structuredRefusalCode(result: CuaToolResult): string | undefined {
  if (!result.structuredJson) {
    return undefined;
  }
  try {
    const value = JSON.parse(result.structuredJson) as {
      status?: unknown;
      refusal?: { code?: unknown };
    };
    return value.status === "refused" && typeof value.refusal?.code === "string"
      ? value.refusal.code
      : undefined;
  } catch {
    return undefined;
  }
}

export function projectedToolDetails(result: CuaToolResult, tool: string): Record<string, unknown> {
  if (!result.structuredJson) {
    throw new Error(`COMPUTER_DRIVER_ERROR: ${tool} returned no structuredContent`);
  }
  try {
    const value: unknown = JSON.parse(result.structuredJson);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {}
  throw new Error(`COMPUTER_DRIVER_ERROR: ${tool} returned invalid structuredContent`);
}

export function nativeWindows(value: unknown): Array<z.infer<typeof NativeWindowSchema>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const parsed = NativeWindowSchema.safeParse(entry);
    return parsed.success && parsed.data.pid ? [parsed.data] : [];
  });
}

export function projectWindows(
  state: CuaFrameState,
  windows: Array<z.infer<typeof NativeWindowSchema>>,
): { windows: Array<Record<string, unknown>>; truncatedWindows?: number } {
  const bounded = boundedItems(windows);
  return {
    windows: bounded.items.map((window) => ({
      windowRef: issueWindowRef(state, { pid: window.pid!, windowId: window.window_id }),
      ...(window.app_name ? { appName: window.app_name } : {}),
      ...(window.title ? { title: window.title } : {}),
      bounds: window.bounds,
      ...(window.is_on_screen !== undefined ? { isOnScreen: window.is_on_screen } : {}),
      ...(window.minimized !== undefined ? { minimized: window.minimized } : {}),
      ...(window.z_index !== undefined ? { zIndex: window.z_index } : {}),
    })),
    ...(bounded.truncated ? { truncatedWindows: bounded.truncated } : {}),
  };
}

export function projectApps(state: CuaFrameState, value: unknown): Record<string, unknown> {
  const raw = Array.isArray(value) ? value : [];
  const apps = raw.flatMap((entry) => {
    const parsed = NativeAppSchema.safeParse(entry);
    if (!parsed.success) {
      return [];
    }
    const app = issueAppRef(state, {
      ...(parsed.data.pid ? { pid: parsed.data.pid } : {}),
      name: parsed.data.name,
      ...(parsed.data.bundle_id ? { bundleId: parsed.data.bundle_id } : {}),
      ...(parsed.data.launch_path ? { launchPath: parsed.data.launch_path } : {}),
    });
    return [
      {
        app,
        name: parsed.data.name,
        ...(parsed.data.running !== undefined ? { running: parsed.data.running } : {}),
        ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
        ...(parsed.data.kind ? { kind: parsed.data.kind } : {}),
        ...(parsed.data.last_used ? { lastUsed: parsed.data.last_used } : {}),
      },
    ];
  });
  const bounded = boundedItems(apps);
  return {
    apps: bounded.items,
    totalApps: apps.length,
    ...(bounded.truncated ? { truncatedApps: bounded.truncated } : {}),
  };
}

export function projectProcesses(value: unknown): Record<string, unknown> {
  const processes = boundedItems(Array.isArray(value) ? value : []);
  return {
    processes: processes.items,
    ...(processes.truncated ? { truncatedProcesses: processes.truncated } : {}),
  };
}

export function windowObservation(
  result: CuaToolResult,
  state: CuaFrameState,
  windowRef: string,
  options: { fromZoom?: boolean } = {},
): ComputerActResult {
  const structured = projectedToolDetails(result, options.fromZoom ? "zoom" : "get_window_state");
  const observation = issueObservation(state, windowRef, options);
  const snapshotId =
    typeof structured.snapshot_id === "string" ? structured.snapshot_id : undefined;
  const rawElements = Array.isArray(structured.elements) ? structured.elements : [];
  let omittedElementCount = 0;
  const elements = rawElements.slice(0, 2_000).flatMap((entry) => {
    const parsed = NativeElementSchema.safeParse(entry);
    if (!parsed.success || !parsed.data.frame) {
      omittedElementCount += 1;
      return [];
    }
    const elementRef = issueElementRef(observation, {
      elementIndex: parsed.data.element_index,
      ...(parsed.data.element_token ? { elementToken: parsed.data.element_token } : {}),
      ...(snapshotId ? { snapshotId } : {}),
    });
    return [
      {
        elementRef,
        role: parsed.data.role?.trim() || "unknown",
        ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}),
        ...(parsed.data.value !== undefined ? { value: parsed.data.value } : {}),
        bounds: {
          x: parsed.data.frame.x,
          y: parsed.data.frame.y,
          width: parsed.data.frame.w,
          height: parsed.data.frame.h,
        },
      },
    ];
  });
  const image = result.images.find((entry) => entry.mimeType === "image/png");
  const base64 = image ? canonicalizeBase64(image.dataBase64) : undefined;
  if (image && !base64) {
    throw new Error("COMPUTER_DRIVER_ERROR: CUA Driver returned malformed window PNG base64");
  }
  const width =
    typeof structured.screenshot_width === "number" && structured.screenshot_width > 0
      ? Math.trunc(structured.screenshot_width)
      : undefined;
  const height =
    typeof structured.screenshot_height === "number" && structured.screenshot_height > 0
      ? Math.trunc(structured.screenshot_height)
      : undefined;
  const details: Record<string, unknown> = {
    ...(typeof structured.total_element_count === "number"
      ? { totalElementCount: structured.total_element_count }
      : {}),
    ...(rawElements.length > 2_000 ? { truncatedElements: rawElements.length - 2_000 } : {}),
    ...(omittedElementCount ? { omittedElementsWithoutBounds: omittedElementCount } : {}),
    ...(structured.degraded === true ? { degraded: true } : {}),
    ...(typeof structured.degraded_reason === "string"
      ? { degradedReason: structured.degraded_reason }
      : {}),
    ...(typeof structured.screenshot_error === "string"
      ? { screenshotError: structured.screenshot_error }
      : {}),
  };
  const action = actionEnvelope(result, details);
  return {
    ...action,
    observation: {
      kind: "window",
      ...(base64 ? { base64, format: "png" as const } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      observationId: observation.id,
      ...(elements.length ? { elements } : {}),
    },
    ...(!action.escalation && structured.escalation && typeof structured.escalation === "object"
      ? { escalation: { recommended: "window-pixel", reasonCode: "ax_tree_unavailable" } }
      : {}),
  };
}

export function browserBinding(
  result: CuaToolResult,
  state: CuaFrameState,
  windowRef: string,
): ComputerActResult {
  const structured = projectedToolDetails(result, "get_browser_state");
  if (
    structured.mode !== "bind" ||
    typeof structured.target_id !== "string" ||
    structured.target_id.length === 0 ||
    !Array.isArray(structured.tabs)
  ) {
    throw new Error("COMPUTER_DRIVER_ERROR: invalid browser bind result");
  }
  const browserRef = issueBrowserRef(state, { targetId: structured.target_id, windowRef });
  const pages = structured.tabs.flatMap((entry) => {
    const parsed = NativeBrowserTabSchema.safeParse(entry);
    if (!parsed.success) {
      return [];
    }
    return [
      {
        pageRef: issuePageRef(state, browserRef, parsed.data.tab_id),
        ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
        ...(parsed.data.url !== undefined ? { url: parsed.data.url } : {}),
        ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
      },
    ];
  });
  const bounded = boundedItems(pages);
  return {
    ok: true,
    details: {
      browserRef,
      pages: bounded.items,
      ...(bounded.truncated ? { truncatedPages: bounded.truncated } : {}),
      ...(typeof structured.binding_quality === "string"
        ? { bindingQuality: structured.binding_quality }
        : {}),
      ...(typeof structured.binding_route === "string"
        ? { bindingRoute: structured.binding_route }
        : {}),
      ...(typeof structured.mutation_allowed === "boolean"
        ? { mutationAllowed: structured.mutation_allowed }
        : {}),
      ...(typeof structured.native_title === "string"
        ? { nativeTitle: structured.native_title }
        : {}),
    },
  };
}

export function browserObservation(
  result: CuaToolResult,
  state: CuaFrameState,
  target: {
    browserRef: string;
    pageRef: string;
    targetId: string;
    tabId: string;
  },
): ComputerActResult {
  const structured = projectedToolDetails(result, "get_browser_state");
  if (
    structured.mode !== "snapshot" ||
    structured.target_id !== target.targetId ||
    structured.tab_id !== target.tabId
  ) {
    throw new Error("COMPUTER_DRIVER_ERROR: invalid browser snapshot result");
  }
  const observation = issueBrowserObservation(state, target.browserRef, target.pageRef);
  const rawRefs = [
    ...(Array.isArray(structured.refs)
      ? structured.refs.map((value) => ({ value, kind: "action" }))
      : []),
    ...(Array.isArray(structured.content_refs)
      ? structured.content_refs.map((value) => ({ value, kind: "content" }))
      : []),
  ];
  const seen = new Set<string>();
  const elements = rawRefs.flatMap(({ value, kind }) => {
    const parsed = NativeBrowserRefSchema.safeParse(value);
    if (!parsed.success || seen.has(parsed.data.ref)) {
      return [];
    }
    seen.add(parsed.data.ref);
    return [
      {
        elementRef: issueBrowserElementRef(observation, parsed.data.ref),
        kind,
        ...(parsed.data.node !== undefined ? { node: parsed.data.node } : {}),
        ...(parsed.data.role !== undefined ? { role: parsed.data.role } : {}),
        ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}),
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.value !== undefined ? { value: parsed.data.value } : {}),
        ...(parsed.data.states !== undefined ? { states: parsed.data.states } : {}),
        ...(parsed.data.actions !== undefined ? { actions: parsed.data.actions } : {}),
        ...(parsed.data.frame !== undefined ? { frame: parsed.data.frame } : {}),
        ...(parsed.data.visibility !== undefined ? { visibility: parsed.data.visibility } : {}),
      },
    ];
  });
  const boundedElements = elements.slice(0, MAX_BROWSER_ELEMENTS);
  const image = result.images.find((entry) => entry.mimeType === "image/png");
  const base64 = image ? canonicalizeBase64(image.dataBase64) : undefined;
  if (image && !base64) {
    throw new Error("COMPUTER_DRIVER_ERROR: CUA Driver returned malformed browser PNG base64");
  }
  const width =
    typeof structured.screenshot_width === "number" && structured.screenshot_width > 0
      ? Math.trunc(structured.screenshot_width)
      : undefined;
  const height =
    typeof structured.screenshot_height === "number" && structured.screenshot_height > 0
      ? Math.trunc(structured.screenshot_height)
      : undefined;
  const page =
    structured.page && typeof structured.page === "object" && !Array.isArray(structured.page)
      ? (structured.page as Record<string, unknown>)
      : undefined;
  return {
    ok: true,
    observation: {
      kind: "browser",
      ...(base64 ? { base64, format: "png" as const } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      observationId: observation.id,
    },
    details: {
      browserRef: target.browserRef,
      pageRef: target.pageRef,
      elements: boundedElements,
      ...(elements.length > MAX_BROWSER_ELEMENTS
        ? { truncatedElements: elements.length - MAX_BROWSER_ELEMENTS }
        : {}),
      ...(typeof structured.snapshot_id === "string"
        ? { snapshot: { format: "dom_refs_v1" } }
        : structured.snapshot &&
            typeof structured.snapshot === "object" &&
            !Array.isArray(structured.snapshot)
          ? {
              snapshot: projectSemanticBrowserSnapshot(
                structured.snapshot as Record<string, unknown>,
              ),
            }
          : {}),
      ...(typeof structured.url === "string" ? { url: structured.url } : {}),
      ...(page
        ? {
            page: {
              ...(typeof page.url === "string" ? { url: page.url } : {}),
              ...(typeof page.title === "string" ? { title: page.title } : {}),
            },
          }
        : {}),
      ...(typeof structured.truncated === "boolean" ? { truncated: structured.truncated } : {}),
    },
  };
}

export function browserToolEnvelope(
  result: CuaToolResult,
  tool:
    | "browser_prepare"
    | "browser_navigate"
    | "browser_click"
    | "browser_type"
    | "browser_set_input_files"
    | "browser_download"
    | "browser_pointer",
): ComputerActResult {
  if (tool === "browser_click" || tool === "browser_type" || tool === "browser_pointer") {
    return actionEnvelope(result);
  }
  const structured = projectedToolDetails(result, tool);
  const details: Record<string, unknown> = {};
  if (tool === "browser_prepare") {
    for (const [source, destination] of [
      ["prepared", "prepared"],
      ["action", "action"],
      ["message", "message"],
      ["side_effects", "sideEffects"],
    ] as const) {
      if (structured[source] !== undefined) {
        details[destination] = structured[source];
      }
    }
    const endpointOwnership = structured.endpoint_ownership;
    if (
      endpointOwnership &&
      typeof endpointOwnership === "object" &&
      !Array.isArray(endpointOwnership) &&
      typeof (endpointOwnership as Record<string, unknown>).method === "string"
    ) {
      details.endpointOwnership = {
        method: (endpointOwnership as Record<string, unknown>).method,
      };
    }
  } else if (tool === "browser_navigate") {
    if (typeof structured.url === "string") {
      details.url = structured.url;
    }
    if (typeof structured.refs_invalidated === "boolean") {
      details.refsInvalidated = structured.refs_invalidated;
    }
  } else if (tool === "browser_set_input_files") {
    if (typeof structured.file_count === "number") {
      details.fileCount = structured.file_count;
    }
    if (typeof structured.frame === "string") {
      details.frame = structured.frame;
    }
  } else if (tool === "browser_download") {
    if (typeof structured.status === "string") {
      details.status = structured.status;
    }
    if (typeof structured.bytes === "number") {
      details.bytes = structured.bytes;
    }
  }
  return { ok: true, ...(Object.keys(details).length ? { details } : {}) };
}

function projectSemanticBrowserSnapshot(snapshot: Record<string, unknown>) {
  return {
    format: "semantic_v2",
    ...(typeof snapshot.complete === "boolean" ? { complete: snapshot.complete } : {}),
    ...(typeof snapshot.selected_nodes === "number"
      ? { selectedNodes: snapshot.selected_nodes }
      : {}),
    ...(typeof snapshot.total_nodes === "number" ? { totalNodes: snapshot.total_nodes } : {}),
    ...(snapshot.omitted && typeof snapshot.omitted === "object" && !Array.isArray(snapshot.omitted)
      ? { omitted: snapshot.omitted }
      : {}),
    ...(typeof snapshot.continuation === "string" ? { continuation: snapshot.continuation } : {}),
  };
}

export function browserDialogEnvelope(
  result: CuaToolResult,
  state: CuaFrameState,
  target: { browserRef: string; pageRef: string },
): ComputerActResult {
  const structured = projectedToolDetails(result, "browser_dialog");
  const present = structured.present === true;
  if (!present) {
    clearDialogRef(state);
  }
  const details: Record<string, unknown> = { present };
  if (typeof structured.kind === "string") {
    details.kind = structured.kind;
  }
  if (present && typeof structured.dialog_id === "string") {
    details.dialogRef = issueDialogRef(
      state,
      structured.dialog_id,
      target.browserRef,
      target.pageRef,
    );
  }
  if (typeof structured.action === "string") {
    details.action = structured.action;
  }
  return { ok: true, details };
}
