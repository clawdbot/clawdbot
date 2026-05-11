import type { Command } from "commander";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BrowserParentOpts } from "../browser-cli-shared.js";
import { danger, defaultRuntime } from "../core-api.js";
import {
  callBrowserAct,
  logBrowserActionResult,
  requireRef,
  resolveBrowserActionContext,
} from "./shared.js";

export function registerBrowserElementCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  const runElementAction = async (params: {
    cmd: Command;
    body: Record<string, unknown>;
    successMessage: string | ((result: unknown) => string);
    timeoutMs?: number;
  }): Promise<void> => {
    const { parent, profile } = resolveBrowserActionContext(params.cmd, parentOpts);
    try {
      const result = await callBrowserAct({
        parent,
        profile,
        body: params.body,
        timeoutMs: params.timeoutMs,
      });
      const successMessage =
        typeof params.successMessage === "function"
          ? params.successMessage(result)
          : params.successMessage;
      logBrowserActionResult(parent, result, successMessage);
    } catch (err) {
      defaultRuntime.error(danger(String(err)));
      defaultRuntime.exit(1);
    }
  };

  browser
    .command("click")
    .description("Click an element by ref from snapshot")
    .argument("<ref>", "Ref id from snapshot")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .option("--double", "Double click", false)
    .option("--button <left|right|middle>", "Mouse button to use")
    .option("--modifiers <list>", "Comma-separated modifiers (Shift,Alt,Meta)")
    .action(async (ref: string | undefined, opts, cmd) => {
      const refValue = requireRef(ref);
      if (!refValue) {
        return;
      }
      const modifiers = opts.modifiers
        ? String(opts.modifiers)
            .split(",")
            .map((v: string) => v.trim())
            .filter(Boolean)
        : undefined;
      await runElementAction({
        cmd,
        body: {
          kind: "click",
          ref: refValue,
          targetId: normalizeOptionalString(opts.targetId),
          doubleClick: Boolean(opts.double),
          button: normalizeOptionalString(opts.button),
          modifiers,
        },
        successMessage: (result) => {
          const url = (result as { url?: unknown }).url;
          const suffix = typeof url === "string" && url ? ` on ${url}` : "";
          return `clicked ref ${refValue}${suffix}`;
        },
      });
    });

  browser
    .command("click-coords")
    .description("Click viewport coordinates")
    .argument("<x>", "Viewport x coordinate")
    .argument("<y>", "Viewport y coordinate")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .option("--double", "Double click", false)
    .option("--button <left|right|middle>", "Mouse button to use")
    .option("--delay-ms <ms>", "Delay between mouse down/up", (v: string) => Number(v))
    .action(async (xRaw: string, yRaw: string, opts, cmd) => {
      const x = Number(xRaw);
      const y = Number(yRaw);
      await runElementAction({
        cmd,
        body: {
          kind: "clickCoords",
          x,
          y,
          targetId: normalizeOptionalString(opts.targetId),
          doubleClick: Boolean(opts.double),
          button: normalizeOptionalString(opts.button),
          delayMs: Number.isFinite(opts.delayMs) ? opts.delayMs : undefined,
        },
        successMessage: (result) => {
          const url = (result as { url?: unknown }).url;
          const suffix = typeof url === "string" && url ? ` on ${url}` : "";
          return `clicked ${x},${y}${suffix}`;
        },
      });
    });

  browser
    .command("type")
    .description("Type into an element by ref from snapshot")
    .argument("<ref>", "Ref id from snapshot")
    .argument("<text>", "Text to type")
    .option("--submit", "Press Enter after typing", false)
    .option("--slowly", "Type slowly (human-like)", false)
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (ref: string | undefined, text: string, opts, cmd) => {
      const refValue = requireRef(ref);
      if (!refValue) {
        return;
      }
      await runElementAction({
        cmd,
        body: {
          kind: "type",
          ref: refValue,
          text,
          submit: Boolean(opts.submit),
          slowly: Boolean(opts.slowly),
          targetId: normalizeOptionalString(opts.targetId),
        },
        successMessage: `typed into ref ${refValue}`,
      });
    });

  browser
    .command("press")
    .description("Press a key")
    .argument("<key>", "Key to press (e.g. Enter)")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (key: string, opts, cmd) => {
      await runElementAction({
        cmd,
        body: { kind: "press", key, targetId: normalizeOptionalString(opts.targetId) },
        successMessage: `pressed ${key}`,
      });
    });

  browser
    .command("hover")
    .description("Hover an element by ai ref")
    .argument("<ref>", "Ref id from snapshot")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (ref: string, opts, cmd) => {
      await runElementAction({
        cmd,
        body: { kind: "hover", ref, targetId: normalizeOptionalString(opts.targetId) },
        successMessage: `hovered ref ${ref}`,
      });
    });

  browser
    .command("scrollintoview")
    .description("Scroll an element into view by ref from snapshot")
    .argument("<ref>", "Ref id from snapshot")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .option("--timeout-ms <ms>", "How long to wait for scroll (default: 20000)", (v: string) =>
      Number(v),
    )
    .action(async (ref: string | undefined, opts, cmd) => {
      const refValue = requireRef(ref);
      if (!refValue) {
        return;
      }
      const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : undefined;
      await runElementAction({
        cmd,
        body: {
          kind: "scrollIntoView",
          ref: refValue,
          targetId: normalizeOptionalString(opts.targetId),
          timeoutMs,
        },
        timeoutMs,
        successMessage: `scrolled into view: ${refValue}`,
      });
    });

  browser
    .command("drag")
    .description("Drag from one ref to another")
    .argument("<startRef>", "Start ref id")
    .argument("<endRef>", "End ref id")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (startRef: string, endRef: string, opts, cmd) => {
      await runElementAction({
        cmd,
        body: {
          kind: "drag",
          startRef,
          endRef,
          targetId: normalizeOptionalString(opts.targetId),
        },
        successMessage: `dragged ${startRef} → ${endRef}`,
      });
    });

  browser
    .command("select")
    .description("Select option(s) in a select element")
    .argument("<ref>", "Ref id from snapshot")
    .argument("<values...>", "Option values to select")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (ref: string, values: string[], opts, cmd) => {
      await runElementAction({
        cmd,
        body: {
          kind: "select",
          ref,
          values,
          targetId: normalizeOptionalString(opts.targetId),
        },
        successMessage: `selected ${values.join(", ")}`,
      });
    });
}
