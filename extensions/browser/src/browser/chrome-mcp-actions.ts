// Executes Chrome MCP navigation, snapshot, screenshot, and page actions.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  addTimerTimeoutGraceMs,
  resolveNonNegativeIntegerOption,
} from "openclaw/plugin-sdk/number-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import {
  CHROME_MCP_NAVIGATE_TIMEOUT_MS,
  rethrowChromeMcpDocumentError,
  type ChromeMcpOperationOptions,
  type ChromeMcpProfileOptions,
  type ChromeMcpTargetOperation,
} from "./chrome-mcp-contracts.js";
import { extractJsonMessage, extractSnapshot } from "./chrome-mcp-result.js";
import {
  callTargetTool,
  callTool,
  clearChromeMcpSnapshotRefsForTarget,
  getChromeMcpRoutingState,
  listChromeMcpTargetsWithLease,
  resolveChromeMcpSnapshotRef,
  wrapChromeMcpSnapshotRefs,
  withChromeMcpTarget,
} from "./chrome-mcp-routing.js";
import type { ChromeMcpSnapshotNode } from "./chrome-mcp.snapshot.js";

async function withTempFile<T>(fn: (filePath: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-chrome-mcp-"));
  const filePath = path.join(dir, randomUUID());
  try {
    return await fn(filePath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Ensure a Chrome MCP session can be started for the profile. */
export async function focusChromeMcpTab(
  profileName: string,
  targetId: string,
  profileOptions?: string | ChromeMcpProfileOptions,
  options: ChromeMcpOperationOptions = {},
): Promise<void> {
  await callTargetTool(
    {
      profileName,
      profile: typeof profileOptions === "string" ? undefined : profileOptions,
      userDataDir: typeof profileOptions === "string" ? profileOptions : undefined,
      targetId,
      ...options,
    },
    "select_page",
    { bringToFront: true },
  );
}

/** Close a Chrome MCP page by target id. */
export async function closeChromeMcpTab(
  profileName: string,
  targetId: string,
  profileOptions?: string | ChromeMcpProfileOptions,
  options: ChromeMcpOperationOptions = {},
): Promise<void> {
  const profile = typeof profileOptions === "string" ? undefined : profileOptions;
  const userDataDir = typeof profileOptions === "string" ? profileOptions : undefined;
  await withChromeMcpTarget(
    {
      profileName,
      profile,
      userDataDir,
      targetId,
      ...options,
    },
    async (target) => {
      await callTool(
        profileName,
        target.profileOptions,
        "close_page",
        { pageId: target.pageId },
        options,
        target.lease,
      );
      // Retire inside the same operation lock so queued work cannot dispatch
      // against a closed page id. A later list gets a new opaque handle even if
      // Chrome reuses that numeric id.
      const routing = getChromeMcpRoutingState(target.lease.session);
      routing.targetIdByPageId.delete(target.pageId);
      clearChromeMcpSnapshotRefsForTarget(routing, targetId);
    },
  );
}

/** Navigate a Chrome MCP page and return its resolved URL. */
export async function navigateChromeMcpPage(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  url: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ url: string }> {
  const resolvedTimeoutMs = params.timeoutMs ?? CHROME_MCP_NAVIGATE_TIMEOUT_MS;
  const callTimeoutMs = resolveChromeMcpNavigateCallTimeoutMs(resolvedTimeoutMs);
  return await withChromeMcpTarget({ ...params, timeoutMs: callTimeoutMs }, async (target) => {
    await callTool(
      params.profileName,
      target.profileOptions,
      "navigate_page",
      {
        pageId: target.pageId,
        type: "url",
        url: params.url,
        timeout: resolvedTimeoutMs,
      },
      { timeoutMs: callTimeoutMs, signal: params.signal },
      target.lease,
    );
    const pages = await listChromeMcpTargetsWithLease({
      profileName: params.profileName,
      profileOptions: target.profileOptions,
      lease: target.lease,
      options: { timeoutMs: callTimeoutMs, signal: params.signal },
    });
    const page = pages.find((entry) => entry.targetId === params.targetId)?.page;
    if (!page) {
      throw new Error(
        "Chrome MCP tab identity changed while navigation was running; the navigation outcome is unknown.",
      );
    }
    return { url: page.url ?? params.url };
  });
}

/** Add call-level grace around the MCP navigate timeout. */
export function resolveChromeMcpNavigateCallTimeoutMs(timeoutMs: number): number {
  return addTimerTimeoutGraceMs(timeoutMs) ?? 1;
}

/** Take a structured Chrome MCP snapshot for one page. */
export async function takeChromeMcpSnapshot(
  params: ChromeMcpTargetOperation,
): Promise<ChromeMcpSnapshotNode> {
  return await withChromeMcpTarget(params, async (target) => {
    const result = await callTool(
      params.profileName,
      target.profileOptions,
      "take_snapshot",
      { pageId: target.pageId },
      params,
      target.lease,
    );
    return wrapChromeMcpSnapshotRefs(
      target.lease.session,
      params.targetId,
      extractSnapshot(result),
    );
  });
}

/** Run document-bound evaluations without releasing the target/session lock. */
export async function withChromeMcpDocument<T>(
  params: ChromeMcpTargetOperation,
  task: (document: { evaluate: (fn: string) => Promise<unknown> }) => Promise<T>,
): Promise<T> {
  return await withChromeMcpTarget(params, async (target) => {
    let snapshot: ChromeMcpSnapshotNode;
    try {
      snapshot = extractSnapshot(
        await callTool(
          params.profileName,
          target.profileOptions,
          "take_snapshot",
          { pageId: target.pageId, verbose: true },
          params,
          target.lease,
        ),
      );
    } catch (error) {
      rethrowChromeMcpDocumentError(error);
    }
    const uid = normalizeOptionalString(snapshot.id);
    if (!uid || snapshot.role?.trim().toLowerCase() !== "rootwebarea") {
      throw new Error("Chrome MCP snapshot did not contain a top-level document uid");
    }
    return await task({
      evaluate: async (fn) => {
        try {
          return extractJsonMessage(
            await callTool(
              params.profileName,
              target.profileOptions,
              "evaluate_script",
              { pageId: target.pageId, function: fn, args: [uid] },
              params,
              target.lease,
            ),
          );
        } catch (error) {
          return rethrowChromeMcpDocumentError(error);
        }
      },
    });
  });
}

/** Take a screenshot via Chrome MCP and return the image bytes. */
export async function takeChromeMcpScreenshot(
  params: ChromeMcpTargetOperation & {
    uid?: string;
    fullPage?: boolean;
    format?: "png" | "jpeg";
  },
): Promise<Buffer> {
  return await withTempFile(async (filePath) => {
    const format = params.format ?? "png";
    await callTargetTool(params, "take_screenshot", (session) => ({
      filePath,
      format,
      ...(params.uid
        ? { uid: resolveChromeMcpSnapshotRef(session, params.targetId, params.uid) }
        : {}),
      ...(params.fullPage ? { fullPage: true } : {}),
    }));
    return await fs.readFile(`${filePath}.${format}`);
  });
}

/** Click a Chrome MCP snapshot element by uid. */
export async function clickChromeMcpElement(
  params: ChromeMcpTargetOperation & {
    uid: string;
    doubleClick?: boolean;
  },
): Promise<void> {
  await callTargetTool(params, "click", (session) => ({
    uid: resolveChromeMcpSnapshotRef(session, params.targetId, params.uid),
    ...(params.doubleClick ? { dblClick: true } : {}),
  }));
}

/** Dispatch mouse events at page coordinates through an in-page script. */
export async function clickChromeMcpCoords(
  params: ChromeMcpTargetOperation & {
    x: number;
    y: number;
    doubleClick?: boolean;
    button?: "left" | "right" | "middle";
    delayMs?: number;
  },
): Promise<void> {
  const button = params.button ?? "left";
  const buttonCode = button === "middle" ? 1 : button === "right" ? 2 : 0;
  const pressedButtons = button === "middle" ? 4 : button === "right" ? 2 : 1;
  const x = JSON.stringify(params.x);
  const y = JSON.stringify(params.y);
  const delayMs = JSON.stringify(resolveNonNegativeIntegerOption(params.delayMs, 0));
  const doubleClick = params.doubleClick ? "true" : "false";
  await evaluateChromeMcpScript({
    ...params,
    fn: `async () => {
      const x = ${x};
      const y = ${y};
      const delayMs = ${delayMs};
      const doubleClick = ${doubleClick};
      const target = document.elementFromPoint(x, y) ?? document.body ?? document.documentElement ?? document;
      const base = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: window.screenX + x,
        screenY: window.screenY + y,
        button: ${buttonCode},
      };
      const pressedButtons = ${pressedButtons};
      const dispatch = (type, buttons, detail) => {
        target.dispatchEvent(new MouseEvent(type, { ...base, buttons, detail }));
      };
      dispatch("mousemove", 0, 0);
      dispatch("mousedown", pressedButtons, 1);
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      dispatch("mouseup", 0, 1);
      dispatch("click", 0, 1);
      if (doubleClick) {
        dispatch("mousedown", pressedButtons, 2);
        dispatch("mouseup", 0, 2);
        dispatch("click", 0, 2);
        dispatch("dblclick", 0, 2);
      }
      return true;
    }`,
  });
}

/** Fill one Chrome MCP element by uid. */
export async function fillChromeMcpElement(
  params: ChromeMcpTargetOperation & { uid: string; value: string },
): Promise<void> {
  await callTargetTool(params, "fill", (session) => ({
    uid: resolveChromeMcpSnapshotRef(session, params.targetId, params.uid),
    value: params.value,
  }));
}

/** Fill multiple Chrome MCP form elements in one tool call. */
export async function fillChromeMcpForm(
  params: ChromeMcpTargetOperation & {
    elements: Array<{ uid: string; value: string }>;
  },
): Promise<void> {
  await callTargetTool(params, "fill_form", (session) => ({
    elements: params.elements.map((element) => ({
      ...element,
      uid: resolveChromeMcpSnapshotRef(session, params.targetId, element.uid),
    })),
  }));
}

/** Hover a Chrome MCP snapshot element by uid. */
export async function hoverChromeMcpElement(
  params: ChromeMcpTargetOperation & { uid: string },
): Promise<void> {
  await callTargetTool(params, "hover", (session) => ({
    uid: resolveChromeMcpSnapshotRef(session, params.targetId, params.uid),
  }));
}

/** Drag between two Chrome MCP snapshot element uids. */
export async function dragChromeMcpElement(
  params: ChromeMcpTargetOperation & { fromUid: string; toUid: string },
): Promise<void> {
  await callTargetTool(params, "drag", (session) => ({
    from_uid: resolveChromeMcpSnapshotRef(session, params.targetId, params.fromUid),
    to_uid: resolveChromeMcpSnapshotRef(session, params.targetId, params.toUid),
  }));
}

/** Upload a local file into a Chrome MCP file input by uid. */
export async function uploadChromeMcpFile(
  params: ChromeMcpTargetOperation & { uid: string; filePath: string },
): Promise<void> {
  await callTargetTool(params, "upload_file", (session) => ({
    uid: resolveChromeMcpSnapshotRef(session, params.targetId, params.uid),
    filePath: params.filePath,
  }));
}

/** Press a keyboard key in a Chrome MCP page. */
export async function pressChromeMcpKey(
  params: ChromeMcpTargetOperation & { key: string },
): Promise<void> {
  await callTargetTool(params, "press_key", {
    key: params.key,
  });
}

/** Resize a Chrome MCP page viewport. */
export async function resizeChromeMcpPage(
  params: ChromeMcpTargetOperation & { width: number; height: number },
): Promise<void> {
  await callTargetTool(params, "resize_page", {
    width: params.width,
    height: params.height,
  });
}

/** Evaluate a JavaScript function in a Chrome MCP page. */
export async function evaluateChromeMcpScript(
  params: ChromeMcpTargetOperation & { fn: string; args?: string[] },
): Promise<unknown> {
  const result = await callTargetTool(params, "evaluate_script", (session) => ({
    function: params.fn,
    ...(params.args?.length
      ? {
          args: params.args.map((ref) =>
            resolveChromeMcpSnapshotRef(session, params.targetId, ref),
          ),
        }
      : {}),
  }));
  return extractJsonMessage(result);
}

/** Replace Chrome MCP session creation for focused tests. */
