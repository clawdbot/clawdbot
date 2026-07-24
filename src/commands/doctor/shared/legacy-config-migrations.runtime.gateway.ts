// Legacy gateway runtime config migrations for bind modes, WebChat, and Control UI origins.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  buildDefaultControlUiAllowedOrigins,
  hasConfiguredControlUiAllowedOrigins,
  isGatewayNonLoopbackBindMode,
  resolveGatewayPortWithDefault,
} from "../../../config/gateway-control-ui-origins.js";
import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import { DEFAULT_GATEWAY_PORT } from "../../../config/paths.js";

const GATEWAY_PORT_OOB_RULE: LegacyConfigRule = {
  path: ["gateway", "port"],
  message:
    'gateway.port is outside the valid TCP range (1–65535) and will be removed to avoid startup failure. Run "openclaw doctor --fix".',
  match: (value) => typeof value === "number" && (value < 1 || value > 65_535),
};

const GATEWAY_BIND_RULE: LegacyConfigRule = {
  path: ["gateway", "bind"],
  message:
    'gateway.bind host aliases (for example 0.0.0.0/localhost) are legacy; use bind modes (lan/loopback/custom/tailnet/auto) instead. Run "openclaw doctor --fix".',
  match: (value) => isLegacyGatewayBindHostAlias(value),
  requireSourceLiteral: true,
};

const GATEWAY_WEBCHAT_RULE: LegacyConfigRule = {
  path: ["gateway", "webchat"],
  message: 'gateway.webchat is retired. Run "openclaw doctor --fix".',
};

const CONTROL_UI_DEVICE_AUTH_MIGRATION_RULE: LegacyConfigRule = {
  path: ["gateway", "controlUi", "dangerouslyDisableDeviceAuth"],
  message:
    'gateway.controlUi.dangerouslyDisableDeviceAuth is retired. OpenClaw will preserve authenticated, pairing-only access for remediation, remove the legacy key, and prompt you to reopen the Control UI over HTTPS or localhost before clicking Secure this browser. Run "openclaw doctor --fix".',
  match: (value) => typeof value === "boolean",
};

function isLegacyGatewayBindHostAlias(value: unknown): boolean {
  return normalizeLegacyGatewayBindHostAlias(value) !== null;
}

function normalizeLegacyGatewayBindHostAlias(value: unknown): "lan" | "loopback" | null {
  const normalized = normalizeOptionalLowercaseString(value);
  if (!normalized) {
    return null;
  }
  if (
    normalized === "auto" ||
    normalized === "loopback" ||
    normalized === "lan" ||
    normalized === "tailnet" ||
    normalized === "custom"
  ) {
    return null;
  }
  if (
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "[::]" ||
    normalized === "*"
  ) {
    return "lan";
  }
  if (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]"
  ) {
    return "loopback";
  }
  return null;
}

function escapeControlForLog(value: string): string {
  return value.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

/** Legacy config migration specs for gateway runtime config. */
export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_GATEWAY: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "gateway.control-ui-device-auth-bypass->pairing-migration",
    describe: "Convert the retired Control UI device-auth bypass into explicit pairing",
    legacyRules: [CONTROL_UI_DEVICE_AUTH_MIGRATION_RULE],
    apply: (raw, changes) => {
      const gateway = getRecord(raw.gateway);
      const controlUi = getRecord(gateway?.controlUi);
      if (!controlUi || !Object.hasOwn(controlUi, "dangerouslyDisableDeviceAuth")) {
        return;
      }
      const migrationRequired = controlUi.dangerouslyDisableDeviceAuth === true;
      delete controlUi.dangerouslyDisableDeviceAuth;
      changes.push(
        migrationRequired
          ? "Preserved the retired Control UI device-auth bypass for remediation. Reopen the Control UI over HTTPS or localhost, then click Secure this browser."
          : "Removed disabled gateway.controlUi.dangerouslyDisableDeviceAuth legacy config.",
      );
    },
  }),
  defineLegacyConfigMigration({
    id: "gateway.webchat-remove",
    describe: "Remove retired WebChat gateway config",
    legacyRules: [GATEWAY_WEBCHAT_RULE],
    apply: (raw, changes) => {
      const gateway = getRecord(raw.gateway);
      if (!gateway || !Object.hasOwn(gateway, "webchat")) {
        return;
      }
      delete gateway.webchat;
      if (Object.keys(gateway).length > 0) {
        raw.gateway = gateway;
      } else {
        delete raw.gateway;
      }
      changes.push("Removed retired gateway.webchat config.");
    },
  }),
  defineLegacyConfigMigration({
    id: "gateway.port-oob-repair",
    describe: "Remove out-of-range gateway.port to avoid post-schema-tightening startup failures",
    legacyRules: [GATEWAY_PORT_OOB_RULE],
    apply: (raw, changes) => {
      const gateway = getRecord(raw.gateway);
      if (!gateway || !Object.hasOwn(gateway, "port")) {
        return;
      }
      const port = gateway.port;
      if (typeof port !== "number" || (port >= 1 && port <= 65_535)) {
        return;
      }
      delete gateway.port;
      if (Object.keys(gateway).length > 0) {
        raw.gateway = gateway;
      } else {
        delete raw.gateway;
      }
      changes.push(
        `Removed out-of-range gateway.port (${String(port)}). ` +
          `Valid TCP ports are 1–65535; the gateway will use the default port ${DEFAULT_GATEWAY_PORT}.`,
      );
    },
  }),
  defineLegacyConfigMigration({
    id: "gateway.controlUi.allowedOrigins-seed-for-non-loopback",
    describe: "Seed gateway.controlUi.allowedOrigins for existing non-loopback gateway installs",
    apply: (raw, changes) => {
      const gateway = getRecord(raw.gateway);
      if (!gateway) {
        return;
      }
      const bind = normalizeLegacyGatewayBindHostAlias(gateway.bind) ?? gateway.bind;
      if (!isGatewayNonLoopbackBindMode(bind)) {
        return;
      }
      const controlUi = getRecord(gateway.controlUi) ?? {};
      if (
        hasConfiguredControlUiAllowedOrigins({
          allowedOrigins: controlUi.allowedOrigins,
          dangerouslyAllowHostHeaderOriginFallback:
            controlUi.dangerouslyAllowHostHeaderOriginFallback,
        })
      ) {
        return;
      }
      const port = resolveGatewayPortWithDefault(gateway.port, DEFAULT_GATEWAY_PORT);
      const origins = buildDefaultControlUiAllowedOrigins({
        port,
        bind,
        customBindHost:
          typeof gateway.customBindHost === "string" ? gateway.customBindHost : undefined,
      });
      gateway.controlUi = { ...controlUi, allowedOrigins: origins };
      raw.gateway = gateway;
      changes.push(
        `Seeded gateway.controlUi.allowedOrigins ${JSON.stringify(origins)} for bind=${bind}. ` +
          "Required since v2026.2.26. Add other machine origins to gateway.controlUi.allowedOrigins if needed.",
      );
    },
  }),
  defineLegacyConfigMigration({
    id: "gateway.bind.host-alias->bind-mode",
    describe: "Normalize gateway.bind host aliases to supported bind modes",
    legacyRules: [GATEWAY_BIND_RULE],
    apply: (raw, changes) => {
      const gateway = getRecord(raw.gateway);
      if (!gateway) {
        return;
      }
      const bindRaw = gateway.bind;
      if (typeof bindRaw !== "string") {
        return;
      }

      const normalized = normalizeOptionalLowercaseString(bindRaw);
      if (!normalized) {
        return;
      }
      const mapped = normalizeLegacyGatewayBindHostAlias(bindRaw);

      if (!mapped || normalized === mapped) {
        return;
      }

      gateway.bind = mapped;
      raw.gateway = gateway;
      changes.push(`Normalized gateway.bind "${escapeControlForLog(bindRaw)}" → "${mapped}".`);
    },
  }),
];
