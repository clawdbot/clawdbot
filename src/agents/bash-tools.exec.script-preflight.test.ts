/**
 * Exec script preflight tests.
 * Covers Python/Node script file validation, shell-bleed detection, and
 * symlink/path race handling before execution.
 */
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectUnsafeExecControlShellCommand } from "../infra/exec-control-command-guard.js";
import { prepareSystemRunMutableFileApproval } from "../infra/system-run-approval-binding.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { validateScriptFileForShellBleed } from "./bash-tools.exec-script-preflight.js";
import type { ExecToolApprovalReview, ExecToolDetails } from "./bash-tools.exec-types.js";
import type { AgentToolResult } from "./runtime/index.js";

const processGatewayAllowlistMock = vi.hoisted(() =>
  vi.fn(
    async (_params?: {
      onApprovalReview?: (review: ExecToolApprovalReview) => void;
    }): Promise<{
      allowWithoutEnforcedCommand: boolean;
      revalidateBeforeExecution?: () => Promise<AgentToolResult<ExecToolDetails> | undefined>;
    }> => ({ allowWithoutEnforcedCommand: true }),
  ),
);

vi.mock("./bash-tools.exec-host-gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bash-tools.exec-host-gateway.js")>()),
  processGatewayAllowlist: processGatewayAllowlistMock,
}));

vi.mock("./bash-tools.exec-host-node.js", () => ({
  executeNodeHostCommand: async () => {
    throw new Error("node host execution is not used by script preflight tests");
  },
}));

vi.mock("../utils/delivery-context.shared.js", () => ({
  normalizeDeliveryContext: (value: unknown) => value,
}));

const isWin = process.platform === "win32";

const describeNonWin = isWin ? describe.skip : describe;
const describeWin = isWin ? describe : describe.skip;
const createPreflightTool = () =>
  createExecTool({ host: "gateway", security: "full", ask: "on-miss" });
const runExecPreflight = (params: { command: string; workdir: string }) =>
  createPreflightTool().execute("call-script-preflight", params);

afterEach(() => {
  __setFsSafeTestHooksForTest();
});

beforeEach(() => {
  processGatewayAllowlistMock.mockReset();
  processGatewayAllowlistMock.mockResolvedValue({ allowWithoutEnforcedCommand: true });
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
      runExecPreflight({
        command: "node script.js",
        workdir,
      }),
    ).resolves.toBeDefined();
    expect(swapped).toBe(true);
  });
}

describe("exec interactive OpenClaw channel login guard", () => {
  it("recognizes direct and package-runner channel login commands before execution", async () => {
    await expect(
      detectUnsafeExecControlShellCommand("openclaw channels login --channel whatsapp"),
    ).resolves.toBe("channel-login");
    expect(
      await detectUnsafeExecControlShellCommand(
        "pnpm exec openclaw channels login --channel whatsapp --verbose",
      ),
    ).toBe("channel-login");
    await expect(
      detectUnsafeExecControlShellCommand("openclaw channels status --deep"),
    ).resolves.toBeNull();
  });

  it("blocks interactive channel login commands from exec", async () => {
    const tool = createPreflightTool();

    await expect(
      tool.execute("call-openclaw-channel-login", {
        command: "openclaw channels login --channel whatsapp --verbose",
      }),
    ).rejects.toThrow(/exec cannot run interactive OpenClaw channel login commands/);
    await expect(
      tool.execute("call-wrapped-openclaw-channel-login", {
        command: "sudo -u openclaw bash -lc 'openclaw channels login --channel whatsapp'",
      }),
    ).rejects.toThrow(/exec cannot run interactive OpenClaw channel login commands/);
    await expect(
      tool.execute("call-clustered-sudo-channel-login", {
        command: "sudo -EH bash -lc 'openclaw channels login --channel whatsapp'",
      }),
    ).rejects.toThrow(/exec cannot run interactive OpenClaw channel login commands/);
    await expect(
      tool.execute("call-deep-env-channel-login", {
        command: "env env env env env env openclaw channels login --channel whatsapp",
      }),
    ).rejects.toThrow(/exec cannot run interactive OpenClaw channel login commands/);
    await expect(
      tool.execute("call-env-s-trailing-channel-login", {
        command: "env -S 'openclaw channels' login --channel whatsapp",
      }),
    ).rejects.toThrow(/exec cannot run interactive OpenClaw channel login commands/);
  });
});

describeNonWin("exec script preflight", () => {
  it.each([
    { name: "denies changed bytes", mutate: true },
    { name: "executes unchanged bytes", mutate: false },
  ])("revalidates gateway approval script operands before spawn: $name", async ({ mutate }) => {
    await withTempDir("openclaw-exec-approval-binding-", async (tmp) => {
      const script = path.join(tmp, "script.sh");
      await fs.writeFile(script, "#!/bin/sh\necho approved\n");
      const prepared = await prepareSystemRunMutableFileApproval({
        command: "sh script.sh",
        cwd: tmp,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) {
        throw new Error(prepared.message);
      }
      const approvalReview: ExecToolApprovalReview = {
        id: "guardian:call-script-preflight",
        label: "Guardian",
        status: "approved",
      };
      processGatewayAllowlistMock.mockImplementationOnce(async (params) => {
        params?.onApprovalReview?.(approvalReview);
        return {
          allowWithoutEnforcedCommand: true,
          revalidateBeforeExecution: async () => {
            const current = await prepared.revalidate();
            if (current.ok) {
              return undefined;
            }
            return {
              content: [{ type: "text", text: current.message }],
              details: {
                status: "failed",
                exitCode: null,
                durationMs: 0,
                aggregated: current.message,
                timedOut: false,
                cwd: tmp,
              },
            };
          },
        };
      });
      if (mutate) {
        await fs.writeFile(script, "#!/bin/sh\necho mutated\n");
      }

      const result = await runExecPreflight({ command: "sh script.sh", workdir: tmp });

      if (mutate) {
        expect(result.details.status).toBe("failed");
        expect(result.content[0]).toEqual(
          expect.objectContaining({
            text: expect.stringContaining("approval script operand changed before execution"),
          }),
        );
      } else {
        expect(result.details.status).toBe("completed");
        if (result.details.status !== "completed") {
          throw new Error("expected completed exec result");
        }
        expect(result.details.aggregated).toBe("approved");
      }
      expect(result.details).toMatchObject({
        approvalReviewOutcome: "approved",
        approvalReviews: [approvalReview],
      });
    });
  });

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

  it.each([
    {
      name: "a quoted script path",
      callId: "call-quoted",
      fileName: "bad.js",
      command: 'node "bad.js"',
    },
    {
      name: "an in-workdir script whose name starts with '..'",
      callId: "call-dotdot-prefix-script",
      fileName: "..bad.js",
      command: "node ..bad.js",
    },
  ])("blocks shell env var injection through $name", async ({ callId, fileName, command }) => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const jsPath = path.join(tmp, fileName);
      await fs.writeFile(jsPath, "const value = $DM_JSON;", "utf-8");

      const tool = createPreflightTool();
      await expect(tool.execute(callId, { command, workdir: tmp })).rejects.toThrow(
        /exec preflight: detected likely shell variable injection \(\$DM_JSON\)/,
      );
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

  it.each([
    {
      name: "python behind env",
      callId: "call-env-python",
      fileName: "bad.py",
      contents: "payload = $DM_JSON",
      command: "env python bad.py",
    },
    {
      name: "python behind path-qualified env",
      callId: "call-abs-env-python",
      fileName: "bad.py",
      contents: "payload = $DM_JSON",
      command: "/usr/bin/env python bad.py",
    },
    {
      name: "node behind env",
      callId: "call-env-node",
      fileName: "bad.js",
      contents: "const value = $DM_JSON;",
      command: "env node bad.js",
    },
  ])("validates $name", async ({ callId, fileName, contents, command }) => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      await fs.writeFile(path.join(tmp, fileName), contents, "utf-8");

      const tool = createPreflightTool();
      await expect(tool.execute(callId, { command, workdir: tmp })).rejects.toThrow(
        /exec preflight: detected likely shell variable injection \(\$DM_JSON\)/,
      );
    });
  });

  it.each([
    {
      name: "the first positional python script before extra args",
      callId: "call-python-first-script",
      command: "python bad.py ghost.py",
      files: [
        { fileName: "bad.py", contents: "payload = $DM_JSON" },
        { fileName: "ghost.py", contents: "print('ok')" },
      ],
    },
    {
      name: "a python script before a trailing option value that looks like a script",
      callId: "call-python-trailing-option-value",
      command: "python script.py --output out.py",
      files: [
        { fileName: "script.py", contents: "payload = $DM_JSON" },
        { fileName: "out.py", contents: "print('ok')" },
      ],
    },
    {
      name: "the first positional node script before extra args",
      callId: "call-node-first-script",
      command: "node app.js config.js",
      files: [
        { fileName: "app.js", contents: "const value = $DM_JSON;" },
        { fileName: "config.js", contents: "console.log('ok')" },
      ],
    },
    {
      name: "the node script after --require consumes a preceding .js option value",
      callId: "call-node-require-script",
      command: "node --require bootstrap.js app.js",
      files: [
        { fileName: "bootstrap.js", contents: "console.log('bootstrap')" },
        { fileName: "app.js", contents: "const value = $DM_JSON;" },
      ],
    },
  ])("validates $name", async ({ callId, command, files }) => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      for (const { fileName, contents } of files) {
        await fs.writeFile(path.join(tmp, fileName), contents, "utf-8");
      }

      const tool = createPreflightTool();
      await expect(tool.execute(callId, { command, workdir: tmp })).rejects.toThrow(
        /exec preflight: detected likely shell variable injection \(\$DM_JSON\)/,
      );
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

  it.each([
    {
      name: "--require preload modules when no entry script is provided",
      callId: "call-node-require-only",
      command: "node --require bad.js",
    },
    {
      name: "--import preload modules when no entry script is provided",
      callId: "call-node-import-only",
      command: "node --import bad.js",
    },
    {
      name: "--require preload modules when -e is present",
      callId: "call-node-require-with-eval",
      command: 'node --require bad.js -e "console.log(123)"',
    },
    {
      name: "--import preload modules when -e is present",
      callId: "call-node-import-with-eval",
      command: 'node --import bad.js -e "console.log(123)"',
    },
  ])("validates node $name", async ({ callId, command }) => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "bad.js"), "const value = $DM_JSON;", "utf-8");

      const tool = createPreflightTool();
      await expect(tool.execute(callId, { command, workdir: tmp })).rejects.toThrow(
        /exec preflight: detected likely shell variable injection \(\$DM_JSON\)/,
      );
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
      expect((result.details as { status?: string }).status).toMatch(/completed|failed/);
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

    expect((result.details as { status?: string }).status).toBe("completed");
    expect(text).toBe("ok");
  });

  it("skips preflight file reads for script paths outside the workdir", async () => {
    await withTempDir("openclaw-exec-preflight-parent-", async (parent) => {
      const outsidePath = path.join(parent, "outside.js");
      const workdir = path.join(parent, "workdir");
      await fs.mkdir(workdir, { recursive: true });
      await fs.writeFile(outsidePath, "const value = $DM_JSON;", "utf-8");

      await expect(
        runExecPreflight({
          command: "node ../outside.js",
          workdir,
        }),
      ).resolves.toBeDefined();
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
        runExecPreflight({
          command: "node script.js",
          workdir: tmp,
        }),
      ).resolves.toBeDefined();
      expect(scriptOpenFlags).not.toStrictEqual([]);
      expect(scriptOpenFlags.every((flags) => (flags & fsConstants.O_NONBLOCK) !== 0)).toBe(true);
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
      runExecPreflight({
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
      runExecPreflight({
        command,
        workdir: process.cwd(),
      }),
    ).resolves.toBeDefined();
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
    const htmlBlock = '<section style="padding: 30px 20px; font-family: Arial;">'.repeat(50);
    const command = `ACCESS_TOKEN=$(__openclaw_missing_redos_guard__)\nprintf '%s' '${htmlBlock}' >/dev/null`;

    const start = Date.now();
    await validateScriptFileForShellBleed({ command, workdir: process.cwd() });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });
});
