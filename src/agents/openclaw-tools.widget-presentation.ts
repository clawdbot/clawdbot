import { resolveCurrentChannelWidgetPresenter } from "../canvas/widget-tool.js";
import { resolveWidgetPresenters } from "../plugins/widget-presenters.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";

type WidgetPresentationRunOptions = {
  agentSessionKey?: string;
  runSessionKey?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  nativeChannelId?: string;
  currentChannelId?: string;
  currentMessagingTarget?: string;
};

/** Resolves widget presenters against the trusted delivery facts prepared for this run. */
export function resolveWidgetPresentationForRun(options?: WidgetPresentationRunOptions) {
  const deliveryContext = normalizeDeliveryContext({
    channel: options?.agentChannel,
    to: options?.agentTo ?? options?.currentMessagingTarget ?? options?.currentChannelId,
    accountId: options?.agentAccountId,
    threadId: options?.agentThreadId,
  });
  const sessionKey = options?.runSessionKey ?? options?.agentSessionKey;
  const context = {
    messageChannel: options?.agentChannel,
    accountId: options?.agentAccountId,
    deliveryContext,
    nativeChannelId: options?.nativeChannelId,
    currentChannelId: options?.currentChannelId,
    currentMessagingTarget: options?.currentMessagingTarget,
    sessionKey,
  };
  const presenters = resolveWidgetPresenters().map((registration) => registration.presenter);
  return {
    context,
    deliveryContext,
    presenters,
    currentChannelPresenter: resolveCurrentChannelWidgetPresenter(presenters, context),
  };
}
