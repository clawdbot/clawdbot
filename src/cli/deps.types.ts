// Shared dependency surface for CLI send commands.
import type { CliOutboundSendSource } from "./outbound-send-mapping.js";

/** CLI dependency bag currently used by outbound send command plumbing. */
export type CliDeps = CliOutboundSendSource;
