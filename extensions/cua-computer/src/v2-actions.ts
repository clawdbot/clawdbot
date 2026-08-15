import {
  COMPUTER_USE_V2_ACTION_NAMES,
  type ComputerActParams,
} from "openclaw/plugin-sdk/computer-use";
import { normalizeModifiers, parseKeyChord } from "./actions.js";
import { EscalationReason, type CuaDriverSession } from "./driver-client.js";
import {
  actionEnvelope,
  browserBinding,
  browserDialogEnvelope,
  browserObservation,
  browserToolEnvelope,
  callWindowTool,
  nativeWindows,
  projectApps,
  projectedToolDetails,
  projectProcesses,
  projectWindows,
  windowObservation,
} from "./driver-result.js";
import {
  adoptGeneration,
  clearDialogRef,
  invalidateBrowserObservation,
  resolveBrowserElementRef,
  resolveBrowserObservation,
  resolveBrowserRef,
  resolveDialogRef,
  resolveAppRef,
  resolveElementRef,
  resolveObservation,
  resolvePageRef,
  resolveWindowRef,
  verifyGeneration,
  type CuaFrameState,
} from "./frame.js";

const CUA_WIRE_ACTION_NAMES = COMPUTER_USE_V2_ACTION_NAMES.slice(1, 14);
const CUA_TARGETED_ACTION_NAMES = new Set([
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "left_click_drag",
  "left_mouse_down",
  "left_mouse_up",
  "scroll",
  "type",
  "key",
] as const);

export type CuaComputerActParams = {
  action: ComputerActParams["action"];
  displayFrameId?: string;
  x?: number;
  y?: number;
  fromX?: number;
  fromY?: number;
  text?: string;
  keys?: string;
  modifiers?: string;
  scrollDirection?: "up" | "down" | "left" | "right";
  scrollAmount?: number;
  durationMs?: number;
  screenIndex?: number;
  refWidth?: number;
  windowRef?: string;
  elementRef?: string;
  observationId?: string;
  deliveryMode?: "background" | "foreground";
  query?: string;
  depth?: number;
  maxElements?: number;
  app?: string;
  value?: string;
  path?: string[];
  browserRef?: string;
  pageRef?: string;
  snapshotFormat?: "dom_refs_v1" | "semantic_v2";
  continuation?: string;
  includeScreenshot?: boolean;
  profile?: "isolated_new" | "isolated_named";
  profileName?: string;
  url?: string;
  inputRoute?: "trusted" | "dom_event";
  mode?: "insert_text" | "keystrokes";
  replace?: boolean;
  dialogAction?: "inspect" | "accept" | "dismiss";
  dialogRef?: string;
  promptText?: string;
  files?: string[];
  destinationRoot?: string;
  pointerAction?: "hover" | "right_click" | "double_click" | "scroll" | "drag";
  destinationElementRef?: string;
  toX?: number;
  toY?: number;
  deltaX?: number;
  deltaY?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  reason?:
    | "ax_tree_pixel_mismatch"
    | "background_delivery_failed"
    | "foreground_ineffective"
    | "no_window_target"
    | "other";
};

function requireWindowTarget(
  driver: CuaDriverSession,
  state: CuaFrameState,
  params: CuaComputerActParams,
) {
  verifyGeneration(state, driver.generation);
  if (!params.windowRef) {
    throw new Error(`COMPUTER_INVALID_REQUEST: windowRef is required for ${params.action}`);
  }
  return {
    ref: params.windowRef,
    target: resolveWindowRef(state, params.windowRef),
  };
}

function observationTarget(state: CuaFrameState, params: CuaComputerActParams, windowRef: string) {
  if (!params.observationId) {
    throw new Error(`COMPUTER_STALE_OBSERVATION: observationId is required for ${params.action}`);
  }
  return resolveObservation(state, params.observationId, windowRef);
}

function elementArgs(
  state: CuaFrameState,
  params: CuaComputerActParams,
  windowRef: string,
): Record<string, unknown> | undefined {
  if (!params.elementRef) {
    return undefined;
  }
  const observation = observationTarget(state, params, windowRef);
  const element = resolveElementRef(observation, params.elementRef);
  return element.elementToken
    ? { element_token: element.elementToken }
    : {
        element_index: element.elementIndex,
        ...(element.snapshotId ? { snapshot_id: element.snapshotId } : {}),
      };
}

function browserTarget(
  driver: CuaDriverSession,
  state: CuaFrameState,
  params: CuaComputerActParams,
) {
  verifyGeneration(state, driver.generation);
  if (!params.browserRef || !params.pageRef) {
    throw new Error(
      `COMPUTER_INVALID_REQUEST: browserRef and pageRef are required for ${params.action}`,
    );
  }
  const browser = resolveBrowserRef(state, params.browserRef);
  const page = resolvePageRef(state, params.browserRef, params.pageRef);
  return {
    browserRef: params.browserRef,
    pageRef: params.pageRef,
    targetId: browser.targetId,
    tabId: page.tabId,
  };
}

function browserElement(
  state: CuaFrameState,
  params: CuaComputerActParams,
  target: { browserRef: string; pageRef: string },
  elementRef = params.elementRef,
): string | undefined {
  if (!elementRef) {
    return undefined;
  }
  if (!params.observationId) {
    throw new Error(`COMPUTER_STALE_OBSERVATION: observationId is required for ${params.action}`);
  }
  const observation = resolveBrowserObservation(
    state,
    params.observationId,
    target.browserRef,
    target.pageRef,
  );
  return resolveBrowserElementRef(observation, elementRef);
}

function windowPointArgs(
  state: CuaFrameState,
  params: CuaComputerActParams,
  windowRef: string,
  point: { x?: number; y?: number },
  label: string,
): Record<string, unknown> {
  if (point.x === undefined || point.y === undefined) {
    throw new Error(`COMPUTER_INVALID_REQUEST: ${label} coordinates are required`);
  }
  const observation = observationTarget(state, params, windowRef);
  return {
    x: point.x,
    y: point.y,
    ...(observation.fromZoom ? { from_zoom: true } : {}),
  };
}

async function handleTargetedAct(
  platform: NodeJS.Platform,
  driver: CuaDriverSession,
  state: CuaFrameState,
  params: CuaComputerActParams,
  signal?: AbortSignal,
): Promise<string> {
  const { ref: windowRef, target } = requireWindowTarget(driver, state, params);
  const base = { pid: target.pid, window_id: target.windowId };
  const delivery = params.deliveryMode ? { delivery_mode: params.deliveryMode } : {};
  const element = elementArgs(state, params, windowRef);
  let tool: string;
  let args: Record<string, unknown>;

  switch (params.action) {
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click": {
      tool = "click";
      const button =
        params.action === "right_click"
          ? "right"
          : params.action === "middle_click"
            ? "middle"
            : "left";
      const count = params.action === "double_click" ? 2 : params.action === "triple_click" ? 3 : 1;
      const modifiers = normalizeModifiers(params.modifiers);
      args = {
        ...base,
        ...(element ?? windowPointArgs(state, params, windowRef, params, "click")),
        button,
        count,
        ...(modifiers.length ? { modifier: modifiers } : {}),
        ...delivery,
      };
      break;
    }
    case "left_click_drag": {
      if (element) {
        throw new Error("COMPUTER_UNSUPPORTED_ACTION: cua-driver drag has no element target");
      }
      tool = "drag";
      const from = windowPointArgs(
        state,
        params,
        windowRef,
        { x: params.fromX, y: params.fromY },
        "drag start",
      );
      const to = windowPointArgs(state, params, windowRef, params, "drag end");
      const modifiers = normalizeModifiers(params.modifiers);
      args = {
        ...base,
        from_x: from.x,
        from_y: from.y,
        to_x: to.x,
        to_y: to.y,
        ...(from.from_zoom || to.from_zoom ? { from_zoom: true } : {}),
        ...(params.durationMs === undefined
          ? {}
          : { duration_ms: Math.min(10_000, params.durationMs) }),
        ...(modifiers.length ? { modifier: modifiers } : {}),
        ...delivery,
      };
      break;
    }
    case "left_mouse_down": {
      if (platform !== "linux") {
        throw new Error("COMPUTER_UNSUPPORTED_ACTION: left_mouse_down is Linux-only");
      }
      if (element || params.deliveryMode === "foreground") {
        throw new Error(
          "COMPUTER_UNSUPPORTED_ACTION: left_mouse_down supports only background window pixels",
        );
      }
      tool = "mouse_button_down";
      args = {
        ...base,
        ...windowPointArgs(state, params, windowRef, params, "mouse down"),
        button: "left",
      };
      break;
    }
    case "left_mouse_up": {
      if (platform !== "linux") {
        throw new Error("COMPUTER_UNSUPPORTED_ACTION: left_mouse_up is Linux-only");
      }
      if (element || params.deliveryMode === "foreground") {
        throw new Error(
          "COMPUTER_UNSUPPORTED_ACTION: left_mouse_up supports only background window pixels",
        );
      }
      tool = "mouse_button_up";
      args = {
        ...base,
        ...(params.x !== undefined || params.y !== undefined
          ? windowPointArgs(state, params, windowRef, params, "mouse up")
          : {}),
      };
      break;
    }
    case "scroll": {
      if (!params.scrollDirection) {
        throw new Error("COMPUTER_INVALID_REQUEST: scrollDirection is required for scroll");
      }
      if (normalizeModifiers(params.modifiers).length) {
        throw new Error(
          "COMPUTER_UNSUPPORTED_ACTION: modifier-held scroll is unsupported by cua-driver",
        );
      }
      tool = "scroll";
      args = {
        ...base,
        ...(element ??
          (params.x !== undefined || params.y !== undefined
            ? windowPointArgs(state, params, windowRef, params, "scroll")
            : {})),
        direction: params.scrollDirection,
        by: "line",
        amount: Math.min(50, params.scrollAmount ?? 3),
        ...delivery,
      };
      break;
    }
    case "type": {
      if (!params.text) {
        throw new Error("COMPUTER_INVALID_REQUEST: text is required for type");
      }
      tool = "type_text";
      args = {
        ...base,
        ...(element ??
          (params.x !== undefined || params.y !== undefined
            ? windowPointArgs(state, params, windowRef, params, "type")
            : {})),
        text: params.text,
        ...delivery,
      };
      break;
    }
    case "key": {
      const chord = parseKeyChord(params.keys);
      tool = "press_key";
      args = {
        ...base,
        ...(element ??
          (params.x !== undefined || params.y !== undefined
            ? windowPointArgs(state, params, windowRef, params, "key")
            : {})),
        key: chord.key,
        modifiers: chord.modifiers,
        ...delivery,
      };
      break;
    }
    default:
      throw new Error(`COMPUTER_UNSUPPORTED_ACTION: ${params.action}`);
  }

  const result = await callWindowTool(driver, state, tool, args, signal);
  return JSON.stringify(actionEnvelope(result));
}

export async function handleV2Act(
  platform: NodeJS.Platform,
  driver: CuaDriverSession,
  state: CuaFrameState,
  params: ComputerActParams,
  handleDesktop: (
    driver: CuaDriverSession,
    state: CuaFrameState,
    params: ComputerActParams,
    signal?: AbortSignal,
  ) => Promise<string>,
  signal?: AbortSignal,
): Promise<string> {
  const input = params as CuaComputerActParams & Record<string, unknown>;
  if (
    CUA_TARGETED_ACTION_NAMES.has(input.action as never) &&
    (input.windowRef || input.elementRef)
  ) {
    return await handleTargetedAct(platform, driver, state, input, signal);
  }
  if ((CUA_WIRE_ACTION_NAMES as readonly string[]).includes(input.action)) {
    return await handleDesktop(driver, state, params, signal);
  }

  switch (input.action) {
    case "list_apps": {
      const result = await callWindowTool(driver, state, "list_apps", {}, signal);
      state.apps = new Map();
      const structured = projectedToolDetails(result, "list_apps");
      return JSON.stringify({ ok: true, details: projectApps(state, structured.apps) });
    }
    case "list_windows": {
      const result = await callWindowTool(driver, state, "list_windows", {}, signal);
      const structured = projectedToolDetails(result, "list_windows");
      return JSON.stringify({
        ok: true,
        details: projectWindows(state, nativeWindows(structured.windows)),
      });
    }
    case "get_accessibility_tree": {
      if (input.windowRef || input.query || input.depth !== undefined || input.maxElements) {
        throw new Error(
          "COMPUTER_UNSUPPORTED_ACTION: CUA Driver 0.19.3 exposes get_accessibility_tree only as unfiltered desktop discovery; use get_window_state for a window tree",
        );
      }
      const result = await callWindowTool(driver, state, "get_accessibility_tree", {}, signal);
      const structured = projectedToolDetails(result, "get_accessibility_tree");
      return JSON.stringify({
        ok: true,
        details: {
          ...projectWindows(state, nativeWindows(structured.windows)),
          ...projectProcesses(structured.processes),
        },
      });
    }
    case "get_cursor_position": {
      const result = await callWindowTool(driver, state, "get_cursor_position", {}, signal);
      return JSON.stringify({
        ok: true,
        details: projectedToolDetails(result, "get_cursor_position"),
      });
    }
    case "get_window_state": {
      verifyGeneration(state, driver.generation);
      const window = resolveWindowRef(state, input.windowRef!);
      const result = await callWindowTool(
        driver,
        state,
        "get_window_state",
        {
          pid: window.pid,
          window_id: window.windowId,
          include_screenshot: true,
          max_elements: input.maxElements ?? 2_000,
          ...(input.depth !== undefined ? { max_depth: Math.max(1, input.depth) } : {}),
          ...(input.query ? { query: input.query } : {}),
        },
        signal,
      );
      return JSON.stringify(windowObservation(result, state, input.windowRef!));
    }
    case "launch_app": {
      verifyGeneration(state, driver.generation);
      const appName = input.app!;
      const app = resolveAppRef(state, appName);
      if (appName.startsWith("cua:v2:app:") && !app) {
        throw new Error("COMPUTER_STALE_OBSERVATION: refresh list_apps and retry");
      }
      const result = await callWindowTool(
        driver,
        state,
        "launch_app",
        app
          ? app.launchPath
            ? { launch_path: app.launchPath }
            : app.bundleId
              ? { bundle_id: app.bundleId }
              : { name: app.name }
          : { name: appName },
        signal,
      );
      const structured = projectedToolDetails(result, "launch_app");
      return JSON.stringify({
        ...actionEnvelope(result),
        details: {
          app: projectApps(state, [structured]).apps,
          ...projectWindows(state, nativeWindows(structured.windows)),
        },
      });
    }
    case "kill_app": {
      verifyGeneration(state, driver.generation);
      const appName = input.app!;
      const app = resolveAppRef(state, appName);
      if (!app?.pid) {
        throw new Error(
          "COMPUTER_INVALID_REQUEST: kill_app requires a running app reference from list_apps",
        );
      }
      const result = await callWindowTool(driver, state, "kill_app", { pid: app.pid }, signal);
      return JSON.stringify(actionEnvelope(result, { app: appName }));
    }
    case "bring_to_front": {
      const { target } = requireWindowTarget(driver, state, input);
      const result = await callWindowTool(
        driver,
        state,
        "bring_to_front",
        {
          pid: target.pid,
          window_id: target.windowId,
        },
        signal,
      );
      return JSON.stringify(actionEnvelope(result));
    }
    case "set_value": {
      const { ref, target } = requireWindowTarget(driver, state, input);
      if (input.deliveryMode === "foreground") {
        throw new Error(
          "COMPUTER_UNSUPPORTED_ACTION: cua-driver set_value is background accessibility delivery",
        );
      }
      const element = elementArgs(state, input, ref);
      if (!element) {
        throw new Error("COMPUTER_INVALID_REQUEST: elementRef is required for set_value");
      }
      const result = await callWindowTool(
        driver,
        state,
        "set_value",
        {
          pid: target.pid,
          window_id: target.windowId,
          ...element,
          value: input.value,
        },
        signal,
      );
      return JSON.stringify(actionEnvelope(result));
    }
    case "invoke_menu": {
      const { target } = requireWindowTarget(driver, state, input);
      if (input.deliveryMode === "foreground") {
        throw new Error(
          "COMPUTER_UNSUPPORTED_ACTION: cua-driver invoke_menu is background accessibility delivery",
        );
      }
      const result = await callWindowTool(
        driver,
        state,
        "invoke_menu",
        {
          pid: target.pid,
          window_id: target.windowId,
          path: input.path,
        },
        signal,
      );
      return JSON.stringify(actionEnvelope(result));
    }
    case "zoom": {
      const { ref, target } = requireWindowTarget(driver, state, input);
      resolveObservation(state, input.observationId!, ref);
      const result = await callWindowTool(
        driver,
        state,
        "zoom",
        {
          pid: target.pid,
          window_id: target.windowId,
          x1: input.x1,
          y1: input.y1,
          x2: input.x2,
          y2: input.y2,
        },
        signal,
      );
      return JSON.stringify(windowObservation(result, state, ref, { fromZoom: true }));
    }
    case "get_browser_state": {
      verifyGeneration(state, driver.generation);
      if (input.windowRef) {
        const window = resolveWindowRef(state, input.windowRef);
        const result = await callWindowTool(
          driver,
          state,
          "get_browser_state",
          { pid: window.pid, window_id: window.windowId },
          signal,
        );
        return JSON.stringify(browserBinding(result, state, input.windowRef));
      }
      const target = browserTarget(driver, state, input);
      const snapshotFormat = input.snapshotFormat ?? "dom_refs_v1";
      if (
        snapshotFormat === "dom_refs_v1" &&
        (input.elementRef || input.query || input.continuation)
      ) {
        throw new Error(
          "COMPUTER_INVALID_REQUEST: elementRef, query, and continuation require snapshotFormat=semantic_v2",
        );
      }
      const scopeRef = browserElement(state, input, target);
      const result = await callWindowTool(
        driver,
        state,
        "get_browser_state",
        {
          target_id: target.targetId,
          tab_id: target.tabId,
          snapshot_format: snapshotFormat,
          include_screenshot: input.includeScreenshot ?? true,
          ...(scopeRef ? { scope_ref: scopeRef } : {}),
          ...(input.query ? { query: input.query } : {}),
          ...(input.continuation ? { continuation: input.continuation } : {}),
        },
        signal,
      );
      return JSON.stringify(browserObservation(result, state, target));
    }
    case "browser_prepare": {
      const { target } = requireWindowTarget(driver, state, input);
      const profile = input.profile ?? "isolated_new";
      if (profile === "isolated_named" && !input.profileName) {
        throw new Error(
          "COMPUTER_INVALID_REQUEST: profileName is required for an isolated_named browser profile",
        );
      }
      if (profile === "isolated_new" && input.profileName) {
        throw new Error(
          "COMPUTER_INVALID_REQUEST: profileName is valid only for an isolated_named browser profile",
        );
      }
      const result = await callWindowTool(
        driver,
        state,
        "browser_prepare",
        {
          pid: target.pid,
          allow_launch: true,
          profile: {
            mode: profile,
            ...(input.profileName ? { name: input.profileName } : {}),
          },
        },
        signal,
      );
      return JSON.stringify(browserToolEnvelope(result, "browser_prepare"));
    }
    case "browser_navigate": {
      const target = browserTarget(driver, state, input);
      const result = await callWindowTool(
        driver,
        state,
        "browser_navigate",
        { target_id: target.targetId, tab_id: target.tabId, url: input.url },
        signal,
      );
      invalidateBrowserObservation(state);
      return JSON.stringify(browserToolEnvelope(result, "browser_navigate"));
    }
    case "browser_click": {
      const target = browserTarget(driver, state, input);
      resolveBrowserObservation(state, input.observationId!, target.browserRef, target.pageRef);
      const ref = browserElement(state, input, target);
      const result = await callWindowTool(
        driver,
        state,
        "browser_click",
        {
          target_id: target.targetId,
          tab_id: target.tabId,
          ...(ref ? { ref } : {}),
          ...(input.x !== undefined ? { x: input.x } : {}),
          ...(input.y !== undefined ? { y: input.y } : {}),
          ...(input.inputRoute ? { input_route: input.inputRoute } : {}),
        },
        signal,
      );
      return JSON.stringify(browserToolEnvelope(result, "browser_click"));
    }
    case "browser_type": {
      const target = browserTarget(driver, state, input);
      const ref = browserElement(state, input, target)!;
      const result = await callWindowTool(
        driver,
        state,
        "browser_type",
        {
          target_id: target.targetId,
          tab_id: target.tabId,
          ref,
          text: input.text,
          ...(input.mode ? { mode: input.mode } : {}),
          ...(input.replace !== undefined ? { replace: input.replace } : {}),
        },
        signal,
      );
      return JSON.stringify(browserToolEnvelope(result, "browser_type"));
    }
    case "browser_dialog": {
      const target = browserTarget(driver, state, input);
      const dialogId =
        input.dialogAction === "inspect"
          ? undefined
          : resolveDialogRef(state, input.dialogRef!, target.browserRef, target.pageRef);
      const result = await callWindowTool(
        driver,
        state,
        "browser_dialog",
        {
          target_id: target.targetId,
          tab_id: target.tabId,
          action: input.dialogAction,
          ...(dialogId ? { dialog_id: dialogId } : {}),
          ...(input.promptText !== undefined ? { prompt_text: input.promptText } : {}),
          ...(input.deliveryMode ? { delivery_mode: input.deliveryMode } : {}),
        },
        signal,
      );
      if (input.dialogAction !== "inspect") {
        clearDialogRef(state);
      }
      return JSON.stringify(browserDialogEnvelope(result, state, target));
    }
    case "browser_set_input_files": {
      const target = browserTarget(driver, state, input);
      const ref = browserElement(state, input, target)!;
      const result = await callWindowTool(
        driver,
        state,
        "browser_set_input_files",
        {
          target_id: target.targetId,
          tab_id: target.tabId,
          ref,
          files: input.files,
        },
        signal,
      );
      return JSON.stringify(browserToolEnvelope(result, "browser_set_input_files"));
    }
    case "browser_download": {
      const target = browserTarget(driver, state, input);
      const ref = browserElement(state, input, target)!;
      const result = await callWindowTool(
        driver,
        state,
        "browser_download",
        {
          target_id: target.targetId,
          tab_id: target.tabId,
          ref,
          destination_root: input.destinationRoot,
        },
        signal,
      );
      return JSON.stringify(browserToolEnvelope(result, "browser_download"));
    }
    case "browser_pointer": {
      const target = browserTarget(driver, state, input);
      resolveBrowserObservation(state, input.observationId!, target.browserRef, target.pageRef);
      const ref = browserElement(state, input, target);
      const destinationRef = browserElement(state, input, target, input.destinationElementRef);
      const result = await callWindowTool(
        driver,
        state,
        "browser_pointer",
        {
          target_id: target.targetId,
          tab_id: target.tabId,
          action: input.pointerAction,
          ...(input.inputRoute ? { input_route: input.inputRoute } : {}),
          ...(ref ? { ref } : {}),
          ...(input.x !== undefined ? { x: input.x } : {}),
          ...(input.y !== undefined ? { y: input.y } : {}),
          ...(destinationRef ? { destination_ref: destinationRef } : {}),
          ...(input.toX !== undefined ? { to_x: input.toX } : {}),
          ...(input.toY !== undefined ? { to_y: input.toY } : {}),
          ...(input.deltaX !== undefined ? { delta_x: input.deltaX } : {}),
          ...(input.deltaY !== undefined ? { delta_y: input.deltaY } : {}),
        },
        signal,
      );
      return JSON.stringify(browserToolEnvelope(result, "browser_pointer"));
    }
    case "escalate_scope": {
      const reason = {
        ax_tree_pixel_mismatch: EscalationReason.AxTreePixelMismatch,
        background_delivery_failed: EscalationReason.BackgroundDeliveryFailed,
        foreground_ineffective: EscalationReason.ForegroundIneffective,
        no_window_target: EscalationReason.NoWindowTarget,
        other: EscalationReason.Other,
      }[input.reason!];
      const result = await driver.escalateScope(reason, signal);
      adoptGeneration(state, driver.generation);
      return JSON.stringify({
        ok: true,
        details: {
          captureScope: result.captureScope,
          effectiveScope: result.effectiveScope,
          desktopUnlocked: result.desktopUnlocked,
        },
      });
    }
    default:
      throw new Error(`COMPUTER_UNSUPPORTED_ACTION: ${input.action}`);
  }
}
/* oxlint-disable max-lines -- One action switch is the canonical CUA v2 mapper; splitting browser actions would fork its ref/session lifecycle. */
