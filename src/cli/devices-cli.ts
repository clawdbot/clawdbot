import type { Command } from "commander";

import { callGateway } from "../gateway/call.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { defaultRuntime } from "../runtime.js";
import { withProgress } from "./progress.js";

type DevicesRpcOpts = {
  url?: string;
  token?: string;
  password?: string;
  timeout?: string;
  json?: boolean;
  device?: string;
  role?: string;
  scope?: string[];
};

type DeviceTokenSummary = {
  role: string;
  scopes?: string[];
  revokedAtMs?: number;
};

type PendingDevice = {
  requestId: string;
  deviceId: string;
  displayName?: string;
  role?: string;
  remoteIp?: string;
  isRepair?: boolean;
  ts?: number;
};

type PairedDevice = {
  deviceId: string;
  displayName?: string;
  roles?: string[];
  scopes?: string[];
  remoteIp?: string;
  tokens?: DeviceTokenSummary[];
  createdAtMs?: number;
  approvedAtMs?: number;
};

type DevicePairingList = {
  pending?: PendingDevice[];
  paired?: PairedDevice[];
};

function formatAge(msAgo: number) {
  const s = Math.max(0, Math.floor(msAgo / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

const devicesCallOpts = (cmd: Command, defaults?: { timeoutMs?: number }) =>
  cmd
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (password auth)")
    .option("--timeout <ms>", "Timeout in ms", String(defaults?.timeoutMs ?? 10_000))
    .option("--json", "Output JSON", false);

const callGatewayCli = async (method: string, opts: DevicesRpcOpts, params?: unknown) =>
  withProgress(
    {
      label: `Devices ${method}`,
      indeterminate: true,
      enabled: opts.json !== true,
    },
    async () =>
      await callGateway({
        url: opts.url,
        token: opts.token,
        password: opts.password,
        method,
        params,
        timeoutMs: Number(opts.timeout ?? 10_000),
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      }),
  );

function parseDevicePairingList(value: unknown): DevicePairingList {
  const obj = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    pending: Array.isArray(obj.pending) ? (obj.pending as PendingDevice[]) : [],
    paired: Array.isArray(obj.paired) ? (obj.paired as PairedDevice[]) : [],
  };
}

function formatTokenSummary(tokens: DeviceTokenSummary[] | undefined) {
  if (!tokens || tokens.length === 0) return "tokens: none";
  const parts = tokens
    .map((t) => `${t.role}${t.revokedAtMs ? " (revoked)" : ""}`)
    .sort((a, b) => a.localeCompare(b));
  return `tokens: ${parts.join(", ")}`;
}

export function registerDevicesCli(program: Command) {
  const devices = program.command("devices").description("Device pairing and auth tokens");

  devicesCallOpts(
    devices
      .command("list")
      .description("List pending and paired devices")
      .action(async (opts: DevicesRpcOpts) => {
        const result = await callGatewayCli("device.pair.list", opts, {});
        const list = parseDevicePairingList(result);
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(list, null, 2));
          return;
        }
        if (list.pending?.length) {
          defaultRuntime.log("Pending:");
          for (const req of list.pending) {
            const name = req.displayName || req.deviceId;
            const repair = req.isRepair ? " (repair)" : "";
            const ip = req.remoteIp ? ` · ${req.remoteIp}` : "";
            const age = typeof req.ts === "number" ? ` · ${formatAge(Date.now() - req.ts)} ago` : "";
            const role = req.role ? ` · role: ${req.role}` : "";
            defaultRuntime.log(`- ${req.requestId}: ${name}${repair}${role}${ip}${age}`);
          }
        }
        if (list.paired?.length) {
          defaultRuntime.log("Paired:");
          for (const device of list.paired) {
            const name = device.displayName || device.deviceId;
            const roles = device.roles?.length ? `roles: ${device.roles.join(", ")}` : "roles: -";
            const scopes = device.scopes?.length ? `scopes: ${device.scopes.join(", ")}` : "scopes: -";
            const ip = device.remoteIp ? ` · ${device.remoteIp}` : "";
            const tokens = formatTokenSummary(device.tokens);
            defaultRuntime.log(`- ${name} · ${roles} · ${scopes} · ${tokens}${ip}`);
          }
        }
        if (!list.pending?.length && !list.paired?.length) {
          defaultRuntime.log("No device pairing entries.");
        }
      }),
  );

  devicesCallOpts(
    devices
      .command("approve")
      .description("Approve a pending device pairing request")
      .argument("<requestId>", "Pending request id")
      .action(async (requestId: string, opts: DevicesRpcOpts) => {
        const result = await callGatewayCli("device.pair.approve", opts, { requestId });
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        const deviceId = (result as { device?: { deviceId?: string } })?.device?.deviceId;
        defaultRuntime.log(`device approved: ${deviceId ?? "ok"}`);
      }),
  );

  devicesCallOpts(
    devices
      .command("reject")
      .description("Reject a pending device pairing request")
      .argument("<requestId>", "Pending request id")
      .action(async (requestId: string, opts: DevicesRpcOpts) => {
        const result = await callGatewayCli("device.pair.reject", opts, { requestId });
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        const deviceId = (result as { deviceId?: string })?.deviceId;
        defaultRuntime.log(`device rejected: ${deviceId ?? "ok"}`);
      }),
  );

  devicesCallOpts(
    devices
      .command("rotate")
      .description("Rotate a device token for a role")
      .requiredOption("--device <id>", "Device id")
      .requiredOption("--role <role>", "Role name")
      .option("--scope <scope...>", "Scopes to attach to the token (repeatable)")
      .action(async (opts: DevicesRpcOpts) => {
        const deviceId = String(opts.device ?? "").trim();
        const role = String(opts.role ?? "").trim();
        if (!deviceId || !role) {
          defaultRuntime.error("--device and --role required");
          defaultRuntime.exit(1);
          return;
        }
        const result = await callGatewayCli("device.token.rotate", opts, {
          deviceId,
          role,
          scopes: Array.isArray(opts.scope) ? opts.scope : undefined,
        });
        defaultRuntime.log(JSON.stringify(result, null, 2));
      }),
  );

  devicesCallOpts(
    devices
      .command("revoke")
      .description("Revoke a device token for a role")
      .requiredOption("--device <id>", "Device id")
      .requiredOption("--role <role>", "Role name")
      .action(async (opts: DevicesRpcOpts) => {
        const deviceId = String(opts.device ?? "").trim();
        const role = String(opts.role ?? "").trim();
        if (!deviceId || !role) {
          defaultRuntime.error("--device and --role required");
          defaultRuntime.exit(1);
          return;
        }
        const result = await callGatewayCli("device.token.revoke", opts, {
          deviceId,
          role,
        });
        defaultRuntime.log(JSON.stringify(result, null, 2));
      }),
  );
}
