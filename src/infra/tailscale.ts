import { existsSync } from "node:fs";
import { promptYesNo } from "../cli/prompt.js";
import {
  danger,
  info,
  logVerbose,
  shouldLogVerbose,
  warn,
} from "../globals.js";
import { runExec } from "../process/exec.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import { ensureBinary } from "./binaries.js";

export async function getTailnetHostname(exec: typeof runExec = runExec) {
  // Derive tailnet hostname (or IP fallback) from tailscale status JSON.
  const candidates = [
    "tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  ];
  let lastError: unknown;

  for (const candidate of candidates) {
    if (candidate.startsWith("/") && !existsSync(candidate)) continue;
    try {
      const { stdout } = await exec(candidate, ["status", "--json"]);
      const parsed = stdout
        ? (JSON.parse(stdout) as Record<string, unknown>)
        : {};
      const self =
        typeof parsed.Self === "object" && parsed.Self !== null
          ? (parsed.Self as Record<string, unknown>)
          : undefined;
      const dns =
        typeof self?.DNSName === "string"
          ? (self.DNSName as string)
          : undefined;
      const ips = Array.isArray(self?.TailscaleIPs)
        ? (self.TailscaleIPs as string[])
        : [];
      if (dns && dns.length > 0) return dns.replace(/\.$/, "");
      if (ips.length > 0) return ips[0];
      throw new Error("Could not determine Tailscale DNS or IP");
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError ?? new Error("Could not determine Tailscale DNS or IP");
}

export async function ensureGoInstalled(
  exec: typeof runExec = runExec,
  prompt: typeof promptYesNo = promptYesNo,
  runtime: RuntimeEnv = defaultRuntime,
) {
  // Ensure Go toolchain is present; offer Homebrew install if missing.
  const hasGo = await exec("go", ["version"]).then(
    () => true,
    () => false,
  );
  if (hasGo) return;
  const install = await prompt(
    "Go is not installed. Install via Homebrew (brew install go)?",
    true,
  );
  if (!install) {
    runtime.error("Go is required to build tailscaled from source. Aborting.");
    runtime.exit(1);
  }
  logVerbose("Installing Go via Homebrew…");
  await exec("brew", ["install", "go"]);
}

export async function ensureTailscaledInstalled(
  exec: typeof runExec = runExec,
  prompt: typeof promptYesNo = promptYesNo,
  runtime: RuntimeEnv = defaultRuntime,
) {
  // Ensure tailscaled binary exists; install via Homebrew tailscale if missing.
  const hasTailscaled = await exec("tailscaled", ["--version"]).then(
    () => true,
    () => false,
  );
  if (hasTailscaled) return;

  const install = await prompt(
    "tailscaled not found. Install via Homebrew (tailscale package)?",
    true,
  );
  if (!install) {
    runtime.error("tailscaled is required for user-space funnel. Aborting.");
    runtime.exit(1);
  }
  logVerbose("Installing tailscaled via Homebrew…");
  await exec("brew", ["install", "tailscale"]);
}

export async function ensureFunnel(
  port: number,
  exec: typeof runExec = runExec,
  runtime: RuntimeEnv = defaultRuntime,
  prompt: typeof promptYesNo = promptYesNo,
) {
  // Ensure Funnel is enabled and publish the webhook port.
  try {
    const statusOut = (
      await exec("tailscale", ["funnel", "status", "--json"])
    ).stdout.trim();
    const parsed = statusOut
      ? (JSON.parse(statusOut) as Record<string, unknown>)
      : {};
    if (!parsed || Object.keys(parsed).length === 0) {
      runtime.error(
        danger("Tailscale Funnel is not enabled on this tailnet/device."),
      );
      runtime.error(
        info(
          "Enable in admin console: https://login.tailscale.com/admin (see https://tailscale.com/kb/1223/funnel)",
        ),
      );
      runtime.error(
        info(
          "macOS user-space tailscaled docs: https://github.com/tailscale/tailscale/wiki/Tailscaled-on-macOS",
        ),
      );
      const proceed = await prompt(
        "Attempt local setup with user-space tailscaled?",
        true,
      );
      if (!proceed) runtime.exit(1);
      await ensureBinary("brew", exec, runtime);
      await ensureGoInstalled(exec, prompt, runtime);
      await ensureTailscaledInstalled(exec, prompt, runtime);
    }

    logVerbose(`Enabling funnel on port ${port}…`);
    const { stdout } = await exec(
      "tailscale",
      ["funnel", "--yes", "--bg", `${port}`],
      {
        maxBuffer: 200_000,
        timeoutMs: 15_000,
      },
    );
    if (stdout.trim()) console.log(stdout.trim());
  } catch (err) {
    const errOutput = err as { stdout?: unknown; stderr?: unknown };
    const stdout = typeof errOutput.stdout === "string" ? errOutput.stdout : "";
    const stderr = typeof errOutput.stderr === "string" ? errOutput.stderr : "";
    if (stdout.includes("Funnel is not enabled")) {
      console.error(danger("Funnel is not enabled on this tailnet/device."));
      const linkMatch = stdout.match(/https?:\/\/\S+/);
      if (linkMatch) {
        console.error(info(`Enable it here: ${linkMatch[0]}`));
      } else {
        console.error(
          info(
            "Enable in admin console: https://login.tailscale.com/admin (see https://tailscale.com/kb/1223/funnel)",
          ),
        );
      }
    }
    if (
      stderr.includes("client version") ||
      stdout.includes("client version")
    ) {
      console.error(
        warn(
          "Tailscale client/server version mismatch detected; try updating tailscale/tailscaled.",
        ),
      );
    }
    runtime.error(
      "Failed to enable Tailscale Funnel. Is it allowed on your tailnet?",
    );
    runtime.error(
      info(
        "Tip: Funnel is optional for CLAWDBOT. You can keep running the web gateway without it: `pnpm clawdbot gateway`",
      ),
    );
    if (shouldLogVerbose()) {
      const rich = isRich();
      if (stdout.trim()) {
        runtime.error(colorize(rich, theme.muted, `stdout: ${stdout.trim()}`));
      }
      if (stderr.trim()) {
        runtime.error(colorize(rich, theme.muted, `stderr: ${stderr.trim()}`));
      }
      runtime.error(err as Error);
    }
    runtime.exit(1);
  }
}

export async function enableTailscaleServe(
  port: number,
  exec: typeof runExec = runExec,
) {
  await exec("tailscale", ["serve", "--bg", "--yes", `${port}`], {
    maxBuffer: 200_000,
    timeoutMs: 15_000,
  });
}

export async function disableTailscaleServe(exec: typeof runExec = runExec) {
  await exec("tailscale", ["serve", "reset"], {
    maxBuffer: 200_000,
    timeoutMs: 15_000,
  });
}

export async function enableTailscaleFunnel(
  port: number,
  exec: typeof runExec = runExec,
) {
  await exec("tailscale", ["funnel", "--bg", "--yes", `${port}`], {
    maxBuffer: 200_000,
    timeoutMs: 15_000,
  });
}

export async function disableTailscaleFunnel(exec: typeof runExec = runExec) {
  await exec("tailscale", ["funnel", "reset"], {
    maxBuffer: 200_000,
    timeoutMs: 15_000,
  });
}
