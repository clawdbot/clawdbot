import fs from "node:fs/promises";
import type { DesktopHostConfig } from "../../config/types.desktop.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import type { RfbAttachment } from "./attachment.js";
import { getHostDesktopGuidance } from "./host-guidance.js";
import { HostDesktopCredentialsRequiredError } from "./host-source-errors.js";
import { mintDesktopObserverToken } from "./observe-bridge.js";
import { classifyRfbSecurity, probeRfbServer, type RfbProbeResult } from "./rfb-probe.js";
import type { DesktopSessionRegistry } from "./session-registry.js";

const DEFAULT_HOST_DESKTOP_PORT = 5900;
const HOST_DESKTOP_PROBE_TIMEOUT_MS = 1_500;

export type HostDesktopAcquireResult = {
  attachment: RfbAttachment;
  auth: "vnc-password" | "ard-account";
  vncPassword?: string;
};

export type HostDesktopStatus = {
  enabled: boolean;
  state: "attached" | "unavailable" | "disabled";
  port: number;
  security?: string;
};

export type HostDesktopInspection = {
  status: HostDesktopStatus;
  detail: string;
  unavailableReason?: "not-listening" | "not-rfb" | "unsupported";
};

function nonRfbError(port: number): string {
  return `desktop.host.port ${port} is occupied by a non-VNC service; configure desktop.host.port for the loopback VNC server, then restart the gateway`;
}

function unavailableError(port: number, platform: NodeJS.Platform): string {
  return `gateway host desktop is unavailable at 127.0.0.1:${port}. ${getHostDesktopGuidance(platform)}`;
}

function securityLabel(probe: Extract<RfbProbeResult, { kind: "rfb" }>): string {
  const auth = classifyRfbSecurity(probe.securityTypes);
  if (auth === "vnc-password") {
    return "VncAuth";
  }
  if (auth === "ard-account") {
    return "ARD";
  }
  if (auth === "none") {
    return "None";
  }
  return probe.securityTypes.includes(19) ? "VeNCrypt" : "unsupported";
}

/** Probes the configured host desktop without reading or exposing password material. */
export async function inspectHostDesktop(params: {
  config?: DesktopHostConfig;
  platform?: NodeJS.Platform;
}): Promise<HostDesktopInspection> {
  const port = params.config?.port ?? DEFAULT_HOST_DESKTOP_PORT;
  if (params.config?.enabled !== true) {
    return {
      status: { enabled: false, state: "disabled", port },
      detail:
        "disabled; enable the Desktop lab with desktop.host.enabled=true, then restart the gateway",
    };
  }
  const platform = params.platform ?? process.platform;
  const probe = await probeRfbServer({
    host: "127.0.0.1",
    port,
    timeoutMs: HOST_DESKTOP_PROBE_TIMEOUT_MS,
  });
  if (probe.kind === "unreachable" || probe.kind === "timeout") {
    return {
      status: { enabled: true, state: "unavailable", port },
      detail: unavailableError(port, platform),
      unavailableReason: "not-listening",
    };
  }
  if (probe.kind === "not-rfb") {
    return {
      status: { enabled: true, state: "unavailable", port },
      detail: nonRfbError(port),
      unavailableReason: "not-rfb",
    };
  }
  const security = securityLabel(probe);
  const auth = classifyRfbSecurity(probe.securityTypes);
  if (auth === "vnc-password" || auth === "ard-account") {
    return {
      status: { enabled: true, state: "attached", port, security },
      detail: `attached (127.0.0.1:${port}, security: ${security})`,
    };
  }
  const detail =
    auth === "none"
      ? `unavailable: unauthenticated VNC server at 127.0.0.1:${port}; require a password-protected VncAuth server, then retry`
      : `unavailable: ${security} security is not supported; configure a VncAuth server and desktop.host.passwordFile, then retry`;
  return {
    status: { enabled: true, state: "unavailable", port, security },
    detail,
    unavailableReason: "unsupported",
  };
}

/** Creates the host acquisition hook consumed by the source-agnostic desktop registry. */
export function createHostDesktopSource(params: {
  config: DesktopHostConfig;
  platform?: NodeJS.Platform;
}) {
  const port = params.config.port ?? DEFAULT_HOST_DESKTOP_PORT;
  const platform = params.platform ?? process.platform;

  const acquire = async (): Promise<HostDesktopAcquireResult> => {
    const probe = await probeRfbServer({
      host: "127.0.0.1",
      port,
      timeoutMs: HOST_DESKTOP_PROBE_TIMEOUT_MS,
    });
    if (probe.kind === "unreachable" || probe.kind === "timeout") {
      throw new Error(unavailableError(port, platform));
    }
    if (probe.kind === "not-rfb") {
      throw new Error(nonRfbError(port));
    }
    const security = classifyRfbSecurity(probe.securityTypes);
    if (security === "none") {
      throw new Error(
        `refusing unauthenticated VNC server on 127.0.0.1:${port}; require a password-protected VncAuth server, then retry`,
      );
    }
    if (security === "unsupported") {
      const name = probe.securityTypes.includes(19) ? "VeNCrypt" : "the offered VNC security";
      throw new Error(
        `${name} is not supported; configure a VncAuth server and desktop.host.passwordFile, then retry`,
      );
    }

    let vncPassword: string | undefined;
    if (params.config.passwordFile) {
      try {
        vncPassword = (await fs.readFile(params.config.passwordFile, "utf8")).replace(
          /[\r\n]+$/u,
          "",
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `could not read desktop.host.passwordFile ${params.config.passwordFile}: ${reason}; fix the absolute path or remove desktop.host.passwordFile so the UI can prompt`,
          { cause: error },
        );
      }
      if (!vncPassword) {
        throw new Error(
          "desktop.host.passwordFile is empty; write the VNC password or remove desktop.host.passwordFile so the UI can prompt",
        );
      }
      registerSecretValueForRedaction(vncPassword);
    }
    return {
      attachment: { kind: "tcp", host: "127.0.0.1", port },
      auth: security,
      ...(vncPassword ? { vncPassword } : {}),
    };
  };

  return { acquire };
}

export type HostDesktopService = {
  observe(params: {
    control: boolean;
    credentials?: { username?: string; password?: string };
  }): Promise<{
    transport: "rfb";
    wsPath: string;
    expiresAtMs: number;
    control: boolean;
    auth: "vnc-password" | "ard-account";
    vncPassword?: string;
  }>;
  status(): Promise<HostDesktopStatus>;
};

/** Combines host acquisition, registry ownership, and observer-token minting. */
export function createHostDesktopService(params: {
  config: DesktopHostConfig;
  registry: DesktopSessionRegistry;
  platform?: NodeJS.Platform;
}): HostDesktopService {
  const source = createHostDesktopSource({
    config: params.config,
    ...(params.platform ? { platform: params.platform } : {}),
  });
  return {
    async observe(observeParams) {
      const acquired = await params.registry.acquire({
        sourceKey: "host",
        ownerEpoch: 0,
        start: source.acquire,
      });
      const auth = acquired.auth;
      if (!auth) {
        throw new Error("gateway host desktop authentication state is unavailable; retry observe");
      }
      let preauth:
        | {
            auth: "ard-account";
            credentials: { username: string; password: string };
          }
        | undefined;
      if (auth === "ard-account") {
        const username = observeParams.credentials?.username?.trim() ?? "";
        const password = observeParams.credentials?.password ?? "";
        if (!username || !password) {
          throw new HostDesktopCredentialsRequiredError();
        }
        registerSecretValueForRedaction(password);
        preauth = { auth: "ard-account", credentials: { username, password } };
      }
      const minted = mintDesktopObserverToken({
        sourceKey: "host",
        ownerEpoch: 0,
        control: observeParams.control,
        attachment: acquired.attachment,
        ...(preauth ? { preauth } : {}),
      });
      return {
        transport: "rfb",
        wsPath: `/desktop/observe?token=${minted.token}`,
        expiresAtMs: minted.expiresAtMs,
        control: observeParams.control,
        auth,
        ...(auth === "vnc-password" && acquired.vncPassword
          ? { vncPassword: acquired.vncPassword }
          : {}),
      };
    },
    async status() {
      return (
        await inspectHostDesktop({
          config: params.config,
          ...(params.platform ? { platform: params.platform } : {}),
        })
      ).status;
    },
  };
}
