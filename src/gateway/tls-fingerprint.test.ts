import { createHash, X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEST_TLS_CERT_PEM } from "../../test/helpers/tls-fixture.js";
import type { GatewayTlsConfig } from "../config/types.gateway.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { CONFIG_DIR, pinConfigDir } from "../utils.js";
import { resolveGatewayConnectionTlsFingerprint } from "./tls-fingerprint.js";

const tempDirs = createTrackedTempDirs();
const originalConfigDir = CONFIG_DIR;
const fingerprint = createHash("sha256")
  .update(new X509Certificate(TEST_TLS_CERT_PEM).raw)
  .digest("hex");

afterEach(async () => {
  vi.restoreAllMocks();
  pinConfigDir({ OPENCLAW_STATE_DIR: originalConfigDir });
  await tempDirs.cleanup();
});

function resolveLocalPin(tls: GatewayTlsConfig) {
  return resolveGatewayConnectionTlsFingerprint({
    config: { gateway: { mode: "local", tls } },
    url: "wss://127.0.0.1:32123",
    urlSource: "local loopback",
  });
}

describe("Gateway client certificate inspection", () => {
  it.each(["default", "custom"])("does not provision missing %s TLS files", async (location) => {
    const root = await tempDirs.make("openclaw-tls-owner-client-");
    pinConfigDir({ OPENCLAW_STATE_DIR: root });
    const tlsDir = path.join(root, location === "default" ? "gateway/tls" : "custom/tls");
    const tls =
      location === "default"
        ? { enabled: true }
        : {
            enabled: true,
            certPath: path.join(tlsDir, "cert.pem"),
            keyPath: path.join(tlsDir, "key.pem"),
          };

    await resolveLocalPin(tls);

    await expect(fs.access(tlsDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(resolveLocalPin(tls)).resolves.toBeUndefined();
  });

  it.each([undefined, "", " \t", "custom"])(
    "pins existing public certificate (%j) without a key or CA",
    async (location) => {
      const root = await tempDirs.make("openclaw-tls-owner-client-");
      pinConfigDir({ OPENCLAW_STATE_DIR: root });
      const certPath = path.join(
        root,
        location === "custom" ? "custom.pem" : "gateway/tls/gateway-cert.pem",
      );
      await fs.mkdir(path.dirname(certPath), { recursive: true });
      await fs.writeFile(certPath, TEST_TLS_CERT_PEM, { mode: 0o644 });
      const before = await fs.stat(certPath);
      const read = vi.spyOn(fs, "readFile");

      await expect(
        resolveLocalPin({
          enabled: true,
          certPath: location === "custom" ? `  ${certPath}  ` : location,
          keyPath: path.join(root, "missing-key.pem"),
          caPath: path.join(root, "missing-ca.pem"),
        }),
      ).resolves.toBe(fingerprint);

      expect(read.mock.calls.map(([file]) => file)).toEqual([certPath]);
      const after = await fs.stat(certPath);
      expect([after.mode, after.mtimeMs]).toEqual([before.mode, before.mtimeMs]);
    },
  );

  it("leaves malformed certificates unchanged and returns no implicit pin", async () => {
    const root = await tempDirs.make("openclaw-tls-owner-client-");
    const certPath = path.join(root, "bad.pem");
    await fs.writeFile(certPath, "not a certificate");
    await expect(
      resolveLocalPin({ enabled: true, certPath, keyPath: path.join(root, "key.pem") }),
    ).resolves.toBeUndefined();
    await expect(fs.readFile(certPath, "utf8")).resolves.toBe("not a certificate");
    await expect(fs.readdir(root)).resolves.toEqual(["bad.pem"]);
  });

  it("does not read certificates when local TLS is disabled", async () => {
    const read = vi.spyOn(fs, "readFile");
    await expect(resolveLocalPin({ enabled: false })).resolves.toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });
});
