// Policy plugin gateway exposure evidence.
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { ocPathSegment } from "./policy-state-helpers.js";
import type { PolicyGatewayExposureEvidence } from "./policy-state-types.js";

export function scanPolicyGatewayExposure(
  cfg: Record<string, unknown>,
): readonly PolicyGatewayExposureEvidence[] {
  const gateway = isRecord(cfg.gateway) ? cfg.gateway : {};
  const entries: PolicyGatewayExposureEvidence[] = [];
  const bind = typeof gateway.bind === "string" ? gateway.bind : undefined;
  const customBindHost =
    typeof gateway.customBindHost === "string" ? gateway.customBindHost : undefined;
  const hasCustomBindHost = customBindHost !== undefined && customBindHost.trim() !== "";
  const tailscale = isRecord(gateway.tailscale) ? gateway.tailscale : {};
  const tailscaleForcesLoopback = tailscale.mode === "serve" || tailscale.mode === "funnel";
  entries.push({
    id: bind === undefined ? "gateway-bind-default" : "gateway-bind",
    kind: "bind",
    source: "oc://openclaw.config/gateway/bind",
    value: bind ?? (tailscaleForcesLoopback ? "loopback" : "runtime-default"),
    nonLoopback:
      bind === undefined
        ? !tailscaleForcesLoopback
        : bind === "custom"
          ? false
          : isGatewayNonLoopbackBind(bind),
    explicit: bind !== undefined,
  });
  if (bind === "custom" && hasCustomBindHost) {
    entries.push({
      id: "gateway-custom-bind-host",
      kind: "bind",
      source: "oc://openclaw.config/gateway/customBindHost",
      value: customBindHost,
      nonLoopback: isRuntimeNonLoopbackCustomBindHost(customBindHost),
    });
  }

  const auth = isRecord(gateway.auth) ? gateway.auth : {};
  entries.push({
    id: "gateway-auth-mode",
    kind: "auth",
    source: "oc://openclaw.config/gateway/auth/mode",
    value: typeof auth.mode === "string" ? auth.mode : "token",
    explicit: typeof auth.mode === "string",
  });
  entries.push({
    id: "gateway-auth-rate-limit",
    kind: "authRateLimit",
    source: "oc://openclaw.config/gateway/auth/rateLimit",
    value: isRecord(auth.rateLimit),
    explicit: isRecord(auth.rateLimit),
  });

  const controlUi = isRecord(gateway.controlUi) ? gateway.controlUi : {};
  pushGatewayBooleanEvidence(
    entries,
    "gateway-control-ui-enabled",
    "controlUi",
    controlUi.enabled,
    "oc://openclaw.config/gateway/controlUi/enabled",
  );
  pushGatewayBooleanEvidence(
    entries,
    "gateway-control-ui-insecure-auth",
    "controlUi",
    controlUi.allowInsecureAuth,
    "oc://openclaw.config/gateway/controlUi/allowInsecureAuth",
  );
  pushGatewayBooleanEvidence(
    entries,
    "gateway-control-ui-device-auth-disabled",
    "controlUi",
    controlUi.dangerouslyDisableDeviceAuth,
    "oc://openclaw.config/gateway/controlUi/dangerouslyDisableDeviceAuth",
  );
  pushGatewayBooleanEvidence(
    entries,
    "gateway-control-ui-host-origin-fallback",
    "controlUi",
    controlUi.dangerouslyAllowHostHeaderOriginFallback,
    "oc://openclaw.config/gateway/controlUi/dangerouslyAllowHostHeaderOriginFallback",
  );

  if (typeof tailscale.mode === "string") {
    entries.push({
      id: "gateway-tailscale-mode",
      kind: "tailscale",
      source: "oc://openclaw.config/gateway/tailscale/mode",
      value: tailscale.mode,
    });
  }
  if (tailscale.mode === "serve" && tailscale.preserveFunnel === true) {
    entries.push({
      id: "gateway-tailscale-preserve-funnel",
      kind: "tailscale",
      source: "oc://openclaw.config/gateway/tailscale/preserveFunnel",
      value: "funnel",
    });
  }

  const remote = isRecord(gateway.remote) ? gateway.remote : {};
  if (gateway.mode === "remote") {
    entries.push({
      id: "gateway-mode-remote",
      kind: "remote",
      source: "oc://openclaw.config/gateway/mode",
      value: "remote",
    });
    if (typeof remote.url === "string" && remote.url.trim() !== "") {
      entries.push({
        id: "gateway-remote-url",
        kind: "remote",
        source: "oc://openclaw.config/gateway/remote/url",
        value: true,
      });
    }
  }

  const http = isRecord(gateway.http) ? gateway.http : {};
  const endpoints = isRecord(http.endpoints) ? http.endpoints : {};
  pushGatewayHttpEndpointEvidence(entries, endpoints, "chatCompletions");
  pushGatewayHttpEndpointEvidence(entries, endpoints, "responses");
  const nodes = isRecord(gateway.nodes) ? gateway.nodes : {};
  pushGatewayNodeCommandEvidence(entries, nodes);
  return entries.toSorted((a, b) => a.source.localeCompare(b.source));
}

function pushGatewayBooleanEvidence(
  entries: PolicyGatewayExposureEvidence[],
  id: string,
  kind: PolicyGatewayExposureEvidence["kind"],
  value: unknown,
  source: string,
): void {
  if (typeof value !== "boolean") {
    return;
  }
  entries.push({ id, kind, source, value });
}

function pushGatewayHttpEndpointEvidence(
  entries: PolicyGatewayExposureEvidence[],
  endpoints: Record<string, unknown>,
  endpoint: "chatCompletions" | "responses",
): void {
  const config = endpoints[endpoint];
  if (!isRecord(config)) {
    return;
  }
  const source = `oc://openclaw.config/gateway/http/endpoints/${endpoint}`;
  const enabled = config.enabled === true;
  if (enabled) {
    entries.push({
      id: `gateway-http-${endpoint}`,
      kind: "httpEndpoint",
      source: `${source}/enabled`,
      value: true,
      endpoint,
    });
  }
  if (!enabled) {
    return;
  }
  if (endpoint === "chatCompletions") {
    pushGatewayHttpUrlFetchEvidence(entries, source, endpoint, ["images"], config.images);
    return;
  }
  pushGatewayHttpUrlFetchEvidence(entries, source, endpoint, ["files"], config.files);
  pushGatewayHttpUrlFetchEvidence(entries, source, endpoint, ["images"], config.images);
}

function pushGatewayHttpUrlFetchEvidence(
  entries: PolicyGatewayExposureEvidence[],
  endpointSource: string,
  endpoint: string,
  path: readonly string[],
  value: unknown,
): void {
  const allowUrl = isRecord(value) ? value.allowUrl : undefined;
  if (allowUrl === false || (allowUrl !== true && endpoint !== "responses")) {
    return;
  }
  const allowlist = isRecord(value) ? value.urlAllowlist : undefined;
  const hasEffectiveAllowlist =
    Array.isArray(allowlist) &&
    allowlist.some((entry) => isEffectiveGatewayUrlAllowlistEntry(entry));
  entries.push({
    id: `gateway-http-${endpoint}-${path.join("-")}-url-fetch`,
    kind: "httpUrlFetch",
    source: `${endpointSource}/${path.map(ocPathSegment).join("/")}/allowUrl`,
    value: true,
    endpoint,
    explicit: allowUrl === true,
    hasAllowlist: hasEffectiveAllowlist,
  });
}

function pushGatewayNodeCommandEvidence(
  entries: PolicyGatewayExposureEvidence[],
  nodes: Record<string, unknown>,
): void {
  const deniedCommands = new Set(
    Array.isArray(nodes.denyCommands)
      ? nodes.denyCommands
          .filter((command): command is string => typeof command === "string")
          .map((command) => command.trim())
      : [],
  );
  if (Array.isArray(nodes.denyCommands)) {
    nodes.denyCommands.forEach((command, index) => {
      if (typeof command !== "string") {
        return;
      }
      const normalized = command.trim();
      if (normalized === "") {
        return;
      }
      entries.push({
        id: `gateway-node-deny-command-${normalized}`,
        kind: "nodeDenyCommand",
        source: `oc://openclaw.config/gateway/nodes/denyCommands/#${index}`,
        value: normalized,
        command: normalized,
      });
    });
  }
  if (!Array.isArray(nodes.allowCommands)) {
    return;
  }
  nodes.allowCommands.forEach((command, index) => {
    if (typeof command !== "string") {
      return;
    }
    const normalized = command.trim();
    if (normalized === "" || deniedCommands.has(normalized)) {
      return;
    }
    entries.push({
      id: `gateway-node-command-${normalized}`,
      kind: "nodeCommand",
      source: `oc://openclaw.config/gateway/nodes/allowCommands/#${index}`,
      value: normalized,
      command: normalized,
    });
  });
}

function isEffectiveGatewayUrlAllowlistEntry(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "*" && normalized !== "*.";
}

function isGatewayNonLoopbackBind(value: string): boolean {
  return value === "auto" || value === "lan" || value === "custom" || value === "tailnet";
}

function isRuntimeNonLoopbackCustomBindHost(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return isCanonicalDottedDecimalIPv4(normalized) && !normalized.startsWith("127.");
}

function isCanonicalDottedDecimalIPv4(value: string): boolean {
  return /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(
    value,
  );
}
