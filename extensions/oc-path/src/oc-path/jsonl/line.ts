import { POS_FIRST, POS_LAST } from "../oc-path.js";
import type { JsonlAst, JsonlLine } from "./ast.js";

export function pickJsonlLine(ast: JsonlAst, addr: string): JsonlLine | null {
  if (addr === POS_FIRST) {
    for (const line of ast.lines) {
      if (line.kind === "value") {
        return line;
      }
    }
    return null;
  }
  if (addr === POS_LAST) {
    for (let index = ast.lines.length - 1; index >= 0; index -= 1) {
      const line = ast.lines[index];
      if (line !== undefined && line.kind === "value") {
        return line;
      }
    }
    return null;
  }
  const match = /^L(\d+)$/.exec(addr);
  if (match === null || match[1] === undefined) {
    return null;
  }
  const target = Number(match[1]);
  for (const line of ast.lines) {
    if (line.line === target) {
      return line;
    }
  }
  return null;
}
