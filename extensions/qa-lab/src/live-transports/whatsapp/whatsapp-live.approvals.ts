// QA Lab WhatsApp native approval scenarios.
import { randomUUID } from "node:crypto";
import type {
  WhatsAppQaDriverObservedMessage,
  WhatsAppQaDriverSession,
} from "@openclaw/whatsapp/api.js";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  assertApprovalDecisionResult,
  formatApprovalResultValue,
  readAcceptedApprovalRequestId,
} from "../shared/live-approval-result.js";
import type {
  WhatsAppObservedMessage,
  WhatsAppQaApprovalDecision,
  WhatsAppQaApprovalKind,
  WhatsAppQaApprovalScenarioRun,
  WhatsAppQaGateway,
  WhatsAppQaScenarioDefinition,
} from "./whatsapp-live.contracts.js";
import { formatDiagnosticId } from "./whatsapp-live.operations.js";

const WHATSAPP_QA_APPROVAL_DECISION_TIMEOUT_MS = 60_000;

async function requestWhatsAppApproval(params: {
  approvalId: string;
  gateway: WhatsAppQaGateway;
  turnSourceTo: string;
  run: WhatsAppQaApprovalScenarioRun;
  sutAccountId: string;
}) {
  const commonParams = {
    timeoutMs: WHATSAPP_QA_APPROVAL_DECISION_TIMEOUT_MS,
    turnSourceAccountId: params.sutAccountId,
    turnSourceChannel: "whatsapp",
    turnSourceTo: params.turnSourceTo,
    twoPhase: true,
  };
  if (params.run.approvalKind === "exec") {
    const result = await params.gateway.call(
      "exec.approval.request",
      {
        ...commonParams,
        ask: "always",
        command: `printf '%s\\n' '${params.run.token}'`,
        host: "gateway",
        id: params.approvalId,
        security: "full",
      },
      {
        expectFinal: false,
        timeoutMs: WHATSAPP_QA_APPROVAL_DECISION_TIMEOUT_MS + 5_000,
      },
    );
    const acceptedId = readAcceptedApprovalRequestId(result);
    if (acceptedId !== params.approvalId) {
      throw new Error(
        `accepted exec approval id was ${formatApprovalResultValue(
          acceptedId,
        )} instead of ${params.approvalId}`,
      );
    }
    return acceptedId;
  }
  const result = await params.gateway.call(
    "plugin.approval.request",
    {
      ...commonParams,
      agentId: "qa",
      description: `WhatsApp plugin approval QA request ${params.run.token}`,
      pluginId: "qa-whatsapp-plugin",
      severity: "warning",
      title: `WhatsApp plugin approval QA ${params.run.token}`,
      toolName: "whatsapp_qa_tool",
    },
    {
      expectFinal: false,
      timeoutMs: WHATSAPP_QA_APPROVAL_DECISION_TIMEOUT_MS + 5_000,
    },
  );
  return readAcceptedApprovalRequestId(result);
}

async function waitForApprovalDecision(params: {
  approvalId: string;
  gateway: WhatsAppQaGateway;
  kind: WhatsAppQaApprovalKind;
}) {
  const method =
    params.kind === "exec" ? "exec.approval.waitDecision" : "plugin.approval.waitDecision";
  return await params.gateway.call(
    method,
    { id: params.approvalId },
    {
      expectFinal: true,
      timeoutMs: WHATSAPP_QA_APPROVAL_DECISION_TIMEOUT_MS + 5_000,
    },
  );
}

async function resolveApprovalDecision(params: {
  approvalId: string;
  decision: WhatsAppQaApprovalDecision;
  gateway: WhatsAppQaGateway;
  kind: WhatsAppQaApprovalKind;
}) {
  const method = params.kind === "exec" ? "exec.approval.resolve" : "plugin.approval.resolve";
  return await params.gateway.call(
    method,
    { decision: params.decision, id: params.approvalId },
    {
      expectFinal: false,
      timeoutMs: WHATSAPP_QA_APPROVAL_DECISION_TIMEOUT_MS + 5_000,
    },
  );
}

function matchesWhatsAppApprovalPendingText(params: {
  approvalId: string;
  approvalKind: WhatsAppQaApprovalKind;
  text: string;
  token: string;
}) {
  const heading =
    params.approvalKind === "exec" ? "Exec approval required" : "Plugin approval required";
  return (
    params.text.includes(heading) &&
    params.text.includes(params.approvalId) &&
    params.text.includes(params.token) &&
    params.text.includes("React with:") &&
    params.text.includes("👍")
  );
}

function matchesWhatsAppApprovalResolvedText(params: {
  approvalId: string;
  approvalKind: WhatsAppQaApprovalKind;
  decision?: WhatsAppQaApprovalDecision;
  text: string;
}) {
  const decision = params.decision ?? "allow-once";
  const decisionText =
    params.approvalKind === "exec"
      ? decision
      : decision === "allow-once"
        ? "allowed once"
        : "denied";
  const heading =
    params.approvalKind === "exec"
      ? `Exec approval ${decisionText}`
      : `Plugin approval ${decisionText}`;
  return params.text.includes(params.approvalId) && params.text.includes(heading);
}

function formatWhatsAppApprovalWaitDiagnostics(params: {
  approvalId: string;
  approvalKind: WhatsAppQaApprovalKind;
  decision?: WhatsAppQaApprovalDecision;
  driver: WhatsAppQaDriverSession;
  observedAfter?: Date;
  state: "pending" | "resolved";
  sutPhoneE164: string;
  token: string;
}) {
  const lowerBoundMs = params.observedAfter?.getTime();
  const messages = params.driver.getObservedMessages().filter((message) => {
    if (lowerBoundMs === undefined) {
      return true;
    }
    return new Date(message.observedAt).getTime() >= lowerBoundMs;
  });
  if (messages.length === 0) {
    return `observed 0 WhatsApp driver message(s) after ${params.state} approval wait lower bound`;
  }
  const formatted = messages.slice(-5).map((message, index) => {
    const fromExpectedSender =
      !message.fromPhoneE164 || message.fromPhoneE164 === params.sutPhoneE164;
    const approvalTextMatches =
      params.state === "pending"
        ? matchesWhatsAppApprovalPendingText({
            approvalId: params.approvalId,
            approvalKind: params.approvalKind,
            text: message.text,
            token: params.token,
          })
        : matchesWhatsAppApprovalResolvedText({
            approvalId: params.approvalId,
            approvalKind: params.approvalKind,
            decision: params.decision,
            text: message.text,
          });
    return [
      `#${index + 1}`,
      `observedAt=${message.observedAt}`,
      `fromExpectedSut=${fromExpectedSender ? "yes" : "no"}`,
      `fromPhone=${message.fromPhoneE164 ? "present" : "missing"}`,
      `kind=${message.kind}`,
      `textLength=${message.text.length}`,
      `approvalText=${approvalTextMatches ? "yes" : "no"}`,
      `messageId=${formatDiagnosticId(message.messageId)}`,
    ].join(" ");
  });
  return `observed ${messages.length} WhatsApp driver message(s) after ${params.state} approval wait lower bound: ${formatted.join("; ")}`;
}

async function waitForWhatsAppApprovalMessage(params: {
  approvalId: string;
  approvalKind: WhatsAppQaApprovalKind;
  decision?: WhatsAppQaApprovalDecision;
  driver: WhatsAppQaDriverSession;
  observedAfter?: Date;
  observedMessages: WhatsAppObservedMessage[];
  scenario: WhatsAppQaScenarioDefinition;
  state: "pending" | "resolved";
  sutPhoneE164: string;
  timeoutMs: number;
  token: string;
}) {
  let reply: WhatsAppQaDriverObservedMessage;
  try {
    reply = await params.driver.waitForMessage({
      observedAfter: params.observedAfter,
      timeoutMs: params.timeoutMs,
      match: (message) => {
        const fromExpectedSender =
          !message.fromPhoneE164 || message.fromPhoneE164 === params.sutPhoneE164;
        return (
          fromExpectedSender &&
          (params.state === "pending"
            ? matchesWhatsAppApprovalPendingText({
                approvalId: params.approvalId,
                approvalKind: params.approvalKind,
                text: message.text,
                token: params.token,
              })
            : matchesWhatsAppApprovalResolvedText({
                approvalId: params.approvalId,
                approvalKind: params.approvalKind,
                decision: params.decision,
                text: message.text,
              }))
        );
      },
    });
  } catch (error) {
    if (/\btimed out waiting for WhatsApp QA driver message\b/iu.test(formatErrorMessage(error))) {
      throw new Error(
        `${formatErrorMessage(error)}; ${formatWhatsAppApprovalWaitDiagnostics(params)}`,
        { cause: error },
      );
    }
    throw error;
  }
  const observed: WhatsAppObservedMessage = {
    ...reply,
    approvalState: params.state,
    matchedScenario: true,
    scenarioId: params.scenario.id,
    scenarioTitle: params.scenario.title,
  };
  params.observedMessages.push(observed);
  return observed;
}

export async function runWhatsAppApprovalScenario(params: {
  driver: WhatsAppQaDriverSession;
  gateway: WhatsAppQaGateway;
  observedMessages: WhatsAppObservedMessage[];
  run: WhatsAppQaApprovalScenarioRun;
  scenario: WhatsAppQaScenarioDefinition;
  sutAccountId: string;
  sutPhoneE164: string;
  turnSourceTo: string;
}) {
  const requestStartedAt = new Date();
  const requestedApprovalId =
    params.run.approvalKind === "exec"
      ? `whatsapp-qa-exec-${randomUUID()}`
      : `whatsapp-qa-plugin-${randomUUID()}`;
  const approvalId = await requestWhatsAppApproval({
    approvalId: requestedApprovalId,
    gateway: params.gateway,
    turnSourceTo: params.turnSourceTo,
    run: params.run,
    sutAccountId: params.sutAccountId,
  });
  const pending = await waitForWhatsAppApprovalMessage({
    approvalId,
    approvalKind: params.run.approvalKind,
    decision: params.run.decision,
    driver: params.driver,
    observedAfter: requestStartedAt,
    observedMessages: params.observedMessages,
    scenario: params.scenario,
    state: "pending",
    sutPhoneE164: params.sutPhoneE164,
    timeoutMs: params.scenario.timeoutMs,
    token: params.run.token,
  });
  const resolvedPromise = waitForWhatsAppApprovalMessage({
    approvalId,
    approvalKind: params.run.approvalKind,
    decision: params.run.decision,
    driver: params.driver,
    observedAfter: requestStartedAt,
    observedMessages: params.observedMessages,
    scenario: params.scenario,
    state: "resolved",
    sutPhoneE164: params.sutPhoneE164,
    timeoutMs: params.scenario.timeoutMs,
    token: params.run.token,
  });
  try {
    if (params.run.decisionMode === "reaction") {
      if (!pending.fromJid || !pending.messageId) {
        throw new Error("WhatsApp approval prompt did not expose message coordinates.");
      }
      await params.driver.sendReaction(pending.fromJid, pending.messageId, "👍", {
        fromMe: false,
        participant: pending.participantJid,
      });
    } else {
      await resolveApprovalDecision({
        approvalId,
        decision: params.run.decision,
        gateway: params.gateway,
        kind: params.run.approvalKind,
      });
    }
    assertApprovalDecisionResult({
      decision: params.run.decision,
      result: await waitForApprovalDecision({
        approvalId,
        gateway: params.gateway,
        kind: params.run.approvalKind,
      }),
    });
  } catch (error) {
    resolvedPromise.catch(() => {});
    throw error;
  }
  const resolved = await resolvedPromise;
  const responseObservedAt = new Date(resolved.observedAt);
  return {
    approvalId,
    requestStartedAt,
    responseObservedAt,
    rttMs: responseObservedAt.getTime() - requestStartedAt.getTime(),
  };
}
