import { select } from "@clack/prompts";
import { styleSelectParams } from "./prompt-select-styled-params.js";

export function selectStyled<T>(params: Parameters<typeof select<T>>[0]) {
  return select(styleSelectParams(params));
}
