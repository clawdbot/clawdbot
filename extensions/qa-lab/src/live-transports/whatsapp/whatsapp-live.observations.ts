// QA Lab WhatsApp observed-message matching and diagnostics.
import type { WhatsAppQaDriverObservedMessage } from "@openclaw/whatsapp/api.js";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  WhatsAppObservedMessage,
  WhatsAppQaDriverQuotedMessageKey,
  WhatsAppQaMessageScenarioContext,
  WhatsAppQaMessageScenarioRun,
  WhatsAppQaObservedMessagesContext,
} from "./whatsapp-live.contracts.js";

export function messageMatches(message: WhatsAppObservedMessage, matchText: string | RegExp) {
  return typeof matchText === "string"
    ? message.text.includes(matchText)
    : matchText.test(message.text);
}

type WhatsAppReactionExpectation = { anyEmoji: true } | { emoji: string };

export function requireWhatsAppTriggerMessageId(
  context: Pick<WhatsAppQaMessageScenarioContext, "sent">,
): string {
  if (!context.sent.messageId) {
    throw new Error("WhatsApp driver did not return a triggering message id.");
  }
  return context.sent.messageId;
}

export function matchesWhatsAppSutReactionToTrigger(
  message: WhatsAppQaDriverObservedMessage,
  context: Pick<
    WhatsAppQaMessageScenarioContext,
    "sent" | "sutPhoneE164" | "target" | "targetKind"
  >,
  expectation: WhatsAppReactionExpectation,
) {
  const observedReaction = message.reaction;
  const fromExpectedSut = isWhatsAppScenarioSutMessage(message, {
    observedAfter: new Date(0),
    sutPhoneE164: context.sutPhoneE164,
    target: context.target,
    targetKind: context.targetKind,
  });
  if (
    typeof context.sent.messageId !== "string" ||
    message.kind !== "reaction" ||
    !fromExpectedSut ||
    !observedReaction ||
    observedReaction.messageId !== context.sent.messageId
  ) {
    return false;
  }
  if ("emoji" in expectation) {
    return observedReaction.emoji === expectation.emoji;
  }
  return Boolean(observedReaction.emoji);
}

export async function waitForWhatsAppSutReactionToTrigger(
  context: WhatsAppQaMessageScenarioContext,
  params: {
    expectation: WhatsAppReactionExpectation;
    observedAfter?: Date;
    timeoutMs?: number;
  },
) {
  requireWhatsAppTriggerMessageId(context);
  return await waitForScenarioObservedMessage(context, {
    observedAfter: params.observedAfter ?? context.requestStartedAt,
    timeoutMs: params.timeoutMs,
    match: (message) => matchesWhatsAppSutReactionToTrigger(message, context, params.expectation),
  });
}

export async function waitForWhatsAppSutReactionSequenceToTrigger(
  context: WhatsAppQaMessageScenarioContext,
  params: {
    emojis: readonly string[];
    observedAfter?: Date;
    timeoutMs?: number;
  },
) {
  requireWhatsAppTriggerMessageId(context);
  const observedAfter = params.observedAfter ?? context.requestStartedAt;
  const deadline = Date.now() + (params.timeoutMs ?? 30_000);
  const matched: WhatsAppQaDriverObservedMessage[] = [];
  let lastMatchedObservedAtMs = observedAfter.getTime();
  let lastMatchedObservedIndex = -1;

  const scan = () => {
    const messages = context.driver
      .getObservedMessages()
      .map((message, index) => ({ index, message }))
      .toSorted((left, right) => {
        const timeDelta =
          new Date(left.message.observedAt).getTime() -
          new Date(right.message.observedAt).getTime();
        return timeDelta === 0 ? left.index - right.index : timeDelta;
      });
    for (const { index, message } of messages) {
      if (matched.length >= params.emojis.length) {
        return true;
      }
      const observedAtMs = new Date(message.observedAt).getTime();
      if (
        observedAtMs < lastMatchedObservedAtMs ||
        (observedAtMs === lastMatchedObservedAtMs && index <= lastMatchedObservedIndex)
      ) {
        continue;
      }
      const expectedEmoji = params.emojis[matched.length];
      if (!expectedEmoji) {
        return false;
      }
      if (matchesWhatsAppSutReactionToTrigger(message, context, { emoji: expectedEmoji })) {
        matched.push(message);
        lastMatchedObservedAtMs = observedAtMs;
        lastMatchedObservedIndex = index;
      }
    }
    return matched.length >= params.emojis.length;
  };

  while (!scan()) {
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for WhatsApp status reaction sequence ${params.emojis.join(" -> ")}`,
      );
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  return matched;
}

export async function waitForScenarioObservedMessage(
  context: WhatsAppQaMessageScenarioContext,
  params: {
    diagnosticChecks?: Array<{
      label: string;
      match: (message: WhatsAppQaDriverObservedMessage) => boolean;
    }>;
    expectedSender?: (message: WhatsAppQaDriverObservedMessage) => boolean;
    match: (message: WhatsAppQaDriverObservedMessage) => boolean;
    observedAfter?: Date;
    timeoutMs?: number;
  },
) {
  let message: WhatsAppQaDriverObservedMessage;
  try {
    message = await context.driver.waitForMessage({
      observedAfter: params.observedAfter,
      timeoutMs: params.timeoutMs ?? 45_000,
      match: (candidate) =>
        (params.expectedSender?.(candidate) ??
          isWhatsAppScenarioSutMessage(candidate, {
            observedAfter: params.observedAfter ?? new Date(0),
            sutPhoneE164: context.sutPhoneE164,
            target: context.target,
            targetKind: context.targetKind,
          })) &&
        params.match(candidate),
    });
  } catch (error) {
    if (/\btimed out waiting for WhatsApp QA driver message\b/iu.test(formatErrorMessage(error))) {
      throw new Error(
        `${formatErrorMessage(error)}; ${formatWhatsAppScenarioWaitDiagnostics(context, {
          diagnosticChecks: params.diagnosticChecks,
          observedAfter: params.observedAfter,
        })}`,
        { cause: error },
      );
    }
    throw error;
  }
  context.recordObservedMessage(message);
  return message;
}

export function formatDiagnosticId(value: string | undefined | null) {
  return value ? `present(length=${value.length})` : "missing";
}

function formatWhatsAppMessageShape(message: WhatsAppQaDriverObservedMessage, index: number) {
  return [
    `#${index + 1}`,
    `observedAt=${message.observedAt}`,
    `fromPhone=${message.fromPhoneE164 ? "present" : "missing"}`,
    `kind=${message.kind}`,
    `textLength=${message.text.length}`,
    `messageId=${formatDiagnosticId(message.messageId)}`,
    `quoted=${message.quoted ? "present" : "missing"}`,
    `quotedMessageId=${formatDiagnosticId(message.quoted?.messageId)}`,
  ].join(" ");
}

export function formatWhatsAppScenarioWaitDiagnostics(
  context: WhatsAppQaObservedMessagesContext,
  params: {
    diagnosticChecks?: Array<{
      label: string;
      match: (message: WhatsAppQaDriverObservedMessage) => boolean;
    }>;
    observedAfter?: Date;
  },
) {
  const lowerBoundMs = params.observedAfter?.getTime();
  const messages = context.driver.getObservedMessages().filter((message) => {
    if (lowerBoundMs === undefined) {
      return true;
    }
    return new Date(message.observedAt).getTime() >= lowerBoundMs;
  });
  if (messages.length === 0) {
    return "observed 0 WhatsApp driver message(s) after wait lower bound";
  }
  const formatted = messages.slice(-5).map((message, index) => {
    const checks = (params.diagnosticChecks ?? []).map((check) => {
      try {
        const matched = check.match(message);
        return `${check.label}=${matched ? "yes" : "no"}`;
      } catch {
        return `${check.label}=no`;
      }
    });
    return [
      formatWhatsAppMessageShape(message, index),
      `fromExpectedSut=${
        isWhatsAppScenarioSutMessage(message, {
          observedAfter: params.observedAfter ?? new Date(0),
          sutPhoneE164: context.sutPhoneE164,
          target: context.target,
          targetKind: context.targetKind,
        })
          ? "yes"
          : "no"
      }`,
      ...checks,
    ].join(" ");
  });
  return `observed ${messages.length} WhatsApp driver message(s) after wait lower bound: ${formatted.join("; ")}`;
}

function hasWhatsAppBatchExpectations(run: WhatsAppQaMessageScenarioRun) {
  return (
    run.expectedSutMessageCount !== undefined ||
    run.expectedSutMessageCountRange !== undefined ||
    (run.expectedJoinedSutTextIncludes?.length ?? 0) > 0
  );
}

export function isWhatsAppScenarioSutMessage(
  message: WhatsAppQaDriverObservedMessage,
  params: {
    observedAfter: Date;
    sutPhoneE164: string;
    target: string;
    targetKind: "dm" | "group";
  },
) {
  if (new Date(message.observedAt).getTime() < params.observedAfter.getTime()) {
    return false;
  }
  if (params.targetKind === "group") {
    return message.fromJid === params.target && message.fromPhoneE164 === params.sutPhoneE164;
  }
  return message.fromPhoneE164 === params.sutPhoneE164;
}

export function assertWhatsAppMessageFromSutPhone(
  message: WhatsAppQaDriverObservedMessage,
  context: Pick<WhatsAppQaMessageScenarioContext, "sutPhoneE164">,
) {
  if (message.fromPhoneE164 === context.sutPhoneE164) {
    return;
  }
  throw new Error(
    `expected WhatsApp group reply from configured SUT phone; ${formatWhatsAppMessageShape(message, 0)}`,
  );
}

export function assertWhatsAppMessagesFromSutPhone(
  messages: readonly WhatsAppQaDriverObservedMessage[],
  context: Pick<WhatsAppQaMessageScenarioContext, "sutPhoneE164">,
) {
  for (const message of messages) {
    assertWhatsAppMessageFromSutPhone(message, context);
  }
}

export async function assertWhatsAppScenarioMessageBatch(params: {
  alreadyRecordedMessageIds: Set<string>;
  context: WhatsAppQaMessageScenarioContext;
  observedAfter: Date;
  run: WhatsAppQaMessageScenarioRun;
}) {
  if (!hasWhatsAppBatchExpectations(params.run)) {
    return undefined;
  }
  await new Promise((resolve) => {
    setTimeout(resolve, params.run.settleMs ?? 4_000);
  });
  const messages = params.context.driver.getObservedMessages().filter((message) =>
    isWhatsAppScenarioSutMessage(message, {
      observedAfter: params.observedAfter,
      sutPhoneE164: params.context.sutPhoneE164,
      target: params.context.target,
      targetKind: params.run.target,
    }),
  );
  const uniqueMessages = dedupeWhatsAppMessagesById(messages);
  if (
    params.run.expectedSutMessageCount !== undefined &&
    uniqueMessages.length !== params.run.expectedSutMessageCount
  ) {
    throw new Error(
      `expected ${params.run.expectedSutMessageCount} SUT message(s), observed ${
        uniqueMessages.length
      }: ${formatWhatsAppBatchMessageDiagnostics(uniqueMessages)}`,
    );
  }
  if (params.run.expectedSutMessageCountRange !== undefined) {
    const [min, max] = params.run.expectedSutMessageCountRange;
    if (uniqueMessages.length < min || uniqueMessages.length > max) {
      throw new Error(
        `expected ${min}-${max} SUT message(s), observed ${
          uniqueMessages.length
        }: ${formatWhatsAppBatchMessageDiagnostics(uniqueMessages)}`,
      );
    }
  }
  const joinedText = uniqueMessages.map((message) => message.text).join("\n");
  for (const expected of params.run.expectedJoinedSutTextIncludes ?? []) {
    if (!joinedText.includes(expected)) {
      throw new Error(`expected joined WhatsApp SUT text to include ${expected}`);
    }
  }
  for (const message of uniqueMessages) {
    if (!message.messageId || params.alreadyRecordedMessageIds.has(message.messageId)) {
      continue;
    }
    params.context.recordObservedMessage(message);
    params.alreadyRecordedMessageIds.add(message.messageId);
  }
  return `observed ${uniqueMessages.length} SUT message(s) after settle`;
}

export function formatWhatsAppBatchMessageDiagnostics(messages: WhatsAppQaDriverObservedMessage[]) {
  if (messages.length === 0) {
    return "no matching SUT message shapes observed";
  }
  return messages.slice(-5).map(formatWhatsAppMessageShape).join("; ");
}

export function dedupeWhatsAppMessagesById(messages: WhatsAppQaDriverObservedMessage[]) {
  const seen = new Set<string>();
  const unique: WhatsAppQaDriverObservedMessage[] = [];
  for (const message of messages) {
    const messageId = message.messageId?.trim();
    if (messageId) {
      if (seen.has(messageId)) {
        continue;
      }
      seen.add(messageId);
    }
    unique.push(message);
  }
  return unique;
}

export function buildWhatsAppQuotedMessageKeyFromObservedMessage(
  message: WhatsAppQaDriverObservedMessage,
  params: { remoteJid: string },
): WhatsAppQaDriverQuotedMessageKey {
  if (!message.messageId) {
    throw new Error("WhatsApp observed message did not include a message id for quoting.");
  }
  return {
    fromMe: false,
    id: message.messageId,
    messageText: message.text,
    ...(message.participantJid ? { participant: message.participantJid } : {}),
    remoteJid: params.remoteJid,
  };
}
