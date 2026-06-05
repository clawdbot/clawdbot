// Fish completion tests cover fish shell completion script generation.
import { describe, expect, it } from "vitest";
import {
  buildFishOptionCompletionLine,
  buildFishSubcommandCompletionLine,
  escapeFishDescription,
} from "./completion-fish.js";

describe("completion-fish helpers", () => {
  it("escapes single quotes in descriptions", () => {
    expect(escapeFishDescription("Bob's plugin")).toBe("Bob'\\''s plugin");
  });

  it("builds a subcommand completion line", () => {
    const line = buildFishSubcommandCompletionLine({
      rootCmd: "openclaw",
      condition: "__fish_use_subcommand",
      name: "plugins",
      description: "Manage Bob's plugins",
    });
    expect(line).toBe(
      `complete -c openclaw -n "__fish_use_subcommand" -a "plugins" -d 'Manage Bob'\\''s plugins'\n`,
    );
  });

  it("builds option line with short and long flags", () => {
    const line = buildFishOptionCompletionLine({
      rootCmd: "openclaw",
      condition: "__fish_use_subcommand",
      flags: "-s, --shell <shell>",
      description: "Shell target",
    });
    expect(line).toBe(
      `complete -c openclaw -n "__fish_use_subcommand" -s s -l shell -d 'Shell target'\n`,
    );
  });

  it("builds option line with long-only flags", () => {
    const line = buildFishOptionCompletionLine({
      rootCmd: "openclaw",
      condition: "__fish_seen_subcommand_from completion",
      flags: "--write-state",
      description: "Write cache",
    });
    expect(line).toBe(
      `complete -c openclaw -n "__fish_seen_subcommand_from completion" -l write-state -d 'Write cache'\n`,
    );
  });
});
