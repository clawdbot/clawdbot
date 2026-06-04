/**
 * Tests plugin SDK fetch runtime helpers and fixture path behavior.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { execNodeEvalSync } from "../test-utils/node-process.js";

describe("plugin SDK fetch runtime", () => {
  let importProbeOutput = "";

  beforeAll(() => {
    const moduleUrl = pathToFileURL(path.resolve("src/plugin-sdk/fetch-runtime.ts")).href;
    const source = `
      const { getGlobalDispatcher } = await import("undici");
      const before = getGlobalDispatcher();
      await import(${JSON.stringify(moduleUrl)});
      if (getGlobalDispatcher() !== before) {
        throw new Error("undici global dispatcher was replaced");
      }
      console.log("ok");
    `;
    const env = { ...process.env };
    for (const key of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "OPENCLAW_DEBUG_PROXY_ENABLED",
    ]) {
      delete env[key];
    }

    importProbeOutput = execNodeEvalSync(source, { env, imports: ["tsx"] });
  });

  it("does not replace the undici global dispatcher on import", () => {
    expect(importProbeOutput.trim()).toBe("ok");
  });
});
