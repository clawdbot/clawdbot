// Covers rich shell-command extraction, fake parser shapes, source span mapping,
// nested wrapper parsing, and parser error handling.
import { describe, expect, it } from "vitest";
import { explainShellCommand } from "./extract.js";
import { parseBashForCommandExplanation } from "./tree-sitter-runtime.js";

function riskMatches(risk: unknown, fields: Record<string, unknown>): boolean {
  if (!risk || typeof risk !== "object") {
    return false;
  }
  const candidate = risk as Record<string, unknown>;
  return Object.entries(fields).every(([key, value]) => candidate[key] === value);
}

function expectRisk(
  risks: readonly unknown[],
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const risk = risks.find((candidate) => riskMatches(candidate, fields)) as
    | Record<string, unknown>
    | undefined;
  if (!risk) {
    throw new Error(`Expected risk ${JSON.stringify(fields)}`);
  }
  return risk;
}

function spanText(source: string, span: { startIndex: number; endIndex: number }): string {
  return source.slice(span.startIndex, span.endIndex);
}

describe("command explainer tree-sitter runtime", () => {
  it("loads tree-sitter bash and parses a simple command", async () => {
    const tree = await parseBashForCommandExplanation("ls | grep stuff");

    try {
      expect(tree.rootNode.type).toBe("program");
      expect(tree.rootNode.toString()).toContain("pipeline");
    } finally {
      tree.delete();
    }
  });

  it("rejects oversized parser input before parsing", async () => {
    await expect(parseBashForCommandExplanation("x".repeat(128 * 1024 + 1))).rejects.toThrow(
      "Shell command is too large to explain",
    );
  });

  it("uses native JavaScript string offsets for Unicode source", async () => {
    const source = "echo café😀 && echo 雪";
    const explanation = await explainShellCommand(source);

    expect(explanation.topLevelCommands).toHaveLength(2);
    expect(explanation.topLevelCommands.map((command) => command.argv)).toEqual([
      ["echo", "café😀"],
      ["echo", "雪"],
    ]);
    expect(explanation.topLevelCommands.map((command) => command.span)).toMatchObject([
      { startIndex: 0, endIndex: 11 },
      { startIndex: 15, endIndex: 21 },
    ]);
    for (const command of explanation.topLevelCommands) {
      expect(source.slice(command.span.startIndex, command.span.endIndex)).toBe(command.text);
      expect(command.span.endPosition.column).toBe(command.span.endIndex);
    }
  });

  it("explains a pipeline with python inline eval", async () => {
    const explanation = await explainShellCommand('ls | grep "stuff" | python -c \'print("hi")\'');

    expect(explanation.ok).toBe(true);
    expect(explanation.shapes).toContain("pipeline");
    expect(explanation.topLevelCommands.map((step) => step.executable)).toEqual([
      "ls",
      "grep",
      "python",
    ]);
    expect(explanation.topLevelCommands[2]?.argv).toEqual(["python", "-c", 'print("hi")']);
    expect(explanation.nestedCommands).toStrictEqual([]);
    expect(typeof explanation.topLevelCommands[2]?.span.startIndex).toBe("number");
    expect(typeof explanation.topLevelCommands[2]?.span.endIndex).toBe("number");
    expectRisk(explanation.risks, {
      kind: "inline-eval",
      command: "python",
      flag: "-c",
      text: "python -c 'print(\"hi\")'",
    });
  });

  it("separates command substitution in an argument", async () => {
    const explanation = await explainShellCommand("echo $(whoami)");

    expect(explanation.topLevelCommands.map((step) => step.executable)).toEqual(["echo"]);
    expect(explanation.nestedCommands).toHaveLength(1);
    expect(explanation.nestedCommands[0]?.context).toBe("command-substitution");
    expect(explanation.nestedCommands[0]?.executable).toBe("whoami");
    expectRisk(explanation.risks, { kind: "command-substitution", text: "$(whoami)" });
  });

  it("marks command substitution in executable position as dynamic", async () => {
    const explanation = await explainShellCommand("$(whoami) --help");

    expect(explanation.topLevelCommands).toStrictEqual([]);
    expect(explanation.nestedCommands).toHaveLength(1);
    expect(explanation.nestedCommands[0]?.context).toBe("command-substitution");
    expect(explanation.nestedCommands[0]?.executable).toBe("whoami");
    expectRisk(explanation.risks, { kind: "dynamic-executable", text: "$(whoami)" });
  });

  it("separates process substitution commands", async () => {
    const explanation = await explainShellCommand("diff <(ls a) <(ls b)");

    expect(explanation.topLevelCommands.map((step) => step.executable)).toEqual(["diff"]);
    expect(explanation.nestedCommands.map((step) => `${step.context}:${step.executable}`)).toEqual([
      "process-substitution:ls",
      "process-substitution:ls",
    ]);
    expect(explanation.risks.map((risk) => risk.kind)).toContain("process-substitution");
  });

  it("detects AND OR and sequence shapes", async () => {
    const explanation = await explainShellCommand("pnpm test && pnpm build || echo failed; pwd");

    expect(explanation.shapes).toContain("and");
    expect(explanation.shapes).toContain("or");
    expect(explanation.shapes).toContain("sequence");
    expect(explanation.topLevelCommands.map((step) => step.executable)).toEqual([
      "pnpm",
      "pnpm",
      "echo",
      "pwd",
    ]);
  });

  it("emits command topology metadata for operators and shell wrapper payload commands", async () => {
    const chained = await explainShellCommand("git status && npm test; pwd");
    const [gitStatus, npmTest, pwd] = chained.topLevelCommands;
    expect(chained.topLevelCommands.map((step) => step.text)).toEqual([
      "git status",
      "npm test",
      "pwd",
    ]);
    expect(
      (chained.operators ?? []).map((operator) => ({
        kind: operator.kind,
        text: operator.text,
        fromCommandId: operator.fromCommandId,
        toCommandId: operator.toCommandId,
        spanText: spanText(chained.source, operator.span),
      })),
    ).toEqual([
      {
        kind: "and",
        text: "&&",
        fromCommandId: gitStatus?.id,
        toCommandId: npmTest?.id,
        spanText: "&&",
      },
      {
        kind: "sequence",
        text: ";",
        fromCommandId: npmTest?.id,
        toCommandId: pwd?.id,
        spanText: ";",
      },
    ]);

    const pipe = await explainShellCommand("git diff | cat");
    const [gitDiff, catPipe] = pipe.topLevelCommands;
    expect(pipe.topLevelCommands.map((step) => step.text)).toEqual(["git diff", "cat"]);
    expect(pipe.operators).toEqual([
      expect.objectContaining({
        kind: "pipe",
        text: "|",
        fromCommandId: gitDiff?.id,
        toCommandId: catPipe?.id,
      }),
    ]);
    expect(spanText(pipe.source, pipe.operators?.[0]?.span ?? { startIndex: 0, endIndex: 0 })).toBe(
      "|",
    );

    const stderrPipe = await explainShellCommand("grep x file |& cat");
    const [grepStep, catStderrPipe] = stderrPipe.topLevelCommands;
    expect(stderrPipe.topLevelCommands.map((step) => step.text)).toEqual(["grep x file", "cat"]);
    expect(stderrPipe.operators).toEqual([
      expect.objectContaining({
        kind: "stderr-pipe",
        text: "|&",
        fromCommandId: grepStep?.id,
        toCommandId: catStderrPipe?.id,
      }),
    ]);
    expect(
      spanText(
        stderrPipe.source,
        stderrPipe.operators?.[0]?.span ?? { startIndex: 0, endIndex: 0 },
      ),
    ).toBe("|&");

    const newline = await explainShellCommand("echo a\npwd");
    const [echoStep, pwdStep] = newline.topLevelCommands;
    expect(newline.topLevelCommands.map((step) => step.text)).toEqual(["echo a", "pwd"]);
    expect(newline.operators).toEqual([
      expect.objectContaining({
        kind: "newline-sequence",
        text: "\n",
        fromCommandId: echoStep?.id,
        toCommandId: pwdStep?.id,
      }),
    ]);
    expect(
      spanText(newline.source, newline.operators?.[0]?.span ?? { startIndex: 0, endIndex: 0 }),
    ).toBe("\n");

    const wrapper = await explainShellCommand("sh -c 'git status && npm test'");
    const [wrapperStep] = wrapper.topLevelCommands;
    const [nestedGitStatus, nestedNpmTest] = wrapper.nestedCommands;
    expect(wrapper.nestedCommands.map((step) => [step.text, step.parentCommandId])).toEqual([
      ["git status", wrapperStep?.id],
      ["npm test", wrapperStep?.id],
    ]);
    expect(wrapper.operators).toEqual([
      expect.objectContaining({
        kind: "and",
        text: "&&",
        fromCommandId: nestedGitStatus?.id,
        toCommandId: nestedNpmTest?.id,
        parentCommandId: wrapperStep?.id,
      }),
    ]);
  });

  it("detects newline sequences and background commands", async () => {
    const newlineSequence = await explainShellCommand("echo a\necho b");
    expect(newlineSequence.shapes).toContain("sequence");
    expect(newlineSequence.topLevelCommands.map((step) => step.executable)).toEqual([
      "echo",
      "echo",
    ]);

    const background = await explainShellCommand("echo a & echo b");
    expect(background.shapes).toContain("background");
    expect(background.shapes).toContain("sequence");
    expect(background.topLevelCommands.map((step) => step.executable)).toEqual(["echo", "echo"]);
  });

  it("detects conditionals", async () => {
    const explanation = await explainShellCommand(
      "if test -f package.json; then pnpm test; else echo missing; fi",
    );

    expect(explanation.shapes).toContain("if");
    expect(explanation.topLevelCommands.map((step) => step.executable)).toEqual([
      "test",
      "pnpm",
      "echo",
    ]);
  });

  it("detects declaration and test command forms", async () => {
    const declaration = await explainShellCommand("export A=$(whoami)");

    expect(declaration.topLevelCommands).toHaveLength(1);
    expect(declaration.topLevelCommands[0]?.executable).toBe("export");
    expect(declaration.topLevelCommands[0]?.argv).toEqual(["export", "A=$(whoami)"]);
    expect(declaration.nestedCommands).toHaveLength(1);
    expect(declaration.nestedCommands[0]?.context).toBe("command-substitution");
    expect(declaration.nestedCommands[0]?.executable).toBe("whoami");

    const testCommand = await explainShellCommand("[ -f package.json ]");
    expect(testCommand.topLevelCommands).toHaveLength(1);
    expect(testCommand.topLevelCommands[0]?.executable).toBe("[");
    expect(testCommand.topLevelCommands[0]?.argv).toEqual(["[", "-f", "package.json"]);

    const doubleBracket = await explainShellCommand("[[ -f package.json ]]");
    expect(doubleBracket.topLevelCommands).toHaveLength(1);
    expect(doubleBracket.topLevelCommands[0]?.executable).toBe("[[");
    expect(doubleBracket.topLevelCommands[0]?.argv).toEqual(["[[", "-f", "package.json"]);
  });

  it("detects shell wrappers", async () => {
    const explanation = await explainShellCommand('bash -lc "echo hi | wc -c"');

    expect(explanation.topLevelCommands.map((step) => step.executable)).toEqual(["bash"]);
    expect(explanation.nestedCommands).toHaveLength(2);
    const [wrappedEcho, wrappedWc] = explanation.nestedCommands;
    expect(wrappedEcho?.context).toBe("wrapper-payload");
    expect(wrappedEcho?.executable).toBe("echo");
    expect(wrappedWc?.context).toBe("wrapper-payload");
    expect(wrappedWc?.executable).toBe("wc");
    expect(explanation.source.slice(wrappedEcho?.span.startIndex, wrappedEcho?.span.endIndex)).toBe(
      "echo hi",
    );
    expect(explanation.source.slice(wrappedWc?.span.startIndex, wrappedWc?.span.endIndex)).toBe(
      "wc -c",
    );
    expect(explanation.shapes).toContain("pipeline");
    expectRisk(explanation.risks, {
      kind: "shell-wrapper",
      executable: "bash",
      flag: "-lc",
      payload: "echo hi | wc -c",
      text: 'bash -lc "echo hi | wc -c"',
    });

    const combinedFlags = await explainShellCommand('bash -euxc "echo hi"');
    expectRisk(combinedFlags.risks, {
      kind: "shell-wrapper",
      executable: "bash",
      flag: "-euxc",
      payload: "echo hi",
    });

    const combinedInline = await explainShellCommand('bash -c"echo hi"');
    expectRisk(combinedInline.risks, {
      kind: "shell-wrapper",
      executable: "bash",
      payload: "echo hi",
    });

    const powershell = await explainShellCommand('pwsh -Command "Get-ChildItem"');
    expectRisk(powershell.risks, {
      kind: "shell-wrapper",
      executable: "pwsh",
      flag: "-Command",
      payload: "Get-ChildItem",
    });

    const powershellWithOptions = await explainShellCommand(
      "pwsh -ExecutionPolicy Bypass -Command Get-ChildItem",
    );
    expectRisk(powershellWithOptions.risks, {
      kind: "shell-wrapper",
      executable: "pwsh",
      flag: "-Command",
      payload: "Get-ChildItem",
    });

    const dynamicPayload = await explainShellCommand('bash -lc "$CMD"');
    expect(dynamicPayload.nestedCommands).toStrictEqual([]);
    expectRisk(dynamicPayload.risks, {
      kind: "shell-wrapper",
      executable: "bash",
      flag: "-lc",
      payload: "$CMD",
    });

    const invalidPayload = await explainShellCommand("bash -lc 'echo &&'");
    expect(invalidPayload.ok).toBe(false);
    expectRisk(invalidPayload.risks, { kind: "syntax-error" });

    const powershellPipeline = await explainShellCommand(
      'pwsh -Command "Get-ChildItem | Select Name"',
    );
    expect(powershellPipeline.nestedCommands).toStrictEqual([]);
    expectRisk(powershellPipeline.risks, {
      kind: "shell-wrapper",
      executable: "pwsh",
      flag: "-Command",
      payload: "Get-ChildItem | Select Name",
    });

    for (const [command, carrier] of [
      ["time bash -lc 'id'", "time"],
      ["nice bash -lc 'id'", "nice"],
      ["timeout 1 bash -lc 'id'", "timeout"],
      ["caffeinate -d -w 42 bash -lc 'id'", "caffeinate"],
    ] as const) {
      const wrapped = await explainShellCommand(command);
      expectRisk(wrapped.risks, {
        kind: "shell-wrapper-through-carrier",
        command: carrier,
      });
      const wrappedId = wrapped.nestedCommands.find((step) => step.executable === "id");
      expect(wrappedId?.context).toBe("wrapper-payload");
      expect(wrapped.source.slice(wrappedId?.span.startIndex, wrappedId?.span.endIndex)).toBe("id");
    }
  });

  it("maps decoded shell-wrapper payload spans back to original source escapes", async () => {
    const explanation = await explainShellCommand('bash -lc "printf \\"hi\\" | wc -c"');

    const wrappedPrintf = explanation.nestedCommands.find((step) => step.executable === "printf");
    const wrappedWc = explanation.nestedCommands.find((step) => step.executable === "wc");

    expect(wrappedPrintf?.context).toBe("wrapper-payload");
    expect(wrappedPrintf?.text).toBe('printf "hi"');
    expect(
      explanation.source.slice(wrappedPrintf?.span.startIndex, wrappedPrintf?.span.endIndex),
    ).toBe('printf \\"hi\\"');
    expect(explanation.source.slice(wrappedWc?.span.startIndex, wrappedWc?.span.endIndex)).toBe(
      "wc -c",
    );
  });

  it("normalizes static shell words before classifying commands", async () => {
    const quotedCommand = await explainShellCommand("e'c'ho a\\ b \"c d\"");
    expect(quotedCommand.topLevelCommands).toHaveLength(1);
    expect(quotedCommand.topLevelCommands[0]?.executable).toBe("echo");
    expect(quotedCommand.topLevelCommands[0]?.argv).toEqual(["echo", "a b", "c d"]);

    const ansiCString = await explainShellCommand("$'ec\\x68o' hi");
    expect(ansiCString.topLevelCommands).toHaveLength(1);
    expect(ansiCString.topLevelCommands[0]?.executable).toBe("echo");
    expect(ansiCString.topLevelCommands[0]?.argv).toEqual(["echo", "hi"]);

    const wrappedShell = await explainShellCommand("b'a'sh -lc 'echo hi'");
    expectRisk(wrappedShell.risks, {
      kind: "shell-wrapper",
      executable: "bash",
      flag: "-lc",
      payload: "echo hi",
    });
  });

  it("does not normalize dynamic executable names into trusted commands", async () => {
    const dynamicPrefix = await explainShellCommand("e${CMD}ho hi");
    expect(dynamicPrefix.topLevelCommands).toStrictEqual([]);
    expectRisk(dynamicPrefix.risks, { kind: "dynamic-executable", text: "e${CMD}ho" });

    const dynamicQuoted = await explainShellCommand('"${CMD}" hi');
    expect(dynamicQuoted.topLevelCommands).toStrictEqual([]);
    expectRisk(dynamicQuoted.risks, { kind: "dynamic-executable", text: '"${CMD}"' });

    const dynamicGlob = await explainShellCommand("./ec* hi");
    expect(dynamicGlob.topLevelCommands).toStrictEqual([]);
    expectRisk(dynamicGlob.risks, { kind: "dynamic-executable", text: "./ec*" });

    const dynamicBraceExpansion = await explainShellCommand("./{echo,printf} hi");
    expect(dynamicBraceExpansion.topLevelCommands).toStrictEqual([]);
    expectRisk(dynamicBraceExpansion.risks, {
      kind: "dynamic-executable",
      text: "./{echo,printf}",
    });

    const dynamicArgument = await explainShellCommand("echo ./ec*");
    expect(dynamicArgument.topLevelCommands).toHaveLength(1);
    expect(dynamicArgument.topLevelCommands[0]?.executable).toBe("echo");
    expect(dynamicArgument.topLevelCommands[0]?.argv).toEqual(["echo", "./ec*"]);
    expectRisk(dynamicArgument.risks, {
      kind: "dynamic-argument",
      command: "echo",
      argumentIndex: 1,
      text: "./ec*",
    });

    const dynamicShellFlag = await explainShellCommand("bash $FLAGS id");
    expectRisk(dynamicShellFlag.risks, {
      kind: "dynamic-argument",
      command: "bash",
      argumentIndex: 1,
      text: "$FLAGS",
    });

    const lineContinuation = await explainShellCommand("ec\\\nho hi");
    expect(lineContinuation.topLevelCommands).toStrictEqual([]);
    expectRisk(lineContinuation.risks, { kind: "line-continuation" });
    expectRisk(lineContinuation.risks, { kind: "dynamic-executable" });

    const continuedArgument = await explainShellCommand("pnpm test \\\n --filter foo");
    expect(continuedArgument.topLevelCommands).toHaveLength(1);
    expect(continuedArgument.topLevelCommands[0]?.executable).toBe("pnpm");
    expect(continuedArgument.topLevelCommands[0]?.argv).toEqual([
      "pnpm",
      "test",
      "--filter",
      "foo",
    ]);
    expectRisk(continuedArgument.risks, { kind: "line-continuation" });

    const invalidObfuscation = await explainShellCommand("e'c'h'o hi");
    expect(invalidObfuscation.ok).toBe(false);
    expectRisk(invalidObfuscation.risks, { kind: "syntax-error" });
  });

  it("detects command carriers", async () => {
    const find = await explainShellCommand('find . -name "*.ts" -exec grep -n TODO {} +');
    expectRisk(find.risks, { kind: "command-carrier", command: "find", flag: "-exec" });

    const xargs = await explainShellCommand('printf "%s\\n" a b | xargs -I{} sh -c "echo {}"');
    expectRisk(xargs.risks, { kind: "command-carrier", command: "xargs" });

    const envSplitString = await explainShellCommand("env -S 'sh -c \"id\"'");
    expectRisk(envSplitString.risks, { kind: "command-carrier", command: "env", flag: "-S" });
    const envCombinedSplitString = await explainShellCommand("env -iS 'sh -c \"id\"'");
    expectRisk(envCombinedSplitString.risks, {
      kind: "command-carrier",
      command: "env",
      flag: "-S",
    });

    for (const command of [
      'env python -c "print(1)"',
      'sudo python -c "print(1)"',
      'command python -c "print(1)"',
      'exec python -c "print(1)"',
    ]) {
      const explanation = await explainShellCommand(command);
      expectRisk(explanation.risks, {
        kind: "inline-eval",
        command: "python",
        flag: "-c",
      });
    }
  });

  it("detects eval, source, aliases, and carrier shell wrappers", async () => {
    const evalCommand = await explainShellCommand('eval "$OPENCLAW_CMD"');
    expectRisk(evalCommand.risks, { kind: "eval" });

    const builtinEval = await explainShellCommand("builtin eval 'echo hi'");
    expectRisk(builtinEval.risks, { kind: "eval" });

    const sourceCommand = await explainShellCommand(". ./some-script.sh");
    expectRisk(sourceCommand.risks, { kind: "source", command: "." });

    const aliasCommand = await explainShellCommand("alias ll='ls -l'");
    expectRisk(aliasCommand.risks, { kind: "alias" });

    const sudoShell = await explainShellCommand('sudo sh -c "id && whoami"');
    expectRisk(sudoShell.risks, { kind: "shell-wrapper-through-carrier", command: "sudo" });

    const commandShell = await explainShellCommand("command bash -lc 'id && whoami'");
    expectRisk(commandShell.risks, {
      kind: "shell-wrapper-through-carrier",
      command: "command",
    });

    const execShell = await explainShellCommand("exec bash -lc 'id && whoami'");
    expectRisk(execShell.risks, { kind: "shell-wrapper-through-carrier", command: "exec" });

    const execEval = await explainShellCommand("exec eval 'echo hi'");
    expectRisk(execEval.risks, { kind: "eval" });

    const sudoCombinedFlags = await explainShellCommand('sudo bash -euxc "id && whoami"');
    expectRisk(sudoCombinedFlags.risks, {
      kind: "shell-wrapper-through-carrier",
      command: "sudo",
    });
  });

  it("treats function bodies as nested command context", async () => {
    const explanation = await explainShellCommand("ls() { echo hi; }; ls /tmp");

    expect(explanation.topLevelCommands).toHaveLength(1);
    expect(explanation.topLevelCommands[0]?.context).toBe("top-level");
    expect(explanation.topLevelCommands[0]?.executable).toBe("ls");
    expect(explanation.topLevelCommands[0]?.argv).toEqual(["ls", "/tmp"]);
    expect(explanation.nestedCommands).toHaveLength(1);
    expect(explanation.nestedCommands[0]?.context).toBe("function-definition");
    expect(explanation.nestedCommands[0]?.executable).toBe("echo");
    expectRisk(explanation.risks, { kind: "function-definition", name: "ls" });
  });

  it("does not treat literal operator text as command shapes", async () => {
    const quotedSemicolon = await explainShellCommand('echo ";"');
    expect(quotedSemicolon.shapes).not.toContain("sequence");

    const heredoc = await explainShellCommand("cat <<EOF\n;\nEOF");
    expect(heredoc.shapes).not.toContain("sequence");
  });

  it("marks redirects heredocs and here-strings as risks", async () => {
    const redirect = await explainShellCommand("echo hi > out.txt");
    const redirectRisks = redirect.risks.filter((risk) => risk.kind === "redirect");
    expect(redirectRisks).toHaveLength(1);
    expect(redirectRisks[0]?.text).toBe("> out.txt");

    const heredoc = await explainShellCommand("cat <<EOF\nhello\nEOF");
    expectRisk(heredoc.risks, { kind: "heredoc" });

    const hereString = await explainShellCommand('cat <<< "hello"');
    expectRisk(hereString.risks, { kind: "here-string" });
  });

  it("reports syntax errors with source spans", async () => {
    const explanation = await explainShellCommand("echo 'unterminated");

    expect(explanation.ok).toBe(false);
    const syntaxError = expectRisk(explanation.risks, { kind: "syntax-error" });
    const span = syntaxError.span as { startIndex?: unknown; endIndex?: unknown } | undefined;
    expect(typeof span?.startIndex).toBe("number");
    expect(typeof span?.endIndex).toBe("number");
  });

  it("parses and extracts a repeated approval-sized corpus without parser state leakage", async () => {
    const corpus = [
      'ls | grep "stuff" | python -c \'print("hi")\'',
      "echo $(whoami)",
      "diff <(ls a) <(ls b)",
      'find . -name "*.ts" -exec grep -n TODO {} +',
      'bash -lc "echo hi | wc -c"',
    ];
    const iterations = 3;
    for (let index = 0; index < iterations; index += 1) {
      for (const command of corpus) {
        const explanation = await explainShellCommand(command);
        expect(explanation.risks.length + explanation.topLevelCommands.length).toBeGreaterThan(0);
      }
    }
  });
});
