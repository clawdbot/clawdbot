// Voice Call plugin module implements tailscale behavior.
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { resolveVoiceCallStreamExposurePaths, type VoiceCallConfig } from "../config.js";

type TailscaleSelfInfo = {
  dnsName: string | null;
  nodeId: string | null;
};

const TAILSCALE_COMMAND_STDOUT_MAX_BYTES = 4 * 1024 * 1024;

async function runTailscaleCommand(
  args: string[],
  timeoutMs = 2500,
): Promise<{ code: number; stdout: string }> {
  try {
    const result = await runCommandWithTimeout(["tailscale", ...args], {
      killProcessTree: true,
      maxOutputBytes: { stdout: TAILSCALE_COMMAND_STDOUT_MAX_BYTES, stderr: 1 },
      outputCapture: "head",
      terminateOnOutputLimit: { stdout: true },
      timeoutMs,
    });
    if (result.termination !== "exit" || result.outputLimitExceeded) {
      return { code: -1, stdout: "" };
    }
    return { code: result.code ?? -1, stdout: result.stdout };
  } catch {
    return { code: -1, stdout: "" };
  }
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

async function setupTailscaleExposureRoute(opts: {
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

export async function setupTailscaleExposureRoutes(opts: {
  mode: "serve" | "funnel";
  routes: Array<{ path: string; localUrl: string }>;
}): Promise<string | null> {
  const mountedPaths: string[] = [];
  let publicUrl: string | null = null;
  for (const route of opts.routes) {
    const routePublicUrl = await setupTailscaleExposureRoute({ mode: opts.mode, ...route });
    if (!routePublicUrl) {
      for (const path of mountedPaths.toReversed()) {
        await cleanupTailscaleExposureRoute({ mode: opts.mode, path });
      }
      console.warn(
        `[voice-call] Tailscale ${opts.mode} exposure failed for ${route.path}; rolled back ${mountedPaths.length} mounted route(s)`,
      );
      return null;
    }
    publicUrl ??= routePublicUrl;
    mountedPaths.push(route.path);
  }
  return publicUrl;
}

export async function setupTailscaleExposure(config: VoiceCallConfig): Promise<string | null> {
  if (config.tailscale.mode === "off") {
    return null;
  }

  const mode = config.tailscale.mode === "funnel" ? "funnel" : "serve";
  const localUrl = `http://127.0.0.1:${config.serve.port}${config.serve.path}`;
  const streamRoutes = resolveVoiceCallStreamExposurePaths(config).map(
    ({ publicPath, localPath }) => ({
      path: publicPath,
      localUrl: `http://127.0.0.1:${config.serve.port}${localPath}`,
    }),
  );
  return setupTailscaleExposureRoutes({
    mode,
    routes: [
      {
        path: config.tailscale.path,
        localUrl,
      },
      ...streamRoutes,
    ],
  });
}

export async function cleanupTailscaleExposure(config: VoiceCallConfig): Promise<void> {
  if (config.tailscale.mode === "off") {
    return;
  }

  const mode = config.tailscale.mode === "funnel" ? "funnel" : "serve";
  await cleanupTailscaleExposureRoute({ mode, path: config.tailscale.path });
  for (const { publicPath } of resolveVoiceCallStreamExposurePaths(config)) {
    await cleanupTailscaleExposureRoute({ mode, path: publicPath });
  }
}
