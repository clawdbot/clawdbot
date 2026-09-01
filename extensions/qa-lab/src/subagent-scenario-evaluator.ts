import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

type EvidenceInputs = {
  requesterSessionKey: string;
  expectedChildLabel: string;
  sessionStore: unknown;
  tasksPayload: unknown;
};

function readPromptData(value: unknown): string {
  const text = normalizeOptionalString(value) ?? "";
  return /<prompt-data>\s*([\s\S]*?)\s*<\/prompt-data>/iu.exec(text)?.[1]?.trim() ?? text;
}

function normalizeChildResult(value: unknown): string {
  return normalizeLowercaseStringOrEmpty(
    readPromptData(value)
      .replace(/^child result(?:\s*\([^\r\n]*\))?\s*:\s*/iu, "")
      .replace(/^\s*(?:[-*]\s+|\d+[.)]\s+)/gmu, "")
      .replace(/^\s*```[^\r\n]*\r?\n|\r?\n\s*```\s*$/gu, "")
      .replace(/\s+/gu, " ")
      .trim(),
  );
}

function isAcceptedOnlyResult(value: unknown): boolean {
  try {
    const parsed: unknown = JSON.parse(readPromptData(value));
    return isRecord(parsed) && parsed.status === "accepted";
  } catch {
    return false;
  }
}

export function readOwnedChildren(
  params: Pick<EvidenceInputs, "expectedChildLabel" | "requesterSessionKey" | "sessionStore">,
) {
  return isRecord(params.sessionStore)
    ? Object.entries(params.sessionStore).filter(
        ([, entry]) =>
          isRecord(entry) &&
          entry.spawnedBy === params.requesterSessionKey &&
          entry.label === params.expectedChildLabel,
      )
    : [];
}

export function readMatchingTasks(params: EvidenceInputs, childSessionKey?: string) {
  return isRecord(params.tasksPayload) && Array.isArray(params.tasksPayload.tasks)
    ? params.tasksPayload.tasks.filter(
        (task) =>
          isRecord(task) &&
          task.requesterSessionKey === params.requesterSessionKey &&
          task.label === params.expectedChildLabel &&
          (!childSessionKey || task.childSessionKey === childSessionKey),
      )
    : [];
}

function readCompletedOwnedSubagent(params: EvidenceInputs) {
  const children = readOwnedChildren(params);
  const childEntry = children[0];
  if (children.length !== 1 || !childEntry) {
    return undefined;
  }
  const childSessionKey = childEntry[0];
  const tasks = readMatchingTasks(params, childSessionKey);
  const taskRecord = tasks[0];
  if (
    tasks.length !== 1 ||
    !isRecord(taskRecord) ||
    taskRecord.status !== "succeeded" ||
    taskRecord.deliveryStatus !== "delivered"
  ) {
    return undefined;
  }
  return {
    childSessionKey,
    taskInput: normalizeOptionalString(taskRecord.task),
  };
}

function readHandoffSections(value: unknown) {
  const text = normalizeOptionalString(value) ?? "";
  const matches = Array.from(
    text.matchAll(/(?:^|\n)\s*(delegated task|result|evidence)\s*:\s*/giu),
  );
  if (
    matches.map((match) => normalizeLowercaseStringOrEmpty(match[1])).join("|") !==
    "delegated task|result|evidence"
  ) {
    return undefined;
  }
  const sections = matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    return text.slice(start, matches[index + 1]?.index ?? text.length).trim();
  });
  const [delegated, result, evidence] = sections;
  return delegated && result && evidence ? { result, evidence } : undefined;
}

export function evaluateSubagentHandoffEvidence(
  params: EvidenceInputs & { childFinalText?: unknown; parentFinalText?: unknown },
) {
  const completed = readCompletedOwnedSubagent(params);
  const childResult = normalizeChildResult(params.childFinalText);
  const sections = readHandoffSections(params.parentFinalText);
  if (
    !completed ||
    !childResult ||
    isAcceptedOnlyResult(params.childFinalText) ||
    !sections ||
    !/\b(?:child|subagent|delegat(?:e|ed|ion))\b/iu.test(sections.evidence) ||
    !normalizeChildResult(sections.result).includes(childResult)
  ) {
    return undefined;
  }
  return true;
}

export function evaluateForkedSubagentEvidence(
  params: EvidenceInputs & { contextNeedle: string; childTranscripts: unknown },
) {
  const completed = readCompletedOwnedSubagent(params);
  // A nonce copied into the delegated task proves prompt injection, not inherited fork context.
  if (
    !completed?.taskInput ||
    completed.taskInput.includes(params.contextNeedle) ||
    !Array.isArray(params.childTranscripts)
  ) {
    return undefined;
  }
  const transcript = params.childTranscripts.find(
    (candidate) => isRecord(candidate) && candidate.sessionKey === completed.childSessionKey,
  );
  const finalText = isRecord(transcript)
    ? (normalizeOptionalString(transcript.finalText) ?? "")
    : "";
  return finalText.includes(params.contextNeedle) ? true : undefined;
}
