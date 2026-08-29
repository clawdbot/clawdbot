import { describe, expect, it } from "vitest";
import { parseNodeWorkerWorkspaceExecInput } from "./node-workspace-protocol.js";

const request = {
  gatewayNamespace: "gateway-1",
  environmentId: "environment-1",
  sessionId: "session-1",
  generation: 1,
  argv: ["openclaw-internal-workspace-seed"],
};
const key = "a".repeat(64);

describe("node workspace seed protocol", () => {
  it.each([
    { action: "apply", key },
    { action: "store", key, maxAgeMs: 0 },
    { action: "store", key, maxAgeMs: Number.MAX_SAFE_INTEGER },
  ])("accepts $action with maxAgeMs=$maxAgeMs", (seed) => {
    expect(parseNodeWorkerWorkspaceExecInput(JSON.stringify({ ...request, seed }))).toEqual({
      ...request,
      seed,
    });
  });

  it.each([
    ["bad key", { seed: { action: "apply", key: "../outside" } }],
    ["uppercase key", { seed: { action: "apply", key: "A".repeat(64) } }],
    ["bad action", { seed: { action: "remove", key } }],
    ["extra apply key", { seed: { action: "apply", key, maxAgeMs: 0 } }],
    ["extra store key", { seed: { action: "store", key, maxAgeMs: 0, extra: true } }],
    ["missing age", { seed: { action: "store", key } }],
    ["negative age", { seed: { action: "store", key, maxAgeMs: -1 } }],
    ["unsafe age", { seed: { action: "store", key, maxAgeMs: Number.MAX_SAFE_INTEGER + 1 } }],
    ["fractional age", { seed: { action: "store", key, maxAgeMs: 0.5 } }],
    ["reset", { seed: { action: "apply", key }, resetWorkspace: true }],
    ["false reset", { seed: { action: "apply", key }, resetWorkspace: false }],
    [
      "transfer",
      {
        seed: { action: "store", key, maxAgeMs: 0 },
        transfer: { direction: "download", token: "transfer-token", manifestRef: `sha256:${key}` },
      },
    ],
  ])("rejects %s", (_name, invalid) => {
    expect(() =>
      parseNodeWorkerWorkspaceExecInput(JSON.stringify({ ...request, ...invalid })),
    ).toThrow("INVALID_REQUEST:");
  });
});
