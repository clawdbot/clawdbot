import path from "node:path";
import { describe, expect, it } from "vitest";
import { summarizeGatewayServiceLayout } from "./service-layout.js";

describe("resolveGatewayServiceEntrypoint", () => {
  it("resolves a relative entrypoint against an absolute working directory", async () => {
    expect(
      (
        await summarizeGatewayServiceLayout({
          programArguments: ["node", "dist/index.js", "gateway", "run"],
          workingDirectory: "/repo/openclaw",
        })
      )?.entrypoint,
    ).toBe(path.join("/repo/openclaw", "dist", "index.js"));
  });

  it("resolves Windows service entrypoints with Windows path semantics", async () => {
    expect(
      (
        await summarizeGatewayServiceLayout({
          programArguments: ["node.exe", "dist\\index.js", "gateway", "run"],
          workingDirectory: "C:\\openclaw",
        })
      )?.entrypoint,
    ).toBe("C:\\openclaw\\dist\\index.js");
  });

  it("rejects a relative entrypoint without an absolute service working directory", async () => {
    await expect(
      summarizeGatewayServiceLayout({
        programArguments: ["node", "dist/index.js", "gateway", "run"],
      }),
    ).resolves.not.toHaveProperty("entrypoint");
    await expect(
      summarizeGatewayServiceLayout({
        programArguments: ["node", "dist/index.js", "gateway", "run"],
        workingDirectory: "./checkout",
      }),
    ).resolves.not.toHaveProperty("entrypoint");
  });
});
