import { afterEach, describe, expect, it, vi } from "vitest";
import type { Node as TreeSitterNode, Parser, Tree } from "web-tree-sitter";
import { explainShellCommand } from "./extract.js";
import {
  getBashParserForCommandExplanation,
  parseBashForCommandExplanation,
  resolvePackageFileForCommandExplanation,
  setBashParserLoaderForCommandExplanationForTest,
} from "./tree-sitter-runtime.js";

let parserLoaderOverridden = false;

function setParserLoaderForTest(loader: () => Promise<Parser>): void {
  parserLoaderOverridden = true;
  setBashParserLoaderForCommandExplanationForTest(loader);
}

type FakeNodeInit = {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: TreeSitterNode["startPosition"];
  endPosition: TreeSitterNode["endPosition"];
  namedChildren?: TreeSitterNode[];
  fieldChildren?: Record<string, TreeSitterNode>;
  hasError?: boolean;
};

function fakeNode(init: FakeNodeInit): TreeSitterNode {
  const named = init.namedChildren ?? [];
  const children = named;
  return {
    type: init.type,
    text: init.text,
    startIndex: init.startIndex,
    endIndex: init.endIndex,
    startPosition: init.startPosition,
    endPosition: init.endPosition,
    childCount: children.length,
    namedChildCount: named.length,
    hasError: init.hasError ?? false,
    child(index: number): TreeSitterNode | null {
      return children[index] ?? null;
    },
    namedChild(index: number): TreeSitterNode | null {
      return named[index] ?? null;
    },
    childForFieldName(name: string): TreeSitterNode | null {
      return init.fieldChildren?.[name] ?? null;
    },
  } as unknown as TreeSitterNode;
}

function createByteIndexedUnicodeCommandTree(source: string): Tree {
  const firstCommand = "echo café";
  const separator = " && ";
  const secondCommand = "echo ok";
  const firstCommandEnd = Buffer.byteLength(firstCommand, "utf8");
  const secondCommandStart = Buffer.byteLength(firstCommand + separator, "utf8");
  const sourceEnd = Buffer.byteLength(source, "utf8");

  const firstName = fakeNode({
    type: "command_name",
    text: "echo",
    startIndex: 0,
    endIndex: 4,
    startPosition: { row: 0, column: 0 },
    endPosition: { row: 0, column: 4 },
  });
  const firstArgument = fakeNode({
    type: "word",
    text: "café",
    startIndex: 5,
    endIndex: firstCommandEnd,
    startPosition: { row: 0, column: 5 },
    endPosition: { row: 0, column: firstCommandEnd },
  });
  const first = fakeNode({
    type: "command",
    text: firstCommand,
    startIndex: 0,
    endIndex: firstCommandEnd,
    startPosition: { row: 0, column: 0 },
    endPosition: { row: 0, column: firstCommandEnd },
    namedChildren: [firstName, firstArgument],
    fieldChildren: { name: firstName },
  });

  const secondName = fakeNode({
    type: "command_name",
    text: "echo",
    startIndex: secondCommandStart,
    endIndex: secondCommandStart + 4,
    startPosition: { row: 0, column: secondCommandStart },
    endPosition: { row: 0, column: secondCommandStart + 4 },
  });
  const secondArgument = fakeNode({
    type: "word",
    text: "ok",
    startIndex: secondCommandStart + 5,
    endIndex: sourceEnd,
    startPosition: { row: 0, column: secondCommandStart + 5 },
    endPosition: { row: 0, column: sourceEnd },
  });
  const second = fakeNode({
    type: "command",
    text: secondCommand,
    startIndex: secondCommandStart,
    endIndex: sourceEnd,
    startPosition: { row: 0, column: secondCommandStart },
    endPosition: { row: 0, column: sourceEnd },
    namedChildren: [secondName, secondArgument],
    fieldChildren: { name: secondName },
  });

  return {
    rootNode: fakeNode({
      type: "program",
      text: source,
      startIndex: 0,
      endIndex: sourceEnd,
      startPosition: { row: 0, column: 0 },
      endPosition: { row: 0, column: sourceEnd },
      namedChildren: [first, second],
    }),
    delete: vi.fn(),
  } as unknown as Tree;
}

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

afterEach(() => {
  if (parserLoaderOverridden) {
    setBashParserLoaderForCommandExplanationForTest();
    parserLoaderOverridden = false;
  }
  vi.restoreAllMocks();
});

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

  it("retries parser initialization after a loader rejection", async () => {
    const parser = {} as Parser;
    let calls = 0;
    setParserLoaderForTest(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("transient parser load failure");
      }
      return parser;
    });

    await expect(getBashParserForCommandExplanation()).rejects.toThrow(
      "transient parser load failure",
    );
    await expect(getBashParserForCommandExplanation()).resolves.toBe(parser);
    expect(calls).toBe(2);
  });

  it("reports missing parser packages and wasm files with explainer context", () => {
    expect(() =>
      resolvePackageFileForCommandExplanation(
        "definitely-missing-openclaw-parser-package",
        "parser.wasm",
      ),
    ).toThrow("Unable to resolve definitely-missing-openclaw-parser-package");

    expect(() =>
      resolvePackageFileForCommandExplanation("web-tree-sitter", "missing-openclaw-parser.wasm"),
    ).toThrow("Unable to locate missing-openclaw-parser.wasm in web-tree-sitter");
  });

  it("reports parser progress cancellation as a timeout", async () => {
    const reset = vi.fn();
    const parser = {
      parse: (
        _source: string,
        _oldTree: unknown,
        options?: { progressCallback?: (state: unknown) => boolean },
      ) => {
        options?.progressCallback?.({ currentOffset: 0, hasError: false });
        return null;
      },
      reset,
    } as unknown as Parser;
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(501);
    setParserLoaderForTest(async () => parser);

    await expect(parseBashForCommandExplanation("echo hi")).rejects.toThrow(
      "tree-sitter-bash timed out after 500ms while parsing shell command",
    );
    expect(reset).toHaveBeenCalledOnce();
  });

  it("maps parser byte offsets to JavaScript string spans for Unicode source", async () => {
    const source = "echo café && echo ok";
    const parser = {
      parse: vi.fn(() => createByteIndexedUnicodeCommandTree(source)),
      reset: vi.fn(),
    };
    setParserLoaderForTest(async () => parser as unknown as Parser);

    const explanation = await explainShellCommand(source);

    expect(explanation.topLevelCommands).toHaveLength(2);
    expect(explanation.topLevelCommands[0]?.executable).toBe("echo");
    expect(explanation.topLevelCommands[0]?.argv).toEqual(["echo", "café"]);
    expect(explanation.topLevelCommands[0]?.span.startIndex).toBe(0);
    expect(explanation.topLevelCommands[0]?.span.endIndex).toBe(9);
    expect(explanation.topLevelCommands[1]?.executable).toBe("echo");
    expect(explanation.topLevelCommands[1]?.argv).toEqual(["echo", "ok"]);
    expect(explanation.topLevelCommands[1]?.span.startIndex).toBe(13);
    expect(explanation.topLevelCommands[1]?.span.endIndex).toBe(20);
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
