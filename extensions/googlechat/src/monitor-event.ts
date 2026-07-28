// Googlechat plugin module parses standard and Workspace Add-on webhook envelopes.
import type {
  GoogleChatAction,
  GoogleChatActionParameter,
  GoogleChatEvent,
  GoogleChatMessage,
  GoogleChatSpace,
  GoogleChatUser,
} from "./types.js";

export class GoogleChatEventPayloadError extends Error {
  constructor(message = "invalid payload") {
    super(message);
    this.name = "GoogleChatEventPayloadError";
  }
}

type ParsedGoogleChatInboundPayload = {
  event: GoogleChatEvent;
  addOnBearerToken: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordParamsToActionParameters(
  params?: Record<string, string>,
): GoogleChatActionParameter[] | undefined {
  if (!params) {
    return undefined;
  }
  const entries = Object.entries(params)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => ({ key, value }));
  return entries.length > 0 ? entries : undefined;
}

/** Normalize only at authenticated dispatch; durable admission stores the untouched envelope. */
export function parseGoogleChatInboundPayload(raw: unknown): ParsedGoogleChatInboundPayload {
  if (!isRecord(raw)) {
    throw new GoogleChatEventPayloadError();
  }

  let eventPayload: Record<string, unknown> = raw;
  let addOnBearerToken = "";
  const rawObj = raw as {
    commonEventObject?: {
      hostApp?: string;
      invokedFunction?: string;
      parameters?: Record<string, string>;
    };
    chat?: {
      messagePayload?: { space?: GoogleChatSpace; message?: GoogleChatMessage };
      buttonClickedPayload?: {
        space?: GoogleChatSpace;
        message?: GoogleChatMessage;
        user?: GoogleChatUser;
        action?: GoogleChatAction;
      };
      user?: GoogleChatUser;
      eventTime?: string;
    };
    authorizationEventObject?: { systemIdToken?: string };
  };

  if (rawObj.commonEventObject?.hostApp === "CHAT") {
    addOnBearerToken =
      typeof rawObj.authorizationEventObject?.systemIdToken === "string"
        ? rawObj.authorizationEventObject.systemIdToken.trim()
        : "";
  }

  const chat = rawObj.chat;
  const messagePayload = chat?.messagePayload;
  if (rawObj.commonEventObject?.hostApp === "CHAT" && chat && messagePayload) {
    eventPayload = {
      type: "MESSAGE",
      space: messagePayload.space,
      message: messagePayload.message,
      user: chat.user,
      eventTime: chat.eventTime,
    };
  } else if (rawObj.commonEventObject?.hostApp === "CHAT") {
    const chatPayload = rawObj.chat;
    const buttonClickedPayload = chatPayload?.buttonClickedPayload;
    if (buttonClickedPayload) {
      const invokedFunction = rawObj.commonEventObject.invokedFunction;
      const actionParameters = recordParamsToActionParameters(rawObj.commonEventObject.parameters);
      eventPayload = {
        type: "CARD_CLICKED",
        space: buttonClickedPayload.space,
        message: buttonClickedPayload.message,
        user: buttonClickedPayload.user ?? chatPayload?.user,
        eventTime: chatPayload?.eventTime,
        action:
          buttonClickedPayload.action ??
          ({
            ...(typeof invokedFunction === "string" ? { actionMethodName: invokedFunction } : {}),
            ...(actionParameters ? { parameters: actionParameters } : {}),
          } satisfies GoogleChatAction),
        commonEventObject: {
          ...(typeof invokedFunction === "string" ? { invokedFunction } : {}),
          parameters: rawObj.commonEventObject.parameters,
        },
      };
    }
  }

  const event = eventPayload as GoogleChatEvent;
  const eventType = event.type ?? event.eventType;
  if (typeof eventType !== "string" || !isRecord(event.space)) {
    throw new GoogleChatEventPayloadError();
  }
  if (eventType === "MESSAGE") {
    if (!isRecord(event.message) || !event.space?.name?.trim() || !event.message?.name?.trim()) {
      throw new GoogleChatEventPayloadError();
    }
  } else if (eventType === "CARD_CLICKED" && !isRecord(event.user)) {
    throw new GoogleChatEventPayloadError();
  }

  return { event, addOnBearerToken };
}
