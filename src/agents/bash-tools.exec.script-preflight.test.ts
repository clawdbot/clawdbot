import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __setFsSafeTestHooksForTest } from "../infra/fs-safe.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { __testing, createExecTool } from "./bash-tools.exec.js";

const isWin = process.platform === "win32";

const describeNonWin = isWin ? describe.skip : describe;
const describeWin = isWin ? describe : describe.skip;
const validateExecScriptPreflight = __testing.validateScriptFileForShellBleed;
const createPreflightTool = () =>
  createExecTool({ host: "gateway", security: "full", ask: "on-miss" });

afterEach(() => {
  __setFsSafeTestHooksForTest();
});

async function expectSymlinkSwapDuringPreflightToAvoidErrors(params: {
  hookName: "afterPreOpenLstat" | "beforeOpen";
}) {
  await withTempDir("openclaw-exec-preflight-open-race-", async (parent) => {
    const workdir = path.join(parent, "workdir");
    const scriptPath = path.join(workdir, "script.js");
    const outsidePath = path.join(parent, "outside.js");
    await fs.mkdir(workdir, { recursive: true });
    await fs.writeFile(scriptPath, 'console.log("inside")', "utf-8");
    await fs.writeFile(outsidePath, 'console.log("$DM_JSON outside")', "utf-8");
    const scriptRealPath = await fs.realpath(scriptPath);

    let swapped = false;
    __setFsSafeTestHooksForTest({
      [params.hookName]: async (target: string) => {
        if (swapped || path.resolve(target) !== scriptRealPath) {
          return;
        }
        await fs.rm(scriptPath, { force: true });
        await fs.symlink(outsidePath, scriptPath);
        swapped = true;
      },
    });

    await expect(
      validateExecScriptPreflight({
        command: "node script.js",
        workdir,
      }),
    ).resolves.toBeUndefined();
    expect(swapped).toBe(true);
  });
}

describeNonWin("exec script preflight", () => {
  it("blocks shell env var injection tokens in python scripts before execution", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const pyPath = path.join(tmp, "bad.py");

      await fs.writeFile(
        pyPath,
        [
          "import json",
          "# model accidentally wrote shell syntax:",
          "payload = $DM_JSON",
          "print(payload)",
        ].join("\n"),
        "utf-8",
      );

      const tool = createPreflightTool();

      await expect(
        tool.execute("call1", {
          command: "python bad.py",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("blocks obvious shell-as-js output before node execution", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const jsPath = path.join(tmp, "bad.js");

      await fs.writeFile(
        jsPath,
        ['NODE "$TMPDIR/hot.json"', "console.log('hi')"].join("\n"),
        "utf-8",
      );

      const tool = createPreflightTool();

      await expect(
        tool.execute("call1", {
          command: "node bad.js",
          workdir: tmp,
        }),
      ).rejects.toThrow(
        /exec preflight: (detected likely shell variable injection|JS file starts with shell syntax)/,
      );
    });
  });

  it("blocks shell env var injection when script path is quoted", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const jsPath = path.join(tmp, "bad.js");
      await fs.writeFile(jsPath, "const value = $DM_JSON;", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-quoted", {
          command: 'node "bad.js"',
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates in-workdir scripts whose names start with '..'", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const jsPath = path.join(tmp, "..bad.js");
      await fs.writeFile(jsPath, "const value = $DM_JSON;", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-dotdot-prefix-script", {
          command: "node ..bad.js",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates in-workdir symlinked script entrypoints", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const targetPath = path.join(tmp, "bad-target.js");
      const linkPath = path.join(tmp, "link.js");
      await fs.writeFile(targetPath, "const value = $DM_JSON;", "utf-8");
      await fs.symlink(targetPath, linkPath);

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-symlink-entrypoint", {
          command: "node link.js",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates scripts under literal tilde directories in workdir", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const literalTildeDir = path.join(tmp, "~");
      await fs.mkdir(literalTildeDir, { recursive: true });
      await fs.writeFile(path.join(literalTildeDir, "bad.js"), "const value = $DM_JSON;", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-literal-tilde-path", {
          command: 'node "~/bad.js"',
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates python scripts when interpreter is prefixed with env", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const pyPath = path.join(tmp, "bad.py");
      await fs.writeFile(pyPath, "payload = $DM_JSON", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-env-python", {
          command: "env python bad.py",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates python scripts when interpreter is prefixed with path-qualified env", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const pyPath = path.join(tmp, "bad.py");
      await fs.writeFile(pyPath, "payload = $DM_JSON", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-abs-env-python", {
          command: "/usr/bin/env python bad.py",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates node scripts when interpreter is prefixed with env", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const jsPath = path.join(tmp, "bad.js");
      await fs.writeFile(jsPath, "const value = $DM_JSON;", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-env-node", {
          command: "env node bad.js",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates the first positional python script operand when extra args follow", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "bad.py"), "payload = $DM_JSON", "utf-8");
      await fs.writeFile(path.join(tmp, "ghost.py"), "print('ok')", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-python-first-script", {
          command: "python bad.py ghost.py",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates python script operand even when trailing option values look like scripts", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "script.py"), "payload = $DM_JSON", "utf-8");
      await fs.writeFile(path.join(tmp, "out.py"), "print('ok')", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-python-trailing-option-value", {
          command: "python script.py --output out.py",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates the first positional node script operand when extra args follow", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "app.js"), "const value = $DM_JSON;", "utf-8");
      await fs.writeFile(path.join(tmp, "config.js"), "console.log('ok')", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-node-first-script", {
          command: "node app.js config.js",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("still resolves node script when --require consumes a preceding .js option value", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "bootstrap.js"), "console.log('bootstrap')", "utf-8");
      await fs.writeFile(path.join(tmp, "app.js"), "const value = $DM_JSON;", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-node-require-script", {
          command: "node --require bootstrap.js app.js",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates node --require preload modules before a benign entry script", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "bad-preload.js"), "const value = $DM_JSON;", "utf-8");
      await fs.writeFile(path.join(tmp, "app.js"), "console.log('ok')", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-node-preload-before-entry", {
          command: "node --require bad-preload.js app.js",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates node --require preload modules when no entry script is provided", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "bad.js"), "const value = $DM_JSON;", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-node-require-only", {
          command: "node --require bad.js",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates node --import preload modules when no entry script is provided", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "bad.js"), "const value = $DM_JSON;", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-node-import-only", {
          command: "node --import bad.js",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates node --require preload modules even when -e is present", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "bad.js"), "const value = $DM_JSON;", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-node-require-with-eval", {
          command: 'node --require bad.js -e "console.log(123)"',
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates node --import preload modules even when -e is present", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "bad.js"), "const value = $DM_JSON;", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-node-import-with-eval", {
          command: 'node --import bad.js -e "console.log(123)"',
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("skips script-file preflight in yolo host mode", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const jsPath = path.join(tmp, "bad.js");
      await fs.writeFile(jsPath, "const value = $DM_JSON;", "utf-8");

      const tool = createExecTool({
        host: "gateway",
        security: "full",
        ask: "off",
        allowBackground: false,
      });
      const result = await tool.execute("call-yolo-bad-js", {
        command: "node bad.js",
        workdir: tmp,
      });
      const text = result.content.find((c) => c.type === "text")?.text ?? "";

      expect(text).not.toMatch(/exec preflight:/);
      expect(result.details).toMatchObject({
        status: expect.stringMatching(/completed|failed/),
      });
    });
  });

  it("runs heredoc-backed node commands in yolo host mode", async () => {
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      allowBackground: false,
    });
    const result = await tool.execute("call-yolo-heredoc", {
      command: "node <<'NODE'\nprocess.stdout.write('ok')\nNODE",
    });
    const text = result.content.find((c) => c.type === "text")?.text?.trim();

    expect(result.details).toMatchObject({ status: "completed" });
    expect(text).toBe("ok");
  });

  it("skips preflight file reads for script paths outside the workdir", async () => {
    await withTempDir("openclaw-exec-preflight-parent-", async (parent) => {
      const outsidePath = path.join(parent, "outside.js");
      const workdir = path.join(parent, "workdir");
      await fs.mkdir(workdir, { recursive: true });
      await fs.writeFile(outsidePath, "const value = $DM_JSON;", "utf-8");

      await expect(
        validateExecScriptPreflight({
          command: "node ../outside.js",
          workdir,
        }),
      ).resolves.toBeUndefined();
    });
  });

  it("does not trust a swapped script pathname between validation and read", async () => {
    await expectSymlinkSwapDuringPreflightToAvoidErrors({
      hookName: "afterPreOpenLstat",
    });
  });

  it("handles pre-open symlink swaps without surfacing preflight errors", async () => {
    await expectSymlinkSwapDuringPreflightToAvoidErrors({
      hookName: "beforeOpen",
    });
  });

  it("opens preflight script reads with O_NONBLOCK to avoid FIFO stalls", async () => {
    await withTempDir("openclaw-exec-preflight-nonblock-", async (tmp) => {
      const scriptPath = path.join(tmp, "script.js");
      await fs.writeFile(scriptPath, 'console.log("ok")', "utf-8");
      const scriptRealPath = await fs.realpath(scriptPath);

      const scriptOpenFlags: number[] = [];
      __setFsSafeTestHooksForTest({
        beforeOpen: (target, flags) => {
          if (path.resolve(target) === scriptRealPath) {
            scriptOpenFlags.push(flags);
          }
        },
      });

      await expect(
        validateExecScriptPreflight({
          command: "node script.js",
          workdir: tmp,
        }),
      ).resolves.toBeUndefined();
      expect(scriptOpenFlags.length).toBeGreaterThan(0);
      expect(scriptOpenFlags.some((flags) => (flags & fsConstants.O_NONBLOCK) !== 0)).toBe(true);
    });
  });

  const failClosedCases = [
    ["piped interpreter command", "cat bad.py | python"],
    ["top-level control-flow", "if true; then python bad.py; fi"],
    ["multiline top-level control-flow", "if true; then\npython bad.py\nfi"],
    ["shell-wrapped quoted script path", `bash -c "python 'bad.py'"`],
    ["top-level control-flow with quoted script path", 'if true; then python "bad.py"; fi'],
    ["shell-wrapped interpreter", 'bash -c "python bad.py"'],
    ["shell-wrapped control-flow payload", 'bash -c "if true; then python bad.py; fi"'],
    ["env-prefixed shell wrapper", 'env bash -c "python bad.py"'],
    ["absolute shell path", '/bin/bash -c "python bad.py"'],
    ["long option with separate value", 'bash --rcfile shell.rc -c "python bad.py"'],
    ["leading long options", 'bash --noprofile --norc -c "python bad.py"'],
    ["combined shell flags", 'bash -xc "python bad.py"'],
    ["-O option value", 'bash -O extglob -c "python bad.py"'],
    ["-o option value", 'bash -o errexit -c "python bad.py"'],
    ["-c not trailing short flag", 'bash -ceu "python bad.py"'],
    ["process substitution", "python <(cat bad.py)"],
  ] as const;

  it.each(failClosedCases)("fails closed for %s", async (_name, command) => {
    await expect(
      validateExecScriptPreflight({
        command,
        workdir: process.cwd(),
      }),
    ).rejects.toThrow(/exec preflight: complex interpreter invocation detected/);
  });

  const passCases = [
    ["shell-wrapped echoed interpreter words", 'bash -c "echo python"'],
    ["direct inline interpreter command", 'node -e "console.log(123)"'],
    ["interpreter and script hints only in echoed text", "echo 'python bad.py | python'"],
    ["shell keyword-like text only as echo arguments", "echo time python bad.py; cat"],
    ["pipeline containing only interpreter words as plain text", "echo python | cat"],
    ["non-executing pipeline that only prints interpreter words", "printf node | wc -c"],
    ["script-like text in a separate command segment", "echo bad.py; python --version"],
    ["script hints outside interpreter segment with &&", "node --version && ls *.py"],
    [
      "piped interpreter version command with script-like upstream text",
      "echo bad.py | node --version",
    ],
    ["piped node -c command with script-like upstream text", "echo bad.py | node -c ok.js"],
    [
      "piped node -e command with inline script-like text",
      "node -e \"console.log('bad.py')\" | cat",
    ],
    ["escaped shell operator characters", "echo python bad.py \\| node"],
    ["escaped semicolons with interpreter hints", "echo python bad.py \\; node"],
    ["node -e with .py inside quoted inline code", "node -e \"console.log('bad.py')\""],
  ] as const;

  it.each(passCases)("does not fail closed for %s", async (_name, command) => {
    await expect(
      validateExecScriptPreflight({
        command,
        workdir: process.cwd(),
      }),
    ).resolves.toBeUndefined();
  });
});

describeWin("exec script preflight on windows path syntax", () => {
  it("preserves windows-style python relative path separators during script extraction", async () => {
    await withTempDir("openclaw-exec-preflight-win-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "bad.py"), "payload = $DM_JSON", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-win-python-relative", {
          command: "python .\\bad.py",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("preserves windows-style node relative path separators during script extraction", async () => {
    await withTempDir("openclaw-exec-preflight-win-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "bad.js"), "const value = $DM_JSON;", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-win-node-relative", {
          command: "node .\\bad.js",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("preserves windows-style python absolute drive paths during script extraction", async () => {
    await withTempDir("openclaw-exec-preflight-win-", async (tmp) => {
      const absPath = path.join(tmp, "bad.py");
      await fs.writeFile(absPath, "payload = $DM_JSON", "utf-8");
      const winAbsPath = absPath.replaceAll("/", "\\");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-win-python-absolute", {
          command: `python "${winAbsPath}"`,
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("preserves windows-style nested relative path separators during script extraction", async () => {
    await withTempDir("openclaw-exec-preflight-win-", async (tmp) => {
      await fs.mkdir(path.join(tmp, "subdir"), { recursive: true });
      await fs.writeFile(path.join(tmp, "subdir", "bad.py"), "payload = $DM_JSON", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-win-python-subdir-relative", {
          command: "python subdir\\bad.py",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });
});

describe("exec interpreter heuristics ReDoS guard", () => {
  it("does not hang on long commands with VAR=value assignments and whitespace-heavy text", async () => {
    // Simulate a heredoc with HTML content after a VAR= assignment. Keep the
    // command parser check direct so no shell process timing hides regex cost.
    const htmlBlock = '<section style="padding: 30px 20px; font-family: Arial;">'.repeat(50);
    const command = `ACCESS_TOKEN=$(__openclaw_missing_redos_guard__)\ncat > /tmp/out.html << 'EOF'\n${htmlBlock}\nEOF`;

    const start = Date.now();
    await validateExecScriptPreflight({ command, workdir: process.cwd() });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });
});
