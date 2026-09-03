/** Agent-facing inline chat widget tool. */
import { createHash } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import type { BoardWidgetPutResult } from "../../packages/gateway-protocol/src/index.js";
import { optionalStringEnum } from "../agents/schema/string-enum.js";
import { type AnyAgentTool, jsonResult, readToolStringParam } from "../agents/tools/common.js";
import {
  callInProcessGatewayTool,
  type InProcessGatewayCaller,
} from "../agents/tools/in-process-gateway.js";
import { normalizeBoardWidgetDeclared } from "../boards/board-capabilities.js";
import { formatErrorMessage } from "../infra/errors.js";
import { assertWidgetHtmlSize, WidgetHtmlInputError } from "../plugin-sdk/widget-html.js";
import {
  listBoardWidgetContentKinds,
  resolveBoardWidgetContentKind,
} from "../plugins/board-widget-content-kinds.js";
import { describeDashboardCapabilities } from "../plugins/dashboard-capabilities.js";
import type {
  WidgetPresentationError,
  WidgetPresentationSuccess,
  WidgetPresenter,
  WidgetPresenterContext,
  WidgetPresenterDocument,
} from "../plugins/plugin-registration.types.js";
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

function createShowWidgetToolSchema(
  kinds: readonly string[],
  presenters: readonly WidgetPresenter[],
  capabilityGuidance: string,
  pinnedOnly: boolean,
) {
  const presenterTargets = presenters.flatMap((presenter) =>
    presenter.target === "current_channel" ? [] : [presenter.target],
  );
  const targets = ["assistant_message", ...presenterTargets] as const;
  const presenterDescriptions = presenters.flatMap((presenter) =>
    presenter.target === "current_channel" ? [] : [`${presenter.target}: ${presenter.description}`],
  );
  return Type.Object({
    title: Type.String(),
    widget_code: Type.String({
      description:
        "For HTML, fit the iframe width at every viewport: avoid fixed page or card widths; use fluid sizing and wrap or stack multi-column layouts when narrow. Use horizontal scrolling only when exact geometry must remain.",
    }),
    kind: optionalStringEnum(kinds, {
      description: `Widget source kind: ${kinds.join(", ")}`,
    }),
    name: Type.Optional(
      Type.String({
        pattern: "^[a-z0-9][a-z0-9._-]{0,63}$",
        description:
          "Stable dashboard widget name; reuse the same name with pin=true and new widget_code to update",
      }),
    ),
    pin: pinnedOnly
      ? Type.Literal(true, {
          description: "Required: this scheduled surface can only author pinned widgets",
        })
      : Type.Optional(
          Type.Boolean({
            description:
              "Pin only for an explicit dashboard request or multiple non-code visualizations",
          }),
        ),
    tab: Type.Optional(
      Type.String({ pattern: "^[a-z0-9-]{1,40}$", description: "Dashboard tab slug" }),
    ),
    size: optionalStringEnum(["sm", "md", "lg", "xl", "full"] as const, {
      description: "Dashboard size: sm, md, lg, xl, or full",
    }),
    presentation: Type.Optional(
      Type.Object({
        ...(pinnedOnly
          ? {}
          : {
              target: optionalStringEnum(targets, {
                description: [
                  "Where to show the widget. assistant_message: inline in chat",
                  ...presenterDescriptions,
                ].join("; "),
              }),
            }),
        frame: optionalStringEnum(["card", "full-bleed", "frameless"] as const, {
          description: "Pinned dashboard frame: card, full-bleed, or frameless",
        }),
      }),
    ),
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
            description: `Pinned widget host tools: prompt or cron.trigger:<jobId>; grant each read/action ID below unless a scoped grant is specified. ${capabilityGuidance}`,
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
  inlineHostEnabled?: boolean;
  inlineClientAvailable?: boolean;
  /** Scheduled callers without a rendering client may author only durable dashboard widgets. */
  pinnedOnly?: boolean;
  presenters?: readonly WidgetPresenter[];
  presenterContext?: WidgetPresenterContext;
};

type WidgetPresentationAttempt =
  | { ok: true; value: WidgetPresentationSuccess }
  | { ok: false; error: WidgetPresentationError };

async function presentWidget(params: {
  presenter?: WidgetPresenter;
  document: WidgetPresenterDocument;
  title: string;
  context: WidgetPresenterContext;
}): Promise<WidgetPresentationAttempt> {
  const presenter = params.presenter;
  if (!presenter) {
    return {
      ok: false,
      error: {
        code: "no_eligible_node",
        message: "No widget presenter is registered for this target.",
      },
    };
  }
  const errorCode = presenter.target === "current_channel" ? "presentation_error" : "node_error";
  try {
    const availability = await presenter.availability(params.context);
    if (!availability.ok) {
      return availability;
    }
    return await presenter.present({
      document: params.document,
      title: params.title,
      context: params.context,
    });
  } catch (error) {
    return {
      ok: false,
      error: { code: errorCode, message: formatErrorMessage(error) },
    };
  }
}

export function resolveCurrentChannelWidgetPresenter(
  presenters: readonly WidgetPresenter[],
  context: WidgetPresenterContext,
): Extract<WidgetPresenter, { target: "current_channel" }> | undefined {
  const matches = presenters.filter(
    (presenter): presenter is Extract<WidgetPresenter, { target: "current_channel" }> => {
      if (presenter.target !== "current_channel") {
        return false;
      }
      try {
        return presenter.match(context);
      } catch {
        return false;
      }
    },
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function widgetPresentationFailureText(
  error: WidgetPresentationError,
  inlineAvailable: boolean,
): string {
  const message = /[.!?]$/u.test(error.message) ? error.message : `${error.message}.`;
  if (!inlineAvailable) {
    return message;
  }
  const nextStep =
    error.code === "no_eligible_node"
      ? "Pair a canvas-capable device or open the OpenClaw app, then retry."
      : "Retry the requested presentation destination when it is available.";
  return `${message} The widget is available inline here. ${nextStep}`;
}

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
  const pinnedOnly = options.pinnedOnly === true;
  const inlineHostEnabled = options.inlineHostEnabled !== false;
  const inlineAvailable =
    !pinnedOnly && inlineHostEnabled && options.inlineClientAvailable !== false;
  const registeredKinds = listBoardWidgetContentKinds(currentPluginRegistry());
  const allKinds = ["html", ...registeredKinds] as const;
  const presenters = options.presenters ?? [];
  const presenterContext =
    options.presenterContext ??
    (options.agentSessionKey ? { sessionKey: options.agentSessionKey } : {});
  const currentChannelPresenter = pinnedOnly
    ? undefined
    : resolveCurrentChannelWidgetPresenter(presenters, presenterContext);
  const kinds =
    currentChannelPresenter && !inlineAvailable
      ? allKinds.filter((kind) => currentChannelPresenter.capabilities.sourceKinds.includes(kind))
      : allKinds;
  const advertisedRegisteredKinds = kinds.filter((kind) => kind !== "html");
  const explicitPresenters = pinnedOnly
    ? []
    : presenters.filter((presenter) => presenter.target !== "current_channel");
  const presenterPrompt =
    explicitPresenters.length > 0
      ? " Use presentation.target to choose a registered device surface."
      : "";
  const usageGuidance = pinnedOnly
    ? "This scheduled surface is pinned-only: set pin=true to create or update a durable session dashboard widget."
    : "Keep one ad hoc visualization inline; pin for explicit dashboard requests or multiple non-code visualizations.";
  const destinationGuidance = pinnedOnly
    ? "Author a widget for the current session dashboard. Inline and device presentation are unavailable"
    : `Show a widget on the user's current surface. ${
        inlineHostEnabled
          ? "Set pin=true to also place it on this session's dashboard"
          : "Inline hosting is disabled; set pin=true to place it on this session's dashboard"
      }`;
  return {
    label: "Show Widget",
    name: "show_widget",
    description: `Visual helps? Make widget. Do not wait for ask. ${usageGuidance} Update HTML by name. Use for comparisons, trends, timelines, flows, hierarchies, dashboards, status, progress, layouts, and choices. Text clearer? Skip. ${destinationGuidance}; kind defaults to html${advertisedRegisteredKinds.length ? ` and registered kinds are ${advertisedRegisteredKinds.join(", ")}` : ""}. Reuse the same explicit name with pin=true and new widget_code to update pinned content. Use name for a stable widget id, tab for a tab slug, size sm|md|lg|xl|full, presentation.frame card|full-bleed|frameless, and after for a sibling widget anchor. Pinned widgets may declare capabilities.netOrigins and capabilities.tools for operator approval. HTML widgets are self-contained HTML or SVG. Dashboard host APIs: openclaw.prompt.send(text), openclaw.state.emit(payload), openclaw.data.read(bindingId, params?), openclaw.action.run(actionId, params?), and openclaw.cron.trigger(jobId). openclaw.host.controlUiBaseUrl is the Control UI origin plus base path after dashboard host initialization, otherwise null; read it at click time. Open links in a new tab with target="_blank" and rel="noopener noreferrer". \`title\` is host metadata. Start directly with content; do not repeat the title or recreate dashboard chrome. HTML is pre-themed with --surface --card --elevated --text --text-strong --muted --border --border-strong --accent --accent-fill --accent-fg --ok --warn --danger --info --radius --font-body --font-mono.${presenterPrompt}`,
    parameters: createShowWidgetToolSchema(
      kinds,
      explicitPresenters,
      describeDashboardCapabilities(currentPluginRegistry()),
      pinnedOnly,
    ),
    ...(currentChannelPresenter || pinnedOnly
      ? {}
      : { requiredClientCaps: SHOW_WIDGET_REQUIRED_CLIENT_CAPS }),
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
      if (pinnedOnly && !shouldPin) {
        throw new WidgetHtmlInputError("pin=true is required for this scheduled widget surface");
      }
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
      const presentation = asOptionalRecord(params.presentation);
      if (pinnedOnly && presentation?.target !== undefined) {
        throw new WidgetHtmlInputError(
          "presentation.target is unavailable for this pinned-only scheduled widget surface",
        );
      }
      const requestedTarget =
        readToolStringParam(presentation ?? {}, "target") ?? "assistant_message";
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
      const currentPresenterSupportsKind =
        currentChannelPresenter?.target === "current_channel" &&
        currentChannelPresenter.capabilities.sourceKinds.includes(kind);
      const wantsCurrentChannel =
        requestedTarget === "assistant_message" && currentPresenterSupportsKind;
      const wantsNodePanel = requestedTarget === "node_panel";
      if (!inlineAvailable && !wantsCurrentChannel && !wantsNodePanel && !shouldPin) {
        throw new WidgetHtmlInputError(
          "inline widget hosting is disabled; set pin=true to place the widget on the session dashboard",
        );
      }
      if (wantsCurrentChannel && currentChannelPresenter?.target === "current_channel") {
        const { maxSourceBytes } = currentChannelPresenter.capabilities;
        if (maxSourceBytes !== undefined) {
          assertWidgetHtmlSize(rawWidgetCode, maxSourceBytes, { inputName: "widget_code" });
        }
      }
      const composedWidget = registration
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
      const wrappedDocument = buildWidgetDocument(
        title,
        composedWidget,
        registration ? { scriptOrigins: ["'self'"] } : {},
      );
      let pinnedText = "";
      let pinnedWidgetName: string | undefined;
      let capabilityState: BoardWidgetPutResult["widgets"][number]["grantState"] | undefined;
      if (pinSessionKey) {
        const sessionKey = pinSessionKey;
        const explicitName = readToolStringParam(params, "name");
        const name = explicitName ?? slugWidgetName(title);
        const tab = readToolStringParam(params, "tab");
        const size = readToolStringParam(params, "size");
        const frame = readToolStringParam(presentation ?? {}, "frame");
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
          ...(frame ? { presentation: frame } : {}),
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
        if (!widget) {
          throw new WidgetHtmlInputError(
            "Dashboard did not return the pinned widget; read the board and retry.",
          );
        }
        capabilityState = widget.grantState;
        pinnedText = `pinned to dashboard tab ${widget.tabId} as ${
          snapshot.resolvedWidgetName
        }${size ? ` (${size})` : ""}`;
        if (capabilityState === "pending") {
          pinnedText +=
            "; capabilities pending: ask the operator to review and approve the dashboard permission card";
        }
        if (capabilityState === "rejected") {
          pinnedText +=
            "; capabilities rejected: review the requested access and session permission policy with the operator before retrying";
        }
        if (capabilityState === "granted") {
          pinnedText += "; capabilities granted";
        }
      }
      const hasPresentationRoute = inlineAvailable || wantsCurrentChannel || wantsNodePanel;
      if (!hasPresentationRoute) {
        return jsonResult({
          status:
            capabilityState === "pending" || capabilityState === "rejected"
              ? capabilityState
              : "pinned",
          boardWidgetName: pinnedWidgetName,
          capabilityState,
          text: `Widget ${pinnedText}`,
        });
      }
      let document: Awaited<ReturnType<typeof createCanvasDocument>> | undefined;
      const hostDocument = async () =>
        (document ??= await createCanvasDocument(
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
        ));

      let presentationAttempt: WidgetPresentationAttempt | undefined;
      if (wantsCurrentChannel && currentChannelPresenter) {
        presentationAttempt = await presentWidget({
          presenter: currentChannelPresenter,
          document: { kind: "html", html: wrappedDocument },
          title,
          context: presenterContext,
        });
      } else if (wantsNodePanel) {
        const hosted = await hostDocument();
        presentationAttempt = await presentWidget({
          presenter: explicitPresenters.find((presenter) => presenter.target === "node_panel"),
          document: { kind: "html", html: wrappedDocument, hostedUrl: hosted.entryUrl },
          title,
          context: presenterContext,
        });
      }

      if (presentationAttempt?.ok && presentationAttempt.value.kind === "message") {
        const receipt = presentationAttempt.value.receipt;
        const messageId = receipt.primaryPlatformMessageId ?? receipt.platformMessageIds[0];
        return jsonResult({
          kind: "widget",
          presentation: {
            target: "current_channel",
            title,
            receipt,
          },
          ...(pinnedWidgetName ? { boardWidgetName: pinnedWidgetName } : {}),
          ...(capabilityState ? { capabilityState } : {}),
          text: `Widget presented in the current channel${messageId ? ` as message ${messageId}` : ""}${pinnedText ? `; ${pinnedText}` : ""}`,
        });
      }

      if (presentationAttempt && !presentationAttempt.ok && !inlineAvailable) {
        const failureText = widgetPresentationFailureText(presentationAttempt.error, false);
        if (pinnedWidgetName) {
          return jsonResult({
            status: "partial",
            boardWidgetName: pinnedWidgetName,
            capabilityState,
            presentation: {
              target: requestedTarget === "node_panel" ? "node_panel" : "current_channel",
              status: "failed",
              error: presentationAttempt.error,
            },
            text: `Widget ${pinnedText}, but presentation failed: ${failureText}`,
          });
        }
        throw new WidgetHtmlInputError(`Widget presentation failed: ${failureText}`);
      }

      const hosted = await hostDocument();
      const presentedNode =
        presentationAttempt?.ok && presentationAttempt.value.kind === "node"
          ? presentationAttempt.value
          : undefined;
      const target = presentedNode ? "node_panel" : "assistant_message";
      const presentationText = presentedNode
        ? `; presented on ${presentedNode.nodeName ?? presentedNode.nodeId} (${presentedNode.nodeId})`
        : presentationAttempt && !presentationAttempt.ok
          ? `; ${widgetPresentationFailureText(presentationAttempt.error, true)}`
          : "";
      return jsonResult({
        kind: "canvas",
        ...(capabilityState ? { capabilityState } : {}),
        presentation: {
          target,
          title,
          sandbox: "scripts",
          ...(presentedNode
            ? { node: { id: presentedNode.nodeId, name: presentedNode.nodeName } }
            : {}),
        },
        view: {
          id: hosted.id,
          url: hosted.entryUrl,
          ...(pinnedWidgetName ? { boardWidgetName: pinnedWidgetName } : {}),
        },
        text: `Widget hosted at ${hosted.entryUrl}${pinnedText ? `; ${pinnedText}` : ""}${presentationText}`,
      });
    },
  };
}
