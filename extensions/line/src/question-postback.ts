// Line plugin module owns the postback encoding for ask_user question controls.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const QUESTION_ID_PARAM = "line.question";
const OPTION_INDEX_PARAM = "line.option";
// LINE rejects a postback whose data exceeds 300 bytes, and it is the only place a
// question reference can ride back, so an oversized reference renders no button.
const POSTBACK_DATA_MAX_BYTES = 300;

export type LineQuestionPostback = { questionId: string; optionIndex: number };

function withinPostbackLimit(data: string): string | undefined {
  return Buffer.byteLength(data, "utf8") <= POSTBACK_DATA_MAX_BYTES ? data : undefined;
}

/** Encodes one ask_user choice into LINE postback data, or nothing when it cannot fit. */
export function buildLineQuestionPostbackData(callback: LineQuestionPostback): string | undefined {
  const questionId = normalizeOptionalString(callback.questionId);
  if (!questionId) {
    return undefined;
  }
  const params = new URLSearchParams({ [QUESTION_ID_PARAM]: questionId });
  if (!Number.isInteger(callback.optionIndex) || callback.optionIndex < 0) {
    return undefined;
  }
  params.set(OPTION_INDEX_PARAM, String(callback.optionIndex));
  return withinPostbackLimit(params.toString());
}

/** Reads a question choice back out of inbound postback data, if it carries one. */
export function parseLineQuestionPostbackData(data: string): LineQuestionPostback | undefined {
  if (!data.includes(QUESTION_ID_PARAM)) {
    return undefined;
  }
  const params = new URLSearchParams(data);
  const questionId = normalizeOptionalString(params.get(QUESTION_ID_PARAM));
  if (!questionId) {
    return undefined;
  }
  const rawIndex = normalizeOptionalString(params.get(OPTION_INDEX_PARAM));
  if (!rawIndex || !/^\d+$/.test(rawIndex)) {
    return undefined;
  }
  return { questionId, optionIndex: Number(rawIndex) };
}

/**
 * Submit an ask_user choice a LINE tap carried, and report only what the user needs.
 *
 * A successful answer needs no acknowledgement: the agent's own next reply is the
 * feedback, and LINE already echoes the chosen label through the action's
 * `displayText`. Only an answer that cannot land says so.
 */
export async function resolveLineQuestionPostback(params: {
  cfg: OpenClawConfig;
  callback: LineQuestionPostback;
  senderId?: string;
  accountId: string;
}): Promise<{ status: "answered" | "already-terminal" | "failed" }> {
  try {
    const result = await questionGatewayRuntime.resolveOption({
      cfg: params.cfg,
      questionId: params.callback.questionId,
      senderId: params.senderId,
      clientDisplayName: `LINE question (${params.accountId})`,
      optionIndex: params.callback.optionIndex,
    });
    if (result.status === "answered" || result.status === "already-terminal") {
      return { status: result.status };
    }
    // The resolver reports custom-input only to a request that asked for one, and
    // this path submits an option index, so anything else could not be recorded.
    return { status: "failed" };
  } catch {
    // The tap is the user's only signal that anything happened; a swallowed failure
    // would leave the question looking answered while the agent still waits.
    return { status: "failed" };
  }
}
