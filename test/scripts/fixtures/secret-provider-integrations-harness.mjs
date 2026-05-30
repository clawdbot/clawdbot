import path from "node:path";
import { pathToFileURL } from "node:url";

const [proofScriptPath, root, mode] = process.argv.slice(2);
setTimeout(() => {
  console.error("proof harness timed out");
  process.exit(124);
}, 3000);

const proof = await import(`${pathToFileURL(proofScriptPath).href}?case=${Date.now()}`);
const startedAt = Date.now();

try {
  if (mode === "start") {
    await proof.startGateway(
      {
        env: {
          ...process.env,
          OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
        },
      },
      9,
      "proof-token",
    );
  } else if (mode === "status") {
    await proof.waitForManagedGatewayStatus(process.env, "proof-token");
  } else {
    throw new Error(`unknown proof harness mode: ${mode}`);
  }
  console.log(
    JSON.stringify({ ok: false, elapsedMs: Date.now() - startedAt, message: "unexpected success" }),
  );
  process.exit(1);
} catch (error) {
  console.log(
    JSON.stringify({
      ok: true,
      elapsedMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(0);
}
