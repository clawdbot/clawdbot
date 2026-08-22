import { describe, expect, it } from "vitest";
import { hasShellCompoundCommand, splitTopLevelStages } from "./tool-display-exec-shell.js";
import { resolveExecDetail } from "./tool-display-exec.js";

describe("shell substitution display parsing", () => {
  it("falls back to the raw command for compound substitutions", () => {
    for (const command of [
      "echo $(if true; then pnpm test; fi) && pnpm build",
      "echo $(case x in x) pnpm test;; esac) && pnpm build",
      "echo $(worker() { pnpm test; }; worker) && pnpm build",
    ]) {
      expect(hasShellCompoundCommand(command)).toBe(true);
      expect(splitTopLevelStages(command)).toEqual([command]);
      expect(resolveExecDetail({ command }, { detailMode: "explain" })).toBe(command);
    }
  });

  it("recognizes a compound command after an inner separator", () => {
    const command = "echo $(printf x; if true; then pnpm test; fi) && pnpm build";

    expect(hasShellCompoundCommand(command)).toBe(true);
    expect(resolveExecDetail({ command }, { detailMode: "explain" })).toBe(command);
  });

  it("keeps ordinary and arithmetic substitutions concise", () => {
    for (const command of [
      "echo $(date) && pnpm build",
      "echo $((ready + 1)) && pnpm build",
      "printf '%s' '$(if true; then pnpm test; fi)' && pnpm build",
    ]) {
      expect(hasShellCompoundCommand(command)).toBe(false);
      expect(resolveExecDetail({ command }, { detailMode: "explain" })).toBe(
        "print text → run build",
      );
    }
  });
});
