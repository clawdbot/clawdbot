#!/usr/bin/env node

import { fileURLToPath } from "node:url";

try {
  process.chdir(fileURLToPath(new URL("..", import.meta.url)));
  // The accepted launcher binds the gateway process to exactly these inherited
  // authority values; the product runtime adds only isolated paths and its port.
  const gatewayEnvironment = {
    OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
    OPENCLAW_PRODUCT_TREE_SHA: process.env.OPENCLAW_PRODUCT_TREE_SHA,
    OPENCLAW_RETURN_COVENANT_PHASE_KEY: process.env.OPENCLAW_RETURN_COVENANT_PHASE_KEY,
    OPENCLAW_RETURN_COVENANT_RUNTIME_ARTIFACT_SHA256:
      process.env.OPENCLAW_RETURN_COVENANT_RUNTIME_ARTIFACT_SHA256,
  };
  const { runReturnCovenantFixtureDriver, runReturnCovenantFixtureGateway } =
    await import("../dist/test-runtime/return-covenant-fixture-driver.js");
  if (process.argv.length === 3 && process.argv[2] === "gateway") {
    await runReturnCovenantFixtureGateway();
  } else {
    await runReturnCovenantFixtureDriver(process.argv.slice(2), {
      launchEnvironment: {
        candidateSha: process.env.OPENCLAW_CANDIDATE_SHA,
        productTreeSha: process.env.OPENCLAW_PRODUCT_TREE_SHA,
        docsHarnessSha: process.env.OPENCLAW_PROOFS_DOCS_REF,
        runtimeArtifactManifestSha256: process.env.OPENCLAW_RETURN_COVENANT_RUNTIME_ARTIFACT_SHA256,
        gatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN,
        gatewayEnvironment,
        launchNonce: process.env.OPENCLAW_RETURN_COVENANT_LAUNCH_NONCE,
        phaseSigningKey: process.env.OPENCLAW_RETURN_COVENANT_PHASE_KEY,
        phaseKeyFingerprint: process.env.OPENCLAW_RETURN_COVENANT_PHASE_KEY_FINGERPRINT,
        attestationPath: process.env.OPENCLAW_RETURN_COVENANT_ATTESTATION_PATH,
      },
    });
  }
} catch (error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.stderr.write("[return-covenant-fixture-driver] FAILED (exit 1)\n");
  process.exitCode = 1;
}
