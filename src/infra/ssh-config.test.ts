import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { beforeAll, describe, expect, it, vi } from "vitest";

type MockSpawnChild = EventEmitter & {
  stdout?: EventEmitter & { setEncoding?: (enc: string) => void };
  kill?: (signal?: string) => void;
};

function createMockSpawnChild() {
  const child = new EventEmitter() as MockSpawnChild;
  const stdout = new EventEmitter() as MockSpawnChild["stdout"];
  stdout!.setEncoding = vi.fn();
  child.stdout = stdout;
  child.kill = vi.fn();
  return { child, stdout };
}

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  const spawn = vi.fn(() => {
    const { child, stdout } = createMockSpawnChild();
    process.nextTick(() => {
      stdout?.emit(
        "data",
        [
          "user steipete",
          "hostname peters-mac-studio-1.sheep-coho.ts.net",
          "port 2222",
          "identityfile none",
          "identityfile /tmp/id_ed25519",
          "",
        ].join("\n"),
      );
      child.emit("exit", 0);
    });
    return child;
  });
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
    },
  );
});

const spawnMock = vi.mocked(spawn);

function requireSpawnArgs(index: number): string[] {
  const args = spawnMock.mock.calls[index]?.[1] as string[] | undefined;
  if (!args) {
    throw new Error("expected ssh spawn args");
  }
  return args;
}

let parseSshConfigOutput: typeof import("./ssh-config.js").parseSshConfigOutput;
let resolveSshConfig: typeof import("./ssh-config.js").resolveSshConfig;

describe("ssh-config", () => {
  beforeAll(async () => {
    ({ parseSshConfigOutput, resolveSshConfig } = await import("./ssh-config.js"));
  });

  it("parses ssh -G output", () => {
    const parsed = parseSshConfigOutput(
      "user bob\nhostname example.com\nport 2222\nidentityfile none\nidentityfile /tmp/id\n",
    );
    expect(parsed.user).toBe("bob");
    expect(parsed.host).toBe("example.com");
    expect(parsed.port).toBe(2222);
    expect(parsed.identityFiles).toEqual(["/tmp/id"]);
  });

  it("ignores invalid ports and blank lines in ssh -G output", () => {
    const parsed = parseSshConfigOutput(
      "user bob\nhostname example.com\nport not-a-number\nidentityfile none\nidentityfile   \n",
    );

    expect(parsed.user).toBe("bob");
    expect(parsed.host).toBe("example.com");
    expect(parsed.port).toBeUndefined();
    expect(parsed.identityFiles).toEqual([]);
  });

  it("resolves ssh config via ssh -G", async () => {
    const config = await resolveSshConfig({ user: "me", host: "alias", port: 22 });
    expect(config?.user).toBe("steipete");
    expect(config?.host).toBe("peters-mac-studio-1.sheep-coho.ts.net");
    expect(config?.port).toBe(2222);
    expect(config?.identityFiles).toEqual(["/tmp/id_ed25519"]);
    expect(requireSpawnArgs(0).slice(-2)).toEqual(["--", "me@alias"]);
  });

  it("adds non-default port and trimmed identity arguments", async () => {
    await resolveSshConfig(
      { user: "me", host: "alias", port: 2022 },
      { identity: "  /tmp/custom_id  " },
    );

    const args = spawnMock.mock.calls.at(-1)?.[1] as string[] | undefined;
    expect(args).toEqual(["-G", "-p", "2022", "-i", "/tmp/custom_id", "--", "me@alias"]);
  });

  it("returns null when ssh -G fails", async () => {
    spawnMock.mockImplementationOnce(
      (_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
        const { child } = createMockSpawnChild();
        process.nextTick(() => {
          child.emit("exit", 1);
        });
        return child as unknown as ChildProcess;
      },
    );

    const config = await resolveSshConfig({ user: "me", host: "bad-host", port: 22 });
    expect(config).toBeNull();
  });

  it("returns null when the ssh process emits an error", async () => {
    spawnMock.mockImplementationOnce(
      (_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
        const { child } = createMockSpawnChild();
        process.nextTick(() => {
          child.emit("error", new Error("spawn boom"));
        });
        return child as unknown as ChildProcess;
      },
    );

    await expect(resolveSshConfig({ user: "me", host: "bad-host", port: 22 })).resolves.toBeNull();
  });
});
