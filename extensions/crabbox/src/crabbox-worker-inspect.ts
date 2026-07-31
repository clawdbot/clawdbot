import { nonEmptyString } from "./crabbox-worker-profile.js";

type CrabboxInspect = {
  host?: unknown;
  id?: unknown;
  providerMetadata?: unknown;
  ready?: unknown;
  sshHost?: unknown;
  sshHostKey?: unknown;
  sshKey?: unknown;
  sshPort?: unknown;
  sshUser?: unknown;
  state?: unknown;
  tailscale?: unknown;
};

export type ParsedInspect = {
  awsInstanceProfileAttached?: boolean;
  host?: string;
  id: string;
  ready?: boolean;
  sshHostKey?: string;
  sshKey?: string;
  sshPort?: number;
  sshUser?: string;
  state: string;
  tailscaleEnabled: boolean;
};

export function parseInspectJson(stdout: string): ParsedInspect {
  let value: CrabboxInspect;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("inspect output is not an object");
    }
    value = parsed as CrabboxInspect;
  } catch {
    throw new Error("Crabbox inspect returned invalid JSON");
  }

  const id = nonEmptyString(value.id);
  const state = nonEmptyString(value.state)?.toLowerCase();
  if (!id || !/^\S{1,128}$/u.test(id) || !state) {
    throw new Error("Crabbox inspect returned an invalid lease identity or state");
  }
  if (value.ready !== undefined && typeof value.ready !== "boolean") {
    throw new Error("Crabbox inspect returned an invalid ready state");
  }
  if (
    value.tailscale !== undefined &&
    (value.tailscale === null ||
      typeof value.tailscale !== "object" ||
      Array.isArray(value.tailscale))
  ) {
    throw new Error("Crabbox inspect returned invalid Tailscale state");
  }
  const tailscaleEnabled = value.tailscale !== undefined;
  let awsInstanceProfileAttached: boolean | undefined;
  if (value.providerMetadata !== undefined) {
    if (
      value.providerMetadata === null ||
      typeof value.providerMetadata !== "object" ||
      Array.isArray(value.providerMetadata)
    ) {
      throw new Error("Crabbox inspect returned invalid provider metadata");
    }
    const attached = (value.providerMetadata as Record<string, unknown>)["instanceProfileAttached"];
    if (attached !== undefined && typeof attached !== "boolean") {
      throw new Error("Crabbox inspect returned invalid AWS instance profile metadata");
    }
    awsInstanceProfileAttached = attached as boolean | undefined;
  }

  const sshHost = inspectString(value.sshHost, "sshHost");
  const fallbackHost = inspectString(value.host, "host");
  const host = sshHost ?? fallbackHost;
  const sshUser = inspectString(value.sshUser, "sshUser");
  const sshHostKey = inspectString(value.sshHostKey, "sshHostKey");
  const sshKey = inspectString(value.sshKey, "sshKey");
  const sshPort = inspectPort(value.sshPort);
  return {
    id,
    state,
    tailscaleEnabled,
    ...(awsInstanceProfileAttached !== undefined ? { awsInstanceProfileAttached } : {}),
    ...(host ? { host } : {}),
    ...(sshUser ? { sshUser } : {}),
    ...(sshHostKey ? { sshHostKey } : {}),
    ...(sshKey ? { sshKey } : {}),
    ...(sshPort ? { sshPort } : {}),
    ...(typeof value.ready === "boolean" ? { ready: value.ready } : {}),
  };
}

function inspectString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Crabbox inspect returned an invalid ${field}`);
  }
  return nonEmptyString(value);
}

function inspectPort(value: unknown): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/u.test(value))) {
    throw new Error("Crabbox inspect returned an invalid sshPort");
  }
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Crabbox inspect returned an invalid sshPort");
  }
  return port;
}
