// QA Lab WhatsApp driver lifecycle and no-reply waits.
import {
  startWhatsAppQaDriverSession,
  type WhatsAppQaDriverObservedMessage,
  type WhatsAppQaDriverSession,
} from "@openclaw/whatsapp/api.js";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { WhatsAppQaMessageScenarioContext } from "./whatsapp-live.contracts.js";
import {
  isWhatsAppScenarioSutMessage,
  waitForScenarioObservedMessage,
} from "./whatsapp-live.observations.js";

export const WHATSAPP_QA_TRANSIENT_DRIVER_ATTEMPTS = 5;
export const WHATSAPP_QA_DRIVER_RECONNECT_DELAY_MS = 10_000;

type WhatsAppQaNoReplyTarget =
  | {
      target: "dm";
    }
  | {
      groupJid: string;
      target: "group";
    };

export function resolveWhatsAppQaNoReplyTarget(params: {
  groupJid?: string;
  target: "dm" | "group";
}): WhatsAppQaNoReplyTarget {
  if (params.target === "dm") {
    return { target: "dm" };
  }
  if (!params.groupJid) {
    throw new Error("WhatsApp group no-reply assertion requires groupJid.");
  }
  return {
    groupJid: params.groupJid,
    target: "group",
  };
}

export async function waitForNoWhatsAppReply(
  params: {
    allowQuietWindowMessage?: (message: WhatsAppQaDriverObservedMessage) => boolean;
    driver: Pick<WhatsAppQaDriverSession, "getObservedMessages">;
    observedAfter: Date;
    sutPhoneE164: string;
    windowMs: number;
  } & WhatsAppQaNoReplyTarget,
) {
  await new Promise((resolve) => {
    setTimeout(resolve, params.windowMs);
  });
  const noReplyTarget =
    params.target === "group"
      ? ({
          groupJid: params.groupJid,
          target: "group",
        } satisfies WhatsAppQaNoReplyTarget)
      : ({
          target: "dm",
        } satisfies WhatsAppQaNoReplyTarget);
  const unexpectedReply = findUnexpectedWhatsAppNoReplyMessage({
    allowQuietWindowMessage: params.allowQuietWindowMessage,
    messages: params.driver.getObservedMessages(),
    observedAfter: params.observedAfter,
    sutPhoneE164: params.sutPhoneE164,
    ...noReplyTarget,
  });
  if (unexpectedReply) {
    throw new Error("unexpected WhatsApp reply observed in quiet scenario");
  }
}

export async function waitForDistinctWhatsAppSutMessages(
  context: WhatsAppQaMessageScenarioContext,
  params: {
    initialMessages?: WhatsAppQaDriverObservedMessage[];
    matchers: Array<(message: WhatsAppQaDriverObservedMessage) => boolean>;
    observedAfter: Date;
    timeoutMs?: number;
  },
) {
  const matched = new Map<number, WhatsAppQaDriverObservedMessage>();
  const usedMessageKeys = new Set<string>();
  const messageKey = (message: WhatsAppQaDriverObservedMessage) =>
    message.messageId ?? `${message.observedAt}:${message.text}`;
  const consider = (message: WhatsAppQaDriverObservedMessage) => {
    if (
      !isWhatsAppScenarioSutMessage(message, {
        observedAfter: params.observedAfter,
        sutPhoneE164: context.sutPhoneE164,
        target: context.target,
        targetKind: "group",
      })
    ) {
      return false;
    }
    const key = messageKey(message);
    if (usedMessageKeys.has(key)) {
      return false;
    }
    for (const [index, matcher] of params.matchers.entries()) {
      if (!matched.has(index) && matcher(message)) {
        matched.set(index, message);
        usedMessageKeys.add(key);
        return true;
      }
    }
    return false;
  };

  for (const message of [
    ...(params.initialMessages ?? []),
    ...context.driver.getObservedMessages(),
  ]) {
    consider(message);
  }

  while (matched.size < params.matchers.length) {
    const next = await waitForWhatsAppScenarioSutMessage(context, {
      observedAfter: params.observedAfter,
      timeoutMs: params.timeoutMs,
      targetKind: "group",
      match: (message) => {
        const key = messageKey(message);
        return (
          !usedMessageKeys.has(key) &&
          params.matchers.some((matcher, index) => !matched.has(index) && matcher(message))
        );
      },
    });
    consider(next);
  }

  return [...matched.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([, message]) => message);
}

export async function waitForWhatsAppScenarioSutMessage(
  context: WhatsAppQaMessageScenarioContext,
  params: {
    diagnosticChecks?: Array<{
      label: string;
      match: (message: WhatsAppQaDriverObservedMessage) => boolean;
    }>;
    match: (message: WhatsAppQaDriverObservedMessage) => boolean;
    observedAfter: Date;
    targetKind: "dm" | "group";
    timeoutMs?: number;
  },
) {
  return await waitForScenarioObservedMessage(context, {
    diagnosticChecks: params.diagnosticChecks,
    observedAfter: params.observedAfter,
    timeoutMs: params.timeoutMs,
    expectedSender: (message) =>
      isWhatsAppScenarioSutMessage(message, {
        observedAfter: params.observedAfter,
        sutPhoneE164: context.sutPhoneE164,
        target: context.target,
        targetKind: params.targetKind,
      }),
    match: params.match,
  });
}

export function findUnexpectedWhatsAppNoReplyMessage(
  params: {
    allowQuietWindowMessage?: (message: WhatsAppQaDriverObservedMessage) => boolean;
    messages: WhatsAppQaDriverObservedMessage[];
    observedAfter: Date;
    sutPhoneE164: string;
  } & WhatsAppQaNoReplyTarget,
): WhatsAppQaDriverObservedMessage | undefined {
  const observedAfterMs = params.observedAfter.getTime();
  return params.messages.find((message) => {
    if (new Date(message.observedAt).getTime() <= observedAfterMs) {
      return false;
    }
    const fromExpectedSut = isWhatsAppScenarioSutMessage(message, {
      observedAfter: params.observedAfter,
      sutPhoneE164: params.sutPhoneE164,
      target: params.target === "group" ? params.groupJid : "",
      targetKind: params.target,
    });
    const missingGroupSender =
      params.target === "group" && message.fromJid === params.groupJid && !message.fromPhoneE164;
    if (!fromExpectedSut && !missingGroupSender) {
      return false;
    }
    return !(params.allowQuietWindowMessage?.(message) ?? false);
  });
}

export function isTransientWhatsAppQaDriverError(error: unknown) {
  const message = formatErrorMessage(error);
  return (
    /\bConnection Closed\b/iu.test(message) ||
    /\bconflict\b/iu.test(message) ||
    /\bpending notifications\b/iu.test(message) ||
    /\bsession conflict\b/iu.test(message)
  );
}

export async function restartWhatsAppQaDriverSession(params: {
  authDir: string;
  current: WhatsAppQaDriverSession;
}) {
  await params.current.close().catch(() => {});
  return await startWhatsAppQaDriverSessionWithRetry({ authDir: params.authDir });
}

export async function startWhatsAppQaDriverSessionWithRetry(params: { authDir: string }) {
  for (const attempt of Array.from(
    { length: WHATSAPP_QA_TRANSIENT_DRIVER_ATTEMPTS },
    (_, index) => index + 1,
  )) {
    try {
      return await startWhatsAppQaDriverSession({
        authDir: params.authDir,
        waitForPendingNotifications: true,
      });
    } catch (error) {
      if (
        attempt >= WHATSAPP_QA_TRANSIENT_DRIVER_ATTEMPTS ||
        !isTransientWhatsAppQaDriverError(error)
      ) {
        throw error;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, WHATSAPP_QA_DRIVER_RECONNECT_DELAY_MS);
      });
    }
  }
  throw new Error("unreachable WhatsApp QA driver retry loop exit");
}
