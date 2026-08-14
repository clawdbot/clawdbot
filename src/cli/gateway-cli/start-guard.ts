import { formatCliCommand } from "../command-format.js";

export function getGatewayStartGuardErrors(params: {
  allowUnconfigured?: boolean;
  configExists: boolean;
  configAuditLocation: string;
  mode: string | undefined;
}): string[] {
  if (params.allowUnconfigured || params.mode === "local") {
    return [];
  }
  if (!params.configExists) {
    return [
      `Missing config. Run \`${formatCliCommand("openclaw setup")}\` or set gateway.mode=local (or pass --allow-unconfigured).`,
    ];
  }
  if (params.mode === undefined) {
    return [
      [
        "Gateway start blocked: existing config is missing gateway.mode.",
        "Treat this as suspicious or clobbered config.",
        `Re-run \`${formatCliCommand("openclaw onboard --mode local")}\` or \`${formatCliCommand("openclaw setup")}\`, set gateway.mode=local manually, or pass --allow-unconfigured.`,
      ].join(" "),
      `Config write audit: ${params.configAuditLocation}`,
    ];
  }
  return [
    `Gateway start blocked: set gateway.mode=local (current: ${params.mode}) or pass --allow-unconfigured.`,
    `Config write audit: ${params.configAuditLocation}`,
  ];
}
