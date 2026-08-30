import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { relayTestKey } from "../../chrome-extension/relay-key.test-support.js";
import { chromeProductRoots, installStableChromeExtension } from "./extension-install-layout.js";
import { installChromeExtensionBootstrap } from "./extension-install.js";
import {
  predictedId,
  useExtensionInstallFixture,
  useNativeHostLaunchFixture,
  writeSecurePreferences,
} from "./extension-install.test-support.js";

const BUILT_NATIVE_HOST_PATH = path.resolve("dist/extensions/browser/native-host-entry.js");
const fixture = useExtensionInstallFixture();
const nativeHostFixture = useNativeHostLaunchFixture();

// Automatic native script launchers are POSIX-only; Windows uses manual pairing.
describe.skipIf(process.platform === "win32")("native host registration", () => {
  it("launches with the exact custom installation context when Chrome has no selectors", async () => {
    const value = await fixture();
    const stateDir = path.join(value.root, "custom state's dir");
    const configPath = path.join(value.root, "custom config's dir", "openclaw.json");
    const launchFixture = await nativeHostFixture(value.root, BUILT_NATIVE_HOST_PATH);
    const relayPort = 19_031;
    const token = relayTestKey(4);
    const deps = {
      ...value.deps,
      stateDir,
      ...launchFixture,
      env: {
        ...value.deps.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
      },
    };
    await fs.mkdir(path.join(stateDir, "credentials"), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(stateDir, "credentials", "browser-extension-relay.secret"),
      `${token}\n`,
      { mode: 0o600 },
    );
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ browser: { profiles: { e2e: { driver: "extension", cdpPort: relayPort } } } })}\n`,
      { mode: 0o600 },
    );
    const installed = await installStableChromeExtension(value.bundledDir, deps);
    const chromium = chromeProductRoots(deps).find((root) => root.product === "chromium");
    if (!chromium) {
      throw new Error("missing Chromium fixture root");
    }
    const extensionId = await predictedId(installed, deps.platform);
    await writeSecurePreferences({
      userDataDir: chromium.userDataDir,
      profile: "Default",
      entries: { [extensionId]: { location: 4, path: installed } },
    });
    const status = await installChromeExtensionBootstrap({
      bundledDir: value.bundledDir,
      pluginRoot: value.pluginRoot,
      waitMs: 1_000,
      deps,
    });
    const registration = status.registrations.find((entry) => entry.product === "chromium");
    expect(registration, status.issues.join("\n")).toMatchObject({ state: "owned" });
    const manifest = JSON.parse(await fs.readFile(registration?.manifestPath ?? "", "utf8")) as {
      path: string;
    };

    const nonce = Buffer.alloc(16, 7).toString("base64url");
    const requestBody = Buffer.from(JSON.stringify({ v: 1, op: "bootstrap", nonce }));
    const requestFrame = Buffer.alloc(requestBody.length + 4);
    if (os.endianness() === "LE") {
      requestFrame.writeUInt32LE(requestBody.length);
    } else {
      requestFrame.writeUInt32BE(requestBody.length);
    }
    requestBody.copy(requestFrame, 4);
    const host = spawnSync(manifest.path, [`chrome-extension://${extensionId}/`], {
      input: requestFrame,
      env: { HOME: value.homeDir, TMPDIR: os.tmpdir() },
      timeout: 10_000,
    });
    expect(host.status, host.stderr.toString("utf8")).toBe(0);
    const frameLength =
      os.endianness() === "LE" ? host.stdout.readUInt32LE() : host.stdout.readUInt32BE();
    expect(host.stdout).toHaveLength(frameLength + 4);
    expect(JSON.parse(host.stdout.subarray(4).toString("utf8"))).toEqual({
      v: 1,
      ok: true,
      nonce,
      pairingString: `ws://127.0.0.1:18789/browser/extension?gateway=ws%3A%2F%2F127.0.0.1%3A18789#${token}`,
    });
  });
});
