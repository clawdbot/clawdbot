import fs from "node:fs/promises";
import type { DesktopHostConfig } from "../../config/types.desktop.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import type { RfbAttachment } from "./attachment.js";
import { getHostDesktopGuidance } from "./host-guidance.js";
import { HostDesktopCredentialsRequiredError } from "./host-source-errors.js";
import {
  createManagedLinuxDesktop,
  type ManagedLinuxDesktop,
  type ManagedLinuxDesktopStatus,
} from "./managed-linux.js";
import { mintDesktopObserverToken } from "./observe-bridge.js";
import type { DesktopObserveRequester } from "./observe-requester.js";
import { classifyRfbSecurity, probeRfbServer, type RfbProbeResult } from "./rfb-probe.js";
import type { DesktopSessionRegistry } from "./session-registry.js";

const DEFAULT_HOST_DESKTOP_PORT = 5900;
const HOST_DESKTOP_PROBE_TIMEOUT_MS = 1_500;

export type HostDesktopAcquireResult = {
  attachment: RfbAttachment;
  auth: "vnc-password" | "ard-account";
  vncPassword?: string;
};

export type HostDesktopStatus =
  | { enabled: false; state: "disabled"; port: number }
  | { enabled: true; state: "attached"; port: number; security: string }
  | { enabled: true; state: "unavailable"; port: number; security?: string }
  | {
      enabled: true;
      state: "managed";
      managedState: ManagedLinuxDesktopStatus["state"] | "unknown";
      port: number;
      display?: number;
      error?: string;
      security?: "VncAuth";
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

function managedPlatformError(platform: NodeJS.Platform): string {
  return `desktop.host.managed is available only on Linux; disable it on ${platform} or configure desktop.host.port for an existing loopback VNC server`;
}

function managedInspection(managedStatus: ManagedLinuxDesktopStatus): HostDesktopInspection {
  if (managedStatus.state === "running") {
    return {
      status: {
        enabled: true,
        state: "managed",
        managedState: "running",
        display: managedStatus.display,
        port: managedStatus.port,
        security: "VncAuth",
      },
      detail: `managed (running, display :${managedStatus.display}, port ${managedStatus.port}, security: VncAuth)`,
    };
  }
  if (managedStatus.state === "failed") {
    return {
      status: {
        enabled: true,
        state: "managed",
        managedState: "failed",
        port: managedStatus.port ?? DEFAULT_HOST_DESKTOP_PORT,
        ...(managedStatus.display !== undefined ? { display: managedStatus.display } : {}),
        error: managedStatus.error,
      },
      detail: `managed (failed: ${managedStatus.error})`,
      unavailableReason: "unsupported",
    };
  }
  const startingCoordinates =
    managedStatus.state === "starting"
      ? {
          port: managedStatus.port ?? DEFAULT_HOST_DESKTOP_PORT,
          ...(managedStatus.display !== undefined ? { display: managedStatus.display } : {}),
        }
      : { port: DEFAULT_HOST_DESKTOP_PORT };
  return {
    status: {
      enabled: true,
      state: "managed",
      managedState: managedStatus.state,
      ...startingCoordinates,
    },
    detail: managedStatus.state === "starting" ? "managed (starting)" : "managed (not started)",
  };
}

function configuredManagedInspection(): HostDesktopInspection {
  return {
    status: {
      enabled: true,
      state: "managed",
      managedState: "unknown",
      port: DEFAULT_HOST_DESKTOP_PORT,
    },
    detail: "managed (configured; runtime state is available from the running Gateway status)",
  };
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
  managedDesktop?: ManagedLinuxDesktop;
  probeRfb?: typeof probeRfbServer;
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
  const probe = await (params.probeRfb ?? probeRfbServer)({
    host: "127.0.0.1",
    port,
    timeoutMs: HOST_DESKTOP_PROBE_TIMEOUT_MS,
  });
  if (probe.kind === "unreachable" || probe.kind === "timeout") {
    if (params.config.port === undefined && params.config.managed === true) {
      if (platform !== "linux") {
        return {
          status: { enabled: true, state: "unavailable", port },
          detail: managedPlatformError(platform),
          unavailableReason: "unsupported",
        };
      }
      return params.managedDesktop
        ? managedInspection(params.managedDesktop.status())
        : configuredManagedInspection();
    }
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
  managedDesktop?: ManagedLinuxDesktop;
  probeRfb?: typeof probeRfbServer;
}) {
  const port = params.config.port ?? DEFAULT_HOST_DESKTOP_PORT;
  const platform = params.platform ?? process.platform;
  const probeRfb = params.probeRfb ?? probeRfbServer;
  const managedDesktop =
    params.managedDesktop ??
    (params.config.managed === true && platform === "linux"
      ? createManagedLinuxDesktop()
      : undefined);

  const acquireAttached = async (
    probe: Extract<RfbProbeResult, { kind: "rfb" }>,
  ): Promise<HostDesktopAcquireResult> => {
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

  const acquire = async (): Promise<HostDesktopAcquireResult> => {
    const probe = await probeRfb({
      host: "127.0.0.1",
      port,
      timeoutMs: HOST_DESKTOP_PROBE_TIMEOUT_MS,
    });
    if (probe.kind === "unreachable" || probe.kind === "timeout") {
      if (params.config.port === undefined && params.config.managed === true) {
        if (platform !== "linux") {
          throw new Error(managedPlatformError(platform));
        }
        if (!managedDesktop) {
          throw new Error("managed Linux desktop lifecycle is unavailable; restart the gateway");
        }
        return await managedDesktop.acquire();
      }
      throw new Error(unavailableError(port, platform));
    }
    if (probe.kind === "not-rfb") {
      throw new Error(nonRfbError(port));
    }
    return await acquireAttached(probe);
  };

  return {
    acquire,
    teardown: managedDesktop ? () => managedDesktop.stop() : undefined,
    inspect: () =>
      inspectHostDesktop({
        config: params.config,
        platform,
        managedDesktop,
        probeRfb,
      }),
  };
}

export type HostDesktopService = {
  observe(params: {
    control: boolean;
    requester?: DesktopObserveRequester;
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
  managedDesktop?: ManagedLinuxDesktop;
}): HostDesktopService {
  const platform = params.platform ?? process.platform;
  const managedDesktop =
    params.managedDesktop ??
    (params.config.managed === true && platform === "linux"
      ? createManagedLinuxDesktop({
          onFailed: () => {
            void params.registry.stop("host", 0);
          },
        })
      : undefined);
  const source = createHostDesktopSource({
    config: params.config,
    platform,
    ...(managedDesktop ? { managedDesktop } : {}),
  });
  return {
    async observe(observeParams) {
      const acquired = await params.registry.acquire({
        sourceKey: "host",
        ownerEpoch: 0,
        start: source.acquire,
        ...(source.teardown ? { teardown: source.teardown } : {}),
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
        requester: observeParams.requester,
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
      return (await source.inspect()).status;
    },
  };
}
