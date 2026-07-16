/** Agent-facing inline web chat widget tool. */
import { createHash } from "node:crypto";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { escapeHtml } from "openclaw/plugin-sdk/text-utility-runtime";
import { assertWidgetHtmlSize, WidgetHtmlInputError } from "openclaw/plugin-sdk/widget-html";
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
  // The prompt bridge precedes widget code so inline handlers can reference
  // sendPrompt() immediately. It creates the prompt channel itself and offers
  // one endpoint to the embedding chat at parse time — before any widget code
  // can run, steal the endpoint, or navigate the frame — so the chat's
  // first-offer-wins adoption is always bound to this document. The send
  // endpoint stays private to this closure, and sendPrompt requires transient
  // user activation, so widget code cannot auto-send without a real user
  // gesture; the chat additionally validates, requires a focused visible
  // frame, and rate limits every prompt.
  // Everything sendPrompt later touches is snapshotted here, before widget
  // code exists, so prototype patches (MessagePort.postMessage, the
  // userActivation getter) by widget code cannot leak the endpoint or fake a
  // gesture. Fail closed: no observable transient user activation, no send.
  const promptBridge =
    "<script>(()=>{if(!window.parent||window.parent===window)return;" +
    "const c=new MessageChannel();" +
    "const post=c.port1.postMessage.bind(c.port1);" +
    "let act=null;" +
    "try{const ua=navigator.userActivation;" +
    'const d=ua&&Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ua),"isActive");' +
    "if(d&&d.get)act=d.get.bind(ua);}catch{}" +
    'window.parent.postMessage({type:"openclaw:widget-prompt-offer"},"*",[c.port2]);' +
    "window.sendPrompt=text=>{if(!act||act()!==true)return;" +
    'post({type:"openclaw:widget-prompt",prompt:String(text)});};})();</script>';
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;"><title>${escapeHtml(title)}</title><style>:root{color-scheme:light dark}*{box-sizing:border-box}html,body{margin:0}body{font:14px system-ui,sans-serif}.svg-widget{display:grid;place-items:center}.svg-widget>svg{max-width:100%}</style></head><body${bodyClass}>${promptBridge}${widgetCode}${sizeReporter}</body></html>`;
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
      "Show an interactive, self-contained HTML or SVG widget to the user on their current surface. Inline all required code and data. A global sendPrompt(text) function submits text to the chat as if the user typed it — wire it to buttons or controls to build interactive widgets. It only works after the user clicks inside the widget (plain conversational text only; slash commands are rejected), so never call it automatically.",
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
        throw new WidgetHtmlInputError("widget_code required");
      }
      assertWidgetHtmlSize(rawWidgetCode, WIDGET_CODE_MAX_CHARS, {
        inputName: "widget_code",
        unit: "characters",
      });
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
