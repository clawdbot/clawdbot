// Completion CLI tests cover shell completion command generation and install output.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { getCompletionScript } from "./completion-cli.js";

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
    expect(script).toContain("$completions = @('status','restart','--force','--token')");
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

  it("generates fish completions for root and nested command contexts", () => {
    const script = getCompletionScript("fish", createCompletionProgram());

    expect(script).toContain(
      'complete -c openclaw -n "__fish_use_subcommand" -a "gateway" -d \'Gateway commands\'',
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
      "complete -c openclaw -n \"__fish_use_subcommand\" -l trigger-script -d 'Condition script file, or - for stdin'",
    );
    expect(fishScript).not.toContain(" -s > ");
    expect(fishScript).toContain(" -l ws -l workspace -d 'Workspace'");
    expect(getCompletionScript("bash", program)).not.toContain("--trigger-script ->");
    expect(getCompletionScript("zsh", program)).not.toContain("{--trigger-script,->}");
  });

  it("generates Bash completions without comma-suffixed short flags", () => {
    const script = getCompletionScript("bash", createCompletionProgram());

    expect(script).toContain("--token");
    expect(script).not.toContain("-t,");
  });

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

// Commander aliases are typeable commands (`openclaw capability` == `openclaw infer`),
// so every shell must complete alias names and keep completing after an alias.
function createAliasedCompletionProgram(): Command {
  const program = new Command();
  program.name("openclaw");
  program.option("--profile <name>", "Profile");
  const infer = program.command("infer").alias("capability").description("Run inference");
  infer.command("embed").description("Embed text").option("--model <id>", "Model id");
  const cron = program.command("cron").description("Cron commands");
  cron
    .command("add")
    .alias("create")
    .description("Add a job")
    .option("--at <time>", "Schedule time");
  return program;
}

describe("completion-cli command aliases", () => {
  it("completes root and nested aliases in zsh lists and dispatch", () => {
    const script = getCompletionScript("zsh", createAliasedCompletionProgram());

    expect(script).toContain("'capability[Run inference]'");
    expect(script).toContain("(infer|capability) _openclaw_infer ;;");
    expect(script).toContain("'create[Add a job]'");
    expect(script).toContain("(add|create) _openclaw_cron_add ;;");
  });

  it("completes root and nested aliases in bash command paths", () => {
    const script = getCompletionScript("bash", createAliasedCompletionProgram());

    expect(script).toContain('opts="infer capability cron --profile"');
    expect(script).toContain('"infer"|"capability")');
    expect(script).toContain('"cron")');
    expect(script).toContain('opts="add create"');
    expect(script).toContain('"cron add"|"cron create")');
    expect(script).toContain('opts="--at"');
  });

  it("offers options after a nested alias in bash", () => {
    if (process.platform === "win32") {
      return;
    }

    const script = getCompletionScript("bash", createAliasedCompletionProgram());
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `${script}
COMP_WORDS=(openclaw --profile work cron create --a)
COMP_CWORD=5
_openclaw_completion
printf '%s\\n' "\${COMPREPLY[@]}"
`,
      ],
      { encoding: "utf8" },
    );
    if (result.error) {
      if (
        "code" in result.error &&
        (result.error.code === "ENOENT" || result.error.code === "EACCES")
      ) {
        return;
      }
      throw result.error;
    }

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("--at");
  });

  it("completes aliases and their subtrees in fish", () => {
    const script = getCompletionScript("fish", createAliasedCompletionProgram());

    expect(script).toContain(
      'complete -c openclaw -n "__fish_use_subcommand" -a "capability" -d \'Run inference\'',
    );
    expect(script).toContain(
      'complete -c openclaw -n "__openclaw_command_path_matches capability -- --profile" -a "embed" -d \'Embed text\'',
    );
    expect(script).toContain(
      'complete -c openclaw -n "__openclaw_command_path_matches cron -- --profile" -a "create" -d \'Add a job\'',
    );
    expect(script).toContain(
      "complete -c openclaw -n \"__openclaw_command_path_matches cron create -- --profile --at\" -l at -d 'Schedule time'",
    );
  });

  it("completes aliases and alias command paths in PowerShell", () => {
    const script = getCompletionScript("powershell", createAliasedCompletionProgram());

    expect(script).toContain("$completions = @('infer','capability','cron','--profile')");
    expect(script).toContain("if ($commandPath -eq 'capability') {");
    expect(script).toContain("if ($commandPath -eq 'cron create') {");
  });
});
