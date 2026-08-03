// Provides an fs facade for Control UI asset runtime tests.
import fs from "node:fs";

// Control UI asset tests/runtime import fs through this facade so the asset
// resolver can be stubbed without mocking node:fs globally.
export const existsSync = fs.existsSync.bind(fs);
export const readFileSync = fs.readFileSync.bind(fs);
export const statSync = fs.statSync.bind(fs);
export const realpathSync = fs.realpathSync.bind(fs);
