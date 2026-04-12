#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";
import { resolveSystemBin } from "../src/infra/resolve-system-bin.js";
import { ensureDebugProxyCa } from "../src/proxy-capture/ca.js";
import { resolveDebugProxySettings } from "../src/proxy-capture/env.js";

const printOnly = process.argv.includes("--print-only");

async function installCa() {
  const settings = resolveDebugProxySettings();
  const ca = await ensureDebugProxyCa(settings.certDir);
  process.stdout.write(`Debug proxy CA: ${ca.certPath}\n`);
  if (printOnly) {
    process.stdout.write("Created or reused the debug proxy CA without changing system trust.\n");
    return;
  }

  if (process.platform !== "darwin") {
    process.stdout.write(
      "Automatic CA trust is only implemented for macOS. Use the printed CA path to trust it manually on this platform.\n",
    );
    return;
  }

  const security = resolveSystemBin("security");
  if (!security) {
    throw new Error("security CLI is required on macOS to trust the debug proxy CA");
  }

  const result = spawnSync(
    security,
    [
      "add-trusted-cert",
      "-d",
      "-r",
      "trustRoot",
      "-k",
      "/Library/Keychains/System.keychain",
      ca.certPath,
    ],
    {
      stdio: "inherit",
    },
  );
  if (result.status !== 0) {
    throw new Error(`security add-trusted-cert failed with exit code ${result.status ?? 1}`);
  }
  process.stdout.write("Trusted the OpenClaw debug proxy CA in System.keychain.\n");
}

void installCa().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
