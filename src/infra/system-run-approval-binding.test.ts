// Covers system-run approval binding normalization and matching.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE,
  buildSystemRunApprovalBinding,
  buildSystemRunApprovalEnvBinding,
  matchSystemRunApprovalBinding,
  missingSystemRunApprovalBinding,
  normalizeSystemRunApprovalPlan,
  prepareSystemRunMutableFileBinding,
  revalidateSystemRunMutableFileBinding,
} from "./system-run-approval-binding.js";

function expectOk<T extends { ok: boolean }>(result: T): T & { ok: true } {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("unreachable");
  }
  return result as T & { ok: true };
}

describe("normalizeSystemRunApprovalPlan", () => {
  it.each([
    {
      name: "accepts commandText and normalized mutable file operands",
      input: {
        argv: ["bash", "-lc", "echo hi"],
        commandText: 'bash -lc "echo hi"',
        commandPreview: "echo hi",
        cwd: " /tmp ",
        agentId: " main ",
        sessionKey: " agent:main:main ",
        mutableFileOperand: {
          argvIndex: 2,
          path: " /tmp/payload.txt ",
          sha256: " abc123 ",
        },
      },
      expected: {
        argv: ["bash", "-lc", "echo hi"],
        commandText: 'bash -lc "echo hi"',
        commandPreview: "echo hi",
        cwd: "/tmp",
        agentId: "main",
        sessionKey: "agent:main:main",
        mutableFileOperand: {
          argvIndex: 2,
          path: "/tmp/payload.txt",
          sha256: "abc123",
        },
      },
    },
    {
      name: "accepts and canonicalizes a prepared policy snapshot",
      input: {
        argv: ["echo", "hi"],
        commandText: "echo hi",
        policySnapshot: {
          security: "allowlist",
          ask: "on-miss",
          askFallback: "deny",
          autoAllowSkills: false,
          allowlistRules: [
            { pattern: "/usr/bin/zsh", source: "allow-always" },
            { pattern: "/usr/bin/echo" },
            { pattern: "/usr/bin/echo" },
          ],
        },
      },
      expected: {
        argv: ["echo", "hi"],
        commandText: "echo hi",
        commandPreview: null,
        cwd: null,
        agentId: null,
        sessionKey: null,
        policySnapshot: {
          security: "allowlist",
          ask: "on-miss",
          askFallback: "deny",
          autoAllowSkills: false,
          allowlistRules: [
            { pattern: "/usr/bin/echo" },
            { pattern: "/usr/bin/zsh", source: "allow-always" },
          ],
        },
        mutableFileOperand: undefined,
      },
    },
    {
      name: "uses locale-independent UTF-8 ordering for portable policy rules",
      input: {
        argv: ["echo", "hi"],
        commandText: "echo hi",
        policySnapshot: {
          security: "allowlist",
          ask: "always",
          askFallback: "deny",
          autoAllowSkills: false,
          allowlistRules: [
            { pattern: "/😀" },
            { pattern: "/A", argPattern: "z" },
            { pattern: "/é" },
            { pattern: "/A", source: "allow-always" },
            { pattern: "/a" },
            { pattern: "/A" },
            { pattern: "/A", argPattern: "A" },
          ],
        },
      },
      expected: {
        argv: ["echo", "hi"],
        commandText: "echo hi",
        commandPreview: null,
        cwd: null,
        agentId: null,
        sessionKey: null,
        policySnapshot: {
          security: "allowlist",
          ask: "always",
          askFallback: "deny",
          autoAllowSkills: false,
          allowlistRules: [
            { pattern: "/A" },
            { pattern: "/A", source: "allow-always" },
            { pattern: "/A", argPattern: "A" },
            { pattern: "/A", argPattern: "z" },
            { pattern: "/a" },
            { pattern: "/é" },
            { pattern: "/😀" },
          ],
        },
        mutableFileOperand: undefined,
      },
    },
    {
      name: "falls back to rawCommand",
      input: {
        argv: ["bash", "-lc", "echo hi"],
        rawCommand: 'bash -lc "echo hi"',
      },
      expected: {
        argv: ["bash", "-lc", "echo hi"],
        commandText: 'bash -lc "echo hi"',
        commandPreview: null,
        cwd: null,
        agentId: null,
        sessionKey: null,
        mutableFileOperand: undefined,
      },
    },
  ])("$name", ({ input, expected }) => {
    expect(normalizeSystemRunApprovalPlan(input)).toEqual(expected);
  });

  it("rejects invalid file operands", () => {
    expect(
      normalizeSystemRunApprovalPlan({
        argv: ["bash", "-lc", "echo hi"],
        commandText: 'bash -lc "echo hi"',
        mutableFileOperand: {
          argvIndex: -1,
          path: "/tmp/payload.txt",
          sha256: "abc123",
        },
      }),
    ).toBeNull();
  });

  it("rejects malformed prepared policy snapshots", () => {
    expect(
      normalizeSystemRunApprovalPlan({
        argv: ["echo", "hi"],
        commandText: "echo hi",
        policySnapshot: {
          security: "full",
          ask: "off",
          askFallback: "deny",
          autoAllowSkills: false,
          allowlistRules: [{ pattern: "valid" }, { pattern: 42 }],
        },
      }),
    ).toBeNull();
  });
});

describe("buildSystemRunApprovalEnvBinding", () => {
  it("normalizes, filters, and sorts env keys before hashing", () => {
    const normalized = buildSystemRunApprovalEnvBinding({
      z_key: "b",
      " bad key ": "ignored",
      alpha: "a",
      EMPTY: 1,
    });
    const reordered = buildSystemRunApprovalEnvBinding({
      alpha: "a",
      z_key: "b",
    });

    expect(normalized).toEqual({
      envHash: reordered.envHash,
      envKeys: ["alpha", "z_key"],
    });
    expect(normalized.envHash).toBeTypeOf("string");
    expect(normalized.envHash).toHaveLength(64);
  });

  it("returns a null hash when no usable env entries remain", () => {
    expect(buildSystemRunApprovalEnvBinding(null)).toEqual({
      envHash: null,
      envKeys: [],
    });
    expect(
      buildSystemRunApprovalEnvBinding({
        bad: 1,
      }),
    ).toEqual({
      envHash: null,
      envKeys: [],
    });
  });

  it("includes Windows-compatible override keys in env binding", () => {
    const base = buildSystemRunApprovalEnvBinding({
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
    });
    const changed = buildSystemRunApprovalEnvBinding({
      "ProgramFiles(x86)": "D:\\SDKs",
    });

    expect(base.envKeys).toEqual(["ProgramFiles(x86)"]);
    expect(base.envHash).toBeTypeOf("string");
    expect(base.envHash).not.toEqual(changed.envHash);
  });
});

describe("buildSystemRunApprovalBinding", () => {
  it("normalizes argv and metadata into a binding", () => {
    const envBinding = buildSystemRunApprovalEnvBinding({
      beta: "2",
      alpha: "1",
    });

    expect(
      buildSystemRunApprovalBinding({
        argv: ["bash", "-lc", 12],
        cwd: " /tmp ",
        agentId: " main ",
        sessionKey: " agent:main:main ",
        env: {
          beta: "2",
          alpha: "1",
        },
      }),
    ).toEqual({
      binding: {
        argv: ["bash", "-lc", "12"],
        cwd: "/tmp",
        agentId: "main",
        sessionKey: "agent:main:main",
        envHash: envBinding.envHash,
      },
      envKeys: ["alpha", "beta"],
    });
  });
});

describe("matchSystemRunApprovalBinding", () => {
  const expected = {
    argv: ["bash", "-lc", "echo hi"],
    cwd: "/tmp",
    agentId: "main",
    sessionKey: "agent:main:main",
    envHash: "abc",
  };

  it("accepts exact matches", () => {
    expectOk(
      matchSystemRunApprovalBinding({
        expected,
        actual: { ...expected },
        actualEnvKeys: ["ALPHA"],
      }),
    );
  });

  it.each([
    {
      name: "argv mismatch",
      actual: { ...expected, argv: ["bash", "-lc", "echo bye"] },
    },
    {
      name: "cwd mismatch",
      actual: { ...expected, cwd: "/var/tmp" },
    },
    {
      name: "agent mismatch",
      actual: { ...expected, agentId: "other" },
    },
    {
      name: "session mismatch",
      actual: { ...expected, sessionKey: "agent:main:other" },
    },
  ])("rejects $name", ({ actual }) => {
    expect(
      matchSystemRunApprovalBinding({
        expected,
        actual,
        actualEnvKeys: ["ALPHA"],
      }),
    ).toEqual({
      ok: false,
      code: "APPROVAL_REQUEST_MISMATCH",
      message: "approval id does not match request",
      details: undefined,
    });
  });
});

describe("missingSystemRunApprovalBinding", () => {
  it("reports env keys with request mismatches", () => {
    expect(missingSystemRunApprovalBinding({ actualEnvKeys: ["ALPHA", "BETA"] })).toEqual({
      ok: false,
      code: "APPROVAL_REQUEST_MISMATCH",
      message: "approval id does not match request",
      details: {
        envKeys: ["ALPHA", "BETA"],
      },
    });
  });
});

describe("mutable file operand binding", () => {
  it("binds every script in a compound command and detects drift", async () => {
    const cwd = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-system-run-binding-")),
    );
    const first = path.join(cwd, "first.sh");
    const second = path.join(cwd, "second.py");
    try {
      fs.writeFileSync(first, "#!/bin/sh\necho first\n");
      fs.writeFileSync(second, "print('second')\n");
      const command = { kind: "shell" as const, text: "sh first.sh && python3 second.py" };
      const prepared = expectOk(await prepareSystemRunMutableFileBinding({ command, cwd }));

      // Assert the script operands by path: a host whose interpreters live in a writable
      // prefix (Homebrew, asdf, nix profiles) also binds those executables, so an operand
      // count would only describe the host that ran the test.
      expect(
        prepared.binding.operands
          .filter((operand) => !operand.executable)
          .map((operand) => operand.snapshot.path),
      ).toEqual([first, second]);
      await expect(
        revalidateSystemRunMutableFileBinding({ binding: prepared.binding, cwd }),
      ).resolves.toEqual({ ok: true });

      fs.writeFileSync(second, "print('changed')\n");
      await expect(
        revalidateSystemRunMutableFileBinding({ binding: prepared.binding, cwd }),
      ).resolves.toEqual({
        ok: false,
        message: APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE,
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("binds direct script executables", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-system-run-direct-"));
    const script = path.join(cwd, "direct.sh");
    try {
      fs.writeFileSync(script, "#!/bin/sh\necho approved\n", { mode: 0o755 });
      const prepared = expectOk(
        await prepareSystemRunMutableFileBinding({
          command: { kind: "shell", text: "./direct.sh" },
          cwd,
        }),
      );
      expect(prepared.binding.operands).toHaveLength(1);

      fs.writeFileSync(script, "#!/bin/sh\necho changed\n", { mode: 0o755 });
      await expect(
        revalidateSystemRunMutableFileBinding({ binding: prepared.binding, cwd }),
      ).resolves.toEqual({
        ok: false,
        message: APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE,
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "accepts unchanged bytes", mutate: false },
    { name: "denies changed bytes", mutate: true },
  ])("revalidates transparent-wrapper executables: $name", async ({ mutate }) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-system-run-wrapper-"));
    const script = path.join(cwd, "wrapped.sh");
    try {
      fs.writeFileSync(script, "#!/bin/sh\necho approved\n", { mode: 0o755 });
      const prepared = expectOk(
        await prepareSystemRunMutableFileBinding({
          command: { kind: "shell", text: "env WRAPPED=1 ./wrapped.sh" },
          cwd,
        }),
      );
      expect(prepared.binding.operands).toHaveLength(1);
      if (mutate) {
        fs.writeFileSync(script, "#!/bin/sh\necho changed\n", { mode: 0o755 });
      }

      await expect(
        revalidateSystemRunMutableFileBinding({ binding: prepared.binding, cwd }),
      ).resolves.toEqual(
        mutate
          ? { ok: false, message: APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE }
          : { ok: true },
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("binds mutable native executables", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-system-run-native-"));
    const executable = path.join(cwd, "native-tool");
    try {
      fs.copyFileSync(process.execPath, executable);
      fs.chmodSync(executable, 0o755);
      const prepared = expectOk(
        await prepareSystemRunMutableFileBinding({
          command: { kind: "shell", text: "./native-tool --version" },
          cwd,
        }),
      );
      expect(prepared.binding.operands).toHaveLength(1);

      fs.appendFileSync(executable, Buffer.from([0]));
      await expect(
        revalidateSystemRunMutableFileBinding({ binding: prepared.binding, cwd }),
      ).resolves.toEqual({
        ok: false,
        message: APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE,
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed for shell startup file operands", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-system-run-startup-"));
    try {
      fs.writeFileSync(path.join(cwd, "init.sh"), "echo init\n");
      fs.writeFileSync(path.join(cwd, "job.sh"), "echo job\n");
      await expect(
        prepareSystemRunMutableFileBinding({
          command: { kind: "shell", text: "bash --rcfile init.sh -i job.sh" },
          cwd,
        }),
      ).resolves.toEqual({
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval cannot safely bind shell startup files",
      });
      await expect(
        prepareSystemRunMutableFileBinding({
          command: { kind: "argv", argv: ["bash", "-O", "extglob", "-i", "job.sh"] },
          cwd,
        }),
      ).resolves.toEqual({
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval cannot safely bind shell startup files",
      });
      await expect(
        prepareSystemRunMutableFileBinding({
          command: { kind: "argv", argv: ["sh", "-s"] },
          cwd,
        }),
      ).resolves.toEqual({
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval cannot safely bind shell startup files",
      });
      await expect(
        prepareSystemRunMutableFileBinding({
          command: { kind: "argv", argv: ["bash", "--rcfile", "init.sh", "-c", "echo ok"] },
          cwd,
        }),
      ).resolves.toEqual({
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval cannot safely bind shell startup files",
      });
      await expect(
        prepareSystemRunMutableFileBinding({
          command: { kind: "argv", argv: ["bash", "-i", "job.sh"] },
          cwd,
        }),
      ).resolves.toEqual({
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval cannot safely bind shell startup files",
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed for shell source built-ins", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-system-run-source-"));
    try {
      fs.writeFileSync(path.join(cwd, "loaded.sh"), "echo loaded\n");
      await expect(
        prepareSystemRunMutableFileBinding({
          command: { kind: "argv", argv: ["bash", "-c", "source loaded.sh"] },
          cwd,
        }),
      ).resolves.toEqual({
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
      });
      await expect(
        prepareSystemRunMutableFileBinding({
          command: { kind: "argv", argv: ["bash", "-c", "echo ok; source loaded.sh"] },
          cwd,
        }),
      ).resolves.toEqual({
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
      });
      await expect(
        prepareSystemRunMutableFileBinding({
          command: {
            kind: "argv",
            argv: ["env", "BASH_ENV=loaded.sh", "bash", "-c", "echo ok"],
          },
          cwd,
        }),
      ).resolves.toEqual({
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval cannot safely bind shell startup environment",
      });
      await expect(
        prepareSystemRunMutableFileBinding({
          command: { kind: "shell", text: "bash -c 'echo ok'" },
          cwd,
          env: { ...process.env, BASH_ENV: path.join(cwd, "loaded.sh") },
        }),
      ).resolves.toEqual({
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval cannot safely bind shell startup environment",
      });
      await expect(
        prepareSystemRunMutableFileBinding({
          command: { kind: "argv", argv: ["node", "--env-file=approved.env", "app.js"] },
          cwd,
        }),
      ).resolves.toEqual({
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
      });
      await expect(
        prepareSystemRunMutableFileBinding({
          command: { kind: "argv", argv: ["bash", "-c", "sh < payload.sh"] },
          cwd,
        }),
      ).resolves.toEqual({
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
      });
      await expect(
        prepareSystemRunMutableFileBinding({
          command: { kind: "shell", text: "cat payload.sh | sh" },
          cwd,
        }),
      ).resolves.toEqual({
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval cannot safely bind shell pipelines",
      });
      await expect(
        prepareSystemRunMutableFileBinding({
          command: { kind: "shell", text: "command source loaded.sh" },
          cwd,
        }),
      ).resolves.toEqual({
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval cannot safely bind shell source operands",
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed for runtime code-loading and cwd options", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-system-run-bun-"));
    try {
      fs.writeFileSync(path.join(cwd, "loader.ts"), "export {};\n");
      fs.writeFileSync(path.join(cwd, "app.ts"), "console.log('app');\n");
      await expect(
        prepareSystemRunMutableFileBinding({
          command: { kind: "argv", argv: ["bun", "--preload", "loader.ts", "app.ts"] },
          cwd,
        }),
      ).resolves.toEqual({
        ok: false,
        message:
          "SYSTEM_RUN_DENIED: approval cannot safely bind runtime code-loading or cwd options",
      });
      for (const command of [
        ["ruby", "-S", "app.rb"],
        ["perl", "-S", "app.pl"],
      ]) {
        await expect(
          prepareSystemRunMutableFileBinding({ command: { kind: "argv", argv: command }, cwd }),
        ).resolves.toEqual({
          ok: false,
          message:
            "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
        });
      }
      await expect(
        prepareSystemRunMutableFileBinding({
          command: { kind: "argv", argv: ["ruby", "--require=loader.rb", "app.rb"] },
          cwd,
        }),
      ).resolves.toEqual({
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
      });
      await expect(
        prepareSystemRunMutableFileBinding({
          command: { kind: "argv", argv: ["ruby", "-Csub", "app.rb"] },
          cwd,
        }),
      ).resolves.toEqual({
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
      });
      await expect(
        prepareSystemRunMutableFileBinding({
          command: {
            kind: "argv",
            argv: ["php", "-d", "auto_prepend_file=loader.php", "app.php"],
          },
          cwd,
        }),
      ).resolves.toEqual({
        ok: false,
        message:
          "SYSTEM_RUN_DENIED: approval cannot safely bind runtime code-loading or cwd options",
      });
      await expect(
        prepareSystemRunMutableFileBinding({
          command: { kind: "argv", argv: ["deno", "run", "--config", "deno.json", "app.ts"] },
          cwd,
        }),
      ).resolves.toEqual({
        ok: false,
        message:
          "SYSTEM_RUN_DENIED: approval cannot safely bind runtime code-loading or cwd options",
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("binds mutable scripts resolved through PATH", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-system-run-path-script-"));
    const binDir = path.join(cwd, "bin");
    try {
      fs.mkdirSync(binDir);
      fs.writeFileSync(path.join(binDir, "workspace-tool"), "#!/bin/sh\necho tool\n", {
        mode: 0o755,
      });
      const prepared = expectOk(
        await prepareSystemRunMutableFileBinding({
          command: { kind: "shell", text: "workspace-tool" },
          cwd,
          env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
        }),
      );
      expect(prepared.binding.operands).toHaveLength(1);

      fs.writeFileSync(path.join(binDir, "workspace-tool"), "#!/bin/sh\necho changed\n", {
        mode: 0o755,
      });
      await expect(
        revalidateSystemRunMutableFileBinding({ binding: prepared.binding, cwd }),
      ).resolves.toEqual({
        ok: false,
        message: APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE,
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("binds both a PATH-resolved interpreter shim and its script operand", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-system-run-path-python-"));
    const binDir = path.join(cwd, "bin");
    const payload = path.join(cwd, "payload.py");
    try {
      fs.mkdirSync(binDir);
      fs.writeFileSync(path.join(binDir, "python"), '#!/bin/sh\nexec python3 "$@"\n', {
        mode: 0o755,
      });
      fs.writeFileSync(payload, "print('approved')\n");
      const prepared = expectOk(
        await prepareSystemRunMutableFileBinding({
          command: { kind: "shell", text: "python payload.py" },
          cwd,
          env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
        }),
      );
      expect(prepared.binding.operands).toHaveLength(2);

      fs.writeFileSync(payload, "print('changed')\n");
      await expect(
        revalidateSystemRunMutableFileBinding({ binding: prepared.binding, cwd }),
      ).resolves.toEqual({
        ok: false,
        message: APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE,
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("binds both an explicit interpreter shim and its script operand", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-system-run-explicit-python-"));
    const shim = path.join(cwd, "python");
    try {
      fs.writeFileSync(shim, '#!/bin/sh\nexec python3 "$@"\n', { mode: 0o755 });
      fs.writeFileSync(path.join(cwd, "payload.py"), "print('approved')\n");
      const prepared = expectOk(
        await prepareSystemRunMutableFileBinding({
          command: { kind: "shell", text: "./python payload.py" },
          cwd,
        }),
      );
      expect(prepared.binding.operands).toHaveLength(2);

      fs.writeFileSync(shim, '#!/bin/sh\nexec python3 -I "$@"\n', { mode: 0o755 });
      await expect(
        revalidateSystemRunMutableFileBinding({ binding: prepared.binding, cwd }),
      ).resolves.toEqual({
        ok: false,
        message: APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE,
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed when an earlier shell segment changes cwd", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-system-run-cd-"));
    try {
      fs.mkdirSync(path.join(cwd, "sub"));
      fs.writeFileSync(path.join(cwd, "sub", "script.sh"), "echo sub\n");
      await expect(
        prepareSystemRunMutableFileBinding({
          command: { kind: "shell", text: "cd sub && sh script.sh" },
          cwd,
        }),
      ).resolves.toEqual({
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval cannot safely bind commands after cwd changes",
      });
      await expect(
        prepareSystemRunMutableFileBinding({
          command: { kind: "argv", argv: ["env", "-C", "sub", "sh", "script.sh"] },
          cwd,
        }),
      ).resolves.toEqual({
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval cannot safely bind dispatch cwd options",
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed when a script operand does not exist", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-system-run-missing-"));
    try {
      await expect(
        prepareSystemRunMutableFileBinding({
          command: { kind: "shell", text: "sh missing.sh" },
          cwd,
        }),
      ).resolves.toEqual({
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval requires an existing script operand",
      });
      await expect(
        prepareSystemRunMutableFileBinding({
          command: { kind: "shell", text: "command-that-does-not-exist" },
          cwd,
        }),
      ).resolves.toEqual({
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval requires a resolved executable",
      });
      await expect(
        prepareSystemRunMutableFileBinding({
          command: { kind: "shell", text: "sh < missing.sh" },
          cwd,
        }),
      ).resolves.toEqual({
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval cannot safely bind this command",
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not let inline eval bypass a mutable loader operand", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-system-run-loader-"));
    try {
      fs.writeFileSync(path.join(cwd, "loader.js"), "module.exports = {};\n");
      fs.writeFileSync(path.join(cwd, "payload.sh"), "echo payload\n", { mode: 0o755 });
      await expect(
        prepareSystemRunMutableFileBinding({
          command: {
            kind: "shell",
            text: "node --require loader.js --eval 'console.log(1)'",
          },
          cwd,
        }),
      ).resolves.toEqual({
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
      });
      await expect(
        prepareSystemRunMutableFileBinding({
          command: { kind: "argv", argv: ["bash", "-c", "./payload.sh"] },
          cwd,
        }),
      ).resolves.toEqual({
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "fails closed when a script operand is unreadable",
    async () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-system-run-unreadable-"));
      const script = path.join(cwd, "unreadable.sh");
      try {
        fs.writeFileSync(script, "#!/bin/sh\necho hidden\n", { mode: 0o000 });
        await expect(
          prepareSystemRunMutableFileBinding({
            command: { kind: "shell", text: "sh unreadable.sh" },
            cwd,
          }),
        ).resolves.toEqual({
          ok: false,
          message: "SYSTEM_RUN_DENIED: approval requires a readable script operand",
        });
      } finally {
        fs.chmodSync(script, 0o600);
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    },
  );
});
