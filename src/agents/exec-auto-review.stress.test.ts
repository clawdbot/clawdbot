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
  signal?: AbortSignal;
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
    signal: params.signal,
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

describe("exec auto-review shell stress", () => {
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
    ["Windows cmd default AutoRun", ["cmd", "/c", "echo safe"], true],
    ["Windows cmd.exe default AutoRun", ["cmd.exe", "/c", "echo safe"], true],
    ["Windows cmd uppercase default AutoRun", ["CMD.EXE", "/C", "echo safe"], true],
    ["Windows cmd hyphenated default AutoRun", ["cmd", "-c", "echo safe"], true],
    ["Windows cmd persistent interactive shell", ["cmd", "/k", "echo safe"], true],
    [
      "Windows cmd persistent shell despite disabled AutoRun",
      ["cmd", "/d", "/k", "echo safe"],
      true,
    ],
    ["Windows cmd switch-only interactive shell", ["cmd", "/d"], true],
    ["Windows cmd bare interactive shell", ["cmd.exe"], true],
    ["Windows cmd missing inline payload", ["cmd", "/d", "/c"], true],
    ["Windows cmd help still enables AutoRun", ["cmd", "/?"], true],
    ["Windows cmd help cannot bind a later command", ["cmd", "/?", "/c", "echo safe"], true],
    ["Windows cmd disabled AutoRun help still has no bound payload", ["cmd", "/d", "/?"], true],
    [
      "Windows cmd /r binds before a later AutoRun switch",
      ["cmd", "/r", "/d", "/c", "echo safe"],
      true,
    ],
    [
      "Windows cmd /r after disabled AutoRun is not a bound /c",
      ["cmd", "/d", "/r", "/c", "echo safe"],
      true,
    ],
    [
      "Windows cmd unknown switches cannot hide startup",
      ["cmd", "/unknown", "/d", "/c", "echo safe"],
      true,
    ],
    [
      "Windows cmd color option cannot smuggle /k",
      ["cmd", "/t:0f/k", "/d", "/c", "echo safe"],
      true,
    ],
    [
      "Windows cmd extension option cannot smuggle /k",
      ["cmd", "/e:on/k", "/d", "/c", "echo safe"],
      true,
    ],
    [
      "Windows cmd expansion option cannot smuggle /r",
      ["cmd", "/v:on/r", "/d", "/c", "echo safe"],
      true,
    ],
    ["Windows cmd payload cannot disable prior AutoRun", ["cmd", "/c", "echo", "/d"], true],
    ["Windows cmd profile-free command", ["cmd", "/d", "/c", "echo safe"], false],
    [
      "Windows cmd documented quiet and quote switches",
      ["cmd", "/d", "/s", "/q", "/c", "echo safe"],
      false,
    ],
    [
      "Windows cmd documented configuration switches",
      ["cmd", "/d", "/e:on", "/f:off", "/v:on", "/t:0f", "/c", "echo safe"],
      false,
    ],
    [
      "Windows cmd uppercase profile-free command",
      ["CMD.EXE", "/D", "/S", "/C", "echo safe"],
      false,
    ],
    [
      "Windows cmd hyphenated switches do not disable AutoRun",
      ["cmd", "-d", "-c", "echo safe"],
      true,
    ],
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

  it("fails closed for 16,384 seeded Windows cmd startup wrapper chains", () => {
    const random = createSeededRandom(0x20260728);
    const opaqueShells = [
      ["cmd", "/c", "echo safe"],
      ["cmd.exe", "/C", "echo safe"],
      ["CMD.EXE", "-c", "echo safe"],
      ["cmd", "/k", "echo safe"],
      ["cmd.exe", "/d", "/k", "echo safe"],
      ["cmd", "/D", "/S", "/K", "echo safe"],
      ["cmd", "-d", "-c", "echo safe"],
      ["cmd", "/?"],
      ["cmd", "/?", "/c", "echo safe"],
      ["cmd.exe", "/d", "/?"],
      ["cmd", "/r", "/d", "/c", "echo safe"],
      ["cmd", "/d", "/r", "/c", "echo safe"],
      ["cmd", "/unknown", "/d", "/c", "echo safe"],
      ["cmd", "/t:0f/k", "/d", "/c", "echo safe"],
      ["cmd", "/e:on/k", "/d", "/c", "echo safe"],
      ["cmd", "/v:on/r", "/d", "/c", "echo safe"],
      ["cmd.exe", "/d", "/c"],
      ["cmd", "/c", "echo", "/d"],
      ["cmd.exe"],
    ] as const;
    const dispatchWrappers = [
      ["env", "--"],
      ["nice", "-n", "5"],
      ["nohup", "--"],
      ["timeout", "5s"],
      ["stdbuf", "-o", "L"],
      ["time", "-p"],
    ] as const;

    for (let index = 0; index < 16_384; index += 1) {
      const argv: string[] = [...chooseSeeded(random, opaqueShells)];
      const wrapperDepth = Math.floor(random() * 7);
      for (let depth = 0; depth < wrapperDepth; depth += 1) {
        argv.unshift(...chooseSeeded(random, dispatchWrappers));
      }

      const trustPlan = resolveDispatchWrapperTrustPlan(argv);
      expect(
        trustPlan.policyBlocked || isBlockedShellWrapperCommand(trustPlan.argv),
        `Windows cmd startup escaped at seed 0x20260728, case ${index}: ${JSON.stringify(argv)}`,
      ).toBe(true);
    }
  });

  it.runIf(process.platform !== "win32").each([
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
    ["Windows cmd default AutoRun", "cmd /c echo safe"],
    ["Windows cmd.exe default AutoRun", "cmd.exe /c echo safe"],
    ["Windows cmd uppercase default AutoRun", "CMD.EXE /C echo safe"],
    ["Windows cmd hyphenated default AutoRun", "cmd -c echo safe"],
    ["Windows cmd hyphenated switches do not disable AutoRun", "cmd -d -c echo safe"],
    ["Windows cmd persistent interactive shell", "cmd /k echo safe"],
    ["Windows cmd persistent shell despite disabled AutoRun", "cmd /d /k echo safe"],
    ["Windows cmd switch-only interactive shell", "cmd /d"],
    ["Windows cmd bare interactive shell", "cmd.exe"],
    ["Windows cmd missing inline payload", "cmd /d /c"],
    ["Windows cmd help still enables AutoRun", "cmd /?"],
    ["Windows cmd help cannot bind a later command", "cmd /? /c echo safe"],
    ["Windows cmd disabled AutoRun help still has no bound payload", "cmd /d /?"],
    ["Windows cmd /r binds before a later AutoRun switch", "cmd /r /d /c echo safe"],
    ["Windows cmd /r after disabled AutoRun is not a bound /c", "cmd /d /r /c echo safe"],
    ["Windows cmd unknown switches cannot hide startup", "cmd /unknown /d /c echo safe"],
    ["Windows cmd color option cannot smuggle /k", "cmd /t:0f/k /d /c echo safe"],
    ["Windows cmd extension option cannot smuggle /k", "cmd /e:on/k /d /c echo safe"],
    ["Windows cmd expansion option cannot smuggle /r", "cmd /v:on/r /d /c echo safe"],
    ["Windows cmd payload cannot disable prior AutoRun", "cmd /c echo /d"],
    ["Windows cmd AutoRun inside transparent carrier", "env -- cmd.exe /c echo safe"],
    [
      "Windows cmd persistent shell inside nested carriers",
      "nohup -- nice -n 5 env -- cmd.exe /d /k echo safe",
    ],
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

  it
    .runIf(process.platform !== "win32")
    .each([
      "node --version",
      "git status",
      "printf safe",
      "cmd /d /c echo safe",
      "cmd.exe /d /s /c echo safe",
      "CMD.EXE /D /S /C echo safe",
      "cmd /d /s /q /c echo safe",
      "cmd /d /e:on /f:off /v:on /t:0f /c echo safe",
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

describe("exec auto-review adversarial model-response stress", () => {
  it("fails closed for 4,096 seeded concurrent malformed reviewer responses", async () => {
    const random = createSeededRandom(0x20260729);
    const variants = [
      {
        name: "duplicate decision",
        text: '{"decision":"ask","risk":"low","decision":"allow"}',
        expected: "ask",
      },
      {
        name: "duplicate risk",
        text: '{"decision":"allow","risk":"high","risk":"low"}',
        expected: "ask",
      },
      {
        name: "escaped duplicate decision",
        text: String.raw`{"decision":"ask","risk":"low","\u0064ecision":"allow"}`,
        expected: "ask",
      },
      {
        name: "escaped duplicate risk",
        text: String.raw`{"decision":"allow","risk":"high","r\u0069sk":"low"}`,
        expected: "ask",
      },
      {
        name: "unexpected approval scope",
        text: '{"decision":"allow","risk":"low","scope":"session"}',
        expected: "ask",
      },
      {
        name: "unexpected executable",
        text: '{"decision":"allow","risk":"low","approvedCommand":"rm -rf /"}',
        expected: "ask",
      },
      {
        name: "truncated JSON",
        text: '{"decision":"allow","risk":"low"',
        expected: "ask",
      },
      {
        name: "concatenated decisions",
        text: '{"decision":"ask","risk":"high"}{"decision":"allow","risk":"low"}',
        expected: "ask",
      },
      {
        name: "valid low-risk allow",
        text: '{"decision":"allow","risk":"low","rationale":"safe seeded control"}',
        expected: "allow-once",
      },
      {
        name: "valid human escalation",
        text: '{"decision":"ask","risk":"high","rationale":"safe seeded control"}',
        expected: "ask",
      },
    ] as const;
    const cases = Array.from({ length: 4_096 }, () => chooseSeeded(random, variants));
    const { reviewer, prepare, complete } = createStressReviewer({
      complete: async (request) => {
        const prompt = request.context.messages[0]?.content ?? "";
        const match = /--case=(\d+)/.exec(prompt);
        const variant = cases[Number(match?.[1])];
        if (!variant) {
          throw new Error("missing seeded reviewer response");
        }
        return {
          stopReason: "stop" as const,
          content: [{ type: "text" as const, text: variant.text }],
        };
      },
    });

    for (let start = 0; start < cases.length; start += 256) {
      const batch = cases.slice(start, start + 256);
      const decisions = await Promise.all(
        batch.map((_variant, offset) => {
          const index = start + offset;
          return Promise.resolve(
            reviewer({
              ...baselineInput,
              command: `git status --case=${index}`,
              argv: ["git", "status", `--case=${index}`],
            }),
          );
        }),
      );
      for (const [offset, decision] of decisions.entries()) {
        const index = start + offset;
        const variant = cases[index];
        expect(
          decision.decision,
          `reviewer response escaped at seed 0x20260729, case ${index}: ${variant?.name}`,
        ).toBe(variant?.expected);
      }
    }

    expect(prepare).toHaveBeenCalledTimes(cases.length);
    expect(complete).toHaveBeenCalledTimes(cases.length);
  });
});

describe("exec auto-review concurrency stress", () => {
  it("cancels 64 concurrent provider reviews without sharing execution signals", async () => {
    const controllers = Array.from({ length: 64 }, () => new AbortController());
    const observedSignals: AbortSignal[] = [];
    const requests = controllers.map((controller, index) => {
      const { reviewer } = createStressReviewer({
        signal: controller.signal,
        complete: async (request) => {
          const providerSignal = request.options.signal;
          if (!providerSignal) {
            throw new Error("review completion must receive an abort signal");
          }
          observedSignals.push(providerSignal);
          return await new Promise<StressCompletionResult>((_resolve, reject) => {
            providerSignal.addEventListener("abort", () => reject(new Error("provider aborted")), {
              once: true,
            });
          });
        },
      });
      return Promise.resolve(
        reviewer({
          ...baselineInput,
          command: `git status --cancel-case=${index}`,
          argv: ["git", "status", `--cancel-case=${index}`],
        }),
      );
    });
    const settled = Promise.allSettled(requests);
    await vi.waitFor(() => expect(observedSignals).toHaveLength(controllers.length));

    for (const [index, controller] of controllers.entries()) {
      controller.abort(new Error(`cancelled review ${index}`));
    }

    const results = await settled;
    for (const [index, result] of results.entries()) {
      expect(result.status, `cancelled review ${index}`).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ message: `cancelled review ${index}` });
      }
    }
    expect(observedSignals.every((signal) => signal.aborted)).toBe(true);
  });

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
