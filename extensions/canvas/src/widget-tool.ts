/** Agent-facing inline web chat widget tool. */
import { createHash } from "node:crypto";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { escapeHtml } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveCanvasHostConfig } from "./config.js";
import { createCanvasDocument } from "./documents.js";
import { SHOW_WIDGET_REQUIRED_CLIENT_CAPS, ShowWidgetToolSchema } from "./tool-schema.js";

export const WIDGET_CODE_MAX_CHARS = 262_144;
export const WIDGET_MAX_PER_SCOPE = 32;

type ShowWidgetToolOptions = {
  config?: OpenClawConfig;
  sessionId?: string;
  agentId?: string;
  stateDir?: string;
};

class WidgetToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

function buildWidgetDocument(title: string, widgetCode: string): string {
  const isSvg = /^<svg/i.test(widgetCode);
  const bodyClass = isSvg ? ' class="svg-widget"' : "";
  // Inline scripts may drive the widget; CSP blocks resource loads, while preview metadata
  // prevents the iframe from inheriting same-origin access to the parent application.
  // The size reporter lets the embedding chat fit the iframe to the content; the
  // parent clamps reported heights, so widget code cannot abuse the channel.
  const sizeReporter =
    "<script>(()=>{if(!window.parent||window.parent===window)return;" +
    // documentElement.scrollHeight reports the viewport for short content, so
    // measure the body box, which tracks the actual widget height.
    "let last=0;const report=()=>{const b=document.body;if(!b)return;" +
    "const h=Math.ceil(Math.max(b.scrollHeight,b.offsetHeight,b.getBoundingClientRect().height));" +
    'if(h&&h!==last){last=h;window.parent.postMessage({type:"openclaw:widget-size",height:h},"*");}};' +
    "addEventListener('load',report);new ResizeObserver(report).observe(document.body);" +
    "setTimeout(report,50);setTimeout(report,500);})();</script>";
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;"><title>${escapeHtml(title)}</title><style>:root{color-scheme:light dark}*{box-sizing:border-box}html,body{margin:0}body{font:14px system-ui,sans-serif}.svg-widget{display:grid;place-items:center}.svg-widget>svg{max-width:100%}</style></head><body${bodyClass}>${widgetCode}${sizeReporter}</body></html>`;
}

function resolveRetentionScope(options: ShowWidgetToolOptions): string {
  const scope = options.sessionId
    ? `session:${options.sessionId}`
    : `agent:${options.agentId ?? "default"}`;
  return createHash("sha256").update(scope).digest("hex");
}

/** Creates a self-contained widget hosted by the Canvas plugin. */
export function createShowWidgetTool(options: ShowWidgetToolOptions = {}): AnyAgentTool {
  return {
    label: "Show Widget",
    name: "show_widget",
    description:
      "Render self-contained SVG or HTML inline in web chat. Use for visual or interactive results; external resources are blocked, so inline all required code and data.",
    parameters: ShowWidgetToolSchema,
    requiredClientCaps: SHOW_WIDGET_REQUIRED_CLIENT_CAPS,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const title = readStringParam(params, "title", { required: true });
      const rawWidgetCode = readStringParam(params, "widget_code", {
        required: true,
        trim: false,
      });
      if (!rawWidgetCode.trim()) {
        throw new WidgetToolInputError("widget_code required");
      }
      if (rawWidgetCode.length > WIDGET_CODE_MAX_CHARS) {
        throw new WidgetToolInputError(
          `widget_code exceeds maximum size (${WIDGET_CODE_MAX_CHARS} characters)`,
        );
      }
      const widgetCode = rawWidgetCode.trim();
      const canvasRootDir = resolveCanvasHostConfig({ config: options.config }).root;
      const document = await createCanvasDocument(
        {
          kind: "html_bundle",
          title,
          entrypoint: { type: "html", value: buildWidgetDocument(title, widgetCode) },
          surface: "assistant_message",
          retentionScope: resolveRetentionScope(options),
          // Direct navigation to the hosted URL must not run widget script as the
          // Control UI origin; the host serves this doc with a CSP sandbox header.
          cspSandbox: "scripts",
        },
        {
          stateDir: options.stateDir,
          canvasRootDir,
          maxDocumentsPerScope: WIDGET_MAX_PER_SCOPE,
        },
      );
      return jsonResult({
        kind: "canvas",
        presentation: { target: "assistant_message", title, sandbox: "scripts" },
        view: { id: document.id, url: document.entryUrl },
        text: `Widget hosted at ${document.entryUrl}`,
      });
    },
  };
}
