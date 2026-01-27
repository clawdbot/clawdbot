import type { Command } from "commander";
import { danger } from "../../globals.js";
import { defaultRuntime } from "../../runtime.js";
import type { BrowserParentOpts } from "../browser-cli-shared.js";
import { callBrowserAct, requireRef, resolveBrowserActionContext } from "./shared.js";

export function registerBrowserElementCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  browser
    .command("click")
    .description("Click an element by ref from snapshot")
    .argument("<ref>", "Ref id from snapshot")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .option("--double", "Double click", false)
    .option("--button <left|right|middle>", "Mouse button to use")
    .option("--modifiers <list>", "Comma-separated modifiers (Shift,Alt,Meta)")
    .action(async (ref: string | undefined, opts, cmd) => {
      const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
      const refValue = requireRef(ref);
      if (!refValue) return;
      const modifiers = opts.modifiers
        ? String(opts.modifiers)
            .split(",")
            .map((v: string) => v.trim())
            .filter(Boolean)
        : undefined;
      try {
        const result = await callBrowserAct<{ url?: string }>({
          parent,
          profile,
          body: {
            kind: "click",
            ref: refValue,
            targetId: opts.targetId?.trim() || undefined,
            doubleClick: Boolean(opts.double),
            button: opts.button?.trim() || undefined,
            modifiers,
          },
        });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        const suffix = result.url ? ` on ${result.url}` : "";
        defaultRuntime.log(`clicked ref ${refValue}${suffix}`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
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
      const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
      const refValue = requireRef(ref);
      if (!refValue) return;
      try {
        const result = await callBrowserAct({
          parent,
          profile,
          body: {
            kind: "type",
            ref: refValue,
            text,
            submit: Boolean(opts.submit),
            slowly: Boolean(opts.slowly),
            targetId: opts.targetId?.trim() || undefined,
          },
        });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`typed into ref ${refValue}`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("press")
    .description("Press a key")
    .argument("<key>", "Key to press (e.g. Enter)")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (key: string, opts, cmd) => {
      const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
      try {
        const result = await callBrowserAct({
          parent,
          profile,
          body: { kind: "press", key, targetId: opts.targetId?.trim() || undefined },
        });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`pressed ${key}`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("hover")
    .description("Hover an element by ai ref")
    .argument("<ref>", "Ref id from snapshot")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (ref: string, opts, cmd) => {
      const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
      try {
        const result = await callBrowserAct({
          parent,
          profile,
          body: { kind: "hover", ref, targetId: opts.targetId?.trim() || undefined },
        });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`hovered ref ${ref}`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
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
      const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
      const refValue = requireRef(ref);
      if (!refValue) return;
      try {
        const result = await callBrowserAct({
          parent,
          profile,
          body: {
            kind: "scrollIntoView",
            ref: refValue,
            targetId: opts.targetId?.trim() || undefined,
            timeoutMs: Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : undefined,
          },
          timeoutMs: Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : undefined,
        });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`scrolled into view: ${refValue}`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("drag")
    .description("Drag from one ref to another")
    .argument("<startRef>", "Start ref id")
    .argument("<endRef>", "End ref id")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (startRef: string, endRef: string, opts, cmd) => {
      const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
      try {
        const result = await callBrowserAct({
          parent,
          profile,
          body: {
            kind: "drag",
            startRef,
            endRef,
            targetId: opts.targetId?.trim() || undefined,
          },
        });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`dragged ${startRef} → ${endRef}`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("select")
    .description("Select option(s) in a select element")
    .argument("<ref>", "Ref id from snapshot")
    .argument("<values...>", "Option values to select")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (ref: string, values: string[], opts, cmd) => {
      const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
      try {
        const result = await callBrowserAct({
          parent,
          profile,
          body: {
            kind: "select",
            ref,
            values,
            targetId: opts.targetId?.trim() || undefined,
          },
        });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`selected ${values.join(", ")}`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });
}
