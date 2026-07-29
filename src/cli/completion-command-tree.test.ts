import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { collectShellCompletionCommandTree } from "./completion-command-tree.js";

describe("shell completion command tree", () => {
  it("collects root command aliases and parsed short and long option flags", () => {
    const program = new Command()
      .name("openclaw")
      .option("-p, --profile <name>", "Profile")
      .option("-v, --verbose", "Verbose output");
    program.command("infer").alias("capability");

    const tree = collectShellCompletionCommandTree(program);

    expect(tree.root.pathVariants).toEqual([[]]);
    expect(tree.root.completions).toEqual([
      "infer",
      "capability",
      "-p",
      "--profile",
      "-v",
      "--verbose",
    ]);
    expect(tree.root.valueOptions).toEqual(["-p", "--profile"]);
  });

  it("expands aliases across every ancestor and inherits value-taking options", () => {
    const program = new Command().name("openclaw").option("-p, --profile <name>", "Profile");
    const cron = program.command("cron").alias("schedule").option("-z, --timezone <zone>");
    cron.command("add").alias("create").option("--at <time>");

    const tree = collectShellCompletionCommandTree(program);

    expect(
      tree.descendants.map(({ pathVariants, valueOptions }) => ({
        pathVariants,
        valueOptions,
      })),
    ).toEqual([
      {
        pathVariants: [["cron"], ["schedule"]],
        valueOptions: ["-p", "--profile", "-z", "--timezone"],
      },
      {
        pathVariants: [
          ["cron", "add"],
          ["cron", "create"],
          ["schedule", "add"],
          ["schedule", "create"],
        ],
        valueOptions: ["-p", "--profile", "-z", "--timezone", "--at"],
      },
    ]);
  });

  it("deduplicates inherited option flags without treating boolean options as values", () => {
    const program = new Command().name("openclaw").option("--profile <name>").option("--verbose");
    program.command("agent").option("--profile <name>").option("--force");

    const tree = collectShellCompletionCommandTree(program);

    expect(tree.descendants[0]?.valueOptions).toEqual(["--profile"]);
    expect(tree.descendants[0]?.completions).toEqual(["--profile", "--force"]);
  });

  it("keeps commandless roots valid for every shell", () => {
    const tree = collectShellCompletionCommandTree(new Command().name("openclaw"));

    expect(tree.root.completions).toEqual([]);
    expect(tree.root.valueOptions).toEqual([]);
    expect(tree.descendants).toEqual([]);
  });
});
