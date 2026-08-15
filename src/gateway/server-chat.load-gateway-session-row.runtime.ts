// Runtime barrel for loading Gateway session rows from chat paths without
// pulling the rest of session-utils into static startup imports.
export { loadGatewaySessionLifecycleSnapshot } from "./session-utils.js";
