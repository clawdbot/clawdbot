import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveGatewayStateDir } from "./paths.js";
import {
  buildMinimalServicePath,
  buildNodeServiceEnvironment,
  buildServiceEnvironment,
  getMinimalServicePathParts,
  getMinimalServicePathPartsFromEnv,
  isNodeVersionManagerRuntime,
  resolveLinuxSystemCaBundle,
} from "./service-env.js";

describe("getMinimalServicePathParts - Linux user directories", () => {
  it("includes user bin directories when HOME is set on Linux", () => {
    const result = getMinimalServicePathParts({
      platform: "linux",
      home: "/home/testuser",
    });

    // Should include all common user bin directories
    expect(result).toContain("/home/testuser/.local/bin");
    expect(result).toContain("/home/testuser/.npm-global/bin");
    expect(result).toContain("/home/testuser/bin");
    expect(result).toContain("/home/testuser/.nvm/current/bin");
    expect(result).toContain("/home/testuser/.local/share/fnm/aliases/default/bin");
    expect(result).toContain("/home/testuser/.local/share/fnm/current/bin");
    expect(result).toContain("/home/testuser/.fnm/aliases/default/bin");
    expect(result).toContain("/home/testuser/.fnm/current/bin");
    expect(result).toContain("/home/testuser/.volta/bin");
    expect(result).toContain("/home/testuser/.asdf/shims");
    expect(result).toContain("/home/testuser/.local/share/pnpm");
    expect(result).toContain("/home/testuser/.bun/bin");
  });

  it("excludes user bin directories when HOME is undefined on Linux", () => {
    const result = getMinimalServicePathParts({
      platform: "linux",
      home: undefined,
    });

    // Should only include system directories
    expect(result).toEqual(["/usr/local/bin", "/usr/bin", "/bin"]);

    // Should not include any user-specific paths
    expect(result.some((p) => p.includes(".local"))).toBe(false);
    expect(result.some((p) => p.includes(".npm-global"))).toBe(false);
    expect(result.some((p) => p.includes(".nvm"))).toBe(false);
  });

  it("places user directories before system directories on Linux", () => {
    const result = getMinimalServicePathParts({
      platform: "linux",
      home: "/home/testuser",
    });

    const userDirIndex = result.indexOf("/home/testuser/.local/bin");
    const systemDirIndex = result.indexOf("/usr/bin");

    expect(userDirIndex).toBeGreaterThan(-1);
    expect(systemDirIndex).toBeGreaterThan(-1);
    expect(userDirIndex).toBeLessThan(systemDirIndex);
  });

  it("places extraDirs before user directories on Linux", () => {
    const result = getMinimalServicePathParts({
      platform: "linux",
      home: "/home/testuser",
      extraDirs: ["/custom/bin"],
    });

    const extraDirIndex = result.indexOf("/custom/bin");
    const userDirIndex = result.indexOf("/home/testuser/.local/bin");

    expect(extraDirIndex).toBeGreaterThan(-1);
    expect(userDirIndex).toBeGreaterThan(-1);
    expect(extraDirIndex).toBeLessThan(userDirIndex);
  });

  it("includes env-configured bin roots when HOME is set on Linux", () => {
    const result = getMinimalServicePathPartsFromEnv({
      platform: "linux",
      env: {
        HOME: "/home/testuser",
        PNPM_HOME: "/opt/pnpm",
        NPM_CONFIG_PREFIX: "/opt/npm",
        BUN_INSTALL: "/opt/bun",
        VOLTA_HOME: "/opt/volta",
        ASDF_DATA_DIR: "/opt/asdf",
        NVM_DIR: "/opt/nvm",
        FNM_DIR: "/opt/fnm",
      },
    });

    expect(result).toContain("/opt/pnpm");
    expect(result).toContain("/opt/npm/bin");
    expect(result).toContain("/opt/bun/bin");
    expect(result).toContain("/opt/volta/bin");
    expect(result).toContain("/opt/asdf/shims");
    expect(result).toContain("/opt/nvm/current/bin");
    expect(result).toContain("/opt/fnm/aliases/default/bin");
    expect(result).toContain("/opt/fnm/current/bin");
  });

  it("includes version manager directories on macOS when HOME is set", () => {
    const result = getMinimalServicePathParts({
      platform: "darwin",
      home: "/Users/testuser",
    });

    // Should include common user bin directories
    expect(result).toContain("/Users/testuser/.local/bin");
    expect(result).toContain("/Users/testuser/.npm-global/bin");
    expect(result).toContain("/Users/testuser/bin");

    // Should include version manager paths (macOS specific)
    // Note: nvm has no stable default path, relies on user's shell config
    expect(result).toContain("/Users/testuser/Library/Application Support/fnm/aliases/default/bin"); // fnm default on macOS
    expect(result).toContain("/Users/testuser/.fnm/aliases/default/bin"); // fnm if customized to ~/.fnm
    expect(result).toContain("/Users/testuser/.volta/bin");
    expect(result).toContain("/Users/testuser/.asdf/shims");
    expect(result).toContain("/Users/testuser/Library/pnpm"); // pnpm default on macOS
    expect(result).toContain("/Users/testuser/.local/share/pnpm"); // pnpm XDG fallback
    expect(result).toContain("/Users/testuser/.bun/bin");

    // Should also include macOS system directories
    expect(result).toContain("/opt/homebrew/bin");
    expect(result).toContain("/usr/local/bin");
  });

  it("includes env-configured version manager dirs on macOS", () => {
    const result = getMinimalServicePathPartsFromEnv({
      platform: "darwin",
      env: {
        HOME: "/Users/testuser",
        FNM_DIR: "/Users/testuser/Library/Application Support/fnm",
        NVM_DIR: "/Users/testuser/.nvm",
        PNPM_HOME: "/Users/testuser/Library/pnpm",
      },
    });

    // fnm uses aliases/default/bin (not current)
    expect(result).toContain("/Users/testuser/Library/Application Support/fnm/aliases/default/bin");
    // nvm: relies on NVM_DIR env var (no stable default path)
    expect(result).toContain("/Users/testuser/.nvm");
    // pnpm: binary is directly in PNPM_HOME
    expect(result).toContain("/Users/testuser/Library/pnpm");
  });

  it("places version manager dirs before system dirs on macOS", () => {
    const result = getMinimalServicePathParts({
      platform: "darwin",
      home: "/Users/testuser",
    });

    // fnm on macOS defaults to ~/Library/Application Support/fnm
    const fnmIndex = result.indexOf(
      "/Users/testuser/Library/Application Support/fnm/aliases/default/bin",
    );
    const homebrewIndex = result.indexOf("/opt/homebrew/bin");

    expect(fnmIndex).toBeGreaterThan(-1);
    expect(homebrewIndex).toBeGreaterThan(-1);
    expect(fnmIndex).toBeLessThan(homebrewIndex);
  });

  it("does not include Linux user directories on Windows", () => {
    const result = getMinimalServicePathParts({
      platform: "win32",
      home: "C:\\Users\\testuser",
    });

    // Windows returns empty array (uses existing PATH)
    expect(result).toEqual([]);
  });
});

describe("getMinimalServicePathParts - Nix Home Manager", () => {
  it("falls back to default Nix profile when NIX_PROFILES is absent on Linux", () => {
    const result = getMinimalServicePathParts({
      platform: "linux",
      home: "/home/testuser",
    });

    expect(result).toContain("/home/testuser/.nix-profile/bin");
  });

  it("falls back to default Nix profile when NIX_PROFILES is absent on macOS", () => {
    const result = getMinimalServicePathParts({
      platform: "darwin",
      home: "/Users/testuser",
    });

    expect(result).toContain("/Users/testuser/.nix-profile/bin");
  });

  it("places rightmost NIX_PROFILES entry before leftmost on Linux", () => {
    const result = getMinimalServicePathPartsFromEnv({
      platform: "linux",
      env: {
        HOME: "/home/testuser",
        NIX_PROFILES: "/nix/var/nix/profiles/default /home/testuser/.nix-profile",
      },
    });

    const userIdx = result.indexOf("/home/testuser/.nix-profile/bin");
    const defaultIdx = result.indexOf("/nix/var/nix/profiles/default/bin");
    expect(userIdx).toBeGreaterThan(-1);
    expect(defaultIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeLessThan(defaultIdx);
  });

  it("places rightmost NIX_PROFILES entry before leftmost on macOS", () => {
    const result = getMinimalServicePathPartsFromEnv({
      platform: "darwin",
      env: {
        HOME: "/Users/testuser",
        NIX_PROFILES: "/nix/var/nix/profiles/default /Users/testuser/.nix-profile",
      },
    });

    const userIdx = result.indexOf("/Users/testuser/.nix-profile/bin");
    const defaultIdx = result.indexOf("/nix/var/nix/profiles/default/bin");
    expect(userIdx).toBeGreaterThan(-1);
    expect(defaultIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeLessThan(defaultIdx);
  });

  it("includes single Nix profile from NIX_PROFILES on Linux", () => {
    const result = getMinimalServicePathPartsFromEnv({
      platform: "linux",
      env: {
        HOME: "/home/testuser",
        NIX_PROFILES: "/nix/var/nix/profiles/per-user/testuser/profile",
      },
    });

    expect(result).toContain("/nix/var/nix/profiles/per-user/testuser/profile/bin");
  });

  it("includes single Nix profile from NIX_PROFILES on macOS", () => {
    const result = getMinimalServicePathPartsFromEnv({
      platform: "darwin",
      env: {
        HOME: "/Users/testuser",
        NIX_PROFILES: "/nix/var/nix/profiles/per-user/testuser/profile",
      },
    });

    expect(result).toContain("/nix/var/nix/profiles/per-user/testuser/profile/bin");
  });

  it("preserves Nix precedence across three profiles", () => {
    const result = getMinimalServicePathPartsFromEnv({
      platform: "linux",
      env: {
        HOME: "/home/testuser",
        NIX_PROFILES:
          "/nix/var/nix/profiles/default /nix/var/nix/profiles/per-user/testuser/custom /home/testuser/.nix-profile",
      },
    });

    const userIdx = result.indexOf("/home/testuser/.nix-profile/bin");
    const customIdx = result.indexOf("/nix/var/nix/profiles/per-user/testuser/custom/bin");
    const defaultIdx = result.indexOf("/nix/var/nix/profiles/default/bin");
    expect(userIdx).toBeGreaterThan(-1);
    expect(customIdx).toBeGreaterThan(-1);
    expect(defaultIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeLessThan(customIdx);
    expect(customIdx).toBeLessThan(defaultIdx);
  });
});

describe("buildMinimalServicePath", () => {
  const splitPath = (value: string, platform: NodeJS.Platform) =>
    value.split(platform === "win32" ? path.win32.delimiter : path.posix.delimiter);

  it("includes Homebrew + system dirs on macOS", () => {
    const result = buildMinimalServicePath({
      platform: "darwin",
    });
    const parts = splitPath(result, "darwin");
    expect(parts).toContain("/opt/homebrew/bin");
    expect(parts).toContain("/usr/local/bin");
    expect(parts).toContain("/usr/bin");
    expect(parts).toContain("/bin");
  });

  it("returns PATH as-is on Windows", () => {
    const result = buildMinimalServicePath({
      env: { PATH: "C:\\\\Windows\\\\System32" },
      platform: "win32",
    });
    expect(result).toBe("C:\\\\Windows\\\\System32");
  });

  it("includes Linux user directories when HOME is set in env", () => {
    const result = buildMinimalServicePath({
      platform: "linux",
      env: { HOME: "/home/alice" },
    });
    const parts = splitPath(result, "linux");

    // Verify user directories are included
    expect(parts).toContain("/home/alice/.local/bin");
    expect(parts).toContain("/home/alice/.npm-global/bin");
    expect(parts).toContain("/home/alice/.nvm/current/bin");
    expect(parts).toContain("/home/alice/.local/share/fnm/aliases/default/bin");

    // Verify system directories are also included
    expect(parts).toContain("/usr/local/bin");
    expect(parts).toContain("/usr/bin");
    expect(parts).toContain("/bin");
  });

  it("excludes Linux user directories when HOME is not in env", () => {
    const result = buildMinimalServicePath({
      platform: "linux",
      env: {},
    });
    const parts = splitPath(result, "linux");

    // Should only have system directories
    expect(parts).toEqual(["/usr/local/bin", "/usr/bin", "/bin"]);

    // No user-specific paths
    expect(parts.some((p) => p.includes("home"))).toBe(false);
  });

  it("ensures user directories come before system directories on Linux", () => {
    const result = buildMinimalServicePath({
      platform: "linux",
      env: { HOME: "/home/bob" },
    });
    const parts = splitPath(result, "linux");

    const firstUserDirIdx = parts.indexOf("/home/bob/.local/bin");
    const firstSystemDirIdx = parts.indexOf("/usr/local/bin");

    expect(firstUserDirIdx).toBeLessThan(firstSystemDirIdx);
  });

  it("includes extra directories when provided", () => {
    const result = buildMinimalServicePath({
      platform: "linux",
      extraDirs: ["/custom/tools"],
      env: {},
    });
    expect(splitPath(result, "linux")).toContain("/custom/tools");
  });

  it("deduplicates directories", () => {
    const result = buildMinimalServicePath({
      platform: "linux",
      extraDirs: ["/usr/bin"],
      env: {},
    });
    const parts = splitPath(result, "linux");
    const unique = [...new Set(parts)];
    expect(parts.length).toBe(unique.length);
  });

  it("prepends explicit runtime bin directories before guessed user paths", () => {
    const result = buildMinimalServicePath({
      platform: "linux",
      extraDirs: ["/home/alice/.nvm/versions/node/v22.22.0/bin"],
      env: { HOME: "/home/alice" },
    });
    const parts = splitPath(result, "linux");

    expect(parts[0]).toBe("/home/alice/.nvm/versions/node/v22.22.0/bin");
    expect(parts).toContain("/home/alice/.nvm/current/bin");
  });
});

describe("buildServiceEnvironment", () => {
  it("sets minimal PATH and gateway vars", () => {
    const env = buildServiceEnvironment({
      env: { HOME: "/home/user" },
      port: 18789,
    });
    expect(env.HOME).toBe("/home/user");
    if (process.platform === "win32") {
      expect(env).not.toHaveProperty("PATH");
    } else {
      expect(env.PATH).toContain("/usr/bin");
    }
    expect(env.OPENCLAW_GATEWAY_PORT).toBe("18789");
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
    expect(env.OPENCLAW_SERVICE_MARKER).toBe("openclaw");
    expect(env.OPENCLAW_SERVICE_KIND).toBe("gateway");
    expect(typeof env.OPENCLAW_SERVICE_VERSION).toBe("string");
    expect(env.OPENCLAW_SYSTEMD_UNIT).toBe("openclaw-gateway.service");
    expect(env.OPENCLAW_WINDOWS_TASK_NAME).toBe("OpenClaw Gateway");
    if (process.platform === "darwin") {
      expect(env.OPENCLAW_LAUNCHD_LABEL).toBe("ai.openclaw.gateway");
    }
  });

  it("passes through OPENCLAW_WRAPPER for gateway services", () => {
    const env = buildServiceEnvironment({
      env: {
        HOME: "/home/user",
        OPENCLAW_WRAPPER: " /usr/local/bin/openclaw-doppler ",
      },
      port: 18789,
    });

    expect(env.OPENCLAW_WRAPPER).toBe("/usr/local/bin/openclaw-doppler");
  });

  it("forwards TMPDIR from the host environment on Linux", () => {
    const env = buildServiceEnvironment({
      env: { HOME: "/home/user", TMPDIR: "/var/folders/xw/abc123/T/" },
      port: 18789,
      platform: "linux",
    });
    expect(env.TMPDIR).toBe("/var/folders/xw/abc123/T/");
  });

  it("uses a durable state temp directory for macOS LaunchAgents", () => {
    const env = buildServiceEnvironment({
      env: { HOME: "/Users/user", TMPDIR: "/var/folders/xw/abc123/T/" },
      port: 18789,
      platform: "darwin",
    });
    expect(env.TMPDIR).toBe(path.join("/Users/user", ".openclaw", "tmp"));
  });

  it("falls back to os.tmpdir when TMPDIR is not set on Linux", () => {
    const env = buildServiceEnvironment({
      env: { HOME: "/home/user" },
      port: 18789,
      platform: "linux",
    });
    expect(env.TMPDIR).toBe(os.tmpdir());
  });

  it("uses profile-specific unit and label", () => {
    const env = buildServiceEnvironment({
      env: { HOME: "/home/user", OPENCLAW_PROFILE: "work" },
      port: 18789,
    });
    expect(env.OPENCLAW_SYSTEMD_UNIT).toBe("openclaw-gateway-work.service");
    expect(env.OPENCLAW_WINDOWS_TASK_NAME).toBe("OpenClaw Gateway (work)");
    if (process.platform === "darwin") {
      expect(env.OPENCLAW_LAUNCHD_LABEL).toBe("ai.openclaw.work");
    }
  });

  it("forwards proxy environment variables for launchd/systemd runtime", () => {
    const env = buildServiceEnvironment({
      env: {
        HOME: "/home/user",
        HTTP_PROXY: " http://proxy.local:7890 ",
        HTTPS_PROXY: "https://proxy.local:7890",
        NO_PROXY: "localhost,127.0.0.1",
        http_proxy: "http://proxy.local:7890",
        all_proxy: "socks5://proxy.local:1080",
      },
      port: 18789,
    });

    expect(env.HTTP_PROXY).toBe("http://proxy.local:7890");
    expect(env.HTTPS_PROXY).toBe("https://proxy.local:7890");
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1");
    expect(env.http_proxy).toBe("http://proxy.local:7890");
    expect(env.all_proxy).toBe("socks5://proxy.local:1080");
  });

  it("omits PATH on Windows so Scheduled Tasks can inherit the current shell path", () => {
    const env = buildServiceEnvironment({
      env: {
        HOME: "C:\\Users\\alice",
        PATH: "C:\\Windows\\System32;C:\\Tools\\rg",
      },
      port: 18789,
      platform: "win32",
    });

    expect(env).not.toHaveProperty("PATH");
    expect(env.OPENCLAW_WINDOWS_TASK_NAME).toBe("OpenClaw Gateway");
  });

  it("prepends extra runtime directories to the gateway service PATH", () => {
    const env = buildServiceEnvironment({
      env: { HOME: "/home/user" },
      port: 18789,
      platform: "linux",
      extraPathDirs: ["/home/user/.nvm/versions/node/v22.22.0/bin"],
    });

    expect(env.PATH?.split(path.posix.delimiter)[0]).toBe(
      "/home/user/.nvm/versions/node/v22.22.0/bin",
    );
  });
});

describe("buildNodeServiceEnvironment", () => {
  it("passes through HOME for node services", () => {
    const env = buildNodeServiceEnvironment({
      env: { HOME: "/home/user" },
    });
    expect(env.HOME).toBe("/home/user");
  });

  it("passes through OPENCLAW_GATEWAY_TOKEN for node services", () => {
    const env = buildNodeServiceEnvironment({
      env: { HOME: "/home/user", OPENCLAW_GATEWAY_TOKEN: " node-token " },
    });
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBe("node-token");
  });

  it("passes through OPENCLAW_ALLOW_INSECURE_PRIVATE_WS for node services", () => {
    const env = buildNodeServiceEnvironment({
      env: { HOME: "/home/user", OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: " 1 " },
    });
    expect(env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS).toBe("1");
  });

  it("omits OPENCLAW_GATEWAY_TOKEN when the env var is empty", () => {
    const env = buildNodeServiceEnvironment({
      env: {
        HOME: "/home/user",
        OPENCLAW_GATEWAY_TOKEN: "   ",
      },
    });
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
  });

  it("forwards proxy environment variables for node services", () => {
    const env = buildNodeServiceEnvironment({
      env: {
        HOME: "/home/user",
        HTTPS_PROXY: " https://proxy.local:7890 ",
        no_proxy: "localhost,127.0.0.1",
      },
    });

    expect(env.HTTPS_PROXY).toBe("https://proxy.local:7890");
    expect(env.no_proxy).toBe("localhost,127.0.0.1");
  });

  it("forwards TMPDIR for node services on Linux", () => {
    const env = buildNodeServiceEnvironment({
      env: { HOME: "/home/user", TMPDIR: "/tmp/custom" },
      platform: "linux",
    });
    expect(env.TMPDIR).toBe("/tmp/custom");
  });

  it("uses a durable state temp directory for macOS node services", () => {
    const env = buildNodeServiceEnvironment({
      env: { HOME: "/Users/user", TMPDIR: "/var/folders/xw/abc123/T/" },
      platform: "darwin",
    });
    expect(env.TMPDIR).toBe(path.join("/Users/user", ".openclaw", "tmp"));
  });

  it("falls back to os.tmpdir for node services when TMPDIR is not set on Linux", () => {
    const env = buildNodeServiceEnvironment({
      env: { HOME: "/home/user" },
      platform: "linux",
    });
    expect(env.TMPDIR).toBe(os.tmpdir());
  });

  it("prepends extra runtime directories to the node service PATH", () => {
    const env = buildNodeServiceEnvironment({
      env: { HOME: "/home/user" },
      platform: "linux",
      extraPathDirs: ["/home/user/.nvm/versions/node/v22.22.0/bin"],
    });

    expect(env.PATH?.split(path.posix.delimiter)[0]).toBe(
      "/home/user/.nvm/versions/node/v22.22.0/bin",
    );
  });
});

describe("shared Node TLS env defaults", () => {
  const builders = [
    {
      name: "gateway service env",
      build: (env: Record<string, string | undefined>, platform?: NodeJS.Platform) =>
        buildServiceEnvironment({ env, port: 18789, platform }),
    },
    {
      name: "node service env",
      build: (env: Record<string, string | undefined>, platform?: NodeJS.Platform) =>
        buildNodeServiceEnvironment({ env, platform }),
    },
  ] as const;

  it.each(builders)("$name defaults NODE_EXTRA_CA_CERTS on macOS", ({ build }) => {
    const env = build({ HOME: "/home/user" }, "darwin");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/cert.pem");
  });

  it.each(builders)("$name does not default NODE_EXTRA_CA_CERTS on Windows", ({ build }) => {
    const env = build({ HOME: "/home/user" }, "win32");
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
  });

  it.each(builders)("$name respects user-provided NODE_EXTRA_CA_CERTS", ({ build }) => {
    const env = build({ HOME: "/home/user", NODE_EXTRA_CA_CERTS: "/custom/certs/ca.pem" });
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/custom/certs/ca.pem");
  });

  it.each(builders)("$name defaults NODE_USE_SYSTEM_CA=1 on macOS", ({ build }) => {
    const env = build({ HOME: "/home/user" }, "darwin");
    expect(env.NODE_USE_SYSTEM_CA).toBe("1");
  });

  it.each(builders)("$name does not default NODE_USE_SYSTEM_CA on non-macOS", ({ build }) => {
    const env = build({ HOME: "/home/user" }, "linux");
    expect(env.NODE_USE_SYSTEM_CA).toBeUndefined();
  });

  it.each(builders)("$name respects user-provided NODE_USE_SYSTEM_CA", ({ build }) => {
    const env = build({ HOME: "/home/user", NODE_USE_SYSTEM_CA: "0" }, "darwin");
    expect(env.NODE_USE_SYSTEM_CA).toBe("0");
  });
});

describe("resolveGatewayStateDir", () => {
  it("uses the default state dir when no overrides are set", () => {
    const env = { HOME: "/Users/test" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".openclaw"));
  });

  it("appends the profile suffix when set", () => {
    const env = { HOME: "/Users/test", OPENCLAW_PROFILE: "rescue" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".openclaw-rescue"));
  });

  it("treats default profiles as the base state dir", () => {
    const env = { HOME: "/Users/test", OPENCLAW_PROFILE: "Default" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".openclaw"));
  });

  it("uses OPENCLAW_STATE_DIR when provided", () => {
    const env = { HOME: "/Users/test", OPENCLAW_STATE_DIR: "/var/lib/openclaw" };
    expect(resolveGatewayStateDir(env)).toBe(path.resolve("/var/lib/openclaw"));
  });

  it("expands ~ in OPENCLAW_STATE_DIR", () => {
    const env = { HOME: "/Users/test", OPENCLAW_STATE_DIR: "~/openclaw-state" };
    expect(resolveGatewayStateDir(env)).toBe(path.resolve("/Users/test/openclaw-state"));
  });

  it("preserves Windows absolute paths without HOME", () => {
    const env = { OPENCLAW_STATE_DIR: "C:\\State\\openclaw" };
    expect(resolveGatewayStateDir(env)).toBe("C:\\State\\openclaw");
  });
});

describe("isNodeVersionManagerRuntime", () => {
  it("returns true when NVM_DIR env var is set", () => {
    expect(isNodeVersionManagerRuntime({ NVM_DIR: "/home/user/.nvm" })).toBe(true);
  });

  it("returns true when execPath contains /.nvm/", () => {
    expect(isNodeVersionManagerRuntime({}, "/home/user/.nvm/versions/node/v22.22.0/bin/node")).toBe(
      true,
    );
  });

  it("returns false when neither NVM_DIR nor nvm execPath", () => {
    expect(isNodeVersionManagerRuntime({}, "/usr/bin/node")).toBe(false);
  });
});

describe("resolveLinuxSystemCaBundle", () => {
  it("returns a known CA bundle path when one exists", () => {
    const result = resolveLinuxSystemCaBundle();
    if (process.platform === "linux") {
      expect(result).toMatch(/\.(crt|pem)$/);
    }
  });
});

describe("shared Node TLS env defaults", () => {
  it("sets macOS TLS defaults for gateway services", () => {
    const env = buildServiceEnvironment({
      env: { HOME: "/Users/test" },
      port: 18789,
      platform: "darwin",
    });
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/cert.pem");
    expect(env.NODE_USE_SYSTEM_CA).toBe("1");
  });

  it("sets macOS TLS defaults for node services", () => {
    const env = buildNodeServiceEnvironment({
      env: { HOME: "/Users/test" },
      platform: "darwin",
    });
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/cert.pem");
    expect(env.NODE_USE_SYSTEM_CA).toBe("1");
  });

  it("defaults NODE_EXTRA_CA_CERTS on Linux when NVM_DIR is set", () => {
    const expected = resolveLinuxSystemCaBundle();
    const env = buildServiceEnvironment({
      env: { HOME: "/home/user", NVM_DIR: "/home/user/.nvm" },
      port: 18789,
      platform: "linux",
      execPath: "/usr/bin/node",
    });
    expect(env.NODE_EXTRA_CA_CERTS).toBe(expected);
  });

  it("defaults NODE_EXTRA_CA_CERTS on Linux when execPath is under nvm", () => {
    const expected = resolveLinuxSystemCaBundle();
    const env = buildNodeServiceEnvironment({
      env: { HOME: "/home/user" },
      platform: "linux",
      execPath: "/home/user/.nvm/versions/node/v22.22.0/bin/node",
    });
    expect(env.NODE_EXTRA_CA_CERTS).toBe(expected);
  });

  it("does not default NODE_EXTRA_CA_CERTS on Linux without nvm", () => {
    const env = buildServiceEnvironment({
      env: { HOME: "/home/user" },
      port: 18789,
      platform: "linux",
      execPath: "/usr/bin/node",
    });
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
  });

  it("respects user-provided NODE_EXTRA_CA_CERTS on Linux with nvm", () => {
    const env = buildNodeServiceEnvironment({
      env: {
        HOME: "/home/user",
        NVM_DIR: "/home/user/.nvm",
        NODE_EXTRA_CA_CERTS: "/custom/ca-bundle.crt",
      },
      platform: "linux",
      execPath: "/home/user/.nvm/versions/node/v22.22.0/bin/node",
    });
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/custom/ca-bundle.crt");
  });
});
