import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";
import {
  bindCodexAppServerRuntimeArtifact,
  captureCodexAppServerRuntimeArtifactBeforeStart,
  finalizeCodexAppServerRuntimeArtifact,
  readCodexAppServerClientRuntimeArtifact,
  validateCodexAppServerRuntimeArtifact,
} from "./runtime-artifact.js";

function startOptions(
  command: string,
  overrides: Partial<CodexAppServerStartOptions> = {},
): CodexAppServerStartOptions {
  return {
    transport: "stdio",
    command,
    commandSource: "config",
    args: ["app-server"],
    headers: {},
    ...overrides,
  };
}

function spawnIdentity(options: CodexAppServerStartOptions, nativeCommand?: string) {
  return {
    command: options.command,
    argsFingerprint: createHash("sha256").update(JSON.stringify(options.args)).digest("hex"),
    ...(options.commandSource ? { commandSource: options.commandSource } : {}),
    ...(options.managedCommandOrder ? { managedCommandOrder: options.managedCommandOrder } : {}),
    ...(nativeCommand ? { nativeCommand } : {}),
  };
}

async function captureBinding(params: {
  options: CodexAppServerStartOptions;
  nativeCommand?: string;
}) {
  const client = {} as CodexAppServerClient;
  const identity = spawnIdentity(params.options, params.nativeCommand);
  const before = await captureCodexAppServerRuntimeArtifactBeforeStart({
    startOptions: params.options,
    spawnIdentity: identity,
  });
  const binding = await finalizeCodexAppServerRuntimeArtifact({
    before,
    startOptions: params.options,
    spawnIdentity: identity,
    runtimeIdentity: { serverVersion: "0.144.1", userAgent: "codex-test" },
  });
  bindCodexAppServerRuntimeArtifact(client, binding);
  return { binding, client };
}

describe("Codex app-server runtime artifact", () => {
  it("binds a native executable and its adjacent code-mode host", async () => {
    await withTempDir("openclaw-codex-runtime-artifact-", async (root) => {
      const command = path.join(root, "codex");
      const codeModeHost = path.join(root, "codex-code-mode-host");
      await fs.writeFile(command, "native-v1");
      await fs.writeFile(codeModeHost, "host-v1");

      const { binding, client } = await captureBinding({ options: startOptions(command) });

      expect(readCodexAppServerClientRuntimeArtifact(client)).toEqual(binding);
      await expect(validateCodexAppServerRuntimeArtifact(binding)).resolves.toBe(true);
      await fs.writeFile(codeModeHost, "host-v2");
      await expect(validateCodexAppServerRuntimeArtifact(binding)).resolves.toBe(false);
    });
  });

  it.runIf(process.platform !== "win32")(
    "resolves relative launch paths and shebang targets from the spawn cwd",
    async () => {
      await withTempDir("openclaw-codex-runtime-cwd-", async (root) => {
        const spawnCwd = path.join(root, "workspace");
        const binDir = path.join(spawnCwd, "bin");
        const interpreterDir = path.join(spawnCwd, "interpreters");
        const nativeDir = path.join(spawnCwd, "native");
        await Promise.all([
          fs.mkdir(binDir, { recursive: true }),
          fs.mkdir(interpreterDir, { recursive: true }),
          fs.mkdir(nativeDir, { recursive: true }),
        ]);
        const command = path.join(binDir, "codex");
        const interpreter = path.join(interpreterDir, "fixture-node");
        const nativeCommand = path.join(nativeDir, "codex-native");
        await Promise.all([
          fs.writeFile(command, "#!/usr/bin/env fixture-node\n"),
          fs.writeFile(interpreter, "interpreter-v1"),
          fs.writeFile(nativeCommand, "native-v1"),
        ]);
        await Promise.all([
          fs.chmod(command, 0o755),
          fs.chmod(interpreter, 0o755),
          fs.chmod(nativeCommand, 0o755),
        ]);
        const options = startOptions("codex", {
          cwd: spawnCwd,
          env: { PATH: ["bin", "interpreters"].join(path.delimiter) },
        });

        const { binding } = await captureBinding({
          options,
          nativeCommand: path.join("native", "codex-native"),
        });
        await expect(validateCodexAppServerRuntimeArtifact(binding)).resolves.toBe(true);

        await fs.writeFile(interpreter, "interpreter-v2");
        await expect(validateCodexAppServerRuntimeArtifact(binding)).resolves.toBe(false);
      });
    },
  );

  it("attests that an adjacent code-mode host is absent", async () => {
    await withTempDir("openclaw-codex-runtime-no-host-", async (root) => {
      const command = path.join(root, "codex");
      const codeModeHost = path.join(root, "codex-code-mode-host");
      await fs.writeFile(command, "native-v1");

      const { binding } = await captureBinding({ options: startOptions(command) });
      await expect(validateCodexAppServerRuntimeArtifact(binding)).resolves.toBe(true);
      await fs.writeFile(codeModeHost, "host-v1");
      await expect(validateCodexAppServerRuntimeArtifact(binding)).resolves.toBe(false);
    });
  });

  it("binds the complete canonical package tree", async () => {
    await withTempDir("openclaw-codex-package-artifact-", async (root) => {
      const binDir = path.join(root, "bin");
      const resourcesDir = path.join(root, "codex-resources");
      const pathDir = path.join(root, "codex-path");
      await Promise.all([
        fs.mkdir(binDir, { recursive: true }),
        fs.mkdir(resourcesDir, { recursive: true }),
        fs.mkdir(pathDir, { recursive: true }),
      ]);
      const command = path.join(binDir, "codex");
      await fs.writeFile(command, "native-v1");
      await fs.writeFile(path.join(binDir, "codex-code-mode-host"), "host-v1");
      await fs.writeFile(path.join(resourcesDir, "bwrap"), "resource-v1");
      await fs.writeFile(path.join(pathDir, "rg"), "rg-v1");
      await fs.writeFile(path.join(root, "codex-package.json"), '{"layoutVersion":1}\n');

      const { binding } = await captureBinding({ options: startOptions(command) });
      await expect(validateCodexAppServerRuntimeArtifact(binding)).resolves.toBe(true);

      await fs.writeFile(path.join(resourcesDir, "bwrap"), "resource-v2");
      await expect(validateCodexAppServerRuntimeArtifact(binding)).resolves.toBe(false);
    });
  });

  it("produces the same package binding regardless of directory enumeration order", async () => {
    await withTempDir("openclaw-codex-package-order-", async (root) => {
      const binDir = path.join(root, "bin");
      await fs.mkdir(binDir, { recursive: true });
      const command = path.join(binDir, "codex");
      await fs.writeFile(command, "native-v1");
      await fs.writeFile(path.join(root, "codex-package.json"), "{}\n");
      await fs.writeFile(path.join(root, "z-resource"), "z");
      await fs.writeFile(path.join(root, "a-resource"), "a");
      const options = startOptions(command);
      const first = await captureBinding({ options });

      await fs.rm(path.join(root, "z-resource"));
      await fs.rm(path.join(root, "a-resource"));
      await fs.writeFile(path.join(root, "a-resource"), "a");
      await fs.writeFile(path.join(root, "z-resource"), "z");
      const second = await captureBinding({ options });

      expect(second.binding).toEqual(first.binding);
    });
  });

  it("binds an explicit code-mode host override", async () => {
    await withTempDir("openclaw-codex-host-override-", async (root) => {
      const command = path.join(root, "codex");
      const codeModeHost = path.join(root, "custom-code-mode-host");
      await fs.writeFile(command, "native-v1");
      await fs.writeFile(codeModeHost, "host-v1");
      const options = startOptions(command, {
        env: { CODEX_CODE_MODE_HOST_PATH: codeModeHost },
      });

      const { binding } = await captureBinding({ options });
      await fs.writeFile(codeModeHost, "host-v2");
      await expect(validateCodexAppServerRuntimeArtifact(binding)).resolves.toBe(false);
    });
  });

  it("detects candidate bytes changing between spawn snapshots", async () => {
    await withTempDir("openclaw-codex-runtime-race-", async (root) => {
      const command = path.join(root, "codex");
      await fs.writeFile(command, "native-v1");
      const options = startOptions(command);
      const identity = spawnIdentity(options);
      const before = await captureCodexAppServerRuntimeArtifactBeforeStart({
        startOptions: options,
        spawnIdentity: identity,
      });
      await fs.writeFile(command, "native-v2");

      await expect(
        finalizeCodexAppServerRuntimeArtifact({
          before,
          startOptions: options,
          spawnIdentity: identity,
          runtimeIdentity: { serverVersion: "0.144.1" },
        }),
      ).rejects.toThrow("changed during startup");
    });
  });

  it("keeps raw argv out of the server-minted artifact id", async () => {
    await withTempDir("openclaw-codex-runtime-secret-", async (root) => {
      const command = path.join(root, "codex");
      await fs.writeFile(command, "native-v1");
      const secret = "provider.api_key=super-secret-value";
      const options = startOptions(command, { args: ["-c", secret, "app-server"] });

      const { binding } = await captureBinding({ options });
      expect(binding.id).not.toContain(secret);
      expect(JSON.stringify(binding)).not.toContain("super-secret-value");
    });
  });

  it("fails closed for remote WebSocket runtimes", async () => {
    const options = startOptions("codex", {
      transport: "websocket",
      url: "ws://127.0.0.1:1234",
    });
    await expect(
      captureCodexAppServerRuntimeArtifactBeforeStart({
        startOptions: options,
        spawnIdentity: spawnIdentity(options),
      }),
    ).rejects.toThrow("WebSocket attestation is unsupported");
  });

  it("fails closed when spawn environment can inject runtime code", async () => {
    const options = startOptions("codex", { env: { NODE_OPTIONS: "--require=/tmp/inject.js" } });
    await expect(
      captureCodexAppServerRuntimeArtifactBeforeStart({
        startOptions: options,
        spawnIdentity: spawnIdentity(options),
      }),
    ).rejects.toThrow("injected runtime environment: NODE_OPTIONS");
  });

  it("allows bounded Node resource and warning options", async () => {
    await withTempDir("openclaw-codex-runtime-node-options-", async (root) => {
      const command = path.join(root, "codex");
      await fs.writeFile(command, "native-v1");
      const options = startOptions(command, {
        env: {
          NODE_OPTIONS:
            "--max-old-space-size=4096 --no-warnings --disable-warning=ExperimentalWarning",
        },
      });

      await expect(captureBinding({ options })).resolves.toMatchObject({
        binding: { id: expect.stringMatching(/^codex-app-server:v1:/u) },
      });
    });
  });

  it("binds the Windows npm shim, Node entrypoint, native binary, and mixed-case host override", async () => {
    await withTempDir("openclaw-codex-runtime-windows-", async (root) => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
      const originalExecPath = Object.getOwnPropertyDescriptor(process, "execPath");
      if (!originalPlatform || !originalExecPath) {
        throw new Error("expected configurable process runtime descriptors");
      }
      const nodePath = path.join(root, "node.exe");
      const shimPath = path.join(root, "codex.cmd");
      const entryPath = path.join(root, "node_modules", "@openai", "codex", "bin", "codex.js");
      const packageRoot = path.join(root, "vendor", "x86_64-pc-windows-msvc");
      const binDir = path.join(packageRoot, "bin");
      const nativePath = path.join(binDir, "codex.exe");
      const hostPath = path.join(root, "custom-host.exe");
      await Promise.all([
        fs.mkdir(path.dirname(entryPath), { recursive: true }),
        fs.mkdir(binDir, { recursive: true }),
      ]);
      await Promise.all([
        fs.writeFile(nodePath, "node-v1"),
        fs.writeFile(entryPath, "entry-v1"),
        fs.writeFile(nativePath, "native-v1"),
        fs.writeFile(hostPath, "host-v1"),
        fs.writeFile(path.join(packageRoot, "codex-package.json"), "{}\n"),
        fs.writeFile(
          shimPath,
          '@ECHO off\r\n"%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
        ),
      ]);
      try {
        Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
        Object.defineProperty(process, "execPath", { ...originalExecPath, value: nodePath });
        const options = startOptions("codex", {
          env: {
            PATH: root,
            PATHEXT: ".CMD;.EXE;.BAT",
            Codex_Code_Mode_Host_Path: hostPath,
          },
        });
        const { binding } = await captureBinding({ options, nativeCommand: nativePath });

        for (const [filePath, replacement] of [
          [nodePath, "node-v2"],
          [entryPath, "entry-v2"],
          [nativePath, "native-v2"],
          [hostPath, "host-v2"],
        ] as const) {
          const original = await fs.readFile(filePath);
          await fs.writeFile(filePath, replacement);
          await expect(validateCodexAppServerRuntimeArtifact(binding)).resolves.toBe(false);
          await fs.writeFile(filePath, original);
          await expect(validateCodexAppServerRuntimeArtifact(binding)).resolves.toBe(true);
        }
      } finally {
        Object.defineProperty(process, "platform", originalPlatform);
        Object.defineProperty(process, "execPath", originalExecPath);
      }
    });
  });

  it("rejects malformed and oversized server-minted ids without filesystem access", async () => {
    const fingerprint = "0".repeat(64);
    await expect(
      validateCodexAppServerRuntimeArtifact({ id: "codex-app-server:v1:wrong", fingerprint }),
    ).resolves.toBe(false);
    await expect(
      validateCodexAppServerRuntimeArtifact({
        id: `codex-app-server:v1:${"a".repeat(32 * 1024)}`,
        fingerprint,
      }),
    ).resolves.toBe(false);
  });

  it("rejects packages beyond the bounded directory depth", async () => {
    await withTempDir("openclaw-codex-package-depth-", async (root) => {
      const binDir = path.join(root, "bin");
      await fs.mkdir(binDir, { recursive: true });
      const command = path.join(binDir, "codex");
      await fs.writeFile(command, "native-v1");
      await fs.writeFile(path.join(root, "codex-package.json"), "{}\n");
      const deep = path.join(root, ...Array.from({ length: 66 }, (_, index) => `d${index}`));
      await fs.mkdir(deep, { recursive: true });
      await fs.writeFile(path.join(deep, "resource"), "x");
      const options = startOptions(command);

      await expect(
        captureCodexAppServerRuntimeArtifactBeforeStart({
          startOptions: options,
          spawnIdentity: spawnIdentity(options),
        }),
      ).rejects.toThrow("bounded directory depth");
    });
  });

  it("honors an already-aborted bounded capture", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop hashing"));
    const options = startOptions("codex");
    await expect(
      captureCodexAppServerRuntimeArtifactBeforeStart({
        startOptions: options,
        spawnIdentity: spawnIdentity(options),
        signal: controller.signal,
      }),
    ).rejects.toThrow("stop hashing");
  });

  it.runIf(process.platform !== "win32")("rejects symlinks inside a package artifact", async () => {
    await withTempDir("openclaw-codex-package-link-", async (root) => {
      const binDir = path.join(root, "bin");
      await fs.mkdir(binDir, { recursive: true });
      const command = path.join(binDir, "codex");
      await fs.writeFile(command, "native-v1");
      await fs.writeFile(path.join(root, "codex-package.json"), "{}\n");
      await fs.symlink(command, path.join(root, "linked-runtime"));
      const options = startOptions(command);

      await expect(
        captureCodexAppServerRuntimeArtifactBeforeStart({
          startOptions: options,
          spawnIdentity: spawnIdentity(options),
        }),
      ).rejects.toThrow("unsupported entry");
    });
  });
});
