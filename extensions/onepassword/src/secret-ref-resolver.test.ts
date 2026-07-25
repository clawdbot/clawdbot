import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SECRET_FILE_MAX_BYTES } from "openclaw/plugin-sdk/secret-file-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { encodeOnePasswordSecretId } from "../onepassword-secret-id.js";
import { createTrustedNodeFixture } from "./trusted-node.test-support.js";

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

async function waitForPath(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for test path: ${filePath}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

function runResolver(params: {
  request: unknown;
  cwd?: string;
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
      ...(params.cwd ? { cwd: params.cwd } : {}),
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
    const resolverSource = fs.readFileSync(resolverPath, "utf8");
    const readIntegerConstant = (name: string): number => {
      const match = new RegExp(`const ${name} = (\\d[\\d_]*)`, "u").exec(resolverSource);
      return Number(match?.[1]?.replaceAll("_", ""));
    };
    const opReadConcurrency = readIntegerConstant("OP_READ_CONCURRENCY");
    const opReadTimeoutMs = readIntegerConstant("OP_READ_TIMEOUT_MS");
    const maxRefsPerRequest = readIntegerConstant("MAX_SECRET_REFS_PER_REQUEST");
    const maxSecretValueBytes = readIntegerConstant("MAX_SECRET_VALUE_BYTES");
    const worstCaseBatchTimeoutMs =
      Math.ceil(maxRefsPerRequest / opReadConcurrency) * opReadTimeoutMs;
    const worstCaseEscapedValueBytes = Buffer.byteLength(
      JSON.stringify("\0".repeat(maxSecretValueBytes)),
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      commandAliases?: Array<{ name?: string; cliCommand?: string }>;
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

    expect(manifest.commandAliases).toContainEqual({
      name: "onepassword",
      cliCommand: "onepassword",
    });
    expect(integration).toMatchObject({
      providerAlias: "onepassword",
      source: "exec",
      command: "${node}",
      args: ["./onepassword-secret-ref-resolver.js"],
      timeoutMs: 90_000,
      noOutputTimeoutMs: 90_000,
      maxOutputBytes: 16 * 1024 * 1024,
      passEnv: expect.arrayContaining([
        "HOME",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "APPDATA",
        "LOCALAPPDATA",
        "TEMP",
        "TMP",
        "OPENCLAW_STATE_DIR",
        "OPENCLAW_PROFILE",
        "PATH",
        "SYSTEMROOT",
        "WINDIR",
      ]),
    });
    expect(integration?.passEnv).not.toContain("OP_SERVICE_ACCOUNT_TOKEN");
    expect(integration?.passEnv).not.toContain("OP_CONNECT_HOST");
    expect(integration?.passEnv).not.toContain("OP_CONNECT_TOKEN");
    expect(integration?.passEnv).not.toContain("OP_ACCOUNT");
    expect(integration?.passEnv).not.toContain("OP_CACHE");
    expect(integration).not.toHaveProperty("trustedDirs");
    expect(integration?.timeoutMs).toBeGreaterThan(worstCaseBatchTimeoutMs);
    expect(integration?.noOutputTimeoutMs).toBeGreaterThan(worstCaseBatchTimeoutMs);
    expect(integration?.maxOutputBytes).toBeGreaterThan(
      maxRefsPerRequest * worstCaseEscapedValueBytes,
    );
    expect(resolverSource).toContain("#!/usr/bin/env node");
    expect(resolverSource).toContain('from "execa"');
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
  it.runIf(process.platform === "win32")(
    "preserves the Windows profile directories required by op",
    async () => {
      const tempDir = makeTempDir();
      const appData = path.join(tempDir, "profile", "AppData", "Roaming");
      const localAppData = path.join(tempDir, "profile", "AppData", "Local");
      const temp = path.join(localAppData, "Temp");
      const tmp = path.join(localAppData, "Tmp");
      for (const directory of [appData, localAppData, temp, tmp]) {
        fs.mkdirSync(directory, { recursive: true });
      }
      fs.writeFileSync(
        path.join(tempDir, "read"),
        `process.stdout.write(JSON.stringify({
  USERPROFILE: process.env.USERPROFILE,
  APPDATA: process.env.APPDATA,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  serviceAccount: process.env.OP_SERVICE_ACCOUNT_TOKEN === "not-a-real-service-account-token",
}));\n`,
      );

      const id = "op://Engineering/OpenRouter/apiKey";
      const result = await runResolver({
        request: { protocolVersion: 1, provider: "onepassword", ids: [id] },
        cwd: tempDir,
        env: {
          CLAW_1PASSWORD_OP: process.execPath,
          HOME: path.join(tempDir, "wrong-home"),
          USERPROFILE: path.join(tempDir, "profile"),
          APPDATA: appData,
          LOCALAPPDATA: localAppData,
          TEMP: temp,
          TMP: tmp,
        },
      });

      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(JSON.parse(result.stdout).values[id])).toEqual({
        USERPROFILE: path.join(tempDir, "profile"),
        APPDATA: appData,
        LOCALAPPDATA: localAppData,
        TEMP: temp,
        TMP: tmp,
        serviceAccount: true,
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "uses op read with native 1Password secret references",
    async () => {
      const tempDir = makeTempDir();
      const opPath = path.join(tempDir, "op");
      const logPath = path.join(tempDir, "op-args.json");
      fs.writeFileSync(
        opPath,
        `#!${createTrustedNodeFixture(tempDir)}
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
        args: ["read", "--cache=false", "--no-newline", "op://Engineering/OpenRouter/apiKey"],
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
        `#!${createTrustedNodeFixture(tempDir)}
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
        "--cache=false",
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
        `#!${createTrustedNodeFixture(tempDir)}
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
        `#!${createTrustedNodeFixture(tempDir)}
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
        "--cache=false",
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

    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: "1Password SecretRef resolver failed.\n",
    });
  });

  it("rejects oversized batches before reading credentials or starting op", async () => {
    const ids = Array.from(
      { length: 33 },
      (_, index) => `op://Engineering/Item${index}/credential`,
    );
    const result = await runResolver({
      request: { protocolVersion: 1, provider: "onepassword", ids },
      env: { CLAW_1PASSWORD_OP: "/does/not/exist/op" },
      token: null,
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    const response = JSON.parse(result.stdout) as {
      values: Record<string, string>;
      errors: Record<string, { message: string }>;
    };
    expect(response.values).toEqual({});
    expect(Object.keys(response.errors)).toEqual(ids);
    expect(new Set(Object.values(response.errors).map((error) => error.message))).toEqual(
      new Set(["1Password SecretRef resolver supports at most 32 references per request."]),
    );
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

    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: "1Password SecretRef resolver failed.\n",
    });
  });

  it("rejects an oversized broker service-account token file", async () => {
    const result = await runResolver({
      request: {
        protocolVersion: 1,
        provider: "onepassword",
        ids: ["op://Engineering/OpenRouter/apiKey"],
      },
      env: { CLAW_1PASSWORD_OP: process.execPath },
      token: "x".repeat(DEFAULT_SECRET_FILE_MAX_BYTES + 1),
    });

    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: "1Password SecretRef resolver failed.\n",
    });
  });

  it.runIf(process.platform !== "win32")("rejects a symlinked broker token file", async () => {
    const stateDir = makeTempDir();
    const tokenDir = path.join(stateDir, "credentials", "onepassword");
    const targetPath = path.join(tokenDir, "service-account-token-target");
    const tokenPath = path.join(tokenDir, "service-account-token");
    fs.mkdirSync(tokenDir, { recursive: true });
    fs.writeFileSync(targetPath, "linked-service-account-token", { mode: 0o600 });
    fs.symlinkSync(targetPath, tokenPath);

    const result = await runResolver({
      request: {
        protocolVersion: 1,
        provider: "onepassword",
        ids: ["op://Engineering/OpenRouter/apiKey"],
      },
      env: { CLAW_1PASSWORD_OP: process.execPath, OPENCLAW_STATE_DIR: stateDir },
      token: null,
    });

    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: "1Password SecretRef resolver failed.\n",
    });
  });

  it.runIf(process.platform !== "win32")(
    "accepts the broker token file through a hardlink",
    async () => {
      const stateDir = makeTempDir();
      const tokenDir = path.join(stateDir, "credentials", "onepassword");
      const targetPath = path.join(tokenDir, "service-account-token-target");
      const tokenPath = path.join(tokenDir, "service-account-token");
      const opPath = path.join(stateDir, "op");
      fs.mkdirSync(tokenDir, { recursive: true });
      fs.writeFileSync(targetPath, "linked-service-account-token", { mode: 0o600 });
      fs.linkSync(targetPath, tokenPath);
      fs.writeFileSync(
        opPath,
        `#!${createTrustedNodeFixture(stateDir)}\nprocess.stdout.write(process.env.OP_SERVICE_ACCOUNT_TOKEN === "linked-service-account-token" ? "ok" : "bad");\n`,
        { mode: 0o755 },
      );

      const result = await runResolver({
        request: {
          protocolVersion: 1,
          provider: "onepassword",
          ids: ["op://Engineering/OpenRouter/apiKey"],
        },
        env: { CLAW_1PASSWORD_OP: opPath, OPENCLAW_STATE_DIR: stateDir },
        token: null,
      });

      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(result.stdout).values).toEqual({
        "op://Engineering/OpenRouter/apiKey": "ok",
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "reads the service token from the selected profile state directory",
    async () => {
      const home = makeTempDir();
      const profileTokenDir = path.join(home, ".openclaw-work", "credentials", "onepassword");
      const defaultTokenDir = path.join(home, ".openclaw", "credentials", "onepassword");
      const opPath = path.join(home, "op");
      fs.mkdirSync(profileTokenDir, { recursive: true });
      fs.mkdirSync(defaultTokenDir, { recursive: true });
      fs.writeFileSync(path.join(profileTokenDir, "service-account-token"), "profile-token", {
        mode: 0o600,
      });
      fs.writeFileSync(path.join(defaultTokenDir, "service-account-token"), "default-token", {
        mode: 0o600,
      });
      fs.writeFileSync(
        opPath,
        `#!${createTrustedNodeFixture(home)}\nprocess.stdout.write(process.env.OP_SERVICE_ACCOUNT_TOKEN);\n`,
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
          HOME: home,
          OPENCLAW_HOME: "",
          OPENCLAW_PROFILE: "work",
          OPENCLAW_STATE_DIR: "",
        },
        token: null,
      });

      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(result.stdout).values).toEqual({
        "op://Engineering/OpenRouter/apiKey": "profile-token",
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not include failed child output in resolver errors",
    async () => {
      const tempDir = makeTempDir();
      const opPath = path.join(tempDir, "op");
      fs.writeFileSync(
        opPath,
        `#!${createTrustedNodeFixture(tempDir)}
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

  it.runIf(process.platform !== "win32")(
    "kills the op process tree when output exceeds the limit",
    async () => {
      const tempDir = makeTempDir();
      const opPath = path.join(tempDir, "op");
      const descendantMarker = path.join(tempDir, "descendant-survived");
      fs.writeFileSync(
        opPath,
        `#!${createTrustedNodeFixture(tempDir)}
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(`process.on("SIGTERM", () => {}); setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(descendantMarker)}, "survived"), 800); setInterval(() => {}, 1000);`)}], { stdio: "ignore" });
process.stdout.write("x".repeat(70 * 1024));
setInterval(() => {}, 1000);
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
      expect(JSON.parse(result.stdout).errors).toEqual({
        "op://Engineering/OpenRouter/apiKey": {
          message: "op read output exceeded the secret value limit.",
        },
      });
      await new Promise((resolve) => {
        setTimeout(resolve, 650);
      });
      expect(fs.existsSync(descendantMarker)).toBe(false);
    },
  );

  it(
    "kills the op process tree when a read times out",
    async () => {
      const tempDir = makeTempDir();
      const descendantReady = path.join(tempDir, "timed-out-descendant-ready");
      const descendantMarker = path.join(tempDir, "timed-out-descendant-survived");
      const opBody = `const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(`const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(descendantReady)}, "ready"); process.on("SIGTERM", () => {}); setTimeout(() => fs.writeFileSync(${JSON.stringify(descendantMarker)}, "survived"), 7500); setInterval(() => {}, 1000);`)}], { stdio: "ignore" });
setInterval(() => {}, 1000);
`;
      let opPath = process.execPath;
      if (process.platform === "win32") {
        fs.writeFileSync(path.join(tempDir, "read"), opBody);
      } else {
        // Do not assume the test runner's Node binary passes production path-trust policy.
        // A per-test executable keeps the scenario independent of package-manager ownership.
        opPath = path.join(tempDir, "op");
        fs.writeFileSync(opPath, `#!${createTrustedNodeFixture(tempDir)}\n${opBody}`, {
          mode: 0o755,
        });
      }

      const resultPromise = runResolver({
        request: {
          protocolVersion: 1,
          provider: "onepassword",
          ids: ["op://Engineering/OpenRouter/apiKey"],
        },
        cwd: tempDir,
        env: { CLAW_1PASSWORD_OP: opPath },
      });
      // Windows verifies the executable owner and ACL chain through OS tooling before op starts.
      // Keep the synchronization bound above that preflight without weakening the kill deadline.
      await Promise.race([
        waitForPath(descendantReady, process.platform === "win32" ? 15_000 : 5_000),
        resultPromise.then((result) => {
          throw new Error(
            `Resolver exited before the descendant was ready: ${JSON.stringify(result)}`,
          );
        }),
      ]);
      const descendantReadyAt = Date.now();
      const result = await resultPromise;
      expect(JSON.parse(result.stdout).errors).toEqual({
        "op://Engineering/OpenRouter/apiKey": {
          message: "op read timed out after 7000ms.",
        },
      });
      const remainingMarkerDelayMs = 8_000 - (Date.now() - descendantReadyAt);
      if (remainingMarkerDelayMs > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, remainingMarkerDelayMs);
        });
      }
      expect(fs.existsSync(descendantMarker)).toBe(false);
    },
    process.platform === "win32" ? 30_000 : 15_000,
  );

  it.runIf(process.platform !== "win32")("bounds concurrent op reads", async () => {
    const tempDir = makeTempDir();
    const opPath = path.join(tempDir, "op");
    const logPath = path.join(tempDir, "events.log");
    fs.writeFileSync(
      opPath,
      `#!${createTrustedNodeFixture(tempDir)}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, "start " + process.pid + "\\n");
setTimeout(() => {
  fs.appendFileSync(${JSON.stringify(logPath)}, "end " + process.pid + "\\n");
  process.stdout.write("not-a-real-value");
}, 80);
`,
      { mode: 0o755 },
    );
    const ids = Array.from({ length: 20 }, (_, index) => `op://Vault/Item${index}/field`);
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
    fs.writeFileSync(
      opPath,
      `#!${createTrustedNodeFixture(tempDir)}\nprocess.stdout.write('from-path');\n`,
      {
        mode: 0o755,
      },
    );
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
        `#!${createTrustedNodeFixture(tempDir)}\nrequire("node:fs").writeFileSync(${JSON.stringify(tokenLogPath)}, process.env.OP_SERVICE_ACCOUNT_TOKEN);\n`,
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

      expect(result).toEqual({
        code: 1,
        stdout: "",
        stderr: "1Password SecretRef resolver failed.\n",
      });
      expect(fs.existsSync(tokenLogPath)).toBe(false);
    },
  );

  it("fails the provider request when the op CLI is missing", async () => {
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

    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: "1Password SecretRef resolver failed.\n",
    });
  });
});
