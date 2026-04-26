import {
  inspectBestEffortPrimaryTailnetIPv4,
  pickBestEffortPrimaryLanIPv4,
} from "../infra/network-discovery-display.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import { isValidIPv4 } from "./net.js";

export function resolveControlUiLinks(params: {
  port: number;
  bind?: "auto" | "lan" | "loopback" | "custom" | "tailnet";
  customBindHost?: string;
  basePath?: string;
  tlsEnabled?: boolean;
}): { httpUrl: string; wsUrl: string } {
  const port = params.port;
  const bind = params.bind ?? "loopback";
  const customBindHost = params.customBindHost?.trim();
  const { tailnetIPv4 } = inspectBestEffortPrimaryTailnetIPv4();
  const host = (() => {
    if (bind === "custom" && customBindHost && isValidIPv4(customBindHost)) {
      return customBindHost;
    }
    if (bind === "tailnet" && tailnetIPv4) {
      return tailnetIPv4 ?? "127.0.0.1";
    }
    if (bind === "lan") {
      return pickBestEffortPrimaryLanIPv4() ?? "127.0.0.1";
    }
    return "127.0.0.1";
  })();
  const basePath = normalizeControlUiBasePath(params.basePath);
  const uiPath = basePath ? `${basePath}/` : "/";
  const wsPath = basePath ? basePath : "";
  const httpScheme = params.tlsEnabled === true ? "https" : "http";
  const wsScheme = params.tlsEnabled === true ? "wss" : "ws";
  return {
    httpUrl: `${httpScheme}://${host}:${port}${uiPath}`,
    wsUrl: `${wsScheme}://${host}:${port}${wsPath}`,
  };
}
