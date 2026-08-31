import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const resolverPath = fileURLToPath(new URL("../vault-secret-ref-resolver.js", import.meta.url));

it("keeps malformed successful Vault responses scoped per id", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end("not-json");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server did not bind to a TCP port");
  }

  try {
    const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [resolverPath], {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            VAULT_ADDR: `http://127.0.0.1:${address.port}`,
            VAULT_TOKEN: "not-a-real-auth-header",
          },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += String(chunk)));
        child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += String(chunk)));
        child.on("error", reject);
        child.on("close", (code) => resolve({ stdout, stderr, code }));
        child.stdin.end(
          `${JSON.stringify({
            protocolVersion: 1,
            provider: "vault",
            ids: ["providers/openai/apiKey", "tts/elevenlabs/apiKey"],
          })}\n`,
        );
      },
    );

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: {},
      errors: {
        "providers/openai/apiKey": {
          message: 'Vault read response for "providers/openai/apiKey" was not valid JSON.',
        },
        "tts/elevenlabs/apiKey": {
          message: 'Vault read response for "tts/elevenlabs/apiKey" was not valid JSON.',
        },
      },
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
