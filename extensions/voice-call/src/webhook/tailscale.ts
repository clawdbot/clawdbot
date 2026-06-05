// Voice Call plugin module implements tailscale behavior.
import { spawn } from "node:child_process";
import type { VoiceCallConfig } from "../config.js";

type TailscaleSelfInfo = {
  dnsName: string | null;
  nodeId: string | null;
};

export const TAILSCALE_COMMAND_STDOUT_MAX_BYTES = 4 * 1024 * 1024;

type TailscaleCommandStdout = {
  bytes: number;
  exceeded: boolean;
  text: string;
};

export function appendTailscaleCommandStdout(
  current: TailscaleCommandStdout,
  data: Buffer | string,
  maxBytes = TAILSCALE_COMMAND_STDOUT_MAX_BYTES,
): TailscaleCommandStdout {
  if (current.exceeded) {
    return current;
  }
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const bytes = current.bytes + buffer.byteLength;
  if (bytes > maxBytes) {
    return { bytes, exceeded: true, text: "" };
  }
  return { bytes, exceeded: false, text: `${current.text}${buffer.toString("utf8")}` };
}

function runTailscaleCommand(
  args: string[],
  timeoutMs = 2500,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const proc = spawn("tailscale", args, {
      stdio: ["ignore", "pipe", "ignore"],
    });

    let stdout: TailscaleCommandStdout = { bytes: 0, exceeded: false, text: "" };
    let settled = false;
    const finish = (result: { code: number; stdout: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    proc.stdout.on("data", (data) => {
      stdout = appendTailscaleCommandStdout(stdout, data);
      if (stdout.exceeded) {
        proc.kill("SIGKILL");
        finish({ code: -1, stdout: "" });
      }
    });

    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      proc.kill("SIGKILL");
      finish({ code: -1, stdout: "" });
    }, timeoutMs);

    proc.on("error", () => {
      finish({ code: -1, stdout: "" });
    });

    proc.on("close", (code) => {
      finish({ code: code ?? -1, stdout: stdout.text });
    });
  });
}

export async function getTailscaleSelfInfo(): Promise<TailscaleSelfInfo | null> {
  const { code, stdout } = await runTailscaleCommand(["status", "--json", "--peers=false"]);
  if (code !== 0) {
    return null;
  }

  try {
    const status = JSON.parse(stdout);
    return {
      dnsName: status.Self?.DNSName?.replace(/\.$/, "") || null,
      nodeId: status.Self?.ID || null,
    };
  } catch {
    return null;
  }
}

export async function getTailscaleDnsName(): Promise<string | null> {
  const info = await getTailscaleSelfInfo();
  return info?.dnsName ?? null;
}

export async function setupTailscaleExposureRoute(opts: {
  mode: "serve" | "funnel";
  path: string;
  localUrl: string;
}): Promise<string | null> {
  const dnsName = await getTailscaleDnsName();
  if (!dnsName) {
    console.warn("[voice-call] Could not get Tailscale DNS name");
    return null;
  }

  const { code } = await runTailscaleCommand([
    opts.mode,
    "--bg",
    "--yes",
    "--set-path",
    opts.path,
    opts.localUrl,
  ]);

  if (code === 0) {
    const publicUrl = `https://${dnsName}${opts.path}`;
    console.log(`[voice-call] Tailscale ${opts.mode} active: ${publicUrl}`);
    return publicUrl;
  }

  console.warn(`[voice-call] Tailscale ${opts.mode} failed`);
  return null;
}

export async function cleanupTailscaleExposureRoute(opts: {
  mode: "serve" | "funnel";
  path: string;
}): Promise<void> {
  await runTailscaleCommand([opts.mode, "off", opts.path]);
}

export async function setupTailscaleExposure(config: VoiceCallConfig): Promise<string | null> {
  if (config.tailscale.mode === "off") {
    return null;
  }

  const mode = config.tailscale.mode === "funnel" ? "funnel" : "serve";
  const localUrl = `http://127.0.0.1:${config.serve.port}${config.serve.path}`;
  return setupTailscaleExposureRoute({
    mode,
    path: config.tailscale.path,
    localUrl,
  });
}

export async function cleanupTailscaleExposure(config: VoiceCallConfig): Promise<void> {
  if (config.tailscale.mode === "off") {
    return;
  }

  const mode = config.tailscale.mode === "funnel" ? "funnel" : "serve";
  await cleanupTailscaleExposureRoute({ mode, path: config.tailscale.path });
}
