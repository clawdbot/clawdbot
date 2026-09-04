import type { GatewayQuestionCall } from "./gateway-question-lifecycle.js";

export const ASK_USER_RPC_GRACE_MS = 10_000;

async function readAskUserQuestionStatus(
  questionId: string,
  gatewayCall: GatewayQuestionCall,
): Promise<string | undefined> {
  const result = await gatewayCall("question.list", { timeoutMs: ASK_USER_RPC_GRACE_MS }, {});
  const questions =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as { questions?: unknown }).questions
      : undefined;
  const question = Array.isArray(questions)
    ? questions.find(
        (candidate) =>
          candidate &&
          typeof candidate === "object" &&
          !Array.isArray(candidate) &&
          (candidate as { id?: unknown }).id === questionId,
      )
    : undefined;
  const status =
    question && typeof question === "object" && !Array.isArray(question)
      ? (question as { status?: unknown }).status
      : undefined;
  return typeof status === "string" ? status : undefined;
}

export type AskUserPromptStatusRead =
  | { kind: "status"; status: string | undefined }
  | { kind: "error" }
  | { kind: "expired" };

export async function readAskUserQuestionStatusBeforeExpiry(
  questionId: string,
  expiresAtMs: number,
  gatewayCall: GatewayQuestionCall,
): Promise<AskUserPromptStatusRead> {
  const remainingMs = expiresAtMs - Date.now();
  if (remainingMs <= 0) {
    return { kind: "expired" };
  }
  return await new Promise<AskUserPromptStatusRead>((resolve) => {
    let settled = false;
    const finish = (result: AskUserPromptStatusRead) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(expiryTimer);
      resolve(result);
    };
    const expiryTimer = setTimeout(() => finish({ kind: "expired" }), remainingMs);
    expiryTimer.unref?.();
    void readAskUserQuestionStatus(questionId, gatewayCall).then(
      (status) => finish({ kind: "status", status }),
      () => finish({ kind: "error" }),
    );
  });
}
