import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLiveTransportQaRunOptions } from "./live-transport-cli.runtime.js";

describe("resolveLiveTransportQaRunOptions", () => {
  it("drops blank model refs so live transports can use provider defaults", () => {
    const options = resolveLiveTransportQaRunOptions({
      repoRoot: "/tmp/openclaw-repo",
      providerMode: "live-frontier",
      primaryModel: " ",
      alternateModel: "",
      listScenarios: true,
    });
    expect(options.repoRoot).toBe(path.resolve("/tmp/openclaw-repo"));
    expect(options.providerMode).toBe("live-frontier");
    expect(options.primaryModel).toBeUndefined();
    expect(options.alternateModel).toBeUndefined();
    expect(options.listScenarios).toBe(true);
  });
});
