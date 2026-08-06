// Gateway Protocol tests cover strict Gateway host system information payloads.
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SystemInfoResultSchema } from "./system-info.js";

const validSystemInfo = {
  machineName: "Gateway Mac",
  hostname: "gateway.local",
  platform: "darwin",
  release: "25.5.0",
  arch: "arm64",
  osLabel: "macOS 26.5.0",
  lanAddress: "192.168.1.20",
  port: 18789,
  nodeVersion: "v24.1.0",
  pid: 1234,
  uptimeMs: 60_000,
  cpuCount: 10,
  cpuModel: "Apple M4",
  loadAverage: [1.2, 1.1, 0.9],
  memoryTotalBytes: 34_359_738_368,
  memoryFreeBytes: 17_179_869_184,
  diskTotalBytes: 994_662_584_320,
  diskAvailableBytes: 497_331_292_160,
  diskPath: "/Users/operator/.openclaw",
};

describe("SystemInfoResultSchema", () => {
  it("accepts a complete Gateway host snapshot", () => {
    expect(Value.Check(SystemInfoResultSchema, validSystemInfo)).toBe(true);
  });

  it("rejects extra properties", () => {
    expect(Value.Check(SystemInfoResultSchema, { ...validSystemInfo, extra: true })).toBe(false);
  });
});
