// Completion CLI tests cover shell completion command generation and install output.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command, Option } from "commander";
import { afterAll, describe, expect, it } from "vitest";
import { getCompletionScript, registerCompletionCli } from "./completion-cli.js";
import {
  createAliasedCompletionProgram,
  itWithFish,
  itWithPowerShell,
  PowerShellCompletionRunner,
  runGeneratedBashCompletion,
  runGeneratedFishCompletion,
} from "./completion-cli.test-support.js";

const powerShellCompletion = new PowerShellCompletionRunner();

afterAll(async () => {
  await powerShellCompletion.close();
});

function createCompletionProgram(): Command {
  const program = new Command();
  program.name("openclaw");
  program.description("CLI root");
  program.option("-v, --verbose", "Verbose output");
  program.option(
    "--status-json",
    "Output JSON (alias for `models status --json`) in $OPENCLAW_STATE_DIR",
  );

  const gateway = program.command("gateway").description("Gateway commands");
  gateway.option("--force", "Force the action");
  gateway.option("-t, --token <token>", "Gateway token");

  gateway.command("status").description("Show gateway status").option("--json", "JSON output");
  gateway.command("restart").description("Restart gateway");
  program
    .command("agent")
    .description("Agent commands")
    .option("--verbose <on|off>", "Set verbosity");
  const sessions = program.command("sessions").description("Session commands");
  sessions.option("--verbose", "Verbose output");
  sessions.command("cleanup").description("Clean sessions").option("--dry-run", "Preview cleanup");

  return program;
}

function createDocumentedCompletionProgram(): Command {
  const program = createCompletionProgram();
  registerCompletionCli(program);
  return program;
}

function createOptionalChoiceCompletionProgram(): Command {
  const program = new Command().name("openclaw");
  program.addOption(new Option("--mode [mode]", "Mode").choices(["auto", "manual", "-legacy"]));
  program.option("--json", "JSON output");
  return program;
}

describe("completion-cli", () => {
  it("generates zsh functions for nested subcommands", () => {
    const script = getCompletionScript("zsh", createCompletionProgram());

    expect(script).toContain("_openclaw_gateway()");
    expect(script).toContain("(status) _openclaw_gateway_status ;;");
    expect(script).toContain("(restart) _openclaw_gateway_restart ;;");
    expect(script).toContain("--force[Force the action]");
    expect(script).toContain("\\`models status --json\\`");
    expect(script).toContain("\\$OPENCLAW_STATE_DIR");
  });

  it("escapes zsh option descriptions for double-quoted arguments specs", () => {
    const program = new Command()
      .name("openclaw")
      .option("--literal", "Use $OPENCLAW_STATE_DIR with `model/list` and John's profile");

    const script = getCompletionScript("zsh", program);

    expect(script).toContain(
      "--literal[Use \\$OPENCLAW_STATE_DIR with \\`model/list\\` and John's profile]",
    );
    expect(script).not.toContain("John'\\''s");
  });

  it("marks zsh option arguments and completes validated shell choices", () => {
    const script = getCompletionScript("zsh", createDocumentedCompletionProgram());

    expect(script).toContain('"[Gateway token]:token:"');
    expect(script).toContain(
      '"[Shell to generate completion for (default: detected)]:shell:(zsh bash powershell fish)"',
    );
  });

  it.skipIf(process.platform === "win32")(
    "keeps zsh completion choices literal and preserves candidate boundaries",
    () => {
      const program = new Command().name("openclaw");
      program.addOption(
        new Option("--value <value>", "Value").choices([
          "two words",
          'say "hello"',
          "it's literal",
          "literal $(printf OPENCLAW_COMPLETION_VALUE_EXECUTED >&2)",
          "literal `printf OPENCLAW_COMPLETION_VALUE_EXECUTED >&2`",
        ]),
      );

      const result = spawnSync(
        "zsh",
        [
          "-fc",
          `${getCompletionScript("zsh", program)}
_arguments() { printf '%s\\n' "$@"; }
_openclaw_root_completion
`,
        ],
        { encoding: "utf8" },
      );
      if (result.error) {
        if ("code" in result.error && result.error.code === "ENOENT") {
          return;
        }
        throw result.error;
      }

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("two\\ words");
      expect(result.stdout).toContain('say\\ \\"hello\\"');
      expect(result.stdout).toContain("OPENCLAW_COMPLETION_VALUE_EXECUTED");
    },
  );

  it("defers zsh registration until compinit is available", async () => {
    if (process.platform === "win32") {
      return;
    }

    const probe = spawnSync("zsh", ["-fc", "exit 0"], { encoding: "utf8" });
    if (probe.error) {
      if (
        "code" in probe.error &&
        (probe.error.code === "ENOENT" || probe.error.code === "EACCES")
      ) {
        return;
      }
      throw probe.error;
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-zsh-completion-"));
    try {
      const scriptPath = path.join(tempDir, "openclaw.zsh");
      await fs.writeFile(scriptPath, getCompletionScript("zsh", createCompletionProgram()), "utf8");

      const result = spawnSync(
        "zsh",
        [
          "-fc",
          `
            source ${JSON.stringify(scriptPath)}
            [[ -z "\${_comps[openclaw]-}" ]] || exit 10
            [[ "\${precmd_functions[(r)_openclaw_register_completion]}" = "_openclaw_register_completion" ]] || exit 11
            autoload -Uz compinit
            compinit -C
            _openclaw_register_completion
            [[ -z "\${precmd_functions[(r)_openclaw_register_completion]}" ]] || exit 12
            [[ "\${_comps[openclaw]-}" = "_openclaw_root_completion" ]]
          `,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: tempDir,
            ZDOTDIR: tempDir,
          },
        },
      );

      expect(result.stderr).not.toContain("command not found: compdef");
      expect(result.status).toBe(0);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("generates PowerShell command paths without the executable prefix", () => {
    const script = getCompletionScript("powershell", createCompletionProgram());

    expect(script).toContain("if ($commandPath -eq 'gateway') {");
    expect(script).toContain("if ($commandPath -eq 'gateway status') {");
    expect(script).not.toContain("if ($commandPath -eq 'openclaw gateway') {");
    expect(script).toContain("$completions = @('status','restart','--force','-t','--token')");
    expect(script).not.toContain("'-t,'");
  });

  it("generates valid PowerShell root arrays when commands or options are empty", () => {
    const commandsOnly = new Command().name("openclaw");
    commandsOnly.command("status");
    const optionsOnly = new Command().name("openclaw").option("--json", "JSON output");
    const empty = new Command().name("openclaw");

    expect(getCompletionScript("powershell", commandsOnly)).toContain("$completions = @('status')");
    expect(getCompletionScript("powershell", optionsOnly)).toContain("$completions = @('--json')");
    expect(getCompletionScript("powershell", empty)).toContain("$completions = @()");
  });

  it("preserves documented short and long completion flags in PowerShell", () => {
    const script = getCompletionScript("powershell", createDocumentedCompletionProgram());

    expect(script).toContain("'-v','--verbose'");
    expect(script).toContain("'--force','-t','--token'");
    expect(script).toContain("'-s','--shell','-i','--install','--write-state','-y','--yes'");
  });

  it("generates PowerShell value choices for both completion shell flags", () => {
    const script = getCompletionScript("powershell", createDocumentedCompletionProgram());

    expect(script).toContain("if ($choiceFlag -in @('-s','--shell')) {");
    expect(script).toContain("@('zsh','bash','powershell','fish')");
    expect(script).toContain("'ParameterValue'");
  });

  it("escapes apostrophes in PowerShell completion choices", () => {
    const program = new Command().name("openclaw");
    program.addOption(new Option("--profile <name>", "Profile").choices(["Jane's", "work"]));

    expect(getCompletionScript("powershell", program)).toContain("@('Jane''s','work')");
  });

  it("matches PowerShell value prefixes literally and case-insensitively", () => {
    const program = new Command().name("openclaw");
    program.addOption(new Option("--value <value>", "Value").choices(["alpha", "a*literal"]));

    expect(getCompletionScript("powershell", program)).toContain(
      "StartsWith($choicePrefix, [StringComparison]::OrdinalIgnoreCase)",
    );
  });

  itWithPowerShell.each([
    ["a long shell flag", "openclaw completion --shell f"],
    ["a short shell flag", "openclaw completion -s f"],
  ])("completes validated values in real PowerShell after %s", async (_name, commandLine) => {
    expect(
      await powerShellCompletion.complete(createDocumentedCompletionProgram(), commandLine),
    ).toEqual(["fish"]);
  });

  itWithPowerShell.each([
    {
      name: "an omitted optional value",
      commandLine: "openclaw --mode --j",
      expected: ["--json"],
    },
    {
      name: "an inline optional value",
      commandLine: "openclaw --mode=a",
      expected: ["--mode=auto"],
    },
    {
      name: "a hyphen-prefixed optional choice",
      commandLine: "openclaw --mode -l",
      expected: ["-legacy"],
    },
  ])("preserves real PowerShell completion after $name", async ({ commandLine, expected }) => {
    expect(
      await powerShellCompletion.complete(createOptionalChoiceCompletionProgram(), commandLine),
    ).toEqual(expected);
  });

  itWithPowerShell.each([
    {
      name: "an ordinary prefix",
      commandLine: "openclaw --value al",
      expected: ["alpha"],
    },
    {
      name: "a literal asterisk",
      commandLine: "openclaw --value a*",
      expected: ["'a*literal'"],
    },
    {
      name: "a literal opening bracket",
      commandLine: "openclaw --value a[",
      expected: ["'a[bracket]'"],
    },
    {
      name: "a case-insensitive literal asterisk",
      commandLine: "openclaw --value A*",
      expected: ["'a*literal'"],
    },
    {
      name: "an inline literal asterisk",
      commandLine: "openclaw --value=a*",
      expected: ["--value='a*literal'"],
    },
  ])("matches real PowerShell choices with $name", async ({ commandLine, expected }) => {
    const program = new Command().name("openclaw");
    program.addOption(
      new Option("--value <value>", "Value").choices(["alpha", "a*literal", "a[bracket]"]),
    );

    expect(await powerShellCompletion.complete(program, commandLine)).toEqual(expected);
  });

  itWithPowerShell.each([
    { name: "ordinary choices", value: "alpha", prefix: "al" },
    { name: "whitespace", value: "two words", prefix: "tw" },
    { name: "apostrophes", value: "Jane's", prefix: "Ja" },
    {
      name: "literal command substitution",
      value: "literal $(Write-Error OPENCLAW_COMPLETION_VALUE_EXECUTED)",
      prefix: "literal",
    },
    {
      name: "literal backtick metacharacters",
      value: "literal `$(Write-Error OPENCLAW_COMPLETION_VALUE_EXECUTED)",
      prefix: "literal",
    },
    {
      name: "literal statement separators",
      value: "literal; Write-Error OPENCLAW_COMPLETION_VALUE_EXECUTED",
      prefix: "literal",
    },
  ])("inserts PowerShell $name as one safe argument", async ({ value, prefix }) => {
    const program = new Command().name("openclaw");
    program.addOption(new Option("--value <value>", "Value").choices([value]));
    const safeValue = /^[A-Za-z0-9_./:+-]+$/.test(value)
      ? value
      : `'${value.replaceAll("'", "''")}'`;

    expect(await powerShellCompletion.complete(program, `openclaw --value ${prefix}`)).toEqual([
      safeValue,
    ]);
    expect(await powerShellCompletion.complete(program, `openclaw --value=${prefix}`)).toEqual([
      `--value=${safeValue}`,
    ]);
  });

  itWithPowerShell("completes root short and long flags in real PowerShell", async () => {
    const completions = await powerShellCompletion.complete(
      createDocumentedCompletionProgram(),
      "openclaw -",
    );

    expect(completions).toEqual(expect.arrayContaining(["-v", "--verbose", "--status-json"]));
  });

  itWithPowerShell(
    "completes documented nested short and long flags in real PowerShell",
    async () => {
      const completions = await powerShellCompletion.complete(
        createDocumentedCompletionProgram(),
        "openclaw completion -",
      );

      expect(completions).toEqual(
        expect.arrayContaining([
          "-s",
          "--shell",
          "-i",
          "--install",
          "-y",
          "--yes",
          "--write-state",
        ]),
      );
    },
  );

  itWithPowerShell.each([
    ["a long flag", "openclaw gateway --token secret st"],
    ["a short flag", "openclaw gateway -t secret st"],
    ["an inline long value", "openclaw gateway --token=secret st"],
    ["an inline short value", "openclaw gateway -t=secret st"],
    ["a preceding boolean flag", "openclaw gateway --force --token secret st"],
  ])("keeps real PowerShell nested completions after %s", async (_name, commandLine) => {
    expect(await powerShellCompletion.complete(createCompletionProgram(), commandLine)).toEqual([
      "status",
    ]);
  });

  itWithPowerShell.each([
    ["-v", ["-v"]],
    ["--v", ["--verbose"]],
  ])("filters real PowerShell root flag aliases for %s", async (prefix, expected) => {
    expect(
      await powerShellCompletion.complete(
        createDocumentedCompletionProgram(),
        `openclaw ${prefix}`,
      ),
    ).toEqual(expected);
  });

  it("generates fish completions for root and nested command contexts", () => {
    const script = getCompletionScript("fish", createCompletionProgram());

    expect(script).toContain(
      'complete -c openclaw -n "__openclaw_command_path_matches --" -a "gateway" -d \'Gateway commands\'',
    );
    expect(script).toContain(
      'complete -c openclaw -n "__openclaw_command_path_matches gateway -- -t --token" -a "status" -d \'Show gateway status\'',
    );
    expect(script).toContain(
      "complete -c openclaw -n \"__openclaw_command_path_matches gateway -- -t --token\" -l force -d 'Force the action'",
    );
    expect(script).toContain(
      "complete -c openclaw -n \"__openclaw_command_path_matches gateway status -- -t --token\" -l json -d 'JSON output'",
    );
    expect(script).toContain("__openclaw_command_path_matches gateway -- -t --token");
    expect(script).toContain("if contains -- $flag $value_options");
  });

  it("distinguishes Fish child command paths from positional arguments", () => {
    const script = getCompletionScript("fish", createCompletionProgram());

    expect(script).toContain('switch "$candidate_path"');
    expect(script).toContain("'gateway status'");
  });

  itWithFish.each([
    ["a separate long root option", "openclaw --profile work g"],
    ["an inline long root option", "openclaw --profile=work g"],
    ["a separate short root option", "openclaw -p work g"],
    ["an inline short root option", "openclaw -p=work g"],
    ["an attached short root option", "openclaw -pwork g"],
    ["a separate log-level root option", "openclaw --log-level debug g"],
    ["an inline log-level root option", "openclaw --log-level=debug g"],
    ["a separate container root option", "openclaw --container local g"],
    ["an inline container root option", "openclaw --container=local g"],
    ["repeated root options", "openclaw --profile first --profile second g"],
    [
      "mixed value-taking root options",
      "openclaw --profile work --log-level debug --container local g",
    ],
    ["a preceding boolean root option", "openclaw -v --profile work g"],
    ["a root option value named like a command", "openclaw --profile gateway g"],
  ])("completes root commands in real Fish after %s", (_name, commandLine) => {
    const program = createCompletionProgram()
      .option("-p, --profile <name>", "Profile")
      .option("--log-level <level>", "Log level")
      .option("--container <name>", "Container");

    expect(runGeneratedFishCompletion(program, commandLine)).toContain("gateway");
  });

  itWithFish.each([
    ["a separate long root option", "openclaw --profile work --p"],
    ["an inline long root option", "openclaw --profile=work --p"],
    ["a separate short root option", "openclaw -p work --p"],
    ["repeated root options", "openclaw --profile first --profile second --p"],
  ])("completes root options in real Fish after %s", (_name, commandLine) => {
    const program = createCompletionProgram().option("-p, --profile <name>", "Profile");

    expect(runGeneratedFishCompletion(program, commandLine)).toContain("--profile");
  });

  itWithFish.each([
    ["the exact nested command", "openclaw gateway status -"],
    ["a separate long option value", "openclaw gateway --token secret status -"],
    ["a separate short option value", "openclaw gateway -t secret status -"],
    ["an inline long option value", "openclaw gateway --token=secret status -"],
    ["an inline short option value", "openclaw gateway -t=secret status -"],
    ["a parent boolean option", "openclaw gateway --force status -"],
  ])("keeps real Fish completions scoped after %s", (_name, commandLine) => {
    expect(runGeneratedFishCompletion(createCompletionProgram(), commandLine)).toEqual(["--json"]);
  });

  itWithFish.each([
    ["a positional argument", "openclaw gateway status query -"],
    ["multiple positional arguments", "openclaw gateway status first second -"],
    ["a positional argument named like a sibling", "openclaw gateway status restart -"],
    ["a long option and positional argument", "openclaw gateway --token secret status query -"],
    ["an inline option and positional argument", "openclaw gateway --token=secret status query -"],
  ])("keeps real Fish leaf options after %s", (_name, commandLine) => {
    const program = createCompletionProgram();
    const gateway = program.commands.find((command) => command.name() === "gateway");
    const status = gateway?.commands.find((command) => command.name() === "status");
    if (!status) {
      throw new Error("Gateway status command is unavailable");
    }
    status.argument("[query...]", "Search query");

    expect(runGeneratedFishCompletion(program, commandLine)).toEqual(["--json"]);
  });

  itWithFish("preserves documented short and long completion flags in real Fish", () => {
    expect(
      runGeneratedFishCompletion(createDocumentedCompletionProgram(), "openclaw completion -"),
    ).toEqual(
      expect.arrayContaining(["-s", "--shell", "-i", "--install", "-y", "--yes", "--write-state"]),
    );
  });

  itWithFish.each([
    ["a separated long optional value", "openclaw --color a", "always"],
    ["a separated short optional value", "openclaw -c n", "never"],
    ["an attached long optional value", "openclaw --color=a", "--color=always"],
  ])("completes real Fish Commander choices after %s", (_name, commandLine, expected) => {
    const program = new Command()
      .name("openclaw")
      .addOption(new Option("-c, --color [when]").choices(["always", "never"]));

    expect(runGeneratedFishCompletion(program, commandLine)).toContain(expected);
  });

  itWithFish.each([
    ["a long shell flag", "openclaw completion --shell f"],
    ["a short shell flag", "openclaw completion -s f"],
  ])("completes validated values in real Fish after %s", (_name, commandLine) => {
    expect(runGeneratedFishCompletion(createDocumentedCompletionProgram(), commandLine)).toEqual([
      "fish",
    ]);
  });

  it("registers validated Fish option choices without filesystem fallback", () => {
    const script = getCompletionScript("fish", createDocumentedCompletionProgram());

    expect(script).toContain(" -s s -l shell -r -f -a ");
    expect(script).toContain("'zsh' 'bash' 'powershell' 'fish'");
  });

  itWithFish.each([
    { name: "whitespace", value: "two words", prefix: "tw" },
    { name: "double quotes", value: 'say "hello"', prefix: "sa" },
    { name: "apostrophes", value: "it's literal", prefix: "it" },
    {
      name: "literal command substitution",
      value: "literal $(printf OPENCLAW_COMPLETION_VALUE_EXECUTED >&2)",
      prefix: "literal",
    },
    {
      name: "literal backtick substitution",
      value: "literal `printf OPENCLAW_COMPLETION_VALUE_EXECUTED >&2`",
      prefix: "literal",
    },
  ])("preserves Fish choice $name as one inert candidate", ({ value, prefix }) => {
    const program = new Command().name("openclaw");
    program.addOption(new Option("--value <value>", "Value").choices([value]));

    expect(runGeneratedFishCompletion(program, `openclaw --value ${prefix}`)).toEqual([value]);
  });

  it("does not require optional Fish option choices", () => {
    const program = new Command().name("openclaw");
    program.addOption(new Option("--mode [mode]", "Mode").choices(["auto", "manual"]));

    const optionLine = getCompletionScript("fish", program)
      .split("\n")
      .find((line) => line.includes(" -l mode "));

    expect(optionLine).toContain(" -f -a ");
    expect(optionLine).not.toContain(" -r ");
    expect(optionLine).toContain("'auto' 'manual'");
  });

  it("scopes fish value-taking option skips to the active command path", () => {
    const script = getCompletionScript("fish", createCompletionProgram());

    expect(script).toContain("__openclaw_command_path_matches agent -- --verbose");
    expect(script).toContain("__openclaw_command_path_matches sessions cleanup --");
    expect(script).not.toContain("__openclaw_command_path_matches sessions cleanup -- --verbose");
    expect(script).toContain(
      "complete -c openclaw -n \"__openclaw_command_path_matches sessions cleanup --\" -l dry-run -d 'Preview cleanup'",
    );
  });

  it("uses Commander's parsed flags instead of value placeholder syntax", () => {
    const program = new Command()
      .name("openclaw")
      .option("--trigger-script <path|->", "Condition script file, or - for stdin")
      .option("--ws, --workspace <name>", "Workspace");

    const fishScript = getCompletionScript("fish", program);

    expect(fishScript).toContain(
      "complete -c openclaw -n \"__openclaw_command_path_matches -- --trigger-script --ws --workspace\" -l trigger-script -r -d 'Condition script file, or - for stdin'",
    );
    expect(fishScript).not.toContain(" -s > ");
    expect(fishScript).toContain(" -l ws -l workspace -r -d 'Workspace'");
    expect(getCompletionScript("bash", program)).not.toContain("--trigger-script ->");
    expect(getCompletionScript("zsh", program)).not.toContain("{--trigger-script,->}");
  });

  it("generates Bash completions without comma-suffixed short flags", () => {
    const script = getCompletionScript("bash", createCompletionProgram());

    expect(script).toContain("--token");
    expect(script).not.toContain("-t,");
  });

  it.skipIf(process.platform === "win32")(
    "completes both root short flags and their long aliases in real Bash",
    () => {
      const completions = runGeneratedBashCompletion(createDocumentedCompletionProgram(), [
        "openclaw",
        "-",
      ]);

      expect(completions).toEqual(expect.arrayContaining(["-v", "--verbose", "--status-json"]));
      expect(completions.some((flag) => flag.endsWith(","))).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "completes every documented completion short flag in real Bash",
    () => {
      const completions = runGeneratedBashCompletion(createDocumentedCompletionProgram(), [
        "openclaw",
        "completion",
        "-",
      ]);

      expect(completions).toEqual(
        expect.arrayContaining([
          "-s",
          "--shell",
          "-i",
          "--install",
          "-y",
          "--yes",
          "--write-state",
        ]),
      );
      expect(completions.some((flag) => flag.endsWith(","))).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "completes both nested value-taking flag aliases in real Bash",
    () => {
      const completions = runGeneratedBashCompletion(createDocumentedCompletionProgram(), [
        "openclaw",
        "gateway",
        "-",
      ]);

      expect(completions).toEqual(expect.arrayContaining(["-t", "--token", "--force"]));
      expect(completions.some((flag) => flag.endsWith(","))).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "filters short and long aliases independently in real Bash",
    () => {
      const program = createDocumentedCompletionProgram();

      expect(runGeneratedBashCompletion(program, ["openclaw", "completion", "-s"])).toEqual(["-s"]);
      expect(runGeneratedBashCompletion(program, ["openclaw", "completion", "--s"])).toEqual([
        "--shell",
      ]);
    },
  );

  it.skipIf(process.platform === "win32").each([
    {
      name: "a long shell flag",
      words: ["openclaw", "completion", "--shell", "f"],
      expected: ["fish"],
    },
    {
      name: "a short shell flag",
      words: ["openclaw", "completion", "-s", "f"],
      expected: ["fish"],
    },
    {
      name: "an inline long shell flag",
      words: ["openclaw", "completion", "--shell=f"],
      expected: ["--shell=fish"],
    },
    {
      name: "an inline short shell flag",
      words: ["openclaw", "completion", "-s=f"],
      expected: ["-s=fish"],
    },
  ])("completes validated values in real Bash after $name", ({ words, expected }) => {
    expect(runGeneratedBashCompletion(createDocumentedCompletionProgram(), words)).toEqual(
      expected,
    );
  });

  it.skipIf(process.platform === "win32").each([
    {
      name: "an omitted optional value",
      words: ["openclaw", "--mode", "--j"],
      expected: ["--json"],
    },
    {
      name: "a separate optional value",
      words: ["openclaw", "--mode", "a"],
      expected: ["auto"],
    },
    {
      name: "an inline optional value",
      words: ["openclaw", "--mode=a"],
      expected: ["--mode=auto"],
    },
    {
      name: "a hyphen-prefixed optional choice",
      words: ["openclaw", "--mode", "-l"],
      expected: ["-legacy"],
    },
  ])("preserves real Bash completion after $name", ({ words, expected }) => {
    expect(runGeneratedBashCompletion(createOptionalChoiceCompletionProgram(), words)).toEqual(
      expected,
    );
  });

  it.skipIf(process.platform === "win32").each([
    {
      name: "whitespace",
      value: "two words",
      prefix: "two ",
    },
    {
      name: "double quotes",
      value: 'say "hello"',
      prefix: 'say "',
    },
    {
      name: "apostrophes",
      value: "it's literal",
      prefix: "it's",
    },
    {
      name: "literal command substitution",
      value: "$(printf OPENCLAW_COMPLETION_VALUE_EXECUTED >&2)",
      prefix: "$(",
    },
    {
      name: "literal backtick substitution",
      value: "`printf OPENCLAW_COMPLETION_VALUE_EXECUTED >&2`",
      prefix: "`",
    },
  ])("keeps Bash choice $name literal without executing it", ({ value, prefix }) => {
    const program = new Command().name("openclaw");
    program.addOption(new Option("--value <value>", "Value").choices([value]));

    expect(runGeneratedBashCompletion(program, ["openclaw", "--value", prefix])).toEqual([value]);
    expect(runGeneratedBashCompletion(program, ["openclaw", `--value=${prefix}`])).toEqual([
      `--value=${value}`,
    ]);
  });

  it.skipIf(process.platform === "win32").each([
    {
      name: "a root option",
      words: ["openclaw", "--channel", "b"],
      expected: ["beta"],
    },
    {
      name: "an inherited parent option",
      words: ["openclaw", "cron", "create", "--channel", "pre"],
      expected: ["preview"],
    },
    {
      name: "an inline inherited parent option",
      words: ["openclaw", "cron", "create", "--channel=pre"],
      expected: ["--channel=preview"],
    },
    {
      name: "a differently prefixed inherited parent choice",
      words: ["openclaw", "cron", "create", "--channel", "pro"],
      expected: ["production"],
    },
  ])("uses the nearest validated Bash choices for $name", ({ words, expected }) => {
    const program = createAliasedCompletionProgram();
    program.addOption(
      new Option("--channel <channel>", "Update channel").choices(["stable", "beta"]),
    );
    const cron = program.commands.find((command) => command.name() === "cron");
    if (!cron) {
      throw new Error("Cron command is unavailable");
    }
    cron.addOption(
      new Option("--channel <channel>", "Cron channel").choices(["production", "preview"]),
    );

    expect(runGeneratedBashCompletion(program, words)).toEqual(expected);
  });

  it("preserves documented short and long completion flags in Fish and Zsh", () => {
    const program = createDocumentedCompletionProgram();
    const fishScript = getCompletionScript("fish", program);
    const zshScript = getCompletionScript("zsh", program);

    expect(fishScript).toContain(" -s s -l shell ");
    expect(fishScript).toContain(" -s i -l install ");
    expect(fishScript).toContain(" -s y -l yes ");
    expect(zshScript).toContain("{--shell,-s}");
    expect(zshScript).toContain("{--install,-i}");
    expect(zshScript).toContain("{--yes,-y}");
  });

  it("preserves required shell values and their Commander choices in Fish and Zsh", () => {
    const program = createDocumentedCompletionProgram();
    const fishScript = getCompletionScript("fish", program);
    const zshScript = getCompletionScript("zsh", program);

    expect(fishScript).toContain(" -s s -l shell -r -f -a ");
    expect(fishScript).toContain(`"'zsh' 'bash' 'powershell' 'fish'"`);
    expect(zshScript).toContain(
      `{--shell,-s}"[Shell to generate completion for (default: detected)]:shell:(zsh bash powershell fish)"`,
    );
    expect(zshScript).toContain('{--token,-t}"[Gateway token]:token:"');
  });

  it.skipIf(process.platform === "win32")(
    "completes Commander option choices instead of commands in real Bash",
    () => {
      const program = createDocumentedCompletionProgram();

      expect(
        runGeneratedBashCompletion(program, ["openclaw", "completion", "--shell", ""]),
      ).toEqual(["zsh", "bash", "powershell", "fish"]);
      expect(runGeneratedBashCompletion(program, ["openclaw", "completion", "-s", "f"])).toEqual([
        "fish",
      ]);
      expect(runGeneratedBashCompletion(program, ["openclaw", "completion", "--shell=f"])).toEqual([
        "--shell=fish",
      ]);
      expect(
        runGeneratedBashCompletion(program, ["openclaw", "completion", "--shell", "=", "f"]),
      ).toEqual(["fish"]);
      expect(runGeneratedBashCompletion(program, ["openclaw", "completion", "-sf"])).toEqual([
        "-sfish",
      ]);
      expect(runGeneratedBashCompletion(program, ["openclaw", "completion", "-ysf"])).toEqual([
        "-ysfish",
      ]);
      expect(runGeneratedBashCompletion(program, ["openclaw", "completion", "-ys", "f"])).toEqual([
        "fish",
      ]);
      expect(runGeneratedBashCompletion(program, ["openclaw", "completion", "-ys"])).toEqual([
        "-yszsh",
        "-ysbash",
        "-yspowershell",
        "-ysfish",
      ]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps optional choice values from consuming the following option in real Bash",
    () => {
      const program = new Command()
        .name("openclaw")
        .addOption(new Option("-c, --color [when]").choices(["always", "never"]))
        .option("-v, --verbose", "Verbose output");

      expect(runGeneratedBashCompletion(program, ["openclaw", "--color", "a"])).toEqual(["always"]);
      expect(runGeneratedBashCompletion(program, ["openclaw", "--color", "--v"])).toEqual([
        "--verbose",
      ]);
      expect(runGeneratedBashCompletion(program, ["openclaw", "-ca"])).toEqual(["-calways"]);
      expect(runGeneratedBashCompletion(program, ["openclaw", "-vca"])).toEqual(["-vcalways"]);
    },
  );

  it("includes Commander option choices in the PowerShell argument completer", () => {
    const script = getCompletionScript("powershell", createDocumentedCompletionProgram());

    expect(script).toContain("switch ($candidatePath)");
    expect(script).toContain("$choiceFlag -in @('-s','--shell')");
    expect(script).toContain("$wordToComplete -match '^(--[^=]+)=(.*)$'");
    expect(script).toContain("$wordToComplete -match '^-[^-].+$'");
    expect(script).toContain("StartsWith($choicePrefix, [StringComparison]::OrdinalIgnoreCase)");
    expect(script).toContain("@('zsh','bash','powershell','fish')");
  });

  it("omits empty PowerShell command-path switches for root-only programs", () => {
    const program = new Command()
      .name("openclaw")
      .addOption(new Option("--theme <theme>").choices(["light", "dark"]));

    expect(getCompletionScript("powershell", program)).not.toContain("switch ($candidatePath)");
  });

  it("quotes PowerShell choice completion text while preserving its display value", () => {
    const program = new Command()
      .name("openclaw")
      .addOption(new Option("--theme <theme>").choices(["light blue", "Bob's green", "path`name"]));

    const script = getCompletionScript("powershell", program);

    expect(script).toContain('$completionText = "$choiceCompletionPrefix$choiceValue"');
    expect(script).toContain('$_.Replace("\'", "\'\'")');
    expect(script).toContain(
      "[System.Management.Automation.CompletionResult]::new($completionText, $_, 'ParameterValue', $_)",
    );
  });

  itWithPowerShell.each([
    ["a separate option value", "openclaw completion --shell f", "fish"],
    ["an attached option value", "openclaw completion --shell=f", "--shell=fish"],
    ["an attached short option value", "openclaw completion -sf", "-sfish"],
    ["a short-option cluster value", "openclaw completion -ysf", "-ysfish"],
    ["a separated short-option cluster value", "openclaw completion -ys f", "fish"],
  ])("completes PowerShell Commander choices after %s", async (_name, commandLine, expected) => {
    expect(
      await powerShellCompletion.complete(createDocumentedCompletionProgram(), commandLine),
    ).toEqual([expected]);
  });

  itWithPowerShell("completes an empty attached short-option cluster value", async () => {
    expect(
      await powerShellCompletion.complete(
        createDocumentedCompletionProgram(),
        "openclaw completion -ys",
      ),
    ).toEqual(["-yszsh", "-ysbash", "-yspowershell", "-ysfish"]);
  });

  itWithPowerShell.each([
    ["a spaced choice", "openclaw --theme l", "'light blue'"],
    ["an attached spaced choice", "openclaw --theme=l", "--theme='light blue'"],
    ["an apostrophe", "openclaw --theme Bob", "'Bob''s green'"],
    ["a backtick", "openclaw --theme p", "'path`name'"],
  ])("quotes %s in real PowerShell completion text", async (_name, commandLine, expected) => {
    const program = new Command()
      .name("openclaw")
      .addOption(new Option("--theme <theme>").choices(["light blue", "Bob's green", "path`name"]));

    expect(await powerShellCompletion.complete(program, commandLine)).toEqual([expected]);
  });

  itWithPowerShell(
    "keeps optional choice values from consuming the following PowerShell option",
    async () => {
      const program = new Command()
        .name("openclaw")
        .addOption(new Option("-c, --color [when]").choices(["always", "never"]))
        .option("-v, --verbose", "Verbose output");

      expect(await powerShellCompletion.complete(program, "openclaw --color a")).toEqual([
        "always",
      ]);
      expect(await powerShellCompletion.complete(program, "openclaw --color --v")).toEqual([
        "--verbose",
      ]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves spaces and apostrophes inside individual Commander choices",
    () => {
      const program = new Command()
        .name("openclaw")
        .addOption(
          new Option("--theme <theme>", "Color theme").choices([
            "light blue",
            "dark",
            "Bob's green",
          ]),
        );

      expect(runGeneratedBashCompletion(program, ["openclaw", "--theme", "l"])).toEqual([
        "light blue",
      ]);
      expect(runGeneratedBashCompletion(program, ["openclaw", "--theme", "Bob"])).toEqual([
        "Bob's green",
      ]);
      expect(getCompletionScript("fish", program)).toContain(`"'light blue' 'dark'`);
      expect(getCompletionScript("zsh", program)).toContain(":theme:(light");
    },
  );

  it("generates valid Bash completion without subcommands", () => {
    if (process.platform === "win32") {
      return;
    }

    const script = getCompletionScript("bash", new Command().name("openclaw"));
    const result = spawnSync("bash", ["--noprofile", "--norc", "-n"], {
      encoding: "utf8",
      input: script,
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
