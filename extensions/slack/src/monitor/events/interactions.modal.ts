// Slack plugin module implements interactions.modal behavior.
import type { AllMiddlewareArgs } from "@slack/bolt";
import { requestHeartbeat } from "openclaw/plugin-sdk/heartbeat-runtime";
import { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";
import { enqueueRoutedSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { dispatchSlackPluginInteractiveHandler } from "../../interactive-dispatch.js";
import { parseSlackModalPrivateMetadata } from "../../modal-metadata.js";
import { authorizeSlackSystemEventSender } from "../auth.js";
import type { SlackMonitorContext } from "../context.js";
import { resolveSlackDeferredActionTarget } from "../deferred-action-routing.js";
import { resolveSlackListenerEventScope, type SlackEventScope } from "../event-scope.js";
import type { ModalInputSummary } from "./modal-input-summary.js";

type SlackModalBody = {
  user?: { id?: string };
  trigger_id?: string;
  view?: {
    id?: string;
    callback_id?: string;
    private_metadata?: string;
    root_view_id?: string;
    previous_view_id?: string;
    external_id?: string;
    hash?: string;
    state?: { values?: unknown };
  };
  is_cleared?: boolean;
};

type SlackModalEventBase = {
  callbackId: string;
  userId: string;
  expectedUserId?: string;
  viewId?: string;
  sessionRouting: ReturnType<typeof resolveModalSessionRouting>;
  stateValues?: unknown;
  payload: {
    actionId: string;
    callbackId: string;
    viewId?: string;
    userId: string;
    teamId?: string;
    rootViewId?: string;
    previousViewId?: string;
    externalId?: string;
    viewHash?: string;
    isStackedView?: boolean;
    privateMetadata?: string;
    routedChannelId?: string;
    routedChannelType?: string;
    inputs: ModalInputSummary[];
  };
};

type SlackModalInteractionKind = "view_submission" | "view_closed";
type SlackModalEventHandlerArgs = { ack: () => Promise<void>; body: unknown } & Pick<
  AllMiddlewareArgs,
  "context" | "client"
>;
type RegisterSlackModalHandler = (
  matcher: RegExp,
  handler: (args: SlackModalEventHandlerArgs) => Promise<void>,
) => void;

type SlackInteractionContextPrefix = "slack:interaction:view" | "slack:interaction:view-closed";
const OPENCLAW_MODAL_CALLBACK_PREFIX = "openclaw:";

function resolveSlackModalPluginInteractiveData(params: {
  callbackId: string;
  metadata: ReturnType<typeof parseSlackModalPrivateMetadata>;
}): string | undefined {
  const metadataData = params.metadata.pluginInteractiveData?.trim();
  if (metadataData) {
    return metadataData;
  }
  if (!params.callbackId.startsWith(OPENCLAW_MODAL_CALLBACK_PREFIX)) {
    return undefined;
  }
  const callbackData = params.callbackId.slice(OPENCLAW_MODAL_CALLBACK_PREFIX.length).trim();
  return callbackData || undefined;
}

function shouldHandleSlackModalLifecycleBody(body: unknown): boolean {
  const typed = body as SlackModalBody;
  const callbackId = typed.view?.callback_id ?? "";
  if (callbackId.startsWith(OPENCLAW_MODAL_CALLBACK_PREFIX)) {
    return true;
  }
  const metadata = parseSlackModalPrivateMetadata(typed.view?.private_metadata);
  return Boolean(metadata.pluginInteractiveData?.trim());
}

function resolveSlackModalPluginNamespace(data: string | undefined): string | undefined {
  if (!data) {
    return undefined;
  }
  const separatorIndex = data.indexOf(":");
  return separatorIndex >= 0 ? data.slice(0, separatorIndex) : data;
}

function resolveSlackPluginSystemEventPayload(
  result: unknown,
): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const systemEvent = (result as { systemEvent?: unknown }).systemEvent;
  if (!systemEvent || typeof systemEvent !== "object") {
    return undefined;
  }
  const typed = systemEvent as {
    summary?: unknown;
    reference?: unknown;
    data?: unknown;
  };
  const output: Record<string, unknown> = {};
  if (typeof typed.summary === "string" && typed.summary.trim()) {
    output.summary = typed.summary;
  }
  if (typeof typed.reference === "string" && typed.reference.trim()) {
    output.reference = typed.reference;
  }
  if (typed.data && typeof typed.data === "object" && !Array.isArray(typed.data)) {
    output.data = typed.data;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function resolveModalSessionRouting(params: {
  ctx: SlackMonitorContext;
  metadata: ReturnType<typeof parseSlackModalPrivateMetadata>;
  userId?: string;
  eventScope?: SlackEventScope;
}): { agentId: string; sessionKey: string; channelId?: string; channelType?: string } {
  const metadata = params.metadata;
  const metadataAgentId = metadata.sessionKey
    ? resolveAgentIdFromSessionKey(metadata.sessionKey)
    : undefined;
  if (metadata.sessionKey && metadataAgentId && !params.eventScope) {
    return {
      agentId: metadataAgentId,
      sessionKey: metadata.sessionKey,
      channelId: metadata.channelId,
      channelType: metadata.channelType,
    };
  }
  const routing = metadata.channelId
    ? {
        ...params.ctx.resolveSlackSystemEventRoute({
          channelId: metadata.channelId,
          channelType: metadata.channelType,
          senderId: params.userId,
          eventScope: params.eventScope,
        }),
        channelId: metadata.channelId,
        channelType: metadata.channelType,
      }
    : {
        ...params.ctx.resolveSlackSystemEventRoute({
          channelType: "im",
          senderId: params.userId,
          eventScope: params.eventScope,
        }),
        channelType: params.eventScope ? "im" : undefined,
      };
  if (
    metadata.sessionKey &&
    (metadata.sessionKey === routing.sessionKey ||
      metadata.sessionKey.startsWith(`${routing.sessionKey}:thread:`))
  ) {
    // Preserve an exact thread only after its base is bound to this Enterprise workspace.
    return { ...routing, sessionKey: metadata.sessionKey };
  }
  return routing;
}

function summarizeSlackViewLifecycleContext(view: {
  root_view_id?: string;
  previous_view_id?: string;
  external_id?: string;
  hash?: string;
}): {
  rootViewId?: string;
  previousViewId?: string;
  externalId?: string;
  viewHash?: string;
  isStackedView?: boolean;
} {
  const rootViewId = view.root_view_id;
  const previousViewId = view.previous_view_id;
  const externalId = view.external_id;
  const viewHash = view.hash;
  return {
    rootViewId,
    previousViewId,
    externalId,
    viewHash,
    isStackedView: Boolean(previousViewId),
  };
}

function resolveSlackModalEventBase(params: {
  ctx: SlackMonitorContext;
  body: SlackModalBody;
  eventScope?: SlackEventScope;
  teamId?: string;
  summarizeViewState: (values: unknown) => ModalInputSummary[];
}): SlackModalEventBase {
  const metadata = parseSlackModalPrivateMetadata(params.body.view?.private_metadata);
  const callbackId = params.body.view?.callback_id ?? "unknown";
  const userId = params.body.user?.id ?? "unknown";
  const viewId = params.body.view?.id;
  const inputs = params.summarizeViewState(params.body.view?.state?.values);
  const sessionRouting = resolveModalSessionRouting({
    ctx: params.ctx,
    metadata,
    userId,
    eventScope: params.eventScope,
  });
  return {
    callbackId,
    userId,
    expectedUserId: metadata.userId,
    viewId,
    sessionRouting,
    stateValues: params.body.view?.state?.values,
    payload: {
      actionId: `view:${callbackId}`,
      callbackId,
      viewId,
      userId,
      teamId: params.teamId,
      ...summarizeSlackViewLifecycleContext({
        root_view_id: params.body.view?.root_view_id,
        previous_view_id: params.body.view?.previous_view_id,
        external_id: params.body.view?.external_id,
        hash: params.body.view?.hash,
      }),
      privateMetadata: params.body.view?.private_metadata,
      routedChannelId: sessionRouting.channelId,
      routedChannelType: sessionRouting.channelType,
      inputs,
    },
  };
}

async function dispatchSlackModalPluginInteractiveHandler(params: {
  ctx: SlackMonitorContext;
  body: SlackModalBody;
  eventScope?: SlackEventScope;
  teamId?: string;
  interactionType: SlackModalInteractionKind;
  data: string | undefined;
  auth: { isAuthorizedSender: boolean };
  channelType?: Parameters<typeof dispatchSlackPluginInteractiveHandler>[0]["channelType"];
  payload: SlackModalEventBase["payload"];
  stateValues?: unknown;
  sessionRouting: SlackModalEventBase["sessionRouting"];
}): Promise<{
  matched: boolean;
  handled: boolean;
  duplicate: boolean;
  namespace?: string;
  systemEvent?: Record<string, unknown>;
}> {
  if (!params.data) {
    return { matched: false, handled: false, duplicate: false };
  }

  const isViewClosed = params.interactionType === "view_closed";
  const interactionId = [
    params.interactionType,
    params.payload.callbackId,
    params.payload.viewId,
    params.payload.userId,
  ]
    .filter(Boolean)
    .join(":");
  const result = await dispatchSlackPluginInteractiveHandler({
    data: params.data,
    interactionId,
    teamId: params.eventScope?.teamId,
    channelType: params.channelType,
    ctx: {
      accountId: params.ctx.accountId,
      interactionId,
      conversationId: params.sessionRouting.channelId ?? "",
      parentConversationId: undefined,
      threadId: undefined,
      senderId: params.payload.userId,
      senderUsername: undefined,
      auth: params.auth,
      interaction: {
        kind: params.interactionType,
        callbackId: params.payload.callbackId,
        viewId: params.payload.viewId,
        rootViewId: params.payload.rootViewId,
        previousViewId: params.payload.previousViewId,
        externalId: params.payload.externalId,
        isStackedView: params.payload.isStackedView,
        isCleared: isViewClosed ? params.body.is_cleared === true : undefined,
        inputs: params.payload.inputs,
        stateValues: params.stateValues,
        triggerId: params.body.trigger_id,
      },
    },
    respond: {
      acknowledge: async () => {},
      reply: async () => {},
      followUp: async () => {},
      editMessage: async () => {},
    },
  });
  return {
    ...result,
    namespace: result.matched ? resolveSlackModalPluginNamespace(params.data) : undefined,
    systemEvent: result.matched ? resolveSlackPluginSystemEventPayload(result.result) : undefined,
  };
}

async function emitSlackModalLifecycleEvent(params: {
  ctx: SlackMonitorContext;
  body: SlackModalBody;
  eventScope?: SlackEventScope;
  teamId?: string;
  interactionType: SlackModalInteractionKind;
  contextPrefix: SlackInteractionContextPrefix;
  summarizeViewState: (values: unknown) => ModalInputSummary[];
  formatSystemEvent: (payload: Record<string, unknown>) => string;
}): Promise<void> {
  const { callbackId, userId, expectedUserId, viewId, sessionRouting, stateValues, payload } =
    resolveSlackModalEventBase({
      ctx: params.ctx,
      body: params.body,
      eventScope: params.eventScope,
      teamId: params.teamId,
      summarizeViewState: params.summarizeViewState,
    });
  const metadata = parseSlackModalPrivateMetadata(params.body.view?.private_metadata);
  const pluginInteractiveData = resolveSlackModalPluginInteractiveData({
    callbackId,
    metadata,
  });
  const isViewClosed = params.interactionType === "view_closed";
  const isCleared = params.body.is_cleared === true;
  const eventPayload = isViewClosed
    ? {
        interactionType: params.interactionType,
        ...payload,
        isCleared,
      }
    : {
        interactionType: params.interactionType,
        ...payload,
      };

  if (isViewClosed) {
    params.ctx.runtime.log?.(
      `slack:interaction view_closed callback=${callbackId} user=${userId} cleared=${isCleared}`,
    );
  } else {
    params.ctx.runtime.log?.(
      `slack:interaction view_submission callback=${callbackId} user=${userId} inputs=${payload.inputs.length}`,
    );
  }

  if (!expectedUserId) {
    if (pluginInteractiveData) {
      try {
        await dispatchSlackModalPluginInteractiveHandler({
          ctx: params.ctx,
          body: params.body,
          eventScope: params.eventScope,
          teamId: params.teamId,
          interactionType: params.interactionType,
          data: pluginInteractiveData,
          auth: { isAuthorizedSender: false },
          payload,
          stateValues,
          sessionRouting,
        });
      } catch (error) {
        params.ctx.runtime.log?.(
          `slack:interaction modal plugin dispatch failed callback=${callbackId} error=${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    params.ctx.runtime.log?.(
      `slack:interaction drop modal callback=${callbackId} user=${userId} reason=missing-expected-user`,
    );
    return;
  }

  const auth = await authorizeSlackSystemEventSender({
    ctx: params.ctx,
    eventScope: params.eventScope,
    senderId: userId,
    channelId: sessionRouting.channelId,
    channelType: sessionRouting.channelType,
    expectedSenderId: expectedUserId,
    interactiveEvent: true,
  });
  if (!auth.allowed) {
    params.ctx.runtime.log?.(
      `slack:interaction drop modal callback=${callbackId} user=${userId} reason=${auth.reason ?? "unauthorized"}`,
    );
    return;
  }

  let pluginDispatch:
    | Awaited<ReturnType<typeof dispatchSlackModalPluginInteractiveHandler>>
    | undefined;
  try {
    pluginDispatch = await dispatchSlackModalPluginInteractiveHandler({
      ctx: params.ctx,
      body: params.body,
      eventScope: params.eventScope,
      teamId: params.teamId,
      interactionType: params.interactionType,
      data: pluginInteractiveData,
      auth: { isAuthorizedSender: auth.allowed },
      channelType: auth.channelType,
      payload,
      stateValues,
      sessionRouting,
    });
  } catch (error) {
    params.ctx.runtime.log?.(
      `slack:interaction modal plugin dispatch failed callback=${callbackId} error=${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const pluginEventFields =
    pluginDispatch?.matched === true
      ? {
          pluginHandled: pluginDispatch.handled,
          pluginNamespace: pluginDispatch.namespace,
          pluginDuplicate: pluginDispatch.duplicate || undefined,
          pluginSystemEvent: pluginDispatch.systemEvent,
        }
      : {};

  const targetKind = auth.channelType === "im" ? "user" : "channel";
  const targetId = targetKind === "user" ? userId : sessionRouting.channelId;
  const deferredTarget = targetId
    ? resolveSlackDeferredActionTarget({
        eventScope: params.eventScope,
        kind: targetKind,
        id: targetId,
      })
    : undefined;

  const queued = enqueueRoutedSystemEvent(
    params.formatSystemEvent({ ...eventPayload, ...pluginEventFields }),
    sessionRouting,
    {
      contextKey: [params.contextPrefix, params.teamId, callbackId, viewId, userId]
        .filter(Boolean)
        .join(":"),
      deliveryContext: {
        channel: "slack",
        ...(deferredTarget ? { to: deferredTarget.target } : {}),
        accountId: params.ctx.accountId,
      },
    },
  );
  if (queued) {
    requestHeartbeat({
      source: "hook",
      intent: "immediate",
      reason: "hook:slack-interaction",
      agentId: sessionRouting.agentId,
      sessionKey: sessionRouting.sessionKey,
      heartbeat: { target: "last" },
    });
  }
}

export function registerModalLifecycleHandler(params: {
  register: RegisterSlackModalHandler;
  matcher: RegExp;
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
  interactionType: SlackModalInteractionKind;
  contextPrefix: SlackInteractionContextPrefix;
  summarizeViewState: (values: unknown) => ModalInputSummary[];
  formatSystemEvent: (payload: Record<string, unknown>) => string;
}) {
  params.register(params.matcher, async (args: SlackModalEventHandlerArgs) => {
    const { ack, body } = args;
    if (!shouldHandleSlackModalLifecycleBody(body)) {
      return;
    }
    await ack();
    const eventScope = resolveSlackListenerEventScope({
      identity: params.ctx.installationIdentity,
      body,
      context: args.context,
      client: args.client,
      clientOptions: params.ctx.app.webClientOptions,
      onDrop: (reason) =>
        params.ctx.runtime.log?.(`slack:interaction drop ${params.interactionType} ${reason}`),
    });
    if (eventScope === null) {
      return;
    }
    if (params.ctx.shouldDropMismatchedSlackEvent?.(body)) {
      params.ctx.runtime.log?.(
        `slack:interaction drop ${params.interactionType} payload (mismatched app/team)`,
      );
      return;
    }
    params.trackEvent?.();
    const typedBody = body as SlackModalBody;
    await emitSlackModalLifecycleEvent({
      ctx: params.ctx,
      body: typedBody,
      eventScope,
      teamId: args.context.teamId,
      interactionType: params.interactionType,
      contextPrefix: params.contextPrefix,
      summarizeViewState: params.summarizeViewState,
      formatSystemEvent: params.formatSystemEvent,
    });
  });
}
