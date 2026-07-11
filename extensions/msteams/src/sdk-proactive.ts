import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
// Msteams plugin module implements sdk proactive behavior.
import { normalizeBotFrameworkServiceUrl } from "./bot-framework-service-url.js";
import {
  validateMSTeamsProactiveServiceUrlBoundary,
  type MSTeamsSdkCloudOptions,
} from "./cloud.js";
import type { MSTeamsApp } from "./sdk.js";

type MSTeamsAccountRef = {
  id?: string;
  name?: string;
  role?: string;
  aadObjectId?: string;
};

type MSTeamsSdkReferenceSource = {
  activityId?: string;
  user?: MSTeamsAccountRef;
  agent?: MSTeamsAccountRef | null;
  /** Legacy imported rows may only carry `bot`; see StoredConversationReference.bot. */
  bot?: MSTeamsAccountRef | null;
  conversation: { id: string; conversationType?: string; tenantId?: string };
  channelId?: string;
  serviceUrl?: string;
  locale?: string;
  tenantId?: string;
  aadObjectId?: string;
};

type MSTeamsSdkConversationReference = {
  activityId?: string;
  channelId: "msteams";
  serviceUrl: string;
  bot: MSTeamsAccountRef & { id: string; role: "bot" };
  conversation: { id: string; conversationType?: string; tenantId?: string };
  locale?: string;
  user?: MSTeamsAccountRef;
  tenantId?: string;
  aadObjectId?: string;
};

type MSTeamsActivitiesClient = {
  create(activity: unknown): Promise<{ id?: string }>;
  createTargeted?(activity: unknown): Promise<{ id?: string }>;
  update(activityId: string, activity: unknown): Promise<unknown>;
  updateTargeted?(activityId: string, activity: unknown): Promise<unknown>;
  delete(activityId: string): Promise<unknown>;
};

type MSTeamsApiClient = {
  serviceUrl?: string;
  http?: unknown;
  conversations: {
    activities(conversationId: string): MSTeamsActivitiesClient;
  };
};

type MSTeamsApiClientCtor = new (
  serviceUrl: string,
  options?: unknown,
  apiClientSettings?: unknown,
) => unknown;

type MSTeamsApiModule = {
  Client: MSTeamsApiClientCtor;
};

type MSTeamsProactiveOptions = {
  threadActivityId?: string;
  serviceUrlBoundary?: MSTeamsSdkCloudOptions;
};

const loadMSTeamsApiModule = createLazyRuntimeModule(
  () => import("@microsoft/teams.api") as unknown as Promise<MSTeamsApiModule>,
);

function resolveThreadedConversationId(conversationId: string, threadActivityId?: string): string {
  if (!threadActivityId) {
    return conversationId.split(";")[0] ?? conversationId;
  }
  const baseId = conversationId.split(";")[0] ?? conversationId;
  return `${baseId};messageid=${threadActivityId}`;
}

function normalizeRequiredServiceUrl(ref: MSTeamsSdkReferenceSource): string {
  if (!ref.serviceUrl) {
    throw new Error("Invalid stored reference: missing serviceUrl");
  }
  return normalizeBotFrameworkServiceUrl(ref.serviceUrl);
}

function buildSdkConversationReference(
  source: MSTeamsSdkReferenceSource,
  options?: MSTeamsProactiveOptions,
): MSTeamsSdkConversationReference {
  const bot = source.agent ?? source.bot ?? undefined;
  if (!bot?.id) {
    throw new Error("Invalid stored reference: missing agent.id");
  }

  const conversationId = resolveThreadedConversationId(
    source.conversation.id,
    options?.threadActivityId,
  );
  const tenantId = source.tenantId ?? source.conversation.tenantId;
  const serviceUrl = normalizeRequiredServiceUrl(source);

  if (options?.serviceUrlBoundary) {
    validateMSTeamsProactiveServiceUrlBoundary({
      cloud: options.serviceUrlBoundary.cloud,
      conversationId,
      storedServiceUrl: serviceUrl,
      configuredServiceUrl: options.serviceUrlBoundary.serviceUrl,
    });
  }

  const botRef = {
    ...bot,
    id: bot.id,
    role: "bot" as const,
  };

  return {
    activityId: source.activityId,
    channelId: "msteams",
    serviceUrl,
    bot: botRef,
    conversation: {
      id: conversationId,
      conversationType: source.conversation.conversationType,
      ...(tenantId ? { tenantId } : {}),
    },
    locale: source.locale,
    user: source.user,
    ...(tenantId ? { tenantId } : {}),
    ...(source.aadObjectId ? { aadObjectId: source.aadObjectId } : {}),
  };
}

function getStructuralApiClient(app: MSTeamsApp): MSTeamsApiClient {
  return app.api as MSTeamsApiClient;
}

function sameServiceUrl(left: string | undefined, right: string): boolean {
  if (!left) {
    return false;
  }
  try {
    return normalizeBotFrameworkServiceUrl(left) === right;
  } catch {
    return false;
  }
}

function stringifyReferenceFallbackActivity(activity: unknown): string {
  if (typeof activity === "string") {
    return activity;
  }
  if (activity == null) {
    return "";
  }
  if (
    typeof activity === "number" ||
    typeof activity === "boolean" ||
    typeof activity === "bigint"
  ) {
    return String(activity);
  }
  return "";
}

async function getApiClientForReference(
  app: MSTeamsApp,
  ref: MSTeamsSdkConversationReference,
): Promise<MSTeamsApiClient> {
  const api = getStructuralApiClient(app);
  if (sameServiceUrl(api.serviceUrl, ref.serviceUrl)) {
    return api;
  }

  const appInternals = app as unknown as {
    client?: unknown;
    api?: { http?: unknown };
  };
  const httpClient = appInternals.api?.http ?? appInternals.client;

  if (!httpClient) {
    return api;
  }

  const { Client } = await loadMSTeamsApiModule();
  return new Client(ref.serviceUrl, httpClient) as MSTeamsApiClient;
}

function mergeReferenceIntoActivity(
  activity: unknown,
  ref: MSTeamsSdkConversationReference,
): Record<string, unknown> {
  const source =
    activity && typeof activity === "object" && !Array.isArray(activity)
      ? (activity as Record<string, unknown>)
      : { type: "message", text: stringifyReferenceFallbackActivity(activity) };
  const existingChannelData =
    source.channelData &&
    typeof source.channelData === "object" &&
    !Array.isArray(source.channelData)
      ? (source.channelData as Record<string, unknown>)
      : undefined;
  const existingTenant =
    existingChannelData?.tenant &&
    typeof existingChannelData.tenant === "object" &&
    !Array.isArray(existingChannelData.tenant)
      ? (existingChannelData.tenant as Record<string, unknown>)
      : undefined;
  let channelData = existingChannelData ? { ...existingChannelData } : undefined;
  if (ref.tenantId) {
    channelData ??= {};
    channelData.tenant = existingTenant
      ? { ...existingTenant, id: ref.tenantId }
      : { id: ref.tenantId };
  }
  return {
    ...source,
    channelId: ref.channelId,
    from: ref.bot,
    recipient: ref.user,
    conversation: ref.conversation,
    ...(channelData ? { channelData } : {}),
    locale: ref.locale,
    ...(ref.tenantId ? { tenantId: ref.tenantId } : {}),
    ...(ref.aadObjectId ? { aadObjectId: ref.aadObjectId } : {}),
  };
}

export async function sendMSTeamsActivityWithReference(
  app: MSTeamsApp,
  source: MSTeamsSdkReferenceSource,
  activity: unknown,
  options?: MSTeamsProactiveOptions,
): Promise<{ id?: string }> {
  const ref = buildSdkConversationReference(source, options);
  const api = await getApiClientForReference(app, ref);
  const activities = api.conversations.activities(ref.conversation.id);
  const activityWithRef = mergeReferenceIntoActivity(activity, ref);
  const isTargeted =
    (activityWithRef.recipient as { isTargeted?: unknown } | undefined)?.isTargeted === true;
  if (isTargeted && ref.conversation.conversationType === "personal") {
    throw new Error("Targeted messages are not supported in 1:1 (personal) chats.");
  }

  const activityId = typeof activityWithRef.id === "string" ? activityWithRef.id : undefined;
  if (activityId) {
    const res =
      isTargeted && activities.updateTargeted
        ? await activities.updateTargeted(activityId, activityWithRef)
        : await activities.update(activityId, activityWithRef);
    return { ...activityWithRef, ...(res && typeof res === "object" ? res : {}) };
  }

  const res =
    isTargeted && activities.createTargeted
      ? await activities.createTargeted(activityWithRef)
      : await activities.create(activityWithRef);
  return { ...activityWithRef, ...res };
}

export async function updateMSTeamsActivityWithReference(
  app: MSTeamsApp,
  source: MSTeamsSdkReferenceSource,
  activityId: string,
  activity: unknown,
  options?: MSTeamsProactiveOptions,
): Promise<unknown> {
  const ref = buildSdkConversationReference(source, options);
  const api = await getApiClientForReference(app, ref);
  return api.conversations.activities(ref.conversation.id).update(activityId, activity);
}

export async function deleteMSTeamsActivityWithReference(
  app: MSTeamsApp,
  source: MSTeamsSdkReferenceSource,
  activityId: string,
  options?: MSTeamsProactiveOptions,
): Promise<unknown> {
  const ref = buildSdkConversationReference(source, options);
  const api = await getApiClientForReference(app, ref);
  return api.conversations.activities(ref.conversation.id).delete(activityId);
}
