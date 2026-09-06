import { diffLines } from "diff";
import type { DiffLine } from "../chat/tool-call-diff.ts";

export type SkillWorkshopDiffRequest = { id: number; previous: string; current: string };
export type SkillWorkshopDiffResponse = {
  id: number;
  diff: ReturnType<typeof computeSkillWorkshopDiff>;
};

export function computeSkillWorkshopDiff(previous: string, current: string) {
  const changes = diffLines(previous.replace(/\r\n?/g, "\n"), current.replace(/\r\n?/g, "\n"), {
    ignoreNewlineAtEof: true,
  });
  const stat = { added: 0, removed: 0 };
  const lines = changes.flatMap((change) => {
    if (change.added) {
      stat.added += change.count;
    } else if (change.removed) {
      stat.removed += change.count;
    }
    return change.value
      .split("\n")
      .slice(0, change.count)
      .map((text): DiffLine => ({
        kind: change.added ? "add" : change.removed ? "del" : "ctx",
        text,
      }));
  });
  return { lines, stat };
}
