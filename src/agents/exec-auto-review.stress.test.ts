import { describe, expect, it, vi } from "vitest";
import { resolveDispatchWrapperTrustPlan } from "../infra/dispatch-wrapper-resolution.js";
import type { ExecAutoReviewInput } from "../infra/exec-auto-review.js";
import { isBlockedShellWrapperCommand } from "../infra/exec-wrapper-resolution.js";
import { resolvePowerShellInlineCommandMatch } from "../infra/shell-inline-command.js";
import { buildExecAutoReviewInputForShellCommand } from "../plugin-sdk/agent-harness-exec-review-runtime.js";
import { createModelExecAutoReviewer } from "./exec-auto-reviewer.js";

const baselineInput: ExecAutoReviewInput = {
  command: "git status",
  argv: ["git", "status"],
  resolvedPath: "/usr/bin/git",
  cwd: "/repo",
  envKeys: [],
  host: "gateway",
  reason: "approval-required",
  analysis: {
    parsed: true,
    allowlistMatched: false,
    inlineEval: false,
  },
};

type StressCompletionRequest = {
  context: { messages: Array<{ content: string }> };
  options: { signal?: AbortSignal };
};

type StressCompletionResult = {
  stopReason: "stop";
  content: Array<{ type: "text"; text: string }>;
};

function createStressReviewer(params: {
  complete: (request: StressCompletionRequest) => Promise<StressCompletionResult>;
  timeoutMs?: number;
}) {
  const prepare = vi.fn(async () => ({
    selection: { provider: "openrouter", modelId: "reviewer", agentDir: "/agent" },
    model: { provider: "openrouter", id: "reviewer", api: "openai" as const },
    auth: { apiKey: "redacted", mode: "env" as const },
  }));
  const complete = vi.fn(params.complete);
  const reviewer = createModelExecAutoReviewer({
    cfg: {},
    ...(params.timeoutMs === undefined ? {} : { reviewer: { timeoutMs: params.timeoutMs } }),
    deps: {
      prepareSimpleCompletionModelForAgent:
        prepare as unknown as typeof import("./simple-completion-runtime.js").prepareSimpleCompletionModelForAgent,
      completeWithPreparedSimpleCompletionModel:
        complete as unknown as typeof import("./simple-completion-runtime.js").completeWithPreparedSimpleCompletionModel,
    },
  });
  return { reviewer, prepare, complete };
}

function modelResponse(decision: "allow" | "ask", risk: "low" | "medium") {
  return {
    stopReason: "stop" as const,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ decision, risk, rationale: "stress fixture" }),
      },
    ],
  };
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function chooseSeeded<T>(random: () => number, values: readonly T[]): T {
  const selected = values[Math.floor(random() * values.length)];
  if (selected === undefined) {
    throw new Error("stress corpus must contain at least one value");
  }
  return selected;
}

describe.runIf(process.platform !== "win32")("exec auto-review shell stress", () => {
  it("keeps mutable PowerShell script entry points outside auto-review", () => {
    const positionalScript = ["pwsh", "-NoProfile", "./safe.ps1"];
    const explicitScript = ["pwsh", "-NoProfile", "-File", "./safe.ps1"];
    const delimitedScript = ["pwsh", "-NoProfile", "--", "./safe.ps1"];
    const consoleScript = [
      "powershell",
      "-NoProfile",
      "-pscf",
      "./evil.psc1",
      "-Command",
      "Get-Date",
    ];

    expect(resolvePowerShellInlineCommandMatch(positionalScript)).toEqual({
      command: null,
      valueTokenIndex: null,
    });
    expect(resolvePowerShellInlineCommandMatch(explicitScript)).toEqual({
      command: "./safe.ps1",
      valueTokenIndex: 3,
    });
    expect(resolvePowerShellInlineCommandMatch(delimitedScript)).toEqual({
      command: null,
      valueTokenIndex: null,
    });
    expect(resolvePowerShellInlineCommandMatch(consoleScript)).toEqual({
      command: "Get-Date",
      valueTokenIndex: 5,
    });
    expect(isBlockedShellWrapperCommand(positionalScript)).toBe(true);
    expect(isBlockedShellWrapperCommand(explicitScript)).toBe(true);
    expect(isBlockedShellWrapperCommand(delimitedScript)).toBe(true);
    expect(isBlockedShellWrapperCommand(consoleScript)).toBe(true);
  });

  it.each<[string, string[], boolean]>([
    ["Fish short initializer", ["fish", "-C", "echo startup", "-c", "echo payload"], true],
    ["Fish long initializer", ["fish", "--init-command=echo startup", "-c", "echo payload"], true],
    ["PowerShell encoded flag", ["pwsh", "-EncodedCommand", "ZQBjAGgAbwA="], true],
    ["PowerShell encoded abbreviation", ["pwsh", "/ec", "ZQBjAGgAbwA="], true],
    ["PowerShell encoded prefix", ["pwsh", "-en", "ZQBjAGgAbwA="], true],
    [
      "PowerShell encoded-arguments alias",
      ["pwsh", "-NoProfile", "-ea", "ZQBjAGgAbwA=", "-Command", "Get-Date"],
      true,
    ],
    [
      "PowerShell slash-prefixed encoded-arguments alias",
      ["pwsh", "/NoProfile", "/ea", "ZQBjAGgAbwA=", "/Command", "Get-Date"],
      true,
    ],
    ["PowerShell default-profile command", ["pwsh", "-Command", "Write-Output safe"], true],
    ["PowerShell implicit script profile", ["pwsh", "./safe.ps1"], true],
    ["PowerShell interactive default profile", ["pwsh"], true],
    ["PowerShell profile-free interactive session", ["pwsh", "-NoProfile"], true],
    ["PowerShell profile-free positional stdin", ["pwsh", "-NoProfile", "-"], true],
    [
      "PowerShell login with profiles disabled",
      ["pwsh", "-Login", "-NoProfile", "-Command", "Write-Output safe"],
      true,
    ],
    [
      "PowerShell session configuration despite disabled profiles",
      ["pwsh", "-NoProfile", "-ConfigurationFile", "/tmp/evil.pssc", "-Command", "Get-Date"],
      true,
    ],
    [
      "PowerShell named session configuration despite disabled profiles",
      ["pwsh", "-NoProfile", "-ConfigurationName", "Unreviewed", "-Command", "Get-Date"],
      true,
    ],
    [
      "PowerShell remoting server despite disabled profiles",
      ["pwsh", "-NoProfile", "-ServerMode", "-Command", "Get-Date"],
      true,
    ],
    [
      "PowerShell abbreviated remoting server",
      ["pwsh", "-NoProfile", "-s", "-Command", "Get-Date"],
      true,
    ],
    [
      "PowerShell socket remoting server",
      ["pwsh", "-NoProfile", "-SocketServerMode", "-Command", "Get-Date"],
      true,
    ],
    [
      "PowerShell abbreviated socket remoting server",
      ["pwsh", "-NoProfile", "-so", "-Command", "Get-Date"],
      true,
    ],
    [
      "PowerShell named-pipe remoting server",
      ["pwsh", "-NoProfile", "-NamedPipeServerMode", "-Command", "Get-Date"],
      true,
    ],
    [
      "PowerShell abbreviated named-pipe remoting server",
      ["pwsh", "-NoProfile", "-nam", "-Command", "Get-Date"],
      true,
    ],
    [
      "Windows PowerShell V2 socket remoting server",
      ["powershell", "-NoProfile", "-V2SocketServerMode", "-Command", "Get-Date"],
      true,
    ],
    [
      "Windows PowerShell abbreviated V2 socket remoting server",
      ["powershell", "-NoProfile", "-v2so", "-Command", "Get-Date"],
      true,
    ],
    ["PowerShell stdin command", ["pwsh", "-NoProfile", "-Command", "-"], true],
    ["PowerShell stdin script", ["pwsh", "-NoProfile", "-File", "-"], true],
    [
      "Windows PowerShell console startup despite disabled profiles",
      ["powershell", "-NoProfile", "-PSConsoleFile", "./evil.psc1", "-Command", "Get-Date"],
      true,
    ],
    [
      "PowerShell option value resembling a profile switch",
      ["pwsh", "-WorkingDir", "/nop", "-Command", "Write-Output safe"],
      true,
    ],
    [
      "PowerShell profile-free command",
      ["pwsh", "-NoProfile", "-Command", "Write-Output safe"],
      false,
    ],
    ["PowerShell profile-free positional script", ["pwsh", "-NoProfile", "./safe.ps1"], true],
    [
      "PowerShell profile-free explicit script",
      ["pwsh", "-NoProfile", "-File", "./safe.ps1"],
      true,
    ],
    ["PowerShell profile-free delimited script", ["pwsh", "-NoProfile", "--", "./safe.ps1"], true],
    ["PowerShell abbreviated profile-free command", ["pwsh", "-nop", "-c", "Get-Date"], false],
  ])("classifies %s using the canonical shell policy", (_name, argv, blocked) => {
    expect(isBlockedShellWrapperCommand(argv)).toBe(blocked);
  });

  it.each<[string, string[]]>([
    ["semantic environment mutation", ["env", "BASH_ENV=/tmp/stress", "bash", "-c", "echo safe"]],
    ["opaque privileged wrapper", ["sudo", "bash", "-c", "echo safe"]],
  ])("preserves the blocked dispatch policy for %s", (_name, argv) => {
    expect(resolveDispatchWrapperTrustPlan(argv)).toMatchObject({ policyBlocked: true });
  });

  it("fails closed for 4,096 seeded login and interactive wrapper chains", () => {
    const random = createSeededRandom(0x20260727);
    const shells = ["bash", "sh", "dash", "zsh", "ksh", "mksh", "yash"] as const;
    const startupOptions = [
      ["-lc"],
      ["-cl"],
      ["-l", "-c"],
      ["--login", "-c"],
      ["-ic"],
      ["-i", "-c"],
      ["--interactive", "-c"],
    ] as const;
    const dispatchWrappers = [
      ["env", "--"],
      ["nice", "-n", "5"],
      ["nohup", "--"],
      ["timeout", "5s"],
      ["stdbuf", "-o", "L"],
      ["time", "-p"],
    ] as const;

    for (let index = 0; index < 4_096; index += 1) {
      const argv = [
        chooseSeeded(random, shells),
        ...chooseSeeded(random, startupOptions),
        `echo auto-review-stress-${index}`,
      ];
      const wrapperDepth = Math.floor(random() * 7);
      for (let depth = 0; depth < wrapperDepth; depth += 1) {
        argv.unshift(...chooseSeeded(random, dispatchWrappers));
      }

      const trustPlan = resolveDispatchWrapperTrustPlan(argv);
      expect(
        trustPlan.policyBlocked || isBlockedShellWrapperCommand(trustPlan.argv),
        `startup wrapper escaped at seed 0x20260727, case ${index}: ${JSON.stringify(argv)}`,
      ).toBe(true);
    }
  });

  it.each([
    ["bash combined login", "bash -lc 'echo startup'"],
    ["bash reversed login flags", "bash -cl 'echo startup'"],
    ["bash separate login flags", "bash -l -c 'echo startup'"],
    ["bash long login", "bash --login -c 'echo startup'"],
    ["bash combined interactive", "bash -ic 'echo startup'"],
    ["bash separate interactive", "bash -i -c 'echo startup'"],
    ["bash long interactive", "bash --interactive -c 'echo startup'"],
    ["POSIX login", "sh -lc 'echo startup'"],
    ["absolute POSIX login", "/bin/sh -lc 'echo startup'"],
    ["dash login", "dash -l -c 'echo startup'"],
    ["zsh interactive", "zsh -i -c 'echo startup'"],
    ["fish init command", "fish -C 'echo startup' -c 'echo payload'"],
    ["fish long init command", "fish --init-command='echo startup' -c 'echo payload'"],
    ["Nushell login", "nu --login -c 'echo startup'"],
    ["Nushell interactive", "nu --interactive -c 'echo startup'"],
    ["Nushell custom config", "nu --config /tmp/auto-review-stress.nu -c 'echo startup'"],
    ["BusyBox shell", "busybox sh -lc 'echo startup'"],
    ["Toybox shell", "toybox sh -lc 'echo startup'"],
    ["env passthrough", "env -- bash -lc 'echo startup'"],
    ["env startup mutation", "env BASH_ENV=/tmp/auto-review-stress bash -c 'echo startup'"],
    ["nice carrier", "nice -n 5 bash -lc 'echo startup'"],
    ["nohup carrier", "nohup -- bash -lc 'echo startup'"],
    ["timeout carrier", "timeout 5s bash -lc 'echo startup'"],
    ["nested carriers", "nohup -- nice -n 5 env -- bash -lc 'echo startup'"],
    ["opaque privileged carrier", "sudo bash -lc 'echo startup'"],
    ["PowerShell default profile", "pwsh -Command 'Write-Output safe'"],
    ["Windows PowerShell default profile", "powershell -Command 'Write-Output safe'"],
    ["PowerShell positional script profile", "pwsh ./safe.ps1"],
    ["Windows PowerShell positional script profile", "powershell ./safe.ps1"],
    ["PowerShell explicit file profile", "pwsh -File ./safe.ps1"],
    ["PowerShell interactive default profile", "pwsh"],
    ["PowerShell profile-free interactive session", "pwsh -NoProfile"],
    ["PowerShell profile-free positional stdin", "pwsh -NoProfile -"],
    ["PowerShell profile-free delimited stdin", "pwsh -NoProfile -- -"],
    ["PowerShell profile-free positional script", "pwsh -NoProfile ./safe.ps1"],
    ["PowerShell profile-free explicit script", "pwsh -NoProfile -File ./safe.ps1"],
    ["PowerShell profile-free delimited script", "pwsh -NoProfile -- ./safe.ps1"],
    [
      "Windows PowerShell console startup despite disabled profiles",
      "powershell -NoProfile -PSConsoleFile ./evil.psc1 -Command 'Write-Output safe'",
    ],
    [
      "Windows PowerShell abbreviated console startup",
      "powershell -NoProfile -pscf ./evil.psc1 -Command 'Write-Output safe'",
    ],
    [
      "PowerShell session configuration despite disabled profiles",
      "pwsh -NoProfile -ConfigurationFile /tmp/evil.pssc -Command 'Write-Output safe'",
    ],
    [
      "PowerShell named session configuration despite disabled profiles",
      "pwsh -NoProfile -ConfigurationName Unreviewed -Command 'Write-Output safe'",
    ],
    [
      "PowerShell custom settings despite disabled profiles",
      "pwsh -NoProfile -SettingsFile /tmp/evil.json -Command 'Write-Output safe'",
    ],
    [
      "PowerShell custom IPC despite disabled profiles",
      "pwsh -NoProfile -CustomPipeName unreviewed -Command 'Write-Output safe'",
    ],
    [
      "PowerShell opaque encoded arguments",
      "pwsh -NoProfile -EncodedArguments ZQBjAGgAbwA= -Command 'Write-Output safe'",
    ],
    [
      "PowerShell encoded-arguments alias",
      "pwsh -NoProfile -ea ZQBjAGgAbwA= -Command 'Write-Output safe'",
    ],
    [
      "PowerShell slash-prefixed encoded-arguments alias",
      "pwsh /NoProfile /ea ZQBjAGgAbwA= /Command 'Write-Output safe'",
    ],
    [
      "PowerShell encoded-arguments alias inside transparent carrier",
      "env -- pwsh -NoProfile -ea ZQBjAGgAbwA= -Command 'Write-Output safe'",
    ],
    [
      "PowerShell remoting server despite disabled profiles",
      "pwsh -NoProfile -ServerMode -Command 'Write-Output safe'",
    ],
    ["PowerShell abbreviated remoting server", "pwsh -NoProfile -s -Command 'Write-Output safe'"],
    [
      "PowerShell socket remoting server",
      "pwsh -NoProfile -SocketServerMode -Command 'Write-Output safe'",
    ],
    [
      "PowerShell abbreviated socket remoting server",
      "pwsh -NoProfile -so -Command 'Write-Output safe'",
    ],
    [
      "PowerShell named-pipe remoting server",
      "pwsh -NoProfile -NamedPipeServerMode -Command 'Write-Output safe'",
    ],
    [
      "PowerShell abbreviated named-pipe remoting server",
      "pwsh -NoProfile -nam -Command 'Write-Output safe'",
    ],
    [
      "Windows PowerShell V2 socket remoting server",
      "powershell -NoProfile -V2SocketServerMode -Command 'Write-Output safe'",
    ],
    [
      "Windows PowerShell abbreviated V2 socket remoting server",
      "powershell -NoProfile -v2so -Command 'Write-Output safe'",
    ],
    [
      "PowerShell slash-prefixed socket remoting server",
      "pwsh /NoProfile /so /Command 'Write-Output safe'",
    ],
    [
      "PowerShell remoting server inside transparent carrier",
      "env -- pwsh -NoProfile -ServerMode -Command 'Write-Output safe'",
    ],
    ["PowerShell stdin command", "pwsh -NoProfile -Command -"],
    ["PowerShell stdin script", "pwsh -NoProfile -File -"],
    [
      "PowerShell interactive execution despite disabled profiles",
      "pwsh -NoProfile -Interactive -Command 'Write-Output safe'",
    ],
    [
      "PowerShell persistent interactive session",
      "pwsh -NoProfile -NoExit -Command 'Write-Output safe'",
    ],
    ["PowerShell abbreviated default profile", "pwsh /c 'Write-Output safe'"],
    ["PowerShell login profile", "pwsh -Login -Command 'Write-Output safe'"],
    ["PowerShell abbreviated login profile", "pwsh -l -Command 'Write-Output safe'"],
    [
      "PowerShell login despite disabled PowerShell profiles",
      "pwsh -Login -NoProfile -Command 'Write-Output safe'",
    ],
    [
      "PowerShell login after disabled PowerShell profiles",
      "pwsh -NoProfile -Login -Command 'Write-Output safe'",
    ],
    [
      "PowerShell login before a profile-free positional script",
      "pwsh -Login -NoProfile ./safe.ps1",
    ],
    [
      "PowerShell profile-load-time flag without profile suppression",
      "pwsh -NoProfileLoadTime -Command 'Write-Output safe'",
    ],
    [
      "PowerShell option value resembling a profile switch",
      "pwsh -WorkingDir /nop -Command 'Write-Output safe'",
    ],
    [
      "PowerShell default profile inside transparent carrier",
      "env -- pwsh -Command 'Write-Output safe'",
    ],
    ["PowerShell encoded command", "pwsh -EncodedCommand ZQBjAGgAbwAgAHAAdwBuAGUAZAA="],
    ["PowerShell abbreviated encoded command", "pwsh /ec ZQBjAGgAbwAgAHAAdwBuAGUAZAA="],
    ["PowerShell short encoded command", "pwsh -e ZQBjAGgAbwAgAHAAdwBuAGUAZAA="],
    ["PowerShell prefix encoded command", "pwsh -en ZQBjAGgAbwAgAHAAdwBuAGUAZAA="],
    ["PowerShell long slash encoded command", "pwsh /EncodedCommand ZQBjAGgAbwAgAHAAdwBuAGUAZAA="],
    [
      "PowerShell encoded command after startup flags",
      "pwsh -NoProfile -EncodedCommand ZQBjAGgAbwAgAHAAdwBuAGUAZAA=",
    ],
    [
      "PowerShell encoded command after valued options",
      "pwsh -win hidden -if XML /ec ZQBjAGgAbwAgAHAAdwBuAGUAZAA=",
    ],
    [
      "PowerShell encoded command inside transparent carrier",
      "env -- pwsh /ec ZQBjAGgAbwAgAHAAdwBuAGUAZAA=",
    ],
    ["multiple commands", "echo safe && bash -lc 'echo startup'"],
    ["unterminated command", "bash -lc 'echo startup"],
  ])("keeps %s outside plugin auto-review", async (_name, command) => {
    for (const host of ["gateway", "node", "codex-app-server"] as const) {
      await expect(
        buildExecAutoReviewInputForShellCommand({
          command,
          cwd: process.cwd(),
          host,
        }),
      ).resolves.toBeUndefined();
    }
  });

  it.each([
    "node --version",
    "git status",
    "printf safe",
    "pwsh -NoProfile -Command 'Write-Output safe'",
    "pwsh -nop -c 'Write-Output safe'",
    "pwsh /NoProfile /c 'Write-Output safe'",
  ])("preserves ordinary reviewable command: %s", async (command) => {
    for (const host of ["gateway", "node", "codex-app-server"] as const) {
      await expect(
        buildExecAutoReviewInputForShellCommand({
          command,
          cwd: process.cwd(),
          host,
        }),
      ).resolves.toMatchObject({ command, host });
    }
  });
});

describe("exec auto-review concurrency stress", () => {
  it("keeps 256 concurrent approvals independently bound and single-use", async () => {
    const { reviewer, prepare, complete } = createStressReviewer({
      complete: async () => modelResponse("allow", "low"),
    });

    const decisions = await Promise.all(
      Array.from({ length: 256 }, (_unused, index) =>
        Promise.resolve(
          reviewer({
            ...baselineInput,
            command: `git status --case=${index}`,
            argv: ["git", "status", `--case=${index}`],
          }),
        ),
      ),
    );

    expect(decisions).toHaveLength(256);
    expect(decisions.every((decision) => decision.decision === "allow-once")).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(256);
    expect(complete).toHaveBeenCalledTimes(256);
  });

  it("never leaks allow authority between 128 mixed concurrent model outcomes", async () => {
    const { reviewer, prepare, complete } = createStressReviewer({
      complete: async (request) => {
        const prompt = request.context.messages[0]?.content ?? "";
        const match = /--case=(\d+)/.exec(prompt);
        const index = Number(match?.[1]);
        await Promise.resolve();
        switch (index % 4) {
          case 0:
            return modelResponse("allow", "low");
          case 1:
            return modelResponse("allow", "medium");
          case 2:
            return modelResponse("ask", "medium");
          default:
            throw new Error("stress provider failure");
        }
      },
    });

    const decisions = await Promise.all(
      Array.from({ length: 128 }, (_unused, index) =>
        Promise.resolve(
          reviewer({
            ...baselineInput,
            command: `git status --case=${index}`,
            argv: ["git", "status", `--case=${index}`],
          }),
        ),
      ),
    );

    for (const [index, decision] of decisions.entries()) {
      expect(decision.decision, `concurrent case ${index}`).toBe(
        index % 4 === 0 ? "allow-once" : "ask",
      );
    }
    expect(prepare).toHaveBeenCalledTimes(128);
    expect(complete).toHaveBeenCalledTimes(128);
  });

  it("aborts every timed-out provider during 64 concurrent approval requests", async () => {
    vi.useFakeTimers();
    try {
      const observedSignals: AbortSignal[] = [];
      const { reviewer, prepare, complete } = createStressReviewer({
        timeoutMs: 1_000,
        complete: async (request) => {
          const signal = request.options.signal;
          if (!signal) {
            throw new Error("review completion must receive an abort signal");
          }
          observedSignals.push(signal);
          return await new Promise<StressCompletionResult>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("stress timeout")), {
              once: true,
            });
          });
        },
      });

      const pending = Promise.all(
        Array.from({ length: 64 }, (_unused, index) =>
          Promise.resolve(
            reviewer({
              ...baselineInput,
              command: `git status --case=${index}`,
              argv: ["git", "status", `--case=${index}`],
            }),
          ),
        ),
      );

      await vi.advanceTimersByTimeAsync(1_001);
      const decisions = await pending;

      expect(decisions).toHaveLength(64);
      expect(decisions.every((decision) => decision.decision === "ask")).toBe(true);
      expect(observedSignals).toHaveLength(64);
      expect(observedSignals.every((signal) => signal.aborted)).toBe(true);
      expect(prepare).toHaveBeenCalledTimes(64);
      expect(complete).toHaveBeenCalledTimes(64);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
