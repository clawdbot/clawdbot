// Msteams plugin module implements cloud behavior.
import type { MSTeamsConfig } from "../runtime-api.js";

export type MSTeamsCloudName = "Public" | "USGov" | "USGovDoD" | "China";

export const DEFAULT_MSTEAMS_CLOUD: MSTeamsCloudName = "Public";

const PUBLIC_MSTEAMS_SERVICE_HOST = "smba.trafficmanager.net";
const CHINA_BOT_FRAMEWORK_SERVICE_HOST = "botframework.azure.cn";

export type MSTeamsSdkCloudOptions = {
  cloud: MSTeamsCloudName;
  serviceUrl?: string;
};

type NormalizedServiceUrl = {
  value: string;
  host: string;
};

function normalizeOptionalServiceUrl(value: string | undefined): NormalizedServiceUrl | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return {
      value: parsed.toString().replace(/\/+$/, ""),
      host: parsed.hostname.toLowerCase(),
    };
  } catch {
    return null;
  }
}

export function resolveMSTeamsSdkCloudOptions(cfg?: MSTeamsConfig): MSTeamsSdkCloudOptions {
  const cloud = cfg?.cloud ?? DEFAULT_MSTEAMS_CLOUD;
  const serviceUrl = cfg?.serviceUrl?.trim();
  if (cloud !== "Public" && cloud !== "China" && !serviceUrl) {
    throw new Error(
      `channels.msteams.cloud=${cloud} requires channels.msteams.serviceUrl so SDK proactive operations use the matching Teams Bot Connector endpoint.`,
    );
  }
  return {
    cloud,
    ...(serviceUrl ? { serviceUrl } : {}),
  };
}

function isChinaBotFrameworkServiceHost(host: string): boolean {
  return (
    host === CHINA_BOT_FRAMEWORK_SERVICE_HOST ||
    host.endsWith(`.${CHINA_BOT_FRAMEWORK_SERVICE_HOST}`)
  );
}

function isChinaBotFrameworkServiceUrl(value: string): boolean {
  const parsed = normalizeOptionalServiceUrl(value);
  return Boolean(parsed && isChinaBotFrameworkServiceHost(parsed.host));
}

export function validateMSTeamsProactiveServiceUrlBoundary(params: {
  cloud: MSTeamsCloudName;
  conversationId: string;
  storedServiceUrl?: string;
  configuredServiceUrl?: string;
}) {
  const configured = normalizeOptionalServiceUrl(params.configuredServiceUrl);
  if (params.cloud !== "Public" && params.cloud !== "China" && !configured) {
    throw new Error(
      `msteams proactive send blocked for ${params.conversationId}: channels.msteams.cloud=${params.cloud} requires ` +
        "channels.msteams.serviceUrl so SDK proactive operations use the matching Teams Bot Connector endpoint.",
    );
  }

  if (params.cloud === "China" && configured && !isChinaBotFrameworkServiceHost(configured.host)) {
    throw new Error(
      `msteams proactive send blocked for ${params.conversationId}: configured Teams serviceUrl (${configured.value}) ` +
        "is not a Microsoft Teams China Bot Framework channel endpoint.",
    );
  }
  if (params.cloud !== "China" && configured && isChinaBotFrameworkServiceHost(configured.host)) {
    throw new Error(
      `msteams proactive send blocked for ${params.conversationId}: configured Teams serviceUrl (${configured.value}) ` +
        "requires channels.msteams.cloud=China.",
    );
  }

  if (configured) {
    const stored = normalizeOptionalServiceUrl(params.storedServiceUrl);
    if (!stored) {
      throw new Error(
        `msteams proactive send blocked for ${params.conversationId}: stored conversation reference is missing a valid serviceUrl. ` +
          "Ask the bot to receive a new Teams message in this conversation, then retry.",
      );
    }
    if (stored.host !== configured.host) {
      throw new Error(
        `msteams proactive send blocked for ${params.conversationId}: stored conversation serviceUrl (${stored.value}) ` +
          `does not match configured Teams SDK serviceUrl host (${configured.host}). ` +
          "Set channels.msteams.cloud/channels.msteams.serviceUrl for the Teams cloud that owns this conversation, or refresh the stored conversation by receiving a new message.",
      );
    }
    return;
  }

  const stored = normalizeOptionalServiceUrl(params.storedServiceUrl);
  if (!stored) {
    throw new Error(
      `msteams proactive send blocked for ${params.conversationId}: stored conversation reference is missing a valid serviceUrl. ` +
        "Ask the bot to receive a new Teams message in this conversation, then retry.",
    );
  }

  if (params.cloud === "China") {
    if (!isChinaBotFrameworkServiceHost(stored.host)) {
      throw new Error(
        `msteams proactive send blocked for ${params.conversationId}: stored conversation serviceUrl (${stored.value}) ` +
          "is not a Microsoft Teams China Bot Framework channel endpoint. " +
          "Use a conversation reference received from the China/21Vianet Teams cloud.",
      );
    }
    return;
  }

  if (isChinaBotFrameworkServiceUrl(stored.value)) {
    throw new Error(
      `msteams proactive send blocked for ${params.conversationId}: stored conversation serviceUrl (${stored.value}) ` +
        "requires channels.msteams.cloud=China.",
    );
  }

  if (stored.host !== PUBLIC_MSTEAMS_SERVICE_HOST) {
    throw new Error(
      `msteams proactive send blocked for ${params.conversationId}: stored conversation serviceUrl (${stored.value}) ` +
        "is not a Microsoft Teams public-cloud Bot Connector endpoint. " +
        "Set channels.msteams.cloud and channels.msteams.serviceUrl for the supported Teams cloud that owns this conversation.",
    );
  }
}
