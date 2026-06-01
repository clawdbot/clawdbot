export type { AcpProvenanceMode, AcpServerOptions, AcpSession } from "@openclaw/acp-core/types";
export { normalizeAcpProvenanceMode } from "@openclaw/acp-core/types";
import { VERSION } from "../version.js";

export const ACP_AGENT_INFO = {
  name: "openclaw-acp",
  title: "OpenClaw ACP Gateway",
  version: VERSION,
};
