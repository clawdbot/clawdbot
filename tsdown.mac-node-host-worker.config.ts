import { isBuiltin } from "node:module";
import type { UserConfig } from "tsdown";
import { createMacNodeHostWorkerBuildPlugin } from "./scripts/lib/mac-node-host-worker-build-plugin.mts";
import { createStateSchemaInlinePlugin } from "./scripts/lib/state-schema-inline-plugin.mts";
import {
  createWorkerDeployBuildPlugin,
  WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID,
} from "./scripts/lib/worker-deploy-build-plugin.mts";

const packageVersion = (await import("./package.json", { with: { type: "json" } })).default.version;
const sourceCommit = process.env.GIT_COMMIT?.trim() ?? "";

const config: UserConfig = {
  entry: {
    "node-host-worker": "src/node-host/mac-node-host-worker-entry.ts",
  },
  outDir: "apps/macos/.build/node-host-worker",
  dts: false,
  env: { NODE_ENV: "production" },
  define: {
    MAC_NODE_HOST_WORKER_SOURCE_COMMIT: JSON.stringify(sourceCommit),
    WORKER_DEPLOY_BUILD: "true",
    WORKER_DEPLOY_VERSION: JSON.stringify(packageVersion),
  },
  alias: {
    bufferutil: WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID,
    "chromium-bidi/lib/cjs/bidiMapper/BidiMapper": WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID,
    "chromium-bidi/lib/cjs/cdp/CdpConnection": WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID,
    "electron/index.js": WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID,
    fsevents: WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID,
    kerberos: WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID,
    "utf-8-validate": WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID,
  },
  deps: {
    alwaysBundle: (id) => !isBuiltin(id),
    onlyBundle: false,
  },
  fixedExtension: false,
  outExtensions: () => ({ js: ".mjs", dts: ".d.ts" }),
  outputOptions: { codeSplitting: false },
  plugins: [
    createStateSchemaInlinePlugin(),
    createMacNodeHostWorkerBuildPlugin(),
    createWorkerDeployBuildPlugin(),
  ],
  shims: true,
  sourcemap: false,
};

export default config;
