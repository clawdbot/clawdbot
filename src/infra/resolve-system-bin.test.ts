// Covers trusted system binary resolution across platform install roots.
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";

type ResolveSystemBin = typeof import("./resolve-system-bin.js").resolveSystemBin;

const windowsRoots = vi.hoisted(() => ({
  systemRoot: "C:\\Windows",
  programFilesRoots: ["C:\\Program Files", "C:\\Program Files (x86)"],
}));

vi.mock("./windows-install-roots.js", async () => {
  const actual = await vi.importActual<typeof import("./windows-install-roots.js")>(
    "./windows-install-roots.js",
  );
  return {
    ...actual,
    getWindowsInstallRoots: () => ({
      systemRoot: windowsRoots.systemRoot,
      programFiles: windowsRoots.programFilesRoots[0] ?? "C:\\Program Files",
      programFilesX86: windowsRoots.programFilesRoots[1] ?? "C:\\Program Files (x86)",
      programW6432: windowsRoots.programFilesRoots[0] ?? null,
    }),
    getWindowsProgramFilesRoots: () => windowsRoots.programFilesRoots,
  };
});

let resolveSystemBin: ResolveSystemBin;
let freshResolveSystemBinId = 0;

let executables: Set<string>;

vi.mock("node:fs", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:fs")>("node:fs"),
    {
      accessSync: (candidate: import("node:fs").PathLike) => {
        const candidatePath = String(candidate);
        if (!executables.has(path.resolve(candidatePath))) {
          throw Object.assign(new Error(`missing executable: ${candidatePath}`), {
            code: "ENOENT",
          });
        }
      },
    },
    { mirrorToDefault: true },
  );
});

function addExecutables(...paths: string[]): void {
  for (const candidate of paths) {
    executables.add(candidate);
  }
}

beforeEach(async () => {
  executables = new Set<string>();
  windowsRoots.systemRoot = "C:\\Windows";
  windowsRoots.programFilesRoots = ["C:\\Program Files", "C:\\Program Files (x86)"];
  ({ resolveSystemBin } = await importFreshModule<typeof import("./resolve-system-bin.js")>(
    import.meta.url,
    `./resolve-system-bin.js?test=${freshResolveSystemBinId++}`,
  ));
});

describe("resolveSystemBin", () => {
  it("returns null when binary is not in any trusted directory", () => {
    expect(resolveSystemBin("nonexistent")).toBeNull();
  });

  if (process.platform !== "win32") {
    it("resolves a binary found in /usr/bin", () => {
      executables.add("/usr/bin/ffmpeg");
      expect(resolveSystemBin("ffmpeg")).toBe("/usr/bin/ffmpeg");
    });

    it.each([
      {
        name: "does NOT resolve a binary found in /usr/local/bin with strict trust",
        executable: "/usr/local/bin/openssl",
        command: "openssl",
        checkStrict: true,
      },
      {
        name: "does NOT resolve a binary found in /opt/homebrew/bin with strict trust",
        executable: "/opt/homebrew/bin/ffmpeg",
        command: "ffmpeg",
        checkStrict: true,
      },
      {
        name: "does NOT resolve a binary from a user-writable directory like ~/.local/bin",
        executable: "/home/testuser/.local/bin/ffmpeg",
        command: "ffmpeg",
        checkStrict: false,
      },
    ])("$name", ({ executable, command, checkStrict }) => {
      addExecutables(executable);
      expect(resolveSystemBin(command)).toBeNull();
      if (checkStrict) {
        expect(resolveSystemBin(command, { trust: "strict" })).toBeNull();
      }
    });

    it("prefers /usr/bin over /usr/local/bin (first match wins)", () => {
      executables.add("/usr/bin/openssl");
      executables.add("/usr/local/bin/openssl");
      expect(resolveSystemBin("openssl")).toBe("/usr/bin/openssl");
    });

    it("caches results across calls", () => {
      executables.add("/usr/bin/ffmpeg");
      expect(resolveSystemBin("ffmpeg")).toBe("/usr/bin/ffmpeg");

      executables.delete("/usr/bin/ffmpeg");
      expect(resolveSystemBin("ffmpeg")).toBe("/usr/bin/ffmpeg");
    });

    it("supports extraDirs for caller-specific paths", () => {
      const customDir = "/custom/system/bin";
      executables.add(`${customDir}/mytool`);
      expect(resolveSystemBin("mytool", { extraDirs: [customDir] })).toBe(`${customDir}/mytool`);
    });

    it("extraDirs results do not poison the cache for callers without extraDirs", () => {
      const untrustedDir = "/home/user/.local/bin";
      executables.add(`${untrustedDir}/ffmpeg`);

      expect(resolveSystemBin("ffmpeg", { extraDirs: [untrustedDir] })).toBe(
        `${untrustedDir}/ffmpeg`,
      );
      expect(resolveSystemBin("ffmpeg")).toBeNull();
    });
  }

  if (process.platform === "darwin") {
    it.each(["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"])(
      "resolves a binary in %s with standard trust on macOS",
      (executable) => {
        addExecutables(executable);
        expect(resolveSystemBin("ffmpeg", { trust: "standard" })).toBe(executable);
      },
    );

    it("prefers /usr/bin over /opt/homebrew/bin with standard trust", () => {
      executables.add("/usr/bin/ffmpeg");
      executables.add("/opt/homebrew/bin/ffmpeg");
      expect(resolveSystemBin("ffmpeg", { trust: "standard" })).toBe("/usr/bin/ffmpeg");
    });

    it("standard trust results do not poison the strict cache", () => {
      executables.add("/opt/homebrew/bin/ffmpeg");
      expect(resolveSystemBin("ffmpeg", { trust: "standard" })).toBe("/opt/homebrew/bin/ffmpeg");
      expect(resolveSystemBin("ffmpeg")).toBeNull();
    });

    it("extraDirs composes with standard trust", () => {
      const customDir = "/opt/custom/bin";
      executables.add(`${customDir}/mytool`);
      expect(resolveSystemBin("mytool", { trust: "standard", extraDirs: [customDir] })).toBe(
        `${customDir}/mytool`,
      );
    });
  }

  if (process.platform === "linux") {
    it("resolves a binary in /usr/local/bin with standard trust on Linux", () => {
      addExecutables("/usr/local/bin/ffmpeg");
      expect(resolveSystemBin("ffmpeg", { trust: "standard" })).toBe("/usr/local/bin/ffmpeg");
    });

    it("prefers /usr/bin over /usr/local/bin with standard trust on Linux", () => {
      executables.add("/usr/bin/ffmpeg");
      executables.add("/usr/local/bin/ffmpeg");
      expect(resolveSystemBin("ffmpeg", { trust: "standard" })).toBe("/usr/bin/ffmpeg");
    });
  }
});

describe("trusted directory list", () => {
  it("resolves Windows system and Program Files tools through the public resolver", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    windowsRoots.systemRoot = "D:\\Windows";
    windowsRoots.programFilesRoots = ["D:\\Program Files", "E:\\Program Files (x86)"];
    try {
      const candidates = [
        {
          command: "pwsh",
          expected: path.win32.join(
            "D:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "pwsh.exe",
          ),
          trust: "strict" as const,
        },
        {
          command: "openssl",
          expected: path.win32.join("D:\\Program Files", "OpenSSL-Win64", "bin", "openssl.exe"),
          trust: "strict" as const,
        },
        {
          command: "ffmpeg",
          expected: path.win32.join("E:\\Program Files (x86)", "ffmpeg", "bin", "ffmpeg.exe"),
          trust: "strict" as const,
        },
        {
          command: "magick",
          expected: path.win32.join("D:\\Program Files", "ImageMagick", "magick.exe"),
          trust: "standard" as const,
        },
        {
          command: "gm",
          expected: path.win32.join("E:\\Program Files (x86)", "GraphicsMagick", "gm.exe"),
          trust: "standard" as const,
        },
      ];
      addExecutables(...candidates.map(({ expected }) => path.resolve(expected)));

      for (const { command, expected, trust } of candidates) {
        expect(resolveSystemBin(command, { trust })).toBe(expected);
      }
      expect(resolveSystemBin("magick", { trust: "strict" })).toBeNull();

      addExecutables(path.resolve("/usr/bin/unix-only.exe"));
      expect(resolveSystemBin("unix-only", { trust: "standard" })).toBeNull();
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("resolves machine-wide Chocolatey shims only with standard trust on Windows", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const chocoFfmpeg = path.win32.join("C:\\", "ProgramData", "chocolatey", "bin", "ffmpeg.exe");
      executables.add(path.resolve(chocoFfmpeg));
      expect(resolveSystemBin("ffmpeg")).toBeNull();
      expect(resolveSystemBin("ffmpeg", { trust: "standard" })).toBe(chocoFfmpeg);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("uses fixed Linux system paths and ignores NIX_PROFILES", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const previousNixProfiles = process.env.NIX_PROFILES;
    process.env.NIX_PROFILES =
      "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-ffmpeg-7.1 /tmp/evil /home/user/.nix-profile";
    try {
      addExecutables(
        "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-ffmpeg-7.1/bin/ffmpeg",
        "/run/current-system/sw/bin/nix-tool",
        "/snap/bin/snap-tool",
        "/usr/local/bin/local-tool",
      );

      expect(resolveSystemBin("ffmpeg")).toBeNull();
      expect(resolveSystemBin("nix-tool")).toBe("/run/current-system/sw/bin/nix-tool");
      expect(resolveSystemBin("snap-tool")).toBe("/snap/bin/snap-tool");
      expect(resolveSystemBin("local-tool")).toBeNull();
      expect(resolveSystemBin("local-tool", { trust: "standard" })).toBe(
        "/usr/local/bin/local-tool",
      );
    } finally {
      if (previousNixProfiles === undefined) {
        delete process.env.NIX_PROFILES;
      } else {
        process.env.NIX_PROFILES = previousNixProfiles;
      }
      platformSpy.mockRestore();
    }
  });

  it("does not widen standard trust on unsupported Unix platforms", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("freebsd");
    try {
      addExecutables("/usr/local/bin/local-tool");
      expect(resolveSystemBin("local-tool", { trust: "strict" })).toBeNull();
      expect(resolveSystemBin("local-tool", { trust: "standard" })).toBeNull();
    } finally {
      platformSpy.mockRestore();
    }
  });
});
