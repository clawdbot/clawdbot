import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { dispatchSlackPluginInteractiveHandler } from "../../interactive-dispatch.js";
import { parseSlackModalPrivateMetadata } from "../../modal-metadata.js";
import { authorizeSlackSystemEventSender } from "../auth.js";
import type { SlackMonitorContext } from "../context.js";
import type { ModalInputSummary } from "./modal-input-summary.js";

type SlackModalBody = {
  user?: { id?: string };
  team?: { id?: string };
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
type SlackModalEventHandlerArgs = { ack: () => Promise<void>; body: unknown };
export type RegisterSlackModalHandler = (
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
}): { sessionKey: string; channelId?: string; channelType?: string } {
  const metadata = params.metadata;
  if (metadata.sessionKey) {
    return {
      sessionKey: metadata.sessionKey,
      channelId: metadata.channelId,
      channelType: metadata.channelType,
    };
  }
  if (metadata.channelId) {
    return {
      sessionKey: params.ctx.resolveSlackSystemEventSessionKey({
        channelId: metadata.channelId,
        channelType: metadata.channelType,
        senderId: params.userId,
      }),
      channelId: metadata.channelId,
      channelType: metadata.channelType,
    };
  }
  return {
    sessionKey: params.ctx.resolveSlackSystemEventSessionKey({}),
  };
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
      teamId: params.body.team?.id,
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
  interactionType: SlackModalInteractionKind;
  data: string | undefined;
  auth: { isAuthorizedSender: boolean };
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
  interactionType: SlackModalInteractionKind;
  contextPrefix: SlackInteractionContextPrefix;
  summarizeViewState: (values: unknown) => ModalInputSummary[];
  formatSystemEvent: (payload: Record<string, unknown>) => string;
}): Promise<void> {
  const { callbackId, userId, expectedUserId, viewId, sessionRouting, stateValues, payload } =
    resolveSlackModalEventBase({
      ctx: params.ctx,
      body: params.body,
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
      interactionType: params.interactionType,
      data: pluginInteractiveData,
      auth: { isAuthorizedSender: auth.allowed },
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

  enqueueSystemEvent(params.formatSystemEvent({ ...eventPayload, ...pluginEventFields }), {
    sessionKey: sessionRouting.sessionKey,
    contextKey: [params.contextPrefix, callbackId, viewId, userId].filter(Boolean).join(":"),
  });
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
  params.register(params.matcher, async ({ ack, body }: SlackModalEventHandlerArgs) => {
    if (!shouldHandleSlackModalLifecycleBody(body)) {
      return;
    }
    await ack();
    if (params.ctx.shouldDropMismatchedSlackEvent?.(body)) {
      params.ctx.runtime.log?.(
        `slack:interaction drop ${params.interactionType} payload (mismatched app/team)`,
      );
      return;
    }
    params.trackEvent?.();
    await emitSlackModalLifecycleEvent({
      ctx: params.ctx,
      body: body as SlackModalBody,
      interactionType: params.interactionType,
      contextPrefix: params.contextPrefix,
      summarizeViewState: params.summarizeViewState,
      formatSystemEvent: params.formatSystemEvent,
    });
  });
}
