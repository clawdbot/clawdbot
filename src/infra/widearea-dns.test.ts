// Tests wide-area DNS discovery parsing and timeout behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as utils from "../utils.js";
import {
  getWideAreaZonePath,
  normalizeWideAreaDomain,
  renderWideAreaGatewayZoneText,
  resolveWideAreaDiscoveryDomain,
  type WideAreaGatewayZoneOpts,
  writeWideAreaGatewayZone,
} from "./widearea-dns.js";

const replaceFileAtomicSyncMock = vi.hoisted(() => vi.fn());

vi.mock("./replace-file.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./replace-file.js")>()),
  replaceFileAtomicSync: replaceFileAtomicSyncMock,
}));

const baseZoneOpts: WideAreaGatewayZoneOpts = {
  domain: "openclaw.internal.",
  gatewayPort: 18789,
  displayName: "Mac Studio (OpenClaw)",
  tailnetIPv4: "100.123.224.76",
  hostLabel: "studio-london",
  instanceLabel: "studio-london",
};

function makeZoneOpts(overrides: Partial<WideAreaGatewayZoneOpts> = {}): WideAreaGatewayZoneOpts {
  return { ...baseZoneOpts, ...overrides };
}

function renderZoneText(overrides: Partial<WideAreaGatewayZoneOpts> = {}): string {
  return renderWideAreaGatewayZoneText({
    ...makeZoneOpts(overrides),
    serial: 2025121701,
  });
}

function expectZoneRecords(text: string, records: string[]): void {
  for (const record of records) {
    expect(text).toContain(record);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  replaceFileAtomicSyncMock.mockReset();
});

describe("wide-area DNS discovery domain helpers", () => {
  it.each([
    { value: "openclaw.internal", expected: "openclaw.internal." },
    { value: "openclaw.internal.", expected: "openclaw.internal." },
    { value: "  openclaw.internal  ", expected: "openclaw.internal." },
    { value: "", expected: null },
    { value: "   ", expected: null },
    { value: null, expected: null },
    { value: undefined, expected: null },
  ])("normalizes domains for %j", ({ value, expected }) => {
    expect(normalizeWideAreaDomain(value)).toBe(expected);
  });

  it.each(["../../x", "foo/bar", "foo\\bar", "evil\nrecords", "openclaw..internal"])(
    "rejects invalid domains for %j",
    (value) => {
      expect(() => normalizeWideAreaDomain(value)).toThrow(
        "wide-area discovery domain must be a valid DNS name",
      );
    },
  );

  it.each([
    {
      name: "prefers config domain over env",
      params: {
        env: { OPENCLAW_WIDE_AREA_DOMAIN: "env.internal" } as NodeJS.ProcessEnv,
        configDomain: "config.internal",
      },
      expected: "config.internal.",
    },
    {
      name: "falls back to env domain",
      params: {
        env: { OPENCLAW_WIDE_AREA_DOMAIN: "env.internal" } as NodeJS.ProcessEnv,
      },
      expected: "env.internal.",
    },
    {
      name: "returns null when both sources are blank",
      params: {
        env: { OPENCLAW_WIDE_AREA_DOMAIN: "   " } as NodeJS.ProcessEnv,
        configDomain: " ",
      },
      expected: null,
    },
    {
      name: "returns null for invalid config domains",
      params: {
        env: { OPENCLAW_WIDE_AREA_DOMAIN: "env.internal" } as NodeJS.ProcessEnv,
        configDomain: "foo/bar",
      },
      expected: null,
    },
    {
      name: "returns null for invalid env domains",
      params: {
        env: { OPENCLAW_WIDE_AREA_DOMAIN: "foo/bar" } as NodeJS.ProcessEnv,
      },
      expected: null,
    },
  ])("$name", ({ params, expected }) => {
    expect(resolveWideAreaDiscoveryDomain(params)).toBe(expected);
  });

  it("builds valid zone paths under the DNS config directory", () => {
    const dnsDir = path.resolve(utils.CONFIG_DIR, "dns");
    const zonePath = getWideAreaZonePath("openclaw.internal.");

    expect(zonePath).toBe(path.join(dnsDir, "openclaw.internal.db"));
    expect(path.relative(dnsDir, zonePath)).toBe("openclaw.internal.db");
  });
});

describe("wide-area DNS-SD zone rendering", () => {
  it("renders a zone with gateway PTR/SRV/TXT records", () => {
    const txt = renderZoneText({
      tailnetIPv6: "fd7a:115c:a1e0::8801:e04c",
      sshPort: 22,
      cliPath: "/opt/homebrew/bin/openclaw",
    });

    expectZoneRecords(txt, [
      `$ORIGIN openclaw.internal.`,
      `studio-london IN A 100.123.224.76`,
      `studio-london IN AAAA fd7a:115c:a1e0::8801:e04c`,
      `_openclaw-gw._tcp IN PTR studio-london._openclaw-gw._tcp`,
      `studio-london._openclaw-gw._tcp IN SRV 0 0 18789 studio-london`,
      `displayName=Mac Studio (OpenClaw)`,
      `gatewayPort=18789`,
      `sshPort=22`,
      `cliPath=/opt/homebrew/bin/openclaw`,
    ]);
  });

  it.each([
    {
      name: "includes tailnetDns when provided",
      overrides: { tailnetDns: "peters-mac-studio-1.sheep-coho.ts.net" },
      records: [`tailnetDns=peters-mac-studio-1.sheep-coho.ts.net`],
    },
    {
      name: "includes gateway TLS TXT fields and trims display metadata",
      overrides: {
        domain: "openclaw.internal",
        displayName: "  Mac Studio (OpenClaw)  ",
        hostLabel: " Studio London ",
        instanceLabel: " Studio London ",
        gatewayTlsEnabled: true,
        gatewayTlsFingerprintSha256: "abc123",
        gatewayDirectReachable: true,
        tailnetDns: " tailnet.ts.net ",
        cliPath: " /opt/homebrew/bin/openclaw ",
      },
      records: [
        `$ORIGIN openclaw.internal.`,
        `studio-london IN A 100.123.224.76`,
        `studio-london._openclaw-gw._tcp IN TXT`,
        `displayName=Mac Studio (OpenClaw)`,
        `gatewayTls=1`,
        `gatewayTlsSha256=abc123`,
        `gatewayDirectReachable=1`,
        `tailnetDns=tailnet.ts.net`,
        `cliPath=/opt/homebrew/bin/openclaw`,
      ],
    },
  ])("$name", ({ overrides, records }) => {
    expectZoneRecords(renderZoneText(overrides), records);
  });
});

describe("wide-area DNS zone writes", () => {
  it("rejects blank domains", async () => {
    await expect(writeWideAreaGatewayZone(makeZoneOpts({ domain: "   " }))).rejects.toThrow(
      "wide-area discovery domain is required",
    );
  });

  it.each(["../../x", "foo/bar", "foo\\bar", "evil\nrecords", "openclaw..internal"])(
    "rejects invalid domain %j before writing",
    async (domain) => {
      await expect(writeWideAreaGatewayZone(makeZoneOpts({ domain }))).rejects.toThrow(
        "wide-area discovery domain must be a valid DNS name",
      );

      expect(replaceFileAtomicSyncMock).not.toHaveBeenCalled();
    },
  );

  it("skips rewriting unchanged content", async () => {
    const existing = renderWideAreaGatewayZoneText({ ...makeZoneOpts(), serial: 2026031301 });
    vi.spyOn(fs, "readFileSync").mockReturnValue(existing);

    const result = await writeWideAreaGatewayZone(makeZoneOpts());

    expect(result).toEqual({
      zonePath: getWideAreaZonePath("openclaw.internal."),
      changed: false,
    });
    expect(replaceFileAtomicSyncMock).not.toHaveBeenCalled();
  });

  it("increments same-day serials when content changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T12:00:00.000Z"));
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      renderWideAreaGatewayZoneText({ ...makeZoneOpts(), serial: 2026031304 }),
    );

    const result = await writeWideAreaGatewayZone(
      makeZoneOpts({ gatewayTlsEnabled: true, gatewayTlsFingerprintSha256: "abc123" }),
    );

    expect(result).toEqual({
      zonePath: getWideAreaZonePath("openclaw.internal."),
      changed: true,
    });
    const expectedZoneText = renderWideAreaGatewayZoneText({
      ...makeZoneOpts({ gatewayTlsEnabled: true, gatewayTlsFingerprintSha256: "abc123" }),
      serial: 2026031305,
    });
    expect(replaceFileAtomicSyncMock).toHaveBeenCalledWith({
      filePath: getWideAreaZonePath("openclaw.internal."),
      content: expectedZoneText,
      dirMode: 0o700,
      mode: 0o644,
      preserveExistingMode: true,
      syncTempFile: true,
      syncParentDir: true,
      tempPrefix: ".openclaw-dns-zone",
    });
  });

  it.runIf(process.platform !== "win32")(
    "preserves the previous zone when the replacement exceeds the OS file-size limit",
    () => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-widearea-dns-fault-"));
      const dnsDir = path.join(stateDir, "dns");
      const zonePath = path.join(dnsDir, "openclaw.internal.db");
      const previous = "; previous valid zone\n$ORIGIN openclaw.internal.\n";
      fs.mkdirSync(dnsDir);
      fs.writeFileSync(zonePath, previous, { mode: 0o640 });

      try {
        const moduleUrl = pathToFileURL(path.resolve("src/infra/widearea-dns.ts")).href;
        const script = `
          const { writeWideAreaGatewayZone } = await import(${JSON.stringify(moduleUrl)});
          try {
            await writeWideAreaGatewayZone({
              domain: "openclaw.internal",
              gatewayPort: 18789,
              displayName: "X".repeat(8192),
              tailnetIPv4: "100.64.0.1",
            });
            process.exitCode = 24;
          } catch (error) {
            if (error?.code !== "EFBIG") {
              console.error(error);
              process.exitCode = 25;
            }
          }
        `;
        const child = spawnSync(
          "/bin/sh",
          [
            "-c",
            'ulimit -f 1; exec "$@"',
            "openclaw-widearea-dns-fault",
            process.execPath,
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            script,
          ],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
          },
        );

        expect(child.status, child.stderr).toBe(0);
        expect(fs.readFileSync(zonePath, "utf8")).toBe(previous);
        expect(fs.statSync(zonePath).mode & 0o777).toBe(0o640);
        expect(fs.readdirSync(dnsDir)).toEqual(["openclaw.internal.db"]);
      } finally {
        fs.rmSync(stateDir, { force: true, recursive: true });
      }
    },
  );
});
