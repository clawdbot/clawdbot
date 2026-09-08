import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareRestartScript, runRestartScript } from "./restart-helper.js";

const windowsKillPolicyStartMarker = "# OPENCLAW_RESTART_KILL_POLICY_BEGIN";
const windowsKillPolicyEndMarker = "# OPENCLAW_RESTART_KILL_POLICY_END";

function findPowerShell(): string | null {
  const executables = process.platform === "win32" ? ["powershell.exe", "pwsh.exe"] : ["pwsh"];
  const candidates = [
    process.env.OPENCLAW_TEST_PWSH,
    ...executables.flatMap((executable) =>
      (process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.join(dir, executable)),
    ),
  ];
  return (
    candidates.find((candidate): candidate is string =>
      Boolean(candidate && existsSync(candidate)),
    ) ?? null
  );
}

const powerShellPath = findPowerShell();
const itWithPowerShell = powerShellPath ? it : it.skip;

async function prepareWindowsScript(gatewayArgv: readonly string[] = []): Promise<string> {
  const originalPlatform = process.platform;
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    const scriptPath = await prepareRestartScript({}, 18789, gatewayArgv);
    if (!scriptPath) {
      throw new Error("expected a standalone restart script");
    }
    return scriptPath;
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
}

function extractWindowsKillPolicy(content: string): string {
  const start = content.indexOf(windowsKillPolicyStartMarker);
  const end = content.indexOf(windowsKillPolicyEndMarker, start);
  if (start < 0 || end < 0) {
    throw new Error("Windows restart kill-policy markers missing");
  }
  return content.slice(start + windowsKillPolicyStartMarker.length, end);
}

async function executeWindowsKillPolicy(content: string, testBody: string) {
  if (!powerShellPath) {
    throw new Error("PowerShell is unavailable");
  }
  const policy = extractWindowsKillPolicy(content);
  const input = [
    "& {",
    '$ErrorActionPreference = "Stop"',
    "$script:RestartLogs = [Collections.Generic.List[string]]::new()",
    "function Write-RestartLog { param([string]$Message) $script:RestartLogs.Add($Message) | Out-Null }",
    policy,
    testBody,
    "}\n\n",
  ].join("\n");
  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(
      powerShellPath,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"],
      { env: process.env },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`PowerShell policy test failed: ${stderr || stdout}`, { cause: error }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    child.stdin?.end(input);
  });
}

itWithPowerShell(
  "executes the shipped PowerShell kill policy with mocked Windows facts",
  async () => {
    const scriptPath = await prepareWindowsScript([
      "node",
      "C:\\openclaw\\dist\\entry.js",
      "gateway",
      "--port",
      "18789",
    ]);
    try {
      const content = await fs.readFile(scriptPath.replace(/\.cmd$/u, ".ps1"), "utf8");
      const result = await executeWindowsKillPolicy(
        content,
        String.raw`
function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Assert-DecisionLog {
  param([string]$Decision)
  $match = @($script:RestartLogs | Where-Object { $_ -like "*decision=$Decision*" })
  Assert-True ($match.Count -gt 0) "missing decision log: $Decision"
}

$commandLines = @(
  @{ Line = '"C:\Program Files\node.exe" "C:\openclaw\entry.js" gateway'; Expected = @('C:\Program Files\node.exe', 'C:\openclaw\entry.js', 'gateway') },
  @{ Line = 'node "" "a b" C:\plain\path'; Expected = @('node', '', 'a b', 'C:\plain\path') },
  @{ Line = 'node a\\\b d"e f"g h'; Expected = @('node', 'a\\\b', 'de fg', 'h') },
  @{ Line = 'node a\\\"b c d'; Expected = @('node', 'a\"b', 'c', 'd') },
  @{ Line = 'node a\\\\"b c" d e'; Expected = @('node', 'a\\b c', 'd', 'e') },
  @{ Line = 'node "a""b"'; Expected = @('node', 'a"b') },
  @{ Line = 'node a"""b'; Expected = @('node', 'a"b') },
  @{ Line = 'node a""""b'; Expected = @('node', 'a"b') },
  @{ Line = 'node "C:\trailing\\"'; Expected = @('node', 'C:\trailing\') },
  @{ Line = ('node' + [char]9 + 'first' + [char]9 + 'second'); Expected = @('node', 'first', 'second') }
)
foreach ($case in $commandLines) {
  $actual = @(Split-OpenClawWindowsCommandLine -CommandLine $case.Line)
  Assert-True ($actual.Count -eq $case.Expected.Count) "argument count mismatch: $($case.Line)"
  for ($index = 0; $index -lt $actual.Count; $index++) {
    Assert-True ([string]::Equals($actual[$index], $case.Expected[$index], [StringComparison]::Ordinal)) "argument mismatch: $($case.Line) at $index"
  }
}

function New-ProcessFacts {
  param([int]$ProcessId, [string]$CreationTime, [string[]]$Argv)
  return [pscustomobject]@{
    ProcessId = $ProcessId
    CreationTimeFileTime = $CreationTime
    Argv = $Argv
  }
}

function New-TestLease {
  param([string]$CreationTime)
  $lease = [pscustomobject]@{
    CreatedAt = [datetime]::FromFileTimeUtc([long]$CreationTime)
    Held = $false
    Terminated = $false
    Disposed = $false
  }
  $lease | Add-Member -MemberType ScriptProperty -Name Handle -Value {
    $this.Held = $true
    return 1
  }
  $lease | Add-Member -MemberType ScriptProperty -Name StartTime -Value {
    if (-not $this.Held) { throw "identity read without a retained process handle" }
    return $this.CreatedAt
  }
  $lease | Add-Member -MemberType ScriptMethod -Name Kill -Value {
    if (-not $this.Held) { throw "kill without a retained process handle" }
    $this.Terminated = $true
  }
  $lease | Add-Member -MemberType ScriptMethod -Name Dispose -Value {
    $this.Disposed = $true
  }
  return $lease
}

function Invoke-MockedKill {
  param($Observed, $Rechecked, $Listeners, $Lease, [string[]]$ExpectedArgv)
  $script:MockObserved = $Observed
  $script:MockRechecked = $Rechecked
  $script:MockListeners = $Listeners
  $script:MockLease = $Lease
  $script:ProcessQueryCalls = 0
  $script:ListenerQueryCalls = 0
  $script:ProcessOpenCalls = 0
  $processQuery = {
    param([int]$IgnoredPid)
    $script:ProcessQueryCalls += 1
    if ($script:ProcessQueryCalls -eq 1) { return $script:MockObserved }
    return $script:MockRechecked
  }
  $listenerQuery = {
    param([int]$IgnoredPort)
    $script:ListenerQueryCalls += 1
    return $script:MockListeners
  }
  $processOpen = {
    param([int]$IgnoredPid)
    $script:ProcessOpenCalls += 1
    return $script:MockLease
  }
  Invoke-OpenClawVerifiedListenerKill -ProcessId 4242 -Port 18789 -ExpectedArgv $ExpectedArgv -ProcessQuery $processQuery -ListenerQuery $listenerQuery -ProcessOpen $processOpen
}

# Get-NetTCPConnection exposes object properties, including duplicate IPv4/IPv6 rows.
function Get-NetTCPConnection {
  param($State, $ErrorAction)
  @(
    [pscustomobject]@{ LocalPort = 18789; OwningProcess = 4242 },
    [pscustomobject]@{ LocalPort = 18789; OwningProcess = 4242 },
    [pscustomobject]@{ LocalPort = 443; OwningProcess = 5252 }
  )
}
$snapshot = Get-OpenClawListenerSnapshot -Port 18789
Assert-True $snapshot.Known "Get-NetTCPConnection snapshot should be known"
Assert-True (@($snapshot.Pids).Count -eq 1) "duplicate listener PIDs should collapse"
Assert-True (@($snapshot.Pids)[0] -eq 4242) "wrong Get-NetTCPConnection PID"

# Force the locale-independent netstat fallback. Localized state text is ignored.
function Get-NetTCPConnection { param($State, $ErrorAction) throw "unavailable" }
function netstat.exe {
  $script:LASTEXITCODE = 0
  @(
    "  TCP    0.0.0.0:18789      0.0.0.0:0       LISTENING      4242",
    "  TCP    [::]:18789         [::]:0          ABHÖREN        4242",
    "  TCP    127.0.0.1:18789    127.0.0.1:61234 HERGESTELLT     5252"
  )
}
$snapshot = Get-OpenClawListenerSnapshot -Port 18789
Assert-True $snapshot.Known "netstat snapshot should be known"
Assert-True (@($snapshot.Pids).Count -eq 1) "netstat IPv4/IPv6 PIDs should collapse"
Assert-True (@($snapshot.Pids)[0] -eq 4242) "wrong netstat PID"

function netstat.exe { $script:LASTEXITCODE = 1 }
$snapshot = Get-OpenClawListenerSnapshot -Port 18789
Assert-True (-not $snapshot.Known) "failed listener queries must remain unknown"

$creation = "133987654321000000"
$expected = @("node", "C:\openclaw\dist\entry.js", "gateway", "--port", "18789")
$managed = New-ProcessFacts 4242 $creation @("node.exe", "C:\openclaw\dist\entry.js", "gateway", "--port", "18789")
$knownListener = [pscustomobject]@{ Known = $true; Pids = @(4242) }

$script:RestartLogs.Clear()
$lease = New-TestLease $creation
Invoke-MockedKill $managed $managed $knownListener $lease $expected
Assert-True $lease.Terminated "managed stale listener was not killed"
Assert-True $lease.Disposed "managed listener handle was not disposed"
Assert-True ($script:ProcessQueryCalls -eq 2) "managed process was not rechecked"
Assert-True ($script:ListenerQueryCalls -eq 1) "managed listener was not rechecked"

$script:RestartLogs.Clear()
$foreign = New-ProcessFacts 4242 $creation @("python.exe", "foreign-listener.py")
$lease = New-TestLease $creation
Invoke-MockedKill $foreign $foreign $knownListener $lease $expected
Assert-True (-not $lease.Terminated) "foreign listener was killed"
Assert-True ($script:ProcessOpenCalls -eq 0) "foreign listener opened a terminate handle"
Assert-DecisionLog "command-mismatch"

$script:RestartLogs.Clear()
$lease = New-TestLease $creation
Invoke-MockedKill $null $null $knownListener $lease $expected
Assert-True (-not $lease.Terminated) "unknown owner was killed"
Assert-True ($script:ProcessOpenCalls -eq 0) "unknown owner opened a terminate handle"
Assert-DecisionLog "process-unavailable"

$script:RestartLogs.Clear()
$lease = New-TestLease $creation
$unknownListeners = [pscustomobject]@{ Known = $false; Pids = @() }
Invoke-MockedKill $managed $managed $unknownListeners $lease $expected
Assert-True (-not $lease.Terminated) "unknown listener state was killed"
Assert-True $lease.Disposed "unknown listener handle was not disposed"
Assert-DecisionLog "listener-query-unavailable"

$script:RestartLogs.Clear()
$recycledLease = New-TestLease "133987654399000000"
Invoke-MockedKill $managed $managed $knownListener $recycledLease $expected
Assert-True (-not $recycledLease.Terminated) "recycled PID target was killed"
Assert-True $recycledLease.Disposed "recycled PID handle was not disposed"
Assert-DecisionLog "process-replaced"

Write-Output "OPENCLAW_RESTART_POLICY_OK"
`,
      );

      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("OPENCLAW_RESTART_POLICY_OK");
    } finally {
      await fs.rm(path.dirname(scriptPath), { recursive: true, force: true });
    }
  },
);

describe.runIf(process.platform === "win32")("Windows restart wrapper", () => {
  it.each([
    {
      name: "completed restart",
      body: '& { [Console]::Out.WriteLine("OPENCLAW_RESTART_COMPLETE"); exit 0 }\n\n',
      accepted: true,
    },
    {
      name: "failed restart with a completion marker",
      body: '& { [Console]::Out.WriteLine("OPENCLAW_RESTART_COMPLETE"); exit 7 }\n\n',
      accepted: false,
    },
    {
      name: "malformed input",
      body: '& { [Console]::Out.WriteLine("OPENCLAW_RESTART_COMPLETE"); this is ( }\n\n',
      accepted: false,
    },
    {
      name: "incomplete input",
      body: '& { [Console]::Out.WriteLine("OPENCLAW_RESTART_COMPLETE"); exit 0\n',
      accepted: false,
    },
  ])("reports the native outcome for $name", async ({ body, accepted }) => {
    const scriptPath = await prepareWindowsScript();
    try {
      await fs.writeFile(scriptPath.replace(/\.cmd$/u, ".ps1"), body);
      // A leftover outcome cannot authorize a new invocation that never ran.
      await fs.writeFile(scriptPath.replace(/\.cmd$/u, ".out"), "OPENCLAW_RESTART_COMPLETE\r\n");
      await expect(runRestartScript(scriptPath, 10_000)).resolves.toBe(accepted);
      expect(existsSync(path.dirname(scriptPath))).toBe(false);
    } finally {
      await fs.rm(path.dirname(scriptPath), { recursive: true, force: true });
    }
  });
});
