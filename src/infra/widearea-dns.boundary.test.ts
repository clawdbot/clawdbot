// Exercises SOA serial ordering through real atomic zone-file replacements.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as utils from "../utils.js";
import {
  getWideAreaZonePath,
  renderWideAreaGatewayZoneText,
  type WideAreaGatewayZoneOpts,
  writeWideAreaGatewayZone,
} from "./widearea-dns.js";

const zoneOpts: WideAreaGatewayZoneOpts = {
  domain: "openclaw.internal.",
  gatewayPort: 18789,
  displayName: "Mac Studio (OpenClaw)",
  tailnetIPv4: "100.123.224.76",
  hostLabel: "studio-london",
  instanceLabel: "studio-london",
};

describe("wide-area DNS zone writer — unmocked production boundary", () => {
  let stateDir: string;
  let originalConfigDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T12:00:00.000Z"));
    stateDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-widearea-dns-boundary-")),
    );
    originalConfigDir = utils.CONFIG_DIR;
    utils.pinConfigDir({ ...process.env, OPENCLAW_STATE_DIR: stateDir });
  });

  afterEach(() => {
    vi.useRealTimers();
    utils.pinConfigDir({ ...process.env, OPENCLAW_STATE_DIR: originalConfigDir });
    fs.rmSync(stateDir, { recursive: true, force: true });
    expect(utils.CONFIG_DIR).toBe(originalConfigDir);
  });

  it.each([
    { name: "advances future-dated serials", previous: 2027010101, expected: 2027010102 },
    { name: "advances counters past 99", previous: 2026031400, expected: 2026031401 },
    { name: "wraps maximum 32-bit serials", previous: 0xffffffff, expected: 2026031301 },
    { name: "accepts zero as a valid serial", previous: 0, expected: 2026031301 },
    { name: "increments matching daily serials", previous: 2026031301, expected: 2026031302 },
    { name: "rejects undefined half-range advances", previous: 4173514949, expected: 4173514950 },
  ])("$name through the real atomic replacement", async ({ previous, expected }) => {
    const zonePath = getWideAreaZonePath(zoneOpts.domain);
    fs.mkdirSync(path.dirname(zonePath), { recursive: true });
    fs.writeFileSync(zonePath, renderWideAreaGatewayZoneText({ ...zoneOpts, serial: previous }));

    const result = await writeWideAreaGatewayZone({
      ...zoneOpts,
      gatewayTlsEnabled: true,
      gatewayTlsFingerprintSha256: "abc123",
    });

    const written = fs.readFileSync(zonePath, "utf8");
    const match = written.match(/^\s*@\s+IN\s+SOA\s+\S+\s+\S+\s+(\d+)\s+/m);
    const serial = Number.parseInt(match?.[1] ?? "", 10);
    const advance = (serial - previous) >>> 0;

    expect(result).toEqual({ zonePath, changed: true });
    expect(written).toContain("gatewayTlsSha256=abc123");
    expect(serial).toBe(expected);
    expect(advance).toBeGreaterThan(0);
    expect(advance).toBeLessThan(0x80000000);
  });
});
