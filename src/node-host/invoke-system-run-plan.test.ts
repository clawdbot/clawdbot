import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { formatExecCommand } from "../infra/system-run-command.js";
import {
  buildSystemRunApprovalPlan,
  hardenApprovedExecutionPaths,
  revalidateApprovedMutableFileOperand,
  resolveMutableFileOperandSnapshotSync,
} from "./invoke-system-run-plan.js";

type PathTokenSetup = {
  expected: string;
};

type HardeningCase = {
  name: string;
  mode: "build-plan" | "harden";
  argv: string[];
  shellCommand?: string | null;
  withPathToken?: boolean;
  expectedArgv: (ctx: { pathToken: PathTokenSetup | null }) => string[];
  expectedArgvChanged?: boolean;
  expectedCmdText?: string;
  checkRawCommandMatchesArgv?: boolean;
  expectedCommandPreview?: string | null;
};

type ScriptOperandFixture = {
  command: string[];
  scriptPath: string;
  initialBody: string;
  expectedArgvIndex: number;
};

type RuntimeFixture = {
  name: string;
  argv: string[];
  scriptName: string;
  initialBody: string;
  expectedArgvIndex: number;
  binName?: string;
  binNames?: string[];
  skipOnWin32?: boolean;
};

type UnsafeRuntimeInvocationCase = {
  name: string;
  binName: string;
  tmpPrefix: string;
  command: string[];
  setup?: (tmp: string) => void;
};

function createScriptOperandFixture(tmp: string, fixture?: RuntimeFixture): ScriptOperandFixture {
  if (fixture) {
    return {
      command: fixture.argv,
      scriptPath: path.join(tmp, fixture.scriptName),
      initialBody: fixture.initialBody,
      expectedArgvIndex: fixture.expectedArgvIndex,
    };
  }
  if (process.platform === "win32") {
    return {
      command: [process.execPath, "./run.js"],
      scriptPath: path.join(tmp, "run.js"),
      initialBody: 'console.log("SAFE");\n',
      expectedArgvIndex: 1,
    };
  }
  return {
    command: ["/bin/sh", "./run.sh"],
    scriptPath: path.join(tmp, "run.sh"),
    initialBody: "#!/bin/sh\necho SAFE\n",
    expectedArgvIndex: 1,
  };
}

let sharedFixtureRoot = "";
let sharedRuntimeBinDir = "";
let sharedFixtureId = 0;
const sharedRuntimeBins = new Set<string>();

beforeAll(() => {
  sharedFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-run-plan-fixtures-"));
  sharedRuntimeBinDir = path.join(sharedFixtureRoot, "bin");
  fs.mkdirSync(sharedRuntimeBinDir, { recursive: true });
});

afterAll(() => {
  if (sharedFixtureRoot) {
    fs.rmSync(sharedFixtureRoot, { recursive: true, force: true });
  }
});

function createFixtureDir(prefix: string): string {
  const dir = path.join(sharedFixtureRoot, `${prefix}${sharedFixtureId++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFakeRuntimeBin(binDir: string, binName: string) {
  const runtimePath =
    process.platform === "win32" ? path.join(binDir, `${binName}.cmd`) : path.join(binDir, binName);
  const runtimeBody =
    process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n";
  fs.writeFileSync(runtimePath, runtimeBody, { mode: 0o755 });
  if (process.platform !== "win32") {
    fs.chmodSync(runtimePath, 0o755);
  }
}

function withFakeRuntimeBins<T>(params: {
  binNames: string[];
  tmpPrefix?: string;
  run: () => T;
}): T {
  void params.tmpPrefix;
  for (const binName of params.binNames) {
    if (sharedRuntimeBins.has(binName)) {
      continue;
    }
    writeFakeRuntimeBin(sharedRuntimeBinDir, binName);
    sharedRuntimeBins.add(binName);
  }
  const oldPath = process.env.PATH;
  process.env.PATH = `${sharedRuntimeBinDir}${path.delimiter}${oldPath ?? ""}`;
  try {
    return params.run();
  } finally {
    if (oldPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = oldPath;
    }
  }
}

function uniqueRuntimeBinNames(
  cases: ReadonlyArray<Pick<RuntimeFixture, "binName" | "binNames">>,
): string[] {
  return [
    ...new Set(
      cases.flatMap(
        (runtimeCase) =>
          runtimeCase.binNames ??
          (runtimeCase.binName ? [runtimeCase.binName] : ["bunx", "pnpm", "npm", "npx", "tsx"]),
      ),
    ),
  ];
}

function resolveNativeBinaryFixturePath(): string {
  for (const candidate of ["/bin/ls", "/usr/bin/ls", "/bin/echo", "/usr/bin/printf"]) {
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      continue;
    }
  }
  throw new Error("expected a native binary fixture path");
}

function expectShellPayloadApprovalDenied(params: {
  tmpPrefix: string;
  fileName: string;
  body: string;
}) {
  if (process.platform === "win32") {
    return;
  }
  const tmp = createFixtureDir(params.tmpPrefix);
  const scriptPath = path.join(tmp, params.fileName);
  fs.writeFileSync(scriptPath, params.body);
  fs.chmodSync(scriptPath, 0o755);
  const prepared = buildSystemRunApprovalPlan({
    command: ["/bin/sh", "-lc", scriptPath],
    rawCommand: scriptPath,
    cwd: tmp,
  });
  expect(prepared).toEqual(DENIED_RUNTIME_APPROVAL);
}

function expectMutableFileOperandApprovalPlan(fixture: ScriptOperandFixture, cwd: string) {
  const prepared = buildSystemRunApprovalPlan({
    command: fixture.command,
    cwd,
  });
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) {
    throw new Error("unreachable");
  }
  expect(prepared.plan.mutableFileOperand).toEqual({
    argvIndex: fixture.expectedArgvIndex,
    path: fs.realpathSync(fixture.scriptPath),
    sha256: expect.any(String),
  });
}

function writeScriptOperandFixture(fixture: ScriptOperandFixture) {
  fs.writeFileSync(fixture.scriptPath, fixture.initialBody);
  if (process.platform !== "win32") {
    fs.chmodSync(fixture.scriptPath, 0o755);
  }
}

function withScriptOperandPlanFixture<T>(
  params: {
    tmpPrefix: string;
    fixture?: RuntimeFixture;
    afterWrite?: (fixture: ScriptOperandFixture, tmp: string) => void;
  },
  run: (fixture: ScriptOperandFixture, tmp: string) => T,
) {
  const tmp = createFixtureDir(params.tmpPrefix);
  const fixture = createScriptOperandFixture(tmp, params.fixture);
  writeScriptOperandFixture(fixture);
  params.afterWrite?.(fixture, tmp);
  return run(fixture, tmp);
}

const DENIED_RUNTIME_APPROVAL = {
  ok: false,
  message: "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
} as const;

function runNamedCase(name: string, run: () => void) {
  try {
    run();
  } catch (error) {
    throw new Error(`case failed: ${name}`, { cause: error });
  }
}

function expectRuntimeApprovalDenied(command: string[], cwd: string) {
  const prepared = buildSystemRunApprovalPlan({ command, cwd });
  expect(prepared).toEqual(DENIED_RUNTIME_APPROVAL);
}

function expectApprovalPlanWithoutMutableOperand(command: string[], cwd: string) {
  const prepared = buildSystemRunApprovalPlan({ command, cwd });
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) {
    throw new Error("unreachable");
  }
  expect(prepared.plan.mutableFileOperand).toBeUndefined();
}

const unsafeRuntimeInvocationCases: UnsafeRuntimeInvocationCase[] = [
  {
    name: "rejects bun package script names that do not bind a concrete file",
    binName: "bun",
    tmpPrefix: "openclaw-bun-package-script-",
    command: ["bun", "run", "dev"],
  },
  {
    name: "rejects deno eval invocations that do not bind a concrete file",
    binName: "deno",
    tmpPrefix: "openclaw-deno-eval-",
    command: ["deno", "eval", "console.log('SAFE')"],
  },
  {
    name: "rejects tsx eval invocations that do not bind a concrete file",
    binName: "tsx",
    tmpPrefix: "openclaw-tsx-eval-",
    command: ["tsx", "--eval", "console.log('SAFE')"],
  },
  {
    name: "rejects busybox applets that cannot be safely bound",
    binName: "busybox",
    tmpPrefix: "openclaw-busybox-awk-",
    command: ["busybox", "awk", 'BEGIN{system("id")}'],
  },
  {
    name: "rejects busybox applets even when cwd contains a file named after the applet",
    binName: "busybox",
    tmpPrefix: "openclaw-busybox-awk-file-bait-",
    command: ["busybox", "awk", 'BEGIN{system("id")}'],
    setup: (tmp) => {
      fs.writeFileSync(path.join(tmp, "awk"), "bait\n");
    },
  },
  {
    name: "rejects toybox applets that cannot be safely bound",
    binName: "toybox",
    tmpPrefix: "openclaw-toybox-awk-",
    command: ["toybox", "awk", 'BEGIN{system("id")}'],
  },
  {
    name: "rejects node inline import operands that cannot be bound to one stable file",
    binName: "node",
    tmpPrefix: "openclaw-node-import-inline-",
    command: ["node", "--import=./preload.mjs", "./main.mjs"],
    setup: (tmp) => {
      fs.writeFileSync(path.join(tmp, "main.mjs"), 'console.log("SAFE")\n');
      fs.writeFileSync(path.join(tmp, "preload.mjs"), 'console.log("SAFE")\n');
    },
  },
  {
    name: "rejects ruby require preloads that approval cannot bind completely",
    binName: "ruby",
    tmpPrefix: "openclaw-ruby-require-",
    command: ["ruby", "-r", "attacker", "./safe.rb"],
    setup: (tmp) => {
      fs.writeFileSync(path.join(tmp, "safe.rb"), 'puts "SAFE"\n');
    },
  },
  {
    name: "rejects perl module preloads that approval cannot bind completely",
    binName: "perl",
    tmpPrefix: "openclaw-perl-module-preload-",
    command: ["perl", "-MPreload", "./safe.pl"],
    setup: (tmp) => {
      fs.writeFileSync(path.join(tmp, "safe.pl"), 'print "SAFE\\n";\n');
    },
  },
  {
    name: "rejects perl load-path flags that can redirect module resolution after approval",
    binName: "perl",
    tmpPrefix: "openclaw-perl-load-path-",
    command: ["perl", "-Ilib", "./safe.pl"],
    setup: (tmp) => {
      fs.writeFileSync(path.join(tmp, "safe.pl"), 'print "SAFE\\n";\n');
    },
  },
  {
    name: "rejects shell payloads that hide mutable interpreter scripts",
    binName: "node",
    tmpPrefix: "openclaw-inline-shell-node-",
    command: ["sh", "-lc", "node ./run.js"],
    setup: (tmp) => {
      fs.writeFileSync(path.join(tmp, "run.js"), 'console.log("SAFE")\n');
    },
  },
  {
    name: "rejects pnpm dlx invocations with unrecognized flags that cannot be safely bound",
    binName: "pnpm",
    tmpPrefix: "openclaw-pnpm-dlx-unknown-flag-",
    command: ["pnpm", "dlx", "--future-flag", "tsx", "./run.ts"],
    setup: (tmp) => {
      fs.writeFileSync(path.join(tmp, "run.ts"), 'console.log("SAFE")\n');
    },
  },
  {
    name: "rejects pnpm dlx invocations with unrecognized global flags that take a value before dlx",
    binName: "pnpm",
    tmpPrefix: "openclaw-pnpm-dlx-unknown-prefix-value-",
    command: ["pnpm", "--future-flag", "value", "dlx", "tsx", "./run.ts"],
    setup: (tmp) => {
      fs.writeFileSync(path.join(tmp, "run.ts"), 'console.log("SAFE")\n');
    },
  },
];

describe("hardenApprovedExecutionPaths", () => {
  const cases: HardeningCase[] = [
    {
      name: "preserves shell-wrapper argv during approval hardening",
      mode: "build-plan",
      argv: ["env", "sh", "-c", "echo SAFE"],
      expectedArgv: () => ["env", "sh", "-c", "echo SAFE"],
      expectedCmdText: 'env sh -c "echo SAFE"',
      expectedCommandPreview: "echo SAFE",
    },
    {
      name: "preserves dispatch-wrapper argv during approval hardening",
      mode: "harden",
      argv: ["env", "tr", "a", "b"],
      shellCommand: null,
      expectedArgv: () => ["env", "tr", "a", "b"],
      expectedArgvChanged: false,
    },
    {
      name: "pins direct PATH-token executable during approval hardening",
      mode: "harden",
      argv: ["poccmd", "SAFE"],
      shellCommand: null,
      withPathToken: true,
      expectedArgv: ({ pathToken }) => [pathToken!.expected, "SAFE"],
      expectedArgvChanged: true,
    },
    {
      name: "preserves env-wrapper PATH-token argv during approval hardening",
      mode: "harden",
      argv: ["env", "poccmd", "SAFE"],
      shellCommand: null,
      withPathToken: true,
      expectedArgv: () => ["env", "poccmd", "SAFE"],
      expectedArgvChanged: false,
    },
    {
      name: "rawCommand matches hardened argv after executable path pinning",
      mode: "build-plan",
      argv: ["poccmd", "hello"],
      withPathToken: true,
      expectedArgv: ({ pathToken }) => [pathToken!.expected, "hello"],
      checkRawCommandMatchesArgv: true,
      expectedCommandPreview: null,
    },
    {
      name: "stores full approval text and preview for path-qualified env wrappers",
      mode: "build-plan",
      argv: ["./env", "sh", "-c", "echo SAFE"],
      expectedArgv: () => ["./env", "sh", "-c", "echo SAFE"],
      expectedCmdText: './env sh -c "echo SAFE"',
      checkRawCommandMatchesArgv: true,
      expectedCommandPreview: "echo SAFE",
    },
  ];

  it.runIf(process.platform !== "win32")("handles approval hardening cases", () => {
    for (const testCase of cases) {
      runNamedCase(testCase.name, () => {
        const tmp = createFixtureDir("openclaw-approval-hardening-");
        const oldPath = process.env.PATH;
        let pathToken: PathTokenSetup | null = null;
        if (testCase.withPathToken) {
          const binDir = path.join(tmp, "bin");
          fs.mkdirSync(binDir, { recursive: true });
          const link = path.join(binDir, "poccmd");
          fs.symlinkSync("/bin/echo", link);
          pathToken = { expected: fs.realpathSync(link) };
          process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
        }
        try {
          if (testCase.mode === "build-plan") {
            const prepared = buildSystemRunApprovalPlan({
              command: testCase.argv,
              cwd: tmp,
            });
            expect(prepared.ok).toBe(true);
            if (!prepared.ok) {
              throw new Error("unreachable");
            }
            expect(prepared.plan.argv).toEqual(testCase.expectedArgv({ pathToken }));
            if (testCase.expectedCmdText) {
              expect(prepared.plan.commandText).toBe(testCase.expectedCmdText);
            }
            if (testCase.checkRawCommandMatchesArgv) {
              expect(prepared.plan.commandText).toBe(formatExecCommand(prepared.plan.argv));
            }
            if ("expectedCommandPreview" in testCase) {
              expect(prepared.plan.commandPreview ?? null).toBe(testCase.expectedCommandPreview);
            }
            return;
          }

          const hardened = hardenApprovedExecutionPaths({
            approvedByAsk: true,
            argv: testCase.argv,
            shellCommand: testCase.shellCommand ?? null,
            cwd: tmp,
          });
          expect(hardened.ok).toBe(true);
          if (!hardened.ok) {
            throw new Error("unreachable");
          }
          expect(hardened.argv).toEqual(testCase.expectedArgv({ pathToken }));
          if (typeof testCase.expectedArgvChanged === "boolean") {
            expect(hardened.argvChanged).toBe(testCase.expectedArgvChanged);
          }
        } finally {
          if (testCase.withPathToken) {
            if (oldPath === undefined) {
              delete process.env.PATH;
            } else {
              process.env.PATH = oldPath;
            }
          }
        }
      });
    }
  });

  const mutableOperandCases: RuntimeFixture[] = [
    {
      name: "python flagged file",
      binName: "python3",
      argv: ["python3", "-B", "./run.py"],
      scriptName: "run.py",
      initialBody: 'print("SAFE")\n',
      expectedArgvIndex: 2,
    },
    {
      name: "lua direct file",
      binName: "lua",
      argv: ["lua", "./run.lua"],
      scriptName: "run.lua",
      initialBody: 'print("SAFE")\n',
      expectedArgvIndex: 1,
    },
    {
      name: "versioned node alias file",
      binName: "node20",
      argv: ["node20", "./run.js"],
      scriptName: "run.js",
      initialBody: 'console.log("SAFE");\n',
      expectedArgvIndex: 1,
    },
    {
      name: "tsx direct file",
      binName: "tsx",
      argv: ["tsx", "./run.ts"],
      scriptName: "run.ts",
      initialBody: 'console.log("SAFE");\n',
      expectedArgvIndex: 1,
    },
    {
      name: "bun run file",
      binName: "bun",
      argv: ["bun", "run", "./run.ts"],
      scriptName: "run.ts",
      initialBody: 'console.log("SAFE");\n',
      expectedArgvIndex: 2,
    },
    {
      name: "deno run file with flags",
      binName: "deno",
      argv: ["deno", "run", "-A", "--allow-read", "--", "./run.ts"],
      scriptName: "run.ts",
      initialBody: 'console.log("SAFE");\n',
      expectedArgvIndex: 5,
    },
    {
      name: "pnpm exec tsx file",
      argv: ["pnpm", "exec", "tsx", "./run.ts"],
      scriptName: "run.ts",
      initialBody: 'console.log("SAFE");\n',
      expectedArgvIndex: 3,
    },
    {
      name: "pnpm dlx tsx file",
      argv: ["pnpm", "dlx", "tsx", "./run.ts"],
      scriptName: "run.ts",
      initialBody: 'console.log("SAFE");\n',
      expectedArgvIndex: 3,
    },
    {
      name: "pnpm reporter dlx package tsx file",
      argv: ["pnpm", "--reporter", "silent", "dlx", "--package", "tsx", "tsx", "./run.ts"],
      scriptName: "run.ts",
      initialBody: 'console.log("SAFE");\n',
      expectedArgvIndex: 7,
    },
    {
      name: "pnpm reporter exec tsx file",
      argv: ["pnpm", "--reporter", "silent", "exec", "tsx", "./run.ts"],
      scriptName: "run.ts",
      initialBody: 'console.log("SAFE");\n',
      expectedArgvIndex: 5,
    },
    {
      name: "pnpm js shim exec tsx file",
      argv: ["./pnpm.js", "exec", "tsx", "./run.ts"],
      scriptName: "run.ts",
      initialBody: 'console.log("SAFE");\n',
      expectedArgvIndex: 3,
      skipOnWin32: true,
    },
    {
      name: "pnpm exec double-dash tsx file",
      argv: ["pnpm", "exec", "--", "tsx", "./run.ts"],
      scriptName: "run.ts",
      initialBody: 'console.log("SAFE");\n',
      expectedArgvIndex: 4,
    },
    {
      name: "pnpm node file",
      argv: ["pnpm", "node", "./run.js"],
      scriptName: "run.js",
      initialBody: 'console.log("SAFE");\n',
      expectedArgvIndex: 2,
      binNames: ["pnpm", "node"],
    },
    {
      name: "bunx tsx file",
      argv: ["bunx", "tsx", "./run.ts"],
      scriptName: "run.ts",
      initialBody: 'console.log("SAFE");\n',
      expectedArgvIndex: 2,
    },
    {
      name: "npm exec tsx file",
      argv: ["npm", "exec", "--", "tsx", "./run.ts"],
      scriptName: "run.ts",
      initialBody: 'console.log("SAFE");\n',
      expectedArgvIndex: 4,
    },
  ];

  it("captures mutable runtime operands in approval plans", () => {
    const tmp = createFixtureDir("openclaw-approval-script-plan-");
    withFakeRuntimeBins({
      binNames: uniqueRuntimeBinNames(mutableOperandCases),
      run: () => {
        for (const runtimeCase of mutableOperandCases) {
          runNamedCase(runtimeCase.name, () => {
            if (runtimeCase.skipOnWin32 && process.platform === "win32") {
              return;
            }
            const fixture = createScriptOperandFixture(tmp, runtimeCase);
            writeScriptOperandFixture(fixture);
            const executablePath = fixture.command[0];
            if (executablePath?.endsWith("pnpm.js")) {
              const shimPath = path.join(tmp, "pnpm.js");
              fs.writeFileSync(shimPath, "#!/usr/bin/env node\nconsole.log('shim')\n");
              fs.chmodSync(shimPath, 0o755);
            }
            expectMutableFileOperandApprovalPlan(fixture, tmp);
          });
        }
      },
    });
  });

  it("captures mutable shell script operands in approval plans", () => {
    withScriptOperandPlanFixture(
      {
        tmpPrefix: "openclaw-approval-script-plan-",
      },
      (fixture, tmp) => {
        expectMutableFileOperandApprovalPlan(fixture, tmp);
      },
    );
  });

  it("allows shell payloads that invoke absolute-path native binaries", () => {
    if (process.platform === "win32") {
      return;
    }
    const binaryPath = resolveNativeBinaryFixturePath();
    const prepared = buildSystemRunApprovalPlan({
      command: ["/bin/sh", "-lc", binaryPath],
      rawCommand: binaryPath,
      cwd: process.cwd(),
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      throw new Error("unreachable");
    }
    expect(prepared.plan.mutableFileOperand).toBeUndefined();
  });

  it("keeps fail-closed behavior for relative native-binary shell payloads", () => {
    if (process.platform === "win32") {
      return;
    }
    const tmp = createFixtureDir("openclaw-shell-relative-binary-binding-");
    const binaryPath = resolveNativeBinaryFixturePath();
    const relativeBinaryPath = path.join(tmp, "tool");
    fs.copyFileSync(binaryPath, relativeBinaryPath);
    fs.chmodSync(relativeBinaryPath, 0o755);
    const prepared = buildSystemRunApprovalPlan({
      command: ["/bin/sh", "-lc", "./tool"],
      rawCommand: "./tool",
      cwd: tmp,
    });
    expect(prepared).toEqual(DENIED_RUNTIME_APPROVAL);
  });

  it("keeps fail-closed behavior for writable absolute native-binary shell payloads", () => {
    if (process.platform === "win32") {
      return;
    }
    const tmp = createFixtureDir("openclaw-shell-absolute-binary-binding-");
    const binaryPath = resolveNativeBinaryFixturePath();
    const copiedBinaryPath = path.join(tmp, "tool");
    fs.copyFileSync(binaryPath, copiedBinaryPath);
    fs.chmodSync(copiedBinaryPath, 0o755);
    const prepared = buildSystemRunApprovalPlan({
      command: ["/bin/sh", "-lc", copiedBinaryPath],
      rawCommand: copiedBinaryPath,
      cwd: tmp,
    });
    expect(prepared).toEqual(DENIED_RUNTIME_APPROVAL);
  });

  it("keeps fail-closed behavior for owner-controlled read-only absolute binaries", () => {
    if (process.platform === "win32") {
      return;
    }
    const tmp = createFixtureDir("openclaw-shell-owned-readonly-binding-");
    const binaryPath = path.join(tmp, "tool");
    try {
      fs.copyFileSync(resolveNativeBinaryFixturePath(), binaryPath);
      fs.chmodSync(binaryPath, 0o555);
      fs.chmodSync(tmp, 0o555);
      const prepared = buildSystemRunApprovalPlan({
        command: ["/bin/sh", "-lc", binaryPath],
        rawCommand: binaryPath,
        cwd: tmp,
      });
      expect(prepared).toEqual(DENIED_RUNTIME_APPROVAL);
    } finally {
      fs.chmodSync(tmp, 0o755);
    }
  });

  it("keeps fail-closed behavior for symlinked binaries with writable targets", () => {
    if (process.platform === "win32") {
      return;
    }
    const tmp = createFixtureDir("openclaw-shell-symlink-binary-binding-");
    const stableDir = path.join(tmp, "stable");
    const mutableDir = path.join(tmp, "mutable");
    try {
      const binaryPath = resolveNativeBinaryFixturePath();
      fs.mkdirSync(stableDir);
      fs.mkdirSync(mutableDir);
      const targetBinaryPath = path.join(mutableDir, "tool");
      const symlinkPath = path.join(stableDir, "tool");
      fs.copyFileSync(binaryPath, targetBinaryPath);
      fs.chmodSync(targetBinaryPath, 0o755);
      fs.symlinkSync(targetBinaryPath, symlinkPath);
      fs.chmodSync(stableDir, 0o555);
      const prepared = buildSystemRunApprovalPlan({
        command: ["/bin/sh", "-lc", symlinkPath],
        rawCommand: symlinkPath,
        cwd: tmp,
      });
      expect(prepared).toEqual(DENIED_RUNTIME_APPROVAL);
    } finally {
      fs.chmodSync(stableDir, 0o755);
    }
  });

  it("keeps fail-closed behavior for mutable or ambiguous shell payload files", () => {
    for (const testCase of [
      {
        tmpPrefix: "openclaw-shell-script-binding-",
        fileName: "run.sh",
        body: "#!/bin/sh\necho SAFE\n",
      },
      {
        tmpPrefix: "openclaw-shell-empty-binding-",
        fileName: "empty",
        body: "",
      },
      {
        tmpPrefix: "openclaw-shell-mz-text-binding-",
        fileName: "mz-script",
        body: "MZ not really a PE file\n",
      },
      {
        tmpPrefix: "openclaw-shell-nul-header-binding-",
        fileName: "nul-script",
        body: "SAFE\u0000maybe-binary\n",
      },
    ]) {
      expectShellPayloadApprovalDenied(testCase);
    }
  });

  it("keeps fail-closed behavior when the shell payload probe stops seeing a file", () => {
    if (process.platform === "win32") {
      return;
    }
    const tmp = createFixtureDir("openclaw-shell-race-binding-");
    const scriptPath = path.join(tmp, "run.sh");
    fs.writeFileSync(scriptPath, "#!/bin/sh\necho SAFE\n");
    fs.chmodSync(scriptPath, 0o755);
    const realStatSync = fs.statSync;
    let targetStatCalls = 0;
    const statSyncSpy = vi.spyOn(fs, "statSync").mockImplementation((pathLike, options) => {
      const targetPath = typeof pathLike === "string" ? pathLike : pathLike.toString();
      if (targetPath === scriptPath) {
        targetStatCalls += 1;
        if (targetStatCalls === 2) {
          return realStatSync(tmp, options);
        }
      }
      return realStatSync(pathLike, options);
    });
    try {
      const prepared = buildSystemRunApprovalPlan({
        command: ["/bin/sh", "-lc", scriptPath],
        rawCommand: scriptPath,
        cwd: tmp,
      });
      expect(prepared).toEqual(DENIED_RUNTIME_APPROVAL);
    } finally {
      statSyncSpy.mockRestore();
    }
  });

  it("rejects unsafe runtime invocation forms", () => {
    withFakeRuntimeBins({
      binNames: [...new Set(unsafeRuntimeInvocationCases.map((testCase) => testCase.binName))],
      run: () => {
        for (const testCase of unsafeRuntimeInvocationCases) {
          runNamedCase(testCase.name, () => {
            const tmp = createFixtureDir(testCase.tmpPrefix);
            testCase.setup?.(tmp);
            expectRuntimeApprovalDenied(testCase.command, tmp);
          });
        }
      },
    });
  });

  it("detects rewritten script operands for pnpm dlx approval plans", () => {
    withFakeRuntimeBins({
      binNames: ["pnpm", "tsx"],
      run: () => {
        withScriptOperandPlanFixture(
          {
            tmpPrefix: "openclaw-pnpm-dlx-approval-",
            fixture: {
              name: "pnpm dlx rewritten script",
              argv: ["pnpm", "dlx", "tsx", "./run.ts"],
              scriptName: "run.ts",
              initialBody: 'console.log("SAFE");\n',
              expectedArgvIndex: 3,
            },
          },
          (fixture, tmp) => {
            const prepared = buildSystemRunApprovalPlan({
              command: fixture.command,
              cwd: tmp,
            });
            expect(prepared.ok).toBe(true);
            if (!prepared.ok) {
              throw new Error("unreachable");
            }
            expect(prepared.plan.mutableFileOperand).toBeDefined();
            fs.writeFileSync(fixture.scriptPath, 'console.log("PWNED");\n');
            expect(
              revalidateApprovedMutableFileOperand({
                snapshot: prepared.plan.mutableFileOperand!,
                argv: prepared.plan.argv,
                cwd: prepared.plan.cwd ?? tmp,
              }),
            ).toBe(false);
          },
        );
      },
    });
  });

  it("does not bind pnpm dlx shell-mode commands to a mutable file operand", () => {
    withFakeRuntimeBins({
      binNames: ["pnpm", "tsx"],
      run: () => {
        const tmp = createFixtureDir("openclaw-pnpm-dlx-shell-mode-");
        fs.writeFileSync(path.join(tmp, "run.ts"), 'console.log("SAFE");\n');
        expect(
          resolveMutableFileOperandSnapshotSync({
            argv: ["pnpm", "dlx", "--shell-mode", "tsx ./run.ts"],
            cwd: tmp,
            shellCommand: null,
          }),
        ).toEqual({ ok: true, snapshot: null });
      },
    });
  });

  it("allows pnpm dlx package binaries that do not bind mutable local files", () => {
    withFakeRuntimeBins({
      binNames: ["pnpm", "eslint"],
      run: () => {
        const cases = [
          {
            prefix: "openclaw-pnpm-dlx-package-bin-",
            command: ["pnpm", "dlx", "cowsay", "hello"],
          },
          {
            prefix: "openclaw-pnpm-dlx-package-runtime-token-",
            command: ["pnpm", "dlx", "cowsay", "node"],
          },
          {
            prefix: "openclaw-pnpm-dlx-package-runtime-token-multi-",
            command: ["pnpm", "dlx", "cowsay", "node", "hello"],
          },
          {
            prefix: "openclaw-pnpm-dlx-package-file-",
            command: ["pnpm", "dlx", "eslint", "src/index.ts"],
            setup: (tmp: string) => {
              fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
              fs.writeFileSync(path.join(tmp, "src", "index.ts"), 'console.log("SAFE");\n');
            },
          },
          {
            prefix: "openclaw-pnpm-dlx-package-data-tail-",
            command: ["pnpm", "dlx", "cowsay", "tsx", "./run.ts"],
            setup: (tmp: string) => {
              fs.writeFileSync(path.join(tmp, "run.ts"), 'console.log("SAFE");\n');
            },
          },
        ];
        for (const testCase of cases) {
          const tmp = createFixtureDir(testCase.prefix);
          testCase.setup?.(tmp);
          expectApprovalPlanWithoutMutableOperand(testCase.command, tmp);
        }
      },
    });
  });

  it("treats -- as the end of pnpm dlx option parsing", () => {
    withFakeRuntimeBins({
      binNames: ["pnpm", "tsx"],
      run: () => {
        withScriptOperandPlanFixture(
          {
            tmpPrefix: "openclaw-pnpm-dlx-double-dash-",
            fixture: {
              name: "pnpm dlx double dash",
              argv: ["pnpm", "dlx", "--", "tsx", "./run.ts"],
              scriptName: "run.ts",
              initialBody: 'console.log("SAFE");\n',
              expectedArgvIndex: 4,
            },
          },
          (fixture, tmp) => {
            expectMutableFileOperandApprovalPlan(fixture, tmp);
          },
        );
      },
    });
  });

  it("captures the real shell script operand after value-taking shell flags", () => {
    const tmp = createFixtureDir("openclaw-shell-option-value-");
    const scriptPath = path.join(tmp, "run.sh");
    fs.writeFileSync(scriptPath, "#!/bin/sh\necho SAFE\n");
    fs.writeFileSync(path.join(tmp, "errexit"), "decoy\n");
    const snapshot = resolveMutableFileOperandSnapshotSync({
      argv: ["/bin/bash", "-o", "errexit", "./run.sh"],
      cwd: tmp,
      shellCommand: null,
    });
    expect(snapshot).toEqual({
      ok: true,
      snapshot: {
        argvIndex: 3,
        path: fs.realpathSync(scriptPath),
        sha256: expect.any(String),
      },
    });
  });
});
