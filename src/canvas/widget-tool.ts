/** Agent-facing inline chat widget tool. */
import { createHash } from "node:crypto";
import { Type } from "typebox";
import { type AnyAgentTool, jsonResult, readStringParam } from "../agents/tools/common.js";
import { assertWidgetHtmlSize, WidgetHtmlInputError } from "../plugin-sdk/widget-html.js";
import { createCanvasDocument } from "./documents.js";
import { buildWidgetDocument } from "./wrap.js";

const SHOW_WIDGET_REQUIRED_CLIENT_CAPS = ["inline-widgets"];
const WIDGET_CODE_MAX_CHARS = 262_144;
const WIDGET_MAX_PER_SCOPE = 32;

const ShowWidgetToolSchema = Type.Object({
  title: Type.String(),
  widget_code: Type.String(),
});

type ShowWidgetToolOptions = {
  sessionId?: string;
  agentId?: string;
  stateDir?: string;
};

function resolveRetentionScope(options: ShowWidgetToolOptions): string {
  const scope = options.sessionId
    ? `session:${options.sessionId}`
    : `agent:${options.agentId ?? "default"}`;
  return createHash("sha256").update(scope).digest("hex");
}

/** Creates a self-contained widget hosted by OpenClaw core. */
export function createShowWidgetTool(options: ShowWidgetToolOptions = {}): AnyAgentTool {
  return {
    label: "Show Widget",
    name: "show_widget",
    description:
      'Show interactive self-contained HTML or SVG widget on the user\'s current surface. Inline everything; no external resources. Pre-themed: bare button, input, select, textarea, table, code, h1-h3 already styled — write minimal HTML. Helper classes: .card, .badge (.ok/.warn/.danger/.info), .metric, .muted, .row; button.primary = the one main action. Theme vars (auto light/dark, live host sync): --surface --card --elevated --text --text-strong --muted --border --border-strong --accent (links/focus/highlight) --accent-fill (primary bg) --accent-fg --ok --warn --danger --info (each with -subtle tint) --radius --font-body --font-mono. Colors ONLY via these vars — never hex/rgb/hsl, no own color palette; layout-only custom vars fine. Page background stays transparent. Pattern: <div class="card"><div class="muted">Uptime</div><div class="metric">18d</div></div> <span class="badge ok">connected</span>. Web chat: sendPrompt(text) sends text as the user\'s message — wire to buttons, suffix label with ↗; works only after a real click inside the widget (never call automatically; slash commands rejected).',
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
      const document = await createCanvasDocument(
        {
          kind: "html_bundle",
          title,
          entrypoint: { type: "html", value: buildWidgetDocument(title, widgetCode) },
          surface: "assistant_message",
          retentionScope: resolveRetentionScope(options),
          // Direct navigation must not run widget script as the Control UI origin.
          cspSandbox: "scripts",
        },
        {
          stateDir: options.stateDir,
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
