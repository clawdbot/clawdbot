/** Locale-independent Task Scheduler registration and runtime facts. */
import { spawnSync } from "node:child_process";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";

type ScheduledTaskStateProbe =
  | { status: "found"; state: number | null; lastRunResult?: string; lastRunTime?: string }
  | { status: "missing" }
  | { status: "unknown"; detail: string };

export function probeScheduledTaskState(
  taskName: string,
  timeoutMs?: number,
): ScheduledTaskStateProbe {
  const encodedTaskName = Buffer.from(taskName, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$taskName=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTaskName}'))`,
    "$lookup=$false",
    "try { $service=New-Object -ComObject 'Schedule.Service'; $service.Connect(); $lookup=$true; $task=$service.GetFolder('\\').GetTask($taskName); $lookup=$false } catch { $exception=$_.Exception; while($null -ne $exception.InnerException){$exception=$exception.InnerException}; [Console]::Out.Write($exception.HResult); if($lookup){exit 1}; exit 2 }",
    // A registered task stays found even when state or optional history cannot be read.
    "$result=@{state=$null}",
    "try { $result.state=[int]$task.State } catch {}",
    "try { $result.lastRunResult=[int]$task.LastTaskResult } catch {}",
    "try { $result.lastRunTime=$task.LastRunTime.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture) } catch {}",
    "$result | ConvertTo-Json -Compress; exit 0",
  ].join("; ");
  // -Command - (script piped over stdin) reads identically to -EncodedCommand but is not
  // the base64-encoded-PowerShell pattern antivirus heuristics flag as malware evasion.
  // Windows PowerShell 5.1's -File - echoes an interactive prompt/transcript ahead of the
  // script's own stdout, corrupting the JSON/HRESULT parsing below; -Command - does not.
  const probe = spawnSync(
    getWindowsPowerShellExePath(),
    ["-NoProfile", "-NonInteractive", "-Command", "-"],
    {
      encoding: "utf8",
      timeout: timeoutMs && timeoutMs > 0 ? Math.min(timeoutMs, 5_000) : 5_000,
      windowsHide: true,
      input: script,
    },
  );
  if (probe.error) {
    return { status: "unknown", detail: probe.error.message };
  }
  if (probe.status === 0) {
    let snapshot: Record<string, unknown> | undefined;
    try {
      snapshot = asOptionalRecord(JSON.parse(probe.stdout));
    } catch {}
    if (!snapshot) {
      return { status: "unknown", detail: "Scheduled Task probe returned invalid JSON." };
    }
    const { state, lastRunResult, lastRunTime } = snapshot;
    return {
      status: "found",
      state:
        typeof state === "number" && Number.isInteger(state) && state >= 0 && state <= 4
          ? state
          : null,
      ...(typeof lastRunResult === "number" && Number.isInteger(lastRunResult)
        ? { lastRunResult: String(lastRunResult) }
        : {}),
      ...(typeof lastRunTime === "string" ? { lastRunTime } : {}),
    };
  }
  const hresult = Number(probe.stdout.trim());
  // Only a missing task/folder during lookup proves absence, not a failed COM connection.
  return probe.status === 1 && (hresult === -2147024894 || hresult === -2147024893)
    ? { status: "missing" }
    : {
        status: "unknown",
        detail: `Scheduled Task probe failed (exit ${probe.status}): ${probe.stdout || probe.stderr}`,
      };
}

export function probeScheduledTaskExists(taskName: string, timeoutMs?: number): boolean | null {
  const probe = probeScheduledTaskState(taskName, timeoutMs);
  return probe.status === "found" ? true : probe.status === "missing" ? false : null;
}
