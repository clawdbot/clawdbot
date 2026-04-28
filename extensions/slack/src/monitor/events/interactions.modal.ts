import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { parseSlackModalPrivateMetadata } from "../../modal-metadata.js";
import { authorizeSlackSystemEventSender } from "../auth.js";
import type { SlackMonitorContext } from "../context.js";

export type ModalInputSummary = {
  blockId: string;
  actionId: string;
  actionType?: string;
  inputKind?: "text" | "number" | "email" | "url" | "rich_text";
  value?: string;
  selectedValues?: string[];
  selectedUsers?: string[];
  selectedChannels?: string[];
  selectedConversations?: string[];
  selectedLabels?: string[];
  selectedDate?: string;
  selectedTime?: string;
  selectedDateTime?: number;
  inputValue?: string;
  inputNumber?: number;
  inputEmail?: string;
  inputUrl?: string;
  richTextValue?: unknown;
  richTextPreview?: string;
};

export type SlackModalBody = {
  user?: { id?: string };
  team?: { id?: string };
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

export type SlackModalInteractionKind = "view_submission" | "view_closed";
export type SlackModalEventHandlerArgs = { ack: () => Promise<void>; body: unknown };
export type RegisterSlackModalHandler = (
  matcher: RegExp,
  handler: (args: SlackModalEventHandlerArgs) => Promise<void>,
) => void;

type SlackInteractionContextPrefix = "slack:interaction:view" | "slack:interaction:view-closed";

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

export async function emitSlackModalLifecycleEvent(params: {
  ctx: SlackMonitorContext;
  body: SlackModalBody;
  interactionType: SlackModalInteractionKind;
  contextPrefix: SlackInteractionContextPrefix;
  summarizeViewState: (values: unknown) => ModalInputSummary[];
  formatSystemEvent: (payload: Record<string, unknown>) => string;
}): Promise<void> {
  const { callbackId, userId, expectedUserId, viewId, sessionRouting, payload } =
    resolveSlackModalEventBase({
      ctx: params.ctx,
      body: params.body,
      summarizeViewState: params.summarizeViewState,
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

  enqueueSystemEvent(params.formatSystemEvent(eventPayload), {
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
