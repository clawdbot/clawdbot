// Fish completion tests cover fish shell completion script generation.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildFishOptionCompletionLine,
  buildFishSubcommandCompletionLine,
} from "./completion-fish.js";

describe("completion-fish helpers", () => {
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
      flags: ["-s", "--shell"],
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
      flags: ["--write-state"],
      description: "Write cache",
    });
    expect(line).toBe(
      `complete -c openclaw -n "__fish_seen_subcommand_from completion" -l write-state -d 'Write cache'\n`,
    );
  });

  it("builds option line with two long aliases", () => {
    const line = buildFishOptionCompletionLine({
      rootCmd: "openclaw",
      condition: "__fish_use_subcommand",
      flags: ["--ws", "--workspace"],
      description: "Workspace",
    });
    expect(line).toBe(
      `complete -c openclaw -n "__fish_use_subcommand" -l ws -l workspace -d 'Workspace'\n`,
    );
  });

  it("preserves required Commander option values and constrained choices", () => {
    const line = buildFishOptionCompletionLine({
      rootCmd: "openclaw",
      condition: "__fish_seen_subcommand_from completion",
      flags: ["-s", "--shell"],
      description: "Shell target",
      requiresValue: true,
      choices: ["zsh", "bash", "powershell", "fish"],
    });

    const quotedChoices = ["zsh", "bash", "powershell", "fish"]
      .map((choice) => `'${choice}'`)
      .join(" ");
    expect(line).toBe(
      `complete -c openclaw -n "__fish_seen_subcommand_from completion" -s s -l shell -r -f -a "${quotedChoices}" -d 'Shell target'\n`,
    );
  });

  it("preserves optional Commander option values without requiring an argument", () => {
    const line = buildFishOptionCompletionLine({
      rootCmd: "openclaw",
      condition: "__fish_use_subcommand",
      flags: ["--color"],
      description: "Color output",
      choices: ["always", "never"],
    });

    expect(line).toContain(` -l color -f -a "'always' 'never'" `);
    expect(line).not.toContain(" -r ");
    expect(line).toContain(
      `complete -c openclaw -n "__fish_use_subcommand; and contains -- (commandline -opc)[-1] --color" -f -a "'always' 'never'" -d 'Color output'`,
    );
  });

  it("preserves whitespace within each Commander choice", () => {
    const line = buildFishOptionCompletionLine({
      rootCmd: "openclaw",
      condition: "__fish_use_subcommand",
      flags: ["--theme"],
      description: "Theme",
      requiresValue: true,
      choices: ["light blue", "dark"],
    });

    expect(line).toContain(` -r -f -a "'light blue' 'dark'" `);
  });

  it.skipIf(process.platform === "win32")(
    "preserves apostrophes and backslashes through both Fish quoting layers",
    () => {
      const line = buildFishOptionCompletionLine({
        rootCmd: "openclaw",
        condition: "true",
        flags: ["--theme"],
        description: "Theme",
        requiresValue: true,
        choices: ["Bob's green", "path\\name", "ends\\"],
      });

      const capture = spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          `complete() { while (( $# )); do if [[ "$1" == "-a" ]]; then printf '%s' "$2"; return; fi; shift; done; }\n${line}`,
        ],
        { encoding: "utf8" },
      );
      expect(capture.status).toBe(0);
      expect(capture.stderr).toBe("");
      expect(capture.stdout).toBe("'Bob\\'s green' 'path\\\\name' 'ends\\\\'");
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps command-shaped Commander choices inert during completion expression parsing",
    () => {
      const marker = "OPENCLAW_FISH_CHOICE_MUST_NOT_EXECUTE";
      const line = buildFishOptionCompletionLine({
        rootCmd: "openclaw",
        condition: "true",
        flags: ["--channel"],
        description: "Channel",
        requiresValue: true,
        choices: ["(stable)", `$(printf ${marker} >&2)`, "light blue"],
      });

      const capture = spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          `complete() { while (( $# )); do if [[ "$1" == "-a" ]]; then printf '%s' "$2"; return; fi; shift; done; }\n${line}`,
        ],
        { encoding: "utf8" },
      );
      expect(capture.status).toBe(0);
      expect(capture.stderr).toBe("");

      const evaluation = spawnSync(
        "bash",
        ["--noprofile", "--norc", "-c", `set -- ${capture.stdout}; printf '%s\\n' "$@"`],
        { encoding: "utf8" },
      );
      expect(evaluation.status).toBe(0);
      expect(evaluation.stderr).toBe("");
      expect(evaluation.stdout.split("\n").filter(Boolean)).toEqual([
        "(stable)",
        `$(printf ${marker} >&2)`,
        "light blue",
      ]);
    },
  );
});
