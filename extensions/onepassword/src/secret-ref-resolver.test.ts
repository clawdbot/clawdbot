import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { encodeOnePasswordSecretId } from "../onepassword-secret-id.js";

const resolverPath = fileURLToPath(
  new URL("../onepassword-secret-ref-resolver.js", import.meta.url),
);
const manifestPath = fileURLToPath(new URL("../openclaw.plugin.json", import.meta.url));
const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-1password-test-"));
  tempDirs.push(dir);
  return dir;
}

function runResolver(params: {
  request: unknown;
  env?: Record<string, string>;
  token?: string | null;
}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const stateDir = params.env?.OPENCLAW_STATE_DIR ?? makeTempDir();
  if (params.token !== null) {
    const tokenDir = path.join(stateDir, "credentials", "onepassword");
    fs.mkdirSync(tokenDir, { recursive: true });
    fs.writeFileSync(
      path.join(tokenDir, "service-account-token"),
      params.token ?? "not-a-real-service-account-token",
      { mode: 0o600 },
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [resolverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OP_SERVICE_ACCOUNT_TOKEN: "",
        CLAW_1PASSWORD_OP: "",
        OPENCLAW_STATE_DIR: stateDir,
        ...params.env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ stdout, stderr, code });
    });
    child.stdin.end(`${JSON.stringify(params.request)}\n`);
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("plugin manifest", () => {
  it("declares the 1Password resolver as a managed Node SecretRef preset", () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      secretProviderIntegrations?: Record<string, Record<string, unknown>>;
    };
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
      openclaw?: {
        build?: {
          staticAssets?: Array<{ source?: string; output?: string }>;
        };
      };
    };
    const integration = manifest.secretProviderIntegrations?.onepassword;

    expect(integration).toMatchObject({
      providerAlias: "onepassword",
      source: "exec",
      command: "${node}",
      args: ["./onepassword-secret-ref-resolver.js"],
      timeoutMs: 40_000,
      noOutputTimeoutMs: 40_000,
      maxOutputBytes: 8 * 1024 * 1024,
      passEnv: expect.arrayContaining(["HOME", "OPENCLAW_STATE_DIR", "PATH"]),
    });
    expect(integration?.passEnv).not.toContain("OP_SERVICE_ACCOUNT_TOKEN");
    expect(integration?.passEnv).not.toContain("OP_CONNECT_HOST");
    expect(integration?.passEnv).not.toContain("OP_CONNECT_TOKEN");
    expect(integration?.passEnv).not.toContain("OP_ACCOUNT");
    expect(integration?.passEnv).not.toContain("OP_CACHE");
    expect(integration).not.toHaveProperty("trustedDirs");
    expect(fs.readFileSync(resolverPath, "utf8")).toContain("#!/usr/bin/env node");
    expect(fs.readFileSync(resolverPath, "utf8")).not.toContain(
      ["openclaw", "plugin-sdk"].join("/"),
    );
    expect(packageJson.openclaw?.build?.staticAssets).toContainEqual({
      source: "./onepassword-op-path.js",
      output: "onepassword-op-path.js",
    });
    expect(packageJson.openclaw?.build?.staticAssets).toContainEqual({
      source: "./onepassword-secret-ref-resolver.js",
      output: "onepassword-secret-ref-resolver.js",
    });
    expect(packageJson.openclaw?.build?.staticAssets).toContainEqual({
      source: "./onepassword-secret-id.js",
      output: "onepassword-secret-id.js",
    });
  });
});

describe("1Password SecretRef resolver", () => {
  it.runIf(process.platform !== "win32")(
    "uses op read with native 1Password secret references",
    async () => {
      const tempDir = makeTempDir();
      const opPath = path.join(tempDir, "op");
      const logPath = path.join(tempDir, "op-args.json");
      fs.writeFileSync(
        opPath,
        `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  args: process.argv.slice(2),
  biometric: process.env.OP_BIOMETRIC_UNLOCK_ENABLED,
  loadDesktopSettings: process.env.OP_LOAD_DESKTOP_APP_SETTINGS,
  account: process.env.OP_ACCOUNT,
  serviceAccount: process.env.OP_SERVICE_ACCOUNT_TOKEN === "not-a-real-service-account-token",
}));
process.stdout.write("not-a-real-value \\t");
`,
        { mode: 0o755 },
      );

      const result = await runResolver({
        request: {
          protocolVersion: 1,
          provider: "onepassword",
          ids: ["op://Engineering/OpenRouter/apiKey"],
        },
        env: {
          CLAW_1PASSWORD_OP: opPath,
          OP_ACCOUNT: "should-not-reach-op",
        },
      });

      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toEqual({
        protocolVersion: 1,
        values: {
          "op://Engineering/OpenRouter/apiKey": "not-a-real-value \t",
        },
        errors: {},
      });
      expect(JSON.parse(fs.readFileSync(logPath, "utf8"))).toEqual({
        args: ["read", "--no-newline", "op://Engineering/OpenRouter/apiKey"],
        biometric: "false",
        loadDesktopSettings: "false",
        serviceAccount: true,
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "decodes native references that do not fit the shared exec id grammar",
    async () => {
      const tempDir = makeTempDir();
      const opPath = path.join(tempDir, "op");
      const logPath = path.join(tempDir, "op-args.json");
      const nativeRef = "op://Personal/OpenClaw QA API Key/password?attribute=value%20one";
      fs.writeFileSync(
        opPath,
        `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write("not-a-real-value");
`,
        { mode: 0o755 },
      );

      const encodedId = encodeOnePasswordSecretId(nativeRef);
      const result = await runResolver({
        request: { protocolVersion: 1, provider: "onepassword", ids: [encodedId] },
        env: { CLAW_1PASSWORD_OP: opPath },
      });

      expect(encodedId).toMatch(/^opb64:[A-Za-z0-9_-]+$/);
      expect(JSON.parse(result.stdout).values).toEqual({ [encodedId]: "not-a-real-value" });
      expect(JSON.parse(fs.readFileSync(logPath, "utf8"))).toEqual([
        "read",
        "--no-newline",
        nativeRef,
      ]);
    },
  );

  it("escapes shorthand ids that begin with the opaque encoding prefix", async () => {
    const nativeRef = "opb64:team/item/field";
    const encodedId = encodeOnePasswordSecretId(nativeRef);

    expect(encodedId).toMatch(/^opb64:[A-Za-z0-9_-]+$/);
    expect(encodedId).not.toBe(nativeRef);
  });

  it.runIf(process.platform !== "win32")(
    "waits for inherited op stdout to close before returning the secret",
    async () => {
      const tempDir = makeTempDir();
      const opPath = path.join(tempDir, "op");
      fs.writeFileSync(
        opPath,
        `#!${process.execPath}
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", "setTimeout(() => process.stdout.write('tail'), 50)"], {
  stdio: ["ignore", process.stdout, "ignore"],
});
process.stdout.write("head");
`,
        { mode: 0o755 },
      );

      const result = await runResolver({
        request: {
          protocolVersion: 1,
          provider: "onepassword",
          ids: ["Engineering/OpenRouter/apiKey"],
        },
        env: { CLAW_1PASSWORD_OP: opPath },
      });

      expect(JSON.parse(result.stdout).values).toEqual({
        "Engineering/OpenRouter/apiKey": "headtail",
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "builds op secret references from shorthand ids",
    async () => {
      const tempDir = makeTempDir();
      const opPath = path.join(tempDir, "op");
      const logPath = path.join(tempDir, "op-args.json");
      fs.writeFileSync(
        opPath,
        `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write("not-a-real-value");
`,
        { mode: 0o755 },
      );

      const result = await runResolver({
        request: {
          protocolVersion: 1,
          provider: "onepassword",
          ids: ["Engineering/OpenRouter/apiKey"],
        },
        env: { CLAW_1PASSWORD_OP: opPath },
      });

      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toEqual({
        protocolVersion: 1,
        values: {
          "Engineering/OpenRouter/apiKey": "not-a-real-value",
        },
        errors: {},
      });
      expect(JSON.parse(fs.readFileSync(logPath, "utf8"))).toEqual([
        "read",
        "--no-newline",
        "op://Engineering/OpenRouter/apiKey",
      ]);
    },
  );

  it("requires an absolute op CLI path", async () => {
    const result = await runResolver({
      request: {
        protocolVersion: 1,
        provider: "onepassword",
        ids: ["op://Engineering/OpenRouter/apiKey"],
      },
      env: {
        CLAW_1PASSWORD_OP: "op",
      },
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: {},
      errors: {
        request: {
          message: "CLAW_1PASSWORD_OP must be an absolute path: op",
        },
      },
    });
  });

  it("rejects requests larger than the supported batch", async () => {
    const result = await runResolver({
      request: {
        protocolVersion: 1,
        provider: "onepassword",
        ids: Array.from({ length: 17 }, (_, index) => `op://Vault/Item${index}/field`),
      },
    });

    expect(JSON.parse(result.stdout).errors).toEqual({
      request: { message: "1Password SecretRef requests support at most 16 ids." },
    });
  });

  it("requires the broker service-account token file", async () => {
    const result = await runResolver({
      request: {
        protocolVersion: 1,
        provider: "onepassword",
        ids: ["op://Engineering/OpenRouter/apiKey"],
      },
      env: { CLAW_1PASSWORD_OP: process.execPath },
      token: null,
    });

    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: {},
      errors: {
        request: {
          message:
            "1Password service account token file is missing, empty, unsafe, or too large. Configure the onepassword plugin token file first.",
        },
      },
    });
  });

  it.runIf(process.platform !== "win32")(
    "does not include failed child output in resolver errors",
    async () => {
      const tempDir = makeTempDir();
      const opPath = path.join(tempDir, "op");
      fs.writeFileSync(
        opPath,
        `#!${process.execPath}
process.stdout.write("secret-output-must-not-escape");
process.stderr.write("secret-error-must-not-escape");
process.exitCode = 1;
`,
        { mode: 0o755 },
      );

      const result = await runResolver({
        request: {
          protocolVersion: 1,
          provider: "onepassword",
          ids: ["op://Engineering/OpenRouter/apiKey"],
        },
        env: { CLAW_1PASSWORD_OP: opPath },
      });
      expect(result.stdout).not.toContain("secret-output-must-not-escape");
      expect(result.stdout).not.toContain("secret-error-must-not-escape");
      expect(JSON.parse(result.stdout).errors).toEqual({
        "op://Engineering/OpenRouter/apiKey": { message: "op read failed with exit code 1." },
      });
    },
  );

  it.runIf(process.platform !== "win32")("bounds concurrent op reads", async () => {
    const tempDir = makeTempDir();
    const opPath = path.join(tempDir, "op");
    const logPath = path.join(tempDir, "events.log");
    fs.writeFileSync(
      opPath,
      `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, "start " + process.pid + "\\n");
setTimeout(() => {
  fs.appendFileSync(${JSON.stringify(logPath)}, "end " + process.pid + "\\n");
  process.stdout.write("not-a-real-value");
}, 80);
`,
      { mode: 0o755 },
    );
    const ids = Array.from({ length: 12 }, (_, index) => `op://Vault/Item${index}/field`);
    const result = await runResolver({
      request: { protocolVersion: 1, provider: "onepassword", ids },
      env: { CLAW_1PASSWORD_OP: opPath },
    });

    expect(Object.keys(JSON.parse(result.stdout).values)).toHaveLength(ids.length);
    let active = 0;
    let maxActive = 0;
    for (const event of fs.readFileSync(logPath, "utf8").trim().split("\n")) {
      active += event.startsWith("start ") ? 1 : -1;
      maxActive = Math.max(maxActive, active);
    }
    expect(maxActive).toBeLessThanOrEqual(4);
  });

  it.runIf(process.platform !== "win32")("resolves the op CLI from PATH", async () => {
    const tempDir = makeTempDir();
    const opPath = path.join(tempDir, process.platform === "win32" ? "op.exe" : "op");
    fs.writeFileSync(opPath, `#!${process.execPath}\nprocess.stdout.write('from-path');\n`, {
      mode: 0o755,
    });
    const result = await runResolver({
      request: {
        protocolVersion: 1,
        provider: "onepassword",
        ids: ["op://Engineering/OpenRouter/apiKey"],
      },
      env: { PATH: tempDir },
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: { "op://Engineering/OpenRouter/apiKey": "from-path" },
      errors: {},
    });
  });

  it.runIf(process.platform !== "win32")(
    "refuses to pass the token to an op CLI in an unsafe PATH directory",
    async () => {
      const tempDir = makeTempDir();
      const opPath = path.join(tempDir, "op");
      const tokenLogPath = path.join(tempDir, "token.log");
      fs.writeFileSync(
        opPath,
        `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(tokenLogPath)}, process.env.OP_SERVICE_ACCOUNT_TOKEN);\n`,
        { mode: 0o755 },
      );
      fs.chmodSync(tempDir, 0o777);

      const result = await runResolver({
        request: {
          protocolVersion: 1,
          provider: "onepassword",
          ids: ["op://Engineering/OpenRouter/apiKey"],
        },
        env: { PATH: tempDir },
      });

      expect(JSON.parse(result.stdout).errors.request.message).toContain(
        "Refusing unsafe 1Password CLI path",
      );
      expect(fs.existsSync(tokenLogPath)).toBe(false);
    },
  );

  it("returns an actionable error when the op CLI is missing", async () => {
    const result = await runResolver({
      request: {
        protocolVersion: 1,
        provider: "onepassword",
        ids: ["op://Engineering/OpenRouter/apiKey"],
      },
      env: {
        CLAW_1PASSWORD_OP: "/does/not/exist/op",
      },
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: {},
      errors: {
        request: {
          message:
            "1Password CLI was not found. Install the official CLI or set CLAW_1PASSWORD_OP to its absolute path.",
        },
      },
    });
  });
});
