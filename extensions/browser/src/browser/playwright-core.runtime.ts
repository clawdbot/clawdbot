import { createRequire } from "node:module";
import type * as PlaywrightCore from "playwright-core";

const require = createRequire(import.meta.url);

export const playwrightCore = require("playwright-core") as typeof PlaywrightCore;
