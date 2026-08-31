/**
 * Runtime dependency facade for session_status output.
 *
 * Tests mock this small module while the tool reuses the canonical status text
 * renderer from the status subsystem.
 */
export { buildStatusText } from "../../status/status-text.js";
