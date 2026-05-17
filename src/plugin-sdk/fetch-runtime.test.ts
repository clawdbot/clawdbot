import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { execNodeEvalSync } from "../test-utils/node-process.js";

describe("plugin SDK fetch runtime", () => {
  it("does not initialize the undici global dispatcher on import", () => {
    const moduleUrl = pathToFileURL(path.resolve("src/plugin-sdk/fetch-runtime.ts")).href;
    const source = `
      const dispatcherKey = Symbol.for("undici.globalDispatcher.1");
      await import(${JSON.stringify(moduleUrl)});
      if (globalThis[dispatcherKey] !== undefined) {
        throw new Error("undici global dispatcher was initialized");
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

    const output = execNodeEvalSync(source, { env, imports: ["tsx"] });

    expect(output.trim()).toBe("ok");
  });
});
