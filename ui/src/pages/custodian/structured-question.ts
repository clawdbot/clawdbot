import type { SystemAgentChatQuestion } from "@openclaw/gateway-protocol";

export type CustodianStructuredQuestion = {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description?: string; recommended?: boolean; reply?: string }>;
  isOther: boolean;
  skipAction?: "exit";
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Sanitize the typed `question` field from `openclaw.chat`. The gateway owns
 * the schema, but this state renders buttons that send messages, so the page
 * still enforces the card contract locally: 2-4 unique options, at most one
 * recommended. Anything else degrades to the prose reply.
 */
export function parseCustodianQuestion(
  value: SystemAgentChatQuestion | undefined,
): CustodianStructuredQuestion | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const id = nonEmptyString(value.id);
  const header = nonEmptyString(value.header);
  const question = nonEmptyString(value.question);
  if (!id || !header || !question || !Array.isArray(value.options)) {
    return null;
  }
  if (value.options.length < 2 || value.options.length > 4) {
    return null;
  }
  const options: CustodianStructuredQuestion["options"] = [];
  for (const option of value.options) {
    const label = nonEmptyString(option?.label);
    if (!label) {
      return null;
    }
    const description = nonEmptyString(option.description ?? null);
    const reply = nonEmptyString(option.reply ?? null);
    options.push({
      label,
      ...(description ? { description } : {}),
      ...(option.recommended === true ? { recommended: true } : {}),
      ...(reply ? { reply } : {}),
    });
  }
  if (new Set(options.map((option) => option.label.toLocaleLowerCase())).size !== options.length) {
    return null;
  }
  if (options.filter((option) => option.recommended).length > 1) {
    return null;
  }
  return {
    id,
    header,
    question,
    options,
    isOther: value.isOther === true,
    ...(value.skipAction === "exit" ? { skipAction: "exit" as const } : {}),
  };
}
