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
import { normalizeOptionalLowercaseString } from "../../../shared/string-coerce.js";

const GATEWAY_BIND_RULE: LegacyConfigRule = {
  path: ["gateway", "bind"],
  message:
    'gateway.bind host aliases (for example 0.0.0.0/localhost) are legacy; use bind modes (lan/loopback/custom/tailnet/auto) instead. Run "openclaw doctor --fix".',
  match: (value) => isLegacyGatewayBindHostAlias(value),
  requireSourceLiteral: true,
};

function isLegacyGatewayBindHostAlias(value: unknown): boolean {
  const normalized = normalizeOptionalLowercaseString(value);
  if (!normalized) {
    return false;
  }
  if (
    normalized === "auto" ||
    normalized === "loopback" ||
    normalized === "lan" ||
    normalized === "tailnet" ||
    normalized === "custom"
  ) {
    return false;
  }
  return (
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "[::]" ||
    normalized === "*" ||
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

function escapeControlForLog(value: string): string {
  return value.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_GATEWAY: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "gateway.controlUi.allowedOrigins-seed-for-non-loopback",
    describe: "Seed gateway.controlUi.allowedOrigins for existing non-loopback gateway installs",
    apply: (raw, changes) => {
      const gateway = getRecord(raw.gateway);
      if (!gateway) {
        return;
      }
      const bind = gateway.bind;
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
      let mapped: "lan" | "loopback" | undefined;
      if (
        normalized === "0.0.0.0" ||
        normalized === "::" ||
        normalized === "[::]" ||
        normalized === "*"
      ) {
        mapped = "lan";
      } else if (
        normalized === "127.0.0.1" ||
        normalized === "localhost" ||
        normalized === "::1" ||
        normalized === "[::1]"
      ) {
        mapped = "loopback";
      }

      if (!mapped || normalized === mapped) {
        return;
      }

      gateway.bind = mapped;
      raw.gateway = gateway;
      changes.push(`Normalized gateway.bind "${escapeControlForLog(bindRaw)}" → "${mapped}".`);
    },
  }),
];
