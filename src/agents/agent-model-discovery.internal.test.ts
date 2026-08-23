/** Tests internal model discovery imports avoid public SDK facade coupling. */
import { beforeAll, describe, expect, it } from "vitest";

let modelDiscovery: typeof import("./agent-model-discovery.js");

describe("agent-model-discovery internal runtime", () => {
  beforeAll(async () => {
    modelDiscovery = await import("./agent-model-discovery.js");
  });

  it("loads without the public agent-sessions SDK facade", () => {
    expect(typeof modelDiscovery.discoverAuthStorage).toBe("function");
    expect(typeof modelDiscovery.discoverModels).toBe("function");
  });
});
