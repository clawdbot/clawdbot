import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { isWSL2Sync } from "openclaw/plugin-sdk/runtime-env";

const execFileAsync = promisify(execFile);
const SYSTEMCTL_TIMEOUT_MS = 5_000;
const WSL_CUDA_MARKERS = [
  "/dev/dxg",
  "/usr/lib/wsl/lib/nvidia-smi",
  "/usr/lib/wsl/lib/libcuda.so.1",
  "/usr/local/cuda",
];

export function parseSystemctlShowProperties(stdout: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    properties.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return properties;
}

export async function isOllamaEnabledWithRestartAlways(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "systemctl",
      ["show", "ollama.service", "--property=UnitFileState,Restart", "--no-pager"],
      { timeout: SYSTEMCTL_TIMEOUT_MS },
    );
    const properties = parseSystemctlShowProperties(stdout);
    return properties.get("UnitFileState") === "enabled" && properties.get("Restart") === "always";
  } catch {
    return false;
  }
}

export async function hasWslCuda(): Promise<boolean> {
  for (const marker of WSL_CUDA_MARKERS) {
    try {
      await access(marker);
      return true;
    } catch {
      // Try the next cheap marker.
    }
  }
  return false;
}

export async function checkWsl2CrashLoopRisk(logger: PluginLogger): Promise<void> {
  try {
    if (!isWSL2Sync()) {
      return;
    }
    if (!(await isOllamaEnabledWithRestartAlways())) {
      return;
    }
    if (!(await hasWslCuda())) {
      return;
    }

    logger.warn(
      [
        "[ollama] WSL2 crash-loop risk: ollama.service is enabled with Restart=always and CUDA is visible.",
        "On WSL2, GPU-backed Ollama can pin host memory while loading a model.",
        "Hyper-V memory reclaim cannot always reclaim those pinned pages, so Windows can terminate and restart the WSL2 VM.",
        "",
        "Common evidence: repeated WSL2 reboots, high CPU in app.slice at startup, and SIGTERM from systemd rather than the Linux OOM killer.",
        "See: https://github.com/ollama/ollama/issues/11317",
        "",
        "Mitigation:",
        "  1. Disable autostart: sudo systemctl disable ollama",
        "  2. Add [experimental] autoMemoryReclaim=disabled to %USERPROFILE%\\.wslconfig on Windows, then run wsl --shutdown",
        "  3. Set OLLAMA_KEEP_ALIVE=5m in the Ollama service environment or start ollama serve manually when needed",
      ].join("\n"),
    );
  } catch {
    // Advisory only: never break provider registration or model discovery.
  }
}
