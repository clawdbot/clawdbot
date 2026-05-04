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

    expect(explanation.topLevelCommands).toEqual([
      expect.objectContaining({
        executable: "echo",
        argv: ["echo", "café"],
        span: expect.objectContaining({ startIndex: 0, endIndex: 9 }),
      }),
      expect.objectContaining({
        executable: "echo",
        argv: ["echo", "ok"],
        span: expect.objectContaining({ startIndex: 13, endIndex: 20 }),
      }),
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
    expect(explanation.nestedCommands).toEqual([]);
    expect(explanation.topLevelCommands[2]?.span).toEqual(
      expect.objectContaining({ startIndex: expect.any(Number), endIndex: expect.any(Number) }),
    );
    expect(explanation.risks).toContainEqual(
      expect.objectContaining({
        kind: "inline-eval",
        command: "python",
        flag: "-c",
        text: "python -c 'print(\"hi\")'",
      }),
    );
  });

  it("separates command substitution in an argument", async () => {
    const explanation = await explainShellCommand("echo $(whoami)");

    expect(explanation.topLevelCommands.map((step) => step.executable)).toEqual(["echo"]);
    expect(explanation.nestedCommands).toEqual([
      expect.objectContaining({ context: "command-substitution", executable: "whoami" }),
    ]);
    expect(explanation.risks).toContainEqual(
      expect.objectContaining({ kind: "command-substitution", text: "$(whoami)" }),
    );
  });

  it("marks command substitution in executable position as dynamic", async () => {
    const explanation = await explainShellCommand("$(whoami) --help");

    expect(explanation.topLevelCommands).toEqual([]);
    expect(explanation.nestedCommands).toEqual([
      expect.objectContaining({ context: "command-substitution", executable: "whoami" }),
    ]);
    expect(explanation.risks).toContainEqual(
      expect.objectContaining({ kind: "dynamic-executable", text: "$(whoami)" }),
    );
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

    expect(explanation.shapes).toEqual(expect.arrayContaining(["and", "or", "sequence"]));
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
    expect(background.shapes).toEqual(expect.arrayContaining(["background", "sequence"]));
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

    expect(declaration.topLevelCommands).toEqual([
      expect.objectContaining({ executable: "export", argv: ["export", "A=$(whoami)"] }),
    ]);
    expect(declaration.nestedCommands).toEqual([
      expect.objectContaining({ context: "command-substitution", executable: "whoami" }),
    ]);

    const testCommand = await explainShellCommand("[ -f package.json ]");
    expect(testCommand.topLevelCommands).toEqual([
      expect.objectContaining({ executable: "[", argv: ["[", "-f", "package.json"] }),
    ]);

    const doubleBracket = await explainShellCommand("[[ -f package.json ]]");
    expect(doubleBracket.topLevelCommands).toEqual([
      expect.objectContaining({ executable: "[[", argv: ["[[", "-f", "package.json"] }),
    ]);
  });

  it("detects shell wrappers", async () => {
    const explanation = await explainShellCommand('bash -lc "echo hi | wc -c"');

    expect(explanation.topLevelCommands.map((step) => step.executable)).toEqual(["bash"]);
    expect(explanation.nestedCommands).toEqual([
      expect.objectContaining({ context: "wrapper-payload", executable: "echo" }),
      expect.objectContaining({ context: "wrapper-payload", executable: "wc" }),
    ]);
    const [wrappedEcho, wrappedWc] = explanation.nestedCommands;
    expect(explanation.source.slice(wrappedEcho?.span.startIndex, wrappedEcho?.span.endIndex)).toBe(
      "echo hi",
    );
    expect(explanation.source.slice(wrappedWc?.span.startIndex, wrappedWc?.span.endIndex)).toBe(
      "wc -c",
    );
    expect(explanation.shapes).toContain("pipeline");
    expect(explanation.risks).toContainEqual(
      expect.objectContaining({
        kind: "shell-wrapper",
        executable: "bash",
        flag: "-lc",
        payload: "echo hi | wc -c",
        text: 'bash -lc "echo hi | wc -c"',
      }),
    );

    const combinedFlags = await explainShellCommand('bash -euxc "echo hi"');
    expect(combinedFlags.risks).toContainEqual(
      expect.objectContaining({
        kind: "shell-wrapper",
        executable: "bash",
        flag: "-euxc",
        payload: "echo hi",
      }),
    );

    const combinedInline = await explainShellCommand('bash -c"echo hi"');
    expect(combinedInline.risks).toContainEqual(
      expect.objectContaining({
        kind: "shell-wrapper",
        executable: "bash",
        payload: "echo hi",
      }),
    );

    const powershell = await explainShellCommand('pwsh -Command "Get-ChildItem"');
    expect(powershell.risks).toContainEqual(
      expect.objectContaining({
        kind: "shell-wrapper",
        executable: "pwsh",
        flag: "-Command",
        payload: "Get-ChildItem",
      }),
    );

    const powershellWithOptions = await explainShellCommand(
      "pwsh -ExecutionPolicy Bypass -Command Get-ChildItem",
    );
    expect(powershellWithOptions.risks).toContainEqual(
      expect.objectContaining({
        kind: "shell-wrapper",
        executable: "pwsh",
        flag: "-Command",
        payload: "Get-ChildItem",
      }),
    );

    const dynamicPayload = await explainShellCommand('bash -lc "$CMD"');
    expect(dynamicPayload.nestedCommands).toEqual([]);
    expect(dynamicPayload.risks).toContainEqual(
      expect.objectContaining({
        kind: "shell-wrapper",
        executable: "bash",
        flag: "-lc",
        payload: "$CMD",
      }),
    );

    const invalidPayload = await explainShellCommand("bash -lc 'echo &&'");
    expect(invalidPayload.ok).toBe(false);
    expect(invalidPayload.risks).toContainEqual(expect.objectContaining({ kind: "syntax-error" }));

    const powershellPipeline = await explainShellCommand(
      'pwsh -Command "Get-ChildItem | Select Name"',
    );
    expect(powershellPipeline.nestedCommands).toEqual([]);
    expect(powershellPipeline.risks).toContainEqual(
      expect.objectContaining({
        kind: "shell-wrapper",
        executable: "pwsh",
        flag: "-Command",
        payload: "Get-ChildItem | Select Name",
      }),
    );

    for (const [command, carrier] of [
      ["time bash -lc 'id'", "time"],
      ["nice bash -lc 'id'", "nice"],
      ["timeout 1 bash -lc 'id'", "timeout"],
      ["caffeinate -d -w 42 bash -lc 'id'", "caffeinate"],
    ] as const) {
      const wrapped = await explainShellCommand(command);
      expect(wrapped.risks).toContainEqual(
        expect.objectContaining({
          kind: "shell-wrapper-through-carrier",
          command: carrier,
        }),
      );
      expect(wrapped.nestedCommands).toContainEqual(
        expect.objectContaining({ context: "wrapper-payload", executable: "id" }),
      );
      const wrappedId = wrapped.nestedCommands.find((step) => step.executable === "id");
      expect(wrapped.source.slice(wrappedId?.span.startIndex, wrappedId?.span.endIndex)).toBe("id");
    }
  });

  it("maps decoded shell-wrapper payload spans back to original source escapes", async () => {
    const explanation = await explainShellCommand('bash -lc "printf \\"hi\\" | wc -c"');

    const wrappedPrintf = explanation.nestedCommands.find((step) => step.executable === "printf");
    const wrappedWc = explanation.nestedCommands.find((step) => step.executable === "wc");

    expect(wrappedPrintf).toEqual(
      expect.objectContaining({
        context: "wrapper-payload",
        text: 'printf "hi"',
      }),
    );
    expect(
      explanation.source.slice(wrappedPrintf?.span.startIndex, wrappedPrintf?.span.endIndex),
    ).toBe('printf \\"hi\\"');
    expect(explanation.source.slice(wrappedWc?.span.startIndex, wrappedWc?.span.endIndex)).toBe(
      "wc -c",
    );
  });

  it("normalizes static shell words before classifying commands", async () => {
    const quotedCommand = await explainShellCommand("e'c'ho a\\ b \"c d\"");
    expect(quotedCommand.topLevelCommands).toEqual([
      expect.objectContaining({ executable: "echo", argv: ["echo", "a b", "c d"] }),
    ]);

    const ansiCString = await explainShellCommand("$'ec\\x68o' hi");
    expect(ansiCString.topLevelCommands).toEqual([
      expect.objectContaining({ executable: "echo", argv: ["echo", "hi"] }),
    ]);

    const wrappedShell = await explainShellCommand("b'a'sh -lc 'echo hi'");
    expect(wrappedShell.risks).toContainEqual(
      expect.objectContaining({
        kind: "shell-wrapper",
        executable: "bash",
        flag: "-lc",
        payload: "echo hi",
      }),
    );
  });

  it("does not normalize dynamic executable names into trusted commands", async () => {
    const dynamicPrefix = await explainShellCommand("e${CMD}ho hi");
    expect(dynamicPrefix.topLevelCommands).toEqual([]);
    expect(dynamicPrefix.risks).toContainEqual(
      expect.objectContaining({ kind: "dynamic-executable", text: "e${CMD}ho" }),
    );

    const dynamicQuoted = await explainShellCommand('"${CMD}" hi');
    expect(dynamicQuoted.topLevelCommands).toEqual([]);
    expect(dynamicQuoted.risks).toContainEqual(
      expect.objectContaining({ kind: "dynamic-executable", text: '"${CMD}"' }),
    );

    const dynamicGlob = await explainShellCommand("./ec* hi");
    expect(dynamicGlob.topLevelCommands).toEqual([]);
    expect(dynamicGlob.risks).toContainEqual(
      expect.objectContaining({ kind: "dynamic-executable", text: "./ec*" }),
    );

    const dynamicBraceExpansion = await explainShellCommand("./{echo,printf} hi");
    expect(dynamicBraceExpansion.topLevelCommands).toEqual([]);
    expect(dynamicBraceExpansion.risks).toContainEqual(
      expect.objectContaining({ kind: "dynamic-executable", text: "./{echo,printf}" }),
    );

    const dynamicArgument = await explainShellCommand("echo ./ec*");
    expect(dynamicArgument.topLevelCommands).toEqual([
      expect.objectContaining({ executable: "echo", argv: ["echo", "./ec*"] }),
    ]);
    expect(dynamicArgument.risks).toContainEqual(
      expect.objectContaining({
        kind: "dynamic-argument",
        command: "echo",
        argumentIndex: 1,
        text: "./ec*",
      }),
    );

    const dynamicShellFlag = await explainShellCommand("bash $FLAGS id");
    expect(dynamicShellFlag.risks).toContainEqual(
      expect.objectContaining({
        kind: "dynamic-argument",
        command: "bash",
        argumentIndex: 1,
        text: "$FLAGS",
      }),
    );

    const lineContinuation = await explainShellCommand("ec\\\nho hi");
    expect(lineContinuation.topLevelCommands).toEqual([]);
    expect(lineContinuation.risks).toContainEqual(
      expect.objectContaining({ kind: "line-continuation" }),
    );
    expect(lineContinuation.risks).toContainEqual(
      expect.objectContaining({ kind: "dynamic-executable" }),
    );

    const continuedArgument = await explainShellCommand("pnpm test \\\n --filter foo");
    expect(continuedArgument.topLevelCommands).toEqual([
      expect.objectContaining({
        executable: "pnpm",
        argv: ["pnpm", "test", "--filter", "foo"],
      }),
    ]);
    expect(continuedArgument.risks).toContainEqual(
      expect.objectContaining({ kind: "line-continuation" }),
    );

    const invalidObfuscation = await explainShellCommand("e'c'h'o hi");
    expect(invalidObfuscation.ok).toBe(false);
    expect(invalidObfuscation.risks).toContainEqual(
      expect.objectContaining({ kind: "syntax-error" }),
    );
  });

  it("detects command carriers", async () => {
    const find = await explainShellCommand('find . -name "*.ts" -exec grep -n TODO {} +');
    expect(find.risks).toContainEqual(
      expect.objectContaining({ kind: "command-carrier", command: "find", flag: "-exec" }),
    );

    const xargs = await explainShellCommand('printf "%s\\n" a b | xargs -I{} sh -c "echo {}"');
    expect(xargs.risks).toContainEqual(
      expect.objectContaining({ kind: "command-carrier", command: "xargs" }),
    );

    const envSplitString = await explainShellCommand("env -S 'sh -c \"id\"'");
    expect(envSplitString.risks).toContainEqual(
      expect.objectContaining({ kind: "command-carrier", command: "env", flag: "-S" }),
    );
    const envCombinedSplitString = await explainShellCommand("env -iS 'sh -c \"id\"'");
    expect(envCombinedSplitString.risks).toContainEqual(
      expect.objectContaining({ kind: "command-carrier", command: "env", flag: "-S" }),
    );

    for (const command of [
      'env python -c "print(1)"',
      'sudo python -c "print(1)"',
      'command python -c "print(1)"',
      'exec python -c "print(1)"',
    ]) {
      const explanation = await explainShellCommand(command);
      expect(explanation.risks).toContainEqual(
        expect.objectContaining({
          kind: "inline-eval",
          command: "python",
          flag: "-c",
        }),
      );
    }
  });

  it("detects eval, source, aliases, and carrier shell wrappers", async () => {
    const evalCommand = await explainShellCommand('eval "$OPENCLAW_CMD"');
    expect(evalCommand.risks).toContainEqual(expect.objectContaining({ kind: "eval" }));

    const builtinEval = await explainShellCommand("builtin eval 'echo hi'");
    expect(builtinEval.risks).toContainEqual(expect.objectContaining({ kind: "eval" }));

    const sourceCommand = await explainShellCommand(". ./some-script.sh");
    expect(sourceCommand.risks).toContainEqual(
      expect.objectContaining({ kind: "source", command: "." }),
    );

    const aliasCommand = await explainShellCommand("alias ll='ls -l'");
    expect(aliasCommand.risks).toContainEqual(expect.objectContaining({ kind: "alias" }));

    const sudoShell = await explainShellCommand('sudo sh -c "id && whoami"');
    expect(sudoShell.risks).toContainEqual(
      expect.objectContaining({ kind: "shell-wrapper-through-carrier", command: "sudo" }),
    );

    const commandShell = await explainShellCommand("command bash -lc 'id && whoami'");
    expect(commandShell.risks).toContainEqual(
      expect.objectContaining({ kind: "shell-wrapper-through-carrier", command: "command" }),
    );

    const execShell = await explainShellCommand("exec bash -lc 'id && whoami'");
    expect(execShell.risks).toContainEqual(
      expect.objectContaining({ kind: "shell-wrapper-through-carrier", command: "exec" }),
    );

    const execEval = await explainShellCommand("exec eval 'echo hi'");
    expect(execEval.risks).toContainEqual(expect.objectContaining({ kind: "eval" }));

    const sudoCombinedFlags = await explainShellCommand('sudo bash -euxc "id && whoami"');
    expect(sudoCombinedFlags.risks).toContainEqual(
      expect.objectContaining({ kind: "shell-wrapper-through-carrier", command: "sudo" }),
    );
  });

  it("treats function bodies as nested command context", async () => {
    const explanation = await explainShellCommand("ls() { echo hi; }; ls /tmp");

    expect(explanation.topLevelCommands).toEqual([
      expect.objectContaining({ context: "top-level", executable: "ls", argv: ["ls", "/tmp"] }),
    ]);
    expect(explanation.nestedCommands).toEqual([
      expect.objectContaining({ context: "function-definition", executable: "echo" }),
    ]);
    expect(explanation.risks).toContainEqual(
      expect.objectContaining({ kind: "function-definition", name: "ls" }),
    );
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
    expect(redirectRisks).toEqual([expect.objectContaining({ text: "> out.txt" })]);

    const heredoc = await explainShellCommand("cat <<EOF\nhello\nEOF");
    expect(heredoc.risks).toContainEqual(expect.objectContaining({ kind: "heredoc" }));

    const hereString = await explainShellCommand('cat <<< "hello"');
    expect(hereString.risks).toContainEqual(expect.objectContaining({ kind: "here-string" }));
  });

  it("reports syntax errors with source spans", async () => {
    const explanation = await explainShellCommand("echo 'unterminated");

    expect(explanation.ok).toBe(false);
    expect(explanation.risks).toContainEqual(
      expect.objectContaining({
        kind: "syntax-error",
        span: expect.objectContaining({
          startIndex: expect.any(Number),
          endIndex: expect.any(Number),
        }),
      }),
    );
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
