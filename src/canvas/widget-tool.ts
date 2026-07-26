/** Agent-facing inline chat widget tool. */
import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { BoardSnapshot } from "../../packages/gateway-protocol/src/index.js";
import { optionalStringEnum } from "../agents/schema/string-enum.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "../agents/tools/common.js";
import {
  callInProcessGatewayTool,
  type InProcessGatewayCaller,
} from "../agents/tools/in-process-gateway.js";
import { normalizeBoardWidgetDeclared } from "../boards/board-capabilities.js";
import { assertWidgetHtmlSize, WidgetHtmlInputError } from "../plugin-sdk/widget-html.js";
import { createCanvasDocument } from "./documents.js";
import { buildWidgetDocument } from "./wrap.js";

const SHOW_WIDGET_REQUIRED_CLIENT_CAPS = ["inline-widgets"];
const WIDGET_CODE_MAX_CHARS = 262_144;
const PINNED_WIDGET_MAX_UTF8_BYTES = 256 * 1024;
const WIDGET_MAX_PER_SCOPE = 32;

const ShowWidgetToolSchema = Type.Object({
  title: Type.String(),
  widget_code: Type.String(),
  name: Type.Optional(
    Type.String({
      pattern: "^[a-z0-9][a-z0-9._-]{0,63}$",
      description: "Stable dashboard widget name when pinning",
    }),
  ),
  pin: Type.Optional(
    Type.Boolean({ description: "Also pin this widget to the session dashboard" }),
  ),
  tab: Type.Optional(
    Type.String({ pattern: "^[a-z0-9-]{1,40}$", description: "Dashboard tab slug" }),
  ),
  size: optionalStringEnum(["sm", "md", "lg", "xl", "full"] as const, {
    description: "Dashboard size: sm, md, lg, xl, or full",
  }),
  presentation: optionalStringEnum(["card", "full-bleed", "frameless"] as const, {
    description: "Pinned dashboard frame: card, full-bleed, or frameless",
  }),
  after: Type.Optional(
    Type.String({
      pattern: "^[a-z0-9][a-z0-9._-]{0,63}$",
      description: "Place after this dashboard widget name",
    }),
  ),
  capabilities: Type.Optional(
    Type.Object({
      netOrigins: Type.Optional(
        Type.Array(Type.String(), {
          description: "Exact HTTPS origins the pinned widget may fetch after approval",
        }),
      ),
      tools: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Pinned widget host tools, such as prompt, sessions.list, or cron.trigger:<jobId>",
        }),
      ),
    }),
  ),
});

type ShowWidgetToolOptions = {
  sessionId?: string;
  agentId?: string;
  agentSessionKey?: string;
  stateDir?: string;
  callGateway?: InProcessGatewayCaller;
};

function slugWidgetName(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (slug && slug.length <= 64) {
    return slug;
  }
  const suffix = createHash("sha256").update(title).digest("hex").slice(0, 8);
  const prefix = (slug || "widget").slice(0, 55).replace(/-+$/gu, "") || "widget";
  return `${prefix}-${suffix}`;
}

function boardWidgetTitle(title: string): string | undefined {
  const normalized = title.trim();
  return normalized ? Array.from(normalized).slice(0, 80).join("") : undefined;
}

function resolveRetentionScope(options: ShowWidgetToolOptions): string {
  const scope = options.sessionId
    ? `session:${options.sessionId}`
    : `agent:${options.agentId ?? "default"}`;
  return createHash("sha256").update(scope).digest("hex");
}

function assertPinnedWidgetDocumentSize(html: string): void {
  if (Buffer.byteLength(html, "utf8") > PINNED_WIDGET_MAX_UTF8_BYTES) {
    throw new WidgetHtmlInputError(
      `pin exceeds effective dashboard budget (${PINNED_WIDGET_MAX_UTF8_BYTES} UTF-8 bytes after wrapping)`,
    );
  }
}

/** Creates a self-contained widget hosted by OpenClaw core. */
export function createShowWidgetTool(options: ShowWidgetToolOptions = {}): AnyAgentTool {
  const gatewayCall = options.callGateway ?? callInProcessGatewayTool;
  return {
    label: "Show Widget",
    name: "show_widget",
    description:
      'Show interactive self-contained HTML or SVG widget on the user\'s current surface. Set pin=true to also place it on this session\'s dashboard; use name for a stable widget id, tab for a tab slug, size sm|md|lg|xl|full, presentation card|full-bleed|frameless, and after for a sibling widget anchor. Dashboard widgets auto-fit their content height until the user resizes them. Pinned widgets may declare capabilities.netOrigins and capabilities.tools for operator approval. Inline everything; no external resources unless an exact HTTPS origin is declared and granted. Dashboard host APIs: openclaw.prompt.send(text), openclaw.state.emit(payload), openclaw.data.read(bindingId, params?), and openclaw.cron.trigger(jobId). Pre-themed: bare button, input, select, textarea, table, code, h1-h3 already styled — write minimal HTML. Helper classes: .card, .badge (.ok/.warn/.danger/.info), .metric, .muted, .row; button.primary = the one main action. Theme vars (auto light/dark, live host sync): --surface --card --elevated --text --text-strong --muted --border --border-strong --accent (links/focus/highlight) --accent-fill (primary bg) --accent-fg --ok --warn --danger --info (each with -subtle tint) --radius --font-body --font-mono. Colors ONLY via these vars — never hex/rgb/hsl, no own color palette; layout-only custom vars fine. Page background stays transparent. Pattern: <div class="card"><div class="muted">Uptime</div><div class="metric">18d</div></div> <span class="badge ok">connected</span>. Web chat: sendPrompt(text) sends text as the user\'s message — wire to buttons, suffix label with ↗; works only after a real click inside the widget (never call automatically; slash commands rejected).',
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
      const shouldPin = params.pin === true;
      const capabilities = normalizeBoardWidgetDeclared(
        params.capabilities as { netOrigins?: string[]; tools?: string[] } | undefined,
      );
      if (capabilities && !shouldPin) {
        throw new WidgetHtmlInputError("capabilities require pin=true");
      }
      const pinSessionKey = shouldPin ? options.agentSessionKey?.trim() : undefined;
      if (shouldPin && !pinSessionKey) {
        throw new WidgetHtmlInputError("pin requires an agent session");
      }
      const widgetCode = rawWidgetCode.trim();
      const wrappedDocument = buildWidgetDocument(title, widgetCode);
      let pinnedText = "";
      let pinnedWidgetName: string | undefined;
      if (pinSessionKey) {
        const sessionKey = pinSessionKey;
        const name = readStringParam(params, "name") ?? slugWidgetName(title);
        pinnedWidgetName = name;
        const tab = readStringParam(params, "tab");
        const size = readStringParam(params, "size");
        const presentation = readStringParam(params, "presentation");
        const after = readStringParam(params, "after");
        const pinnedTitle = boardWidgetTitle(title);
        assertPinnedWidgetDocumentSize(
          buildWidgetDocument(pinnedTitle ?? name, widgetCode, {
            connectOrigins: capabilities?.netOrigins,
          }),
        );
        const snapshot = await gatewayCall<BoardSnapshot>("board.widget.put", {
          sessionKey,
          name,
          ...(pinnedTitle ? { title: pinnedTitle } : {}),
          // The Gateway owns the board document shell so agent-authored bytes
          // can never run before its user-activation and bridge bootstrap.
          content: { kind: "html", html: widgetCode },
          ...(presentation ? { presentation } : {}),
          ...(capabilities ? { declared: capabilities } : {}),
          ...(tab || size || after
            ? {
                placement: {
                  ...(tab ? { tabId: tab } : {}),
                  ...(size ? { size } : {}),
                  ...(after ? { after } : {}),
                },
              }
            : {}),
        });
        const widget = snapshot.widgets.find((candidate) => candidate.name === name);
        pinnedText = `; pinned to dashboard tab ${widget?.tabId ?? tab ?? "main"} as ${name}${
          size ? ` (${size})` : ""
        }`;
      }
      // Pin first: placement validation can fail, and a rejected board write
      // must not materialize or prune the bounded inline-document store.
      const document = await createCanvasDocument(
        {
          kind: "html_bundle",
          title,
          entrypoint: { type: "html", value: wrappedDocument },
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
        view: {
          id: document.id,
          url: document.entryUrl,
          ...(pinnedWidgetName ? { boardWidgetName: pinnedWidgetName } : {}),
        },
        text: `Widget hosted at ${document.entryUrl}${pinnedText}`,
      });
    },
  };
}
