import { Command, Option } from "commander";
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

  it("preserves inherited Commander option choices by their short and long aliases", () => {
    const program = new Command()
      .name("openclaw")
      .addOption(new Option("-p, --profile <name>").choices(["work", "personal"]));
    program
      .command("completion")
      .addOption(new Option("-s, --shell <shell>").choices(["zsh", "bash", "powershell", "fish"]));

    const tree = collectShellCompletionCommandTree(program);

    expect(tree.root.valueChoices).toEqual([
      { flags: ["-p", "--profile"], choices: ["work", "personal"], requiresValue: true },
    ]);
    expect(tree.descendants[0]?.valueChoices).toEqual([
      { flags: ["-p", "--profile"], choices: ["work", "personal"], requiresValue: true },
      {
        flags: ["-s", "--shell"],
        choices: ["zsh", "bash", "powershell", "fish"],
        requiresValue: true,
      },
    ]);
  });

  it("keeps unshadowed inherited aliases when a child reuses one option flag", () => {
    const program = new Command()
      .name("openclaw")
      .addOption(new Option("-p, --profile <name>").choices(["work", "personal"]));
    program.command("gateway").option("-p, --port <port>", "Gateway port");

    const tree = collectShellCompletionCommandTree(program);

    expect(tree.descendants[0]?.valueChoices).toEqual([
      { flags: ["--profile"], choices: ["work", "personal"], requiresValue: true },
    ]);
  });

  it("preserves the optional Commander argument contract for constrained choices", () => {
    const program = new Command()
      .name("openclaw")
      .addOption(new Option("-c, --color [when]").choices(["always", "never"]));
    program.command("gateway");

    const tree = collectShellCompletionCommandTree(program);
    const colorChoice = {
      flags: ["-c", "--color"],
      choices: ["always", "never"],
      requiresValue: false,
    };

    expect(tree.root.valueChoices).toEqual([colorChoice]);
    expect(tree.descendants[0]?.valueChoices).toEqual([colorChoice]);
  });

  it("retains hidden value consumption and inherited-choice shadowing", () => {
    const program = new Command()
      .name("openclaw")
      .addOption(new Option("-p, --profile <name>").choices(["parent"]));
    program
      .command("child")
      .addOption(new Option("--profile <name>").choices(["child"]).hideHelp())
      .option("--visible", "Visible option");

    const context = collectShellCompletionCommandTree(program).descendants[0];

    expect(context?.completions).toEqual(["--visible"]);
    expect(context?.valueOptions).toEqual(["-p", "--profile"]);
    expect(context?.valueChoices).toEqual([
      { flags: ["-p"], choices: ["parent"], requiresValue: true },
      { flags: ["--profile"], choices: ["child"], requiresValue: true },
    ]);
  });

  it("keeps commandless roots valid for every shell", () => {
    const tree = collectShellCompletionCommandTree(new Command().name("openclaw"));

    expect(tree.root.completions).toEqual([]);
    expect(tree.root.valueOptions).toEqual([]);
    expect(tree.descendants).toEqual([]);
  });
});
