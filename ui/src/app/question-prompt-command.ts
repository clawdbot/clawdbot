import type { QuestionAnswers } from "../../../packages/gateway-protocol/src/index.js";

export type QuestionPromptCommand = (request: {
  id: string;
  expiresAtMs: number;
  answers?: QuestionAnswers;
  cancel?: true;
}) => Promise<unknown>;
