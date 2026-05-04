import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLiveTransportQaRunOptions } from "./live-transport-cli.runtime.js";

describe("resolveLiveTransportQaRunOptions", () => {
  it("drops blank model refs so live transports can use provider defaults", () => {
    expect(
      resolveLiveTransportQaRunOptions({
        repoRoot: "/tmp/openclaw-repo",
        providerMode: "live-frontier",
        primaryModel: " ",
        alternateModel: "",
      }),
    ).toMatchObject({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      providerMode: "live-frontier",
      primaryModel: undefined,
      alternateModel: undefined,
    });
  });
});
