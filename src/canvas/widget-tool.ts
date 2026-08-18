/** Agent-facing inline chat widget tool. */
import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { BoardWidgetPutResult } from "../../packages/gateway-protocol/src/index.js";
import { optionalStringEnum } from "../agents/schema/string-enum.js";
import { type AnyAgentTool, jsonResult, readToolStringParam } from "../agents/tools/common.js";
import {
  callInProcessGatewayTool,
  type InProcessGatewayCaller,
} from "../agents/tools/in-process-gateway.js";
import { normalizeBoardWidgetDeclared } from "../boards/board-capabilities.js";
import { assertWidgetHtmlSize, WidgetHtmlInputError } from "../plugin-sdk/widget-html.js";
import {
  listBoardWidgetContentKinds,
  resolveBoardWidgetContentKind,
} from "../plugins/board-widget-content-kinds.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createCanvasDocument } from "./documents.js";
import { buildWidgetDocument } from "./wrap.js";

const SHOW_WIDGET_REQUIRED_CLIENT_CAPS = ["inline-widgets"];
const WIDGET_CODE_MAX_CHARS = 262_144;
const PINNED_WIDGET_MAX_UTF8_BYTES = 256 * 1024;
const WIDGET_MAX_PER_SCOPE = 32;

function currentPluginRegistry() {
  return getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? getActivePluginRegistry();
}

export function hasRegisteredShowWidgetKinds(): boolean {
  return listBoardWidgetContentKinds(currentPluginRegistry()).length > 0;
}

function showWidgetToolSchema(kinds: readonly string[]) {
  return Type.Object({
    title: Type.String(),
    widget_code: Type.String(),
    kind: optionalStringEnum(kinds, {
      description: `Widget source kind: ${kinds.join(", ")}`,
    }),
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
}

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

function generatedWidgetIdentity(title: string, preferredName: string) {
  const key = createHash("sha256").update(title.trim().normalize("NFC")).digest("hex");
  const prefix = preferredName.slice(0, 55).replace(/-+$/gu, "") || "widget";
  return {
    source: "show_widget" as const,
    key,
    fallbackName: `${prefix}-${key.slice(0, 8)}`,
  };
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
  const registeredKinds = listBoardWidgetContentKinds(currentPluginRegistry());
  const kinds = ["html", ...registeredKinds] as const;
  return {
    label: "Show Widget",
    name: "show_widget",
    description: `Visual helps? Make widget. Do not wait for ask. Use for comparisons, trends, timelines, flows, hierarchies, dashboards, status, progress, layouts, and choices. Text clearer? Skip. Show a widget on the user's current surface; kind defaults to html${registeredKinds.length ? ` and registered kinds are ${registeredKinds.join(", ")}` : ""}. Set pin=true to also place it on this session's dashboard; use name for a stable widget id, tab for a tab slug, size sm|md|lg|xl|full, presentation card|full-bleed|frameless, and after for a sibling widget anchor. Pinned widgets may declare capabilities.netOrigins and capabilities.tools for operator approval. HTML widgets are self-contained HTML or SVG. Dashboard host APIs: openclaw.prompt.send(text), openclaw.state.emit(payload), openclaw.data.read(bindingId, params?), and openclaw.cron.trigger(jobId). \`title\` is host metadata. Start directly with content; do not repeat the title or recreate dashboard chrome. HTML is pre-themed with --surface --card --elevated --text --text-strong --muted --border --border-strong --accent --accent-fill --accent-fg --ok --warn --danger --info --radius --font-body --font-mono.`,
    parameters: showWidgetToolSchema(kinds),
    requiredClientCaps: SHOW_WIDGET_REQUIRED_CLIENT_CAPS,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const kind = readToolStringParam(params, "kind") ?? "html";
      const title = readToolStringParam(params, "title", { required: true });
      const rawWidgetCode = readToolStringParam(params, "widget_code", {
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
      const registration =
        kind === "html" ? undefined : resolveBoardWidgetContentKind(currentPluginRegistry(), kind);
      if (kind !== "html" && !registration) {
        throw new WidgetHtmlInputError(
          `widget kind ${JSON.stringify(kind)} is unavailable; enable the plugin that provides it and retry`,
        );
      }
      if (registration) {
        try {
          registration.definition.validateSource(widgetCode);
        } catch (error) {
          throw new WidgetHtmlInputError(`invalid ${kind} widget source: ${String(error)}`);
        }
      }
      const inlineBody = registration
        ? registration.definition.composeDocument({
            source: widgetCode,
            title,
            resourceUrls: Object.fromEntries(
              registration.definition.resources.paths.map((resourcePath) => [
                resourcePath,
                resourcePath,
              ]),
            ),
            promptGranted: false,
          })
        : widgetCode;
      const wrappedDocument = buildWidgetDocument(title, inlineBody, {
        ...(registration ? { scriptOrigins: ["'self'"] } : {}),
      });
      let pinnedText = "";
      let pinnedWidgetName: string | undefined;
      if (pinSessionKey) {
        const sessionKey = pinSessionKey;
        const explicitName = readToolStringParam(params, "name");
        const name = explicitName ?? slugWidgetName(title);
        const tab = readToolStringParam(params, "tab");
        const size = readToolStringParam(params, "size");
        const presentation = readToolStringParam(params, "presentation");
        const after = readToolStringParam(params, "after");
        const pinnedTitle = boardWidgetTitle(title);
        if (!registration) {
          assertPinnedWidgetDocumentSize(
            buildWidgetDocument(pinnedTitle ?? name, widgetCode, {
              connectOrigins: capabilities?.netOrigins,
            }),
          );
        }
        const snapshot = await gatewayCall<BoardWidgetPutResult>("board.widget.put", {
          sessionKey,
          name,
          ...(pinnedTitle ? { title: pinnedTitle } : {}),
          // The Gateway owns the board document shell so agent-authored bytes
          // can never run before its user-activation and bridge bootstrap.
          content: registration
            ? { kind: "registered", contentKind: kind, source: widgetCode }
            : { kind: "html", html: widgetCode },
          ...(presentation ? { presentation } : {}),
          ...(capabilities ? { declared: capabilities } : {}),
          ...(!explicitName ? { generatedIdentity: generatedWidgetIdentity(title, name) } : {}),
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
        pinnedWidgetName = snapshot.resolvedWidgetName;
        const widget = snapshot.widgets.find(
          (candidate) => candidate.name === snapshot.resolvedWidgetName,
        );
        pinnedText = `; pinned to dashboard tab ${widget?.tabId ?? tab ?? "main"} as ${
          snapshot.resolvedWidgetName
        }${size ? ` (${size})` : ""}`;
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
