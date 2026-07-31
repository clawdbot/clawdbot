// Feishu API module exposes the plugin doctor contract.
// The pre-validation doctor registry resolves `doctor-contract-api` from the
// package root (src/plugins/doctor-contract-registry.ts), so separately
// installed @openclaw/feishu builds can repair legacy streaming config before
// schema validation rejects it.
export { legacyConfigRules, normalizeCompatibilityConfig } from "./src/doctor-contract.js";
