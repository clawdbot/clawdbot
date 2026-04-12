import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __setFsSafeTestHooksForTest } from "../infra/fs-safe.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { createExecTool } from "./bash-tools.exec.js";

const isWin = process.platform === "win32";

const describeNonWin = isWin ? describe.skip : describe;
const describeWin = isWin ? describe : describe.skip;

afterEach(() => {
  __setFsSafeTestHooksForTest();
});

async function expectSymlinkSwapDuringPreflightToAvoidErrors(params: {
  hookName: "afterPreOpenLstat" | "beforeOpen";
  callId: string;
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

    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
    const result = await tool.execute(params.callId, {
      command: "node script.js",
      workdir,
    });
    const text = result.content.find((block) => block.type === "text")?.text ?? "";
    expect(swapped).toBe(true);
    expect(text).not.toMatch(/exec preflight:/);
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

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

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

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

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

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
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

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
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

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
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

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
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

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
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

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
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

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
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

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
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

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
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

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
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

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
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

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
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

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
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

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
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

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
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

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
      await expect(
        tool.execute("call-node-import-with-eval", {
          command: 'node --import bad.js -e "console.log(123)"',
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("skips preflight file reads for script paths outside the workdir", async () => {
    await withTempDir("openclaw-exec-preflight-parent-", async (parent) => {
      const outsidePath = path.join(parent, "outside.js");
      const workdir = path.join(parent, "workdir");
      await fs.mkdir(workdir, { recursive: true });
      await fs.writeFile(outsidePath, "const value = $DM_JSON;", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      const result = await tool.execute("call-outside", {
        command: "node ../outside.js",
        workdir,
      });
      const text = result.content.find((block) => block.type === "text")?.text ?? "";
      expect(text).not.toMatch(/exec preflight:/);
    });
  });

  it("does not trust a swapped script pathname between validation and read", async () => {
    await expectSymlinkSwapDuringPreflightToAvoidErrors({
      hookName: "afterPreOpenLstat",
      callId: "call-swapped-pathname",
    });
  });

  it("handles pre-open symlink swaps without surfacing preflight errors", async () => {
    await expectSymlinkSwapDuringPreflightToAvoidErrors({
      hookName: "beforeOpen",
      callId: "call-pre-open-swapped-pathname",
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

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
      const result = await tool.execute("call-nonblocking-preflight-open", {
        command: "node script.js",
        workdir: tmp,
      });
      const text = result.content.find((block) => block.type === "text")?.text ?? "";
      expect(scriptOpenFlags.length).toBeGreaterThan(0);
      expect(scriptOpenFlags.some((flags) => (flags & fsConstants.O_NONBLOCK) !== 0)).toBe(true);
      expect(text).not.toMatch(/exec preflight:/);
    });
  });

  it("fails closed for piped interpreter commands that bypass direct script parsing", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const pyPath = path.join(tmp, "bad.py");
      await fs.writeFile(pyPath, "payload = $DM_JSON", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      await expect(
        tool.execute("call-pipe", {
          command: "cat bad.py | python",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: complex interpreter invocation detected/);
    });
  });

  it("fails closed for top-level interpreter invocations inside shell control-flow", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const pyPath = path.join(tmp, "bad.py");
      await fs.writeFile(pyPath, "payload = $DM_JSON", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      await expect(
        tool.execute("call-top-level-control-flow", {
          command: "if true; then python bad.py; fi",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: complex interpreter invocation detected/);
    });
  });

  it("fails closed for multiline top-level control-flow interpreter invocations", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const pyPath = path.join(tmp, "bad.py");
      await fs.writeFile(pyPath, "payload = $DM_JSON", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      await expect(
        tool.execute("call-top-level-control-flow-multiline", {
          command: "if true; then\npython bad.py\nfi",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: complex interpreter invocation detected/);
    });
  });

  it("fails closed for shell-wrapped interpreter invocations with quoted script paths", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const pyPath = path.join(tmp, "bad.py");
      await fs.writeFile(pyPath, "payload = $DM_JSON", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      await expect(
        tool.execute("call-shell-wrap-quoted-script", {
          command: `bash -c "python '${path.basename(pyPath)}'"`,
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: complex interpreter invocation detected/);
    });
  });

  it("fails closed for top-level control-flow with quoted interpreter script paths", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const pyPath = path.join(tmp, "bad.py");
      await fs.writeFile(pyPath, "payload = $DM_JSON", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      await expect(
        tool.execute("call-top-level-control-flow-quoted-script", {
          command: 'if true; then python "bad.py"; fi',
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: complex interpreter invocation detected/);
    });
  });

  it("fails closed for shell-wrapped interpreter invocations", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const pyPath = path.join(tmp, "bad.py");
      await fs.writeFile(pyPath, "payload = $DM_JSON", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      await expect(
        tool.execute("call-shell-wrap", {
          command: 'bash -c "python bad.py"',
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: complex interpreter invocation detected/);
    });
  });

  it("does not fail closed for shell-wrapped payloads that only echo interpreter words", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      const result = await tool.execute("call-shell-wrap-echo-text", {
        command: 'bash -c "echo python"',
        workdir: tmp,
      });
      const text = result.content.find((block) => block.type === "text")?.text ?? "";
      expect(text).toContain("python");
      expect(text).not.toMatch(/exec preflight:/);
    });
  });

  it("fails closed for shell-wrapped interpreter invocations inside control-flow payloads", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const pyPath = path.join(tmp, "bad.py");
      await fs.writeFile(pyPath, "payload = $DM_JSON", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      await expect(
        tool.execute("call-shell-wrap-control-flow", {
          command: 'bash -c "if true; then python bad.py; fi"',
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: complex interpreter invocation detected/);
    });
  });

  it("fails closed for env-prefixed shell-wrapped interpreter invocations", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const pyPath = path.join(tmp, "bad.py");
      await fs.writeFile(pyPath, "payload = $DM_JSON", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      await expect(
        tool.execute("call-env-shell-wrap", {
          command: 'env bash -c "python bad.py"',
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: complex interpreter invocation detected/);
    });
  });

  it("fails closed for shell-wrapped interpreter invocations via absolute shell paths", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const pyPath = path.join(tmp, "bad.py");
      await fs.writeFile(pyPath, "payload = $DM_JSON", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      await expect(
        tool.execute("call-shell-wrap-abs-path", {
          command: '/bin/bash -c "python bad.py"',
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: complex interpreter invocation detected/);
    });
  });

  it("fails closed for shell-wrapped interpreter invocations when long options take separate values", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const pyPath = path.join(tmp, "bad.py");
      await fs.writeFile(pyPath, "payload = $DM_JSON", "utf-8");
      await fs.writeFile(path.join(tmp, "shell.rc"), "# rc", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      await expect(
        tool.execute("call-shell-wrap-long-option-value", {
          command: 'bash --rcfile shell.rc -c "python bad.py"',
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: complex interpreter invocation detected/);
    });
  });

  it("fails closed for shell-wrapped interpreter invocations with leading long options", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const pyPath = path.join(tmp, "bad.py");
      await fs.writeFile(pyPath, "payload = $DM_JSON", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      await expect(
        tool.execute("call-shell-wrap-long-options", {
          command: 'bash --noprofile --norc -c "python bad.py"',
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: complex interpreter invocation detected/);
    });
  });

  it("fails closed for shell-wrapped interpreter invocations with combined shell flags", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const pyPath = path.join(tmp, "bad.py");
      await fs.writeFile(pyPath, "payload = $DM_JSON", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      await expect(
        tool.execute("call-shell-wrap-combined", {
          command: 'bash -xc "python bad.py"',
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: complex interpreter invocation detected/);
    });
  });

  it("fails closed for shell-wrapped interpreter invocations when -O consumes a separate value", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const pyPath = path.join(tmp, "bad.py");
      await fs.writeFile(pyPath, "payload = $DM_JSON", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      await expect(
        tool.execute("call-shell-wrap-short-option-O-value", {
          command: 'bash -O extglob -c "python bad.py"',
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: complex interpreter invocation detected/);
    });
  });

  it("fails closed for shell-wrapped interpreter invocations when -o consumes a separate value", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const pyPath = path.join(tmp, "bad.py");
      await fs.writeFile(pyPath, "payload = $DM_JSON", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      await expect(
        tool.execute("call-shell-wrap-short-option-o-value", {
          command: 'bash -o errexit -c "python bad.py"',
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: complex interpreter invocation detected/);
    });
  });

  it("fails closed for shell-wrapped interpreter invocations when -c is not the trailing short flag", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const pyPath = path.join(tmp, "bad.py");
      await fs.writeFile(pyPath, "payload = $DM_JSON", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      await expect(
        tool.execute("call-shell-wrap-short-flags", {
          command: 'bash -ceu "python bad.py"',
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: complex interpreter invocation detected/);
    });
  });

  it("fails closed for process-substitution interpreter invocations", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const pyPath = path.join(tmp, "bad.py");
      await fs.writeFile(pyPath, "payload = $DM_JSON", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      await expect(
        tool.execute("call-process-substitution", {
          command: "python <(cat bad.py)",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: complex interpreter invocation detected/);
    });
  });

  it("allows direct inline interpreter commands with no script file hint", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      const result = await tool.execute("call-inline", {
        command: 'node -e "console.log(123)"',
        workdir: tmp,
      });
      const text = result.content.find((block) => block.type === "text")?.text ?? "";
      expect(text).toContain("123");
      expect(text).not.toMatch(/exec preflight:/);
    });
  });

  it("does not fail closed when interpreter and script hints only appear in echoed text", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      const result = await tool.execute("call-echo-text", {
        command: "echo 'python bad.py | python'",
        workdir: tmp,
      });
      const text = result.content.find((block) => block.type === "text")?.text ?? "";
      expect(text).toContain("python bad.py | python");
      expect(text).not.toMatch(/exec preflight:/);
    });
  });

  it("does not fail closed when shell keyword-like text appears only as echo arguments", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      const result = await tool.execute("call-echo-keyword-like-text", {
        command: "echo time python bad.py; cat",
        workdir: tmp,
      });
      const text = result.content.find((block) => block.type === "text")?.text ?? "";
      expect(text).toContain("time python bad.py");
      expect(text).not.toMatch(/exec preflight:/);
    });
  });

  it("does not fail closed for pipelines that only contain interpreter words as plain text", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      const result = await tool.execute("call-echo-pipe-text", {
        command: "echo python | cat",
        workdir: tmp,
      });
      const text = result.content.find((block) => block.type === "text")?.text ?? "";
      expect(text).toContain("python");
      expect(text).not.toMatch(/exec preflight:/);
    });
  });

  it("does not fail closed for non-executing pipelines that only print interpreter words", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      const result = await tool.execute("call-printf-pipe-text", {
        command: "printf node | wc -c",
        workdir: tmp,
      });
      const text = result.content.find((block) => block.type === "text")?.text ?? "";
      expect(text).toContain("4");
      expect(text).not.toMatch(/exec preflight:/);
    });
  });

  it("does not fail closed when script-like text is in a separate command segment", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      const result = await tool.execute("call-separate-script-hint-segment", {
        command: "echo bad.py; python --version",
        workdir: tmp,
      });
      const text = result.content.find((block) => block.type === "text")?.text ?? "";
      expect(text).toContain("bad.py");
      expect(text).not.toMatch(/exec preflight:/);
    });
  });

  it("does not fail closed when script hints appear outside the interpreter segment with &&", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "sample.py"), "print('ok')", "utf-8");
      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      const result = await tool.execute("call-interpreter-version-and-list", {
        command: "node --version && ls *.py",
        workdir: tmp,
      });
      const text = result.content.find((block) => block.type === "text")?.text ?? "";
      expect(text).toContain("sample.py");
      expect(text).not.toMatch(/exec preflight:/);
    });
  });

  it("does not fail closed for piped interpreter version commands with script-like upstream text", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      const result = await tool.execute("call-piped-interpreter-version", {
        command: "echo bad.py | node --version",
        workdir: tmp,
      });
      const text = result.content.find((block) => block.type === "text")?.text ?? "";
      expect(text).toMatch(/v\d+/);
      expect(text).not.toMatch(/exec preflight:/);
    });
  });

  it("does not fail closed for piped node -c syntax-check commands with script-like upstream text", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "ok.js"), "console.log('ok')", "utf-8");
      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      const result = await tool.execute("call-piped-node-check", {
        command: "echo bad.py | node -c ok.js",
        workdir: tmp,
      });
      const text = result.content.find((block) => block.type === "text")?.text ?? "";
      expect(text).not.toMatch(/exec preflight:/);
    });
  });

  it("does not fail closed for piped node -e commands when inline code contains script-like text", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      const result = await tool.execute("call-piped-node-e-inline-script-hint", {
        command: "node -e \"console.log('bad.py')\" | cat",
        workdir: tmp,
      });
      const text = result.content.find((block) => block.type === "text")?.text ?? "";
      expect(text).toContain("bad.py");
      expect(text).not.toMatch(/exec preflight:/);
    });
  });

  it("does not fail closed when shell operator characters are escaped", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      const result = await tool.execute("call-echo-escaped-operator", {
        command: "echo python bad.py \\| node",
        workdir: tmp,
      });
      const text = result.content.find((block) => block.type === "text")?.text ?? "";
      expect(text).toContain("python bad.py | node");
      expect(text).not.toMatch(/exec preflight:/);
    });
  });

  it("does not fail closed when escaped semicolons appear with interpreter hints", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      const result = await tool.execute("call-echo-escaped-semicolon", {
        command: "echo python bad.py \\; node",
        workdir: tmp,
      });
      const text = result.content.find((block) => block.type === "text")?.text ?? "";
      expect(text).toContain("python bad.py ; node");
      expect(text).not.toMatch(/exec preflight:/);
    });
  });

  it("does not fail closed for node -e when .py appears inside quoted inline code", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      const result = await tool.execute("call-inline-script-hint", {
        command: "node -e \"console.log('bad.py')\"",
        workdir: tmp,
      });
      const text = result.content.find((block) => block.type === "text")?.text ?? "";
      expect(text).toContain("bad.py");
      expect(text).not.toMatch(/exec preflight:/);
    });
  });
});

describeWin("exec script preflight on windows path syntax", () => {
  it("preserves windows-style python relative path separators during script extraction", async () => {
    await withTempDir("openclaw-exec-preflight-win-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "bad.py"), "payload = $DM_JSON", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
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

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
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

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
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

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
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
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
    // Simulate a heredoc with HTML content after a VAR= assignment. Keep the
    // command-substitution failure local so the test measures parser behavior,
    // not external network timing.
    const htmlBlock = '<section style="padding: 30px 20px; font-family: Arial;">'.repeat(50);
    const command = `ACCESS_TOKEN=$(__openclaw_missing_redos_guard__)\ncat > /tmp/out.html << 'EOF'\n${htmlBlock}\nEOF`;

    const start = Date.now();
    // The command itself will fail — we only care that the interpreter
    // heuristics analysis completes without hanging.
    try {
      await Promise.race([
        tool.execute("redos-guard", { command }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("ReDoS: regex hung for >5s")), 5000),
        ),
      ]);
    } catch (e) {
      // Any error EXCEPT the timeout is acceptable — it means the regex finished
      if (e instanceof Error && e.message.includes("ReDoS")) {
        throw e;
      }
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });
});
