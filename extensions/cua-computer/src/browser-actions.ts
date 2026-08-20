import { browserElement, browserTarget, requireWindowTarget } from "./action-targets.js";
import type { CuaComputerActParams } from "./action-targets.js";
import type { CuaDriverSession, CuaToolResult } from "./driver-client.js";
import {
  browserBinding,
  browserDialogEnvelope,
  browserObservation,
  browserToolEnvelope,
  callWindowTool,
} from "./driver-result.js";
import type { CuaExecutionResources } from "./execution-resources.js";
import {
  clearDialogRef,
  invalidateBrowserObservation,
  resolveBrowserObservation,
  resolveDialogRef,
  resolveWindowRef,
  verifyGeneration,
  type CuaFrameState,
} from "./frame.js";

export async function handleBrowserAct(
  driver: CuaDriverSession,
  state: CuaFrameState,
  resources: CuaExecutionResources,
  input: CuaComputerActParams,
  signal?: AbortSignal,
): Promise<string | undefined> {
  switch (input.action) {
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
      const files = await resources.resolveFiles(input.resourceHandles ?? []);
      let result: CuaToolResult;
      try {
        result = await callWindowTool(
          driver,
          state,
          "browser_set_input_files",
          {
            target_id: target.targetId,
            tab_id: target.tabId,
            ref,
            files,
          },
          signal,
        );
      } catch (error) {
        signal?.throwIfAborted();
        throw new Error(
          "COMPUTER_DRIVER_ERROR: browser_set_input_files failed; inspect node logs and resource state before retrying",
          { cause: error },
        );
      }
      return JSON.stringify(browserToolEnvelope(result, "browser_set_input_files"));
    }
    case "browser_download": {
      const target = browserTarget(driver, state, input);
      const ref = browserElement(state, input, target)!;
      const resource = await resources.createDirectory("browser-download");
      let result: CuaToolResult;
      try {
        result = await callWindowTool(
          driver,
          state,
          "browser_download",
          {
            target_id: target.targetId,
            tab_id: target.tabId,
            ref,
            destination_root: resource.path,
          },
          signal,
        );
      } catch (error) {
        await resources.discard(resource.handle).catch(() => {});
        signal?.throwIfAborted();
        throw new Error(
          "COMPUTER_DRIVER_ERROR: browser_download failed; inspect node logs and resource state before retrying",
          { cause: error },
        );
      }
      const envelope = browserToolEnvelope(result, "browser_download");
      const fileResourceHandles = await resources.captureFiles(resource.handle);
      return JSON.stringify({
        ...envelope,
        details: {
          ...envelope.details,
          resourceHandle: resource.handle,
          fileResourceHandles,
        },
      });
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
  }
  return undefined;
}
