// Qa Lab tests cover Crabbox runtime behavior.
import { describe, expect, it } from "vitest";
import { type CommandRunner, defaultCommandRunner, sshCommand } from "./crabbox-runtime.js";

describe("Crabbox command runner", () => {
  it("preserves UTF-8 split across child-process pipe chunks", async () => {
    const childScript = `
      process.stdout.write(Buffer.from([0xf0, 0x9f]));
      process.stderr.write(Buffer.from([0xe6]));
      setTimeout(() => {
        process.stdout.write(Buffer.from([0x98, 0x80]));
        process.stderr.write(Buffer.from([0xb5, 0x8b]));
      }, 25);
    `;

    await expect(defaultCommandRunner(process.execPath, ["-e", childScript], {})).resolves.toEqual({
      stdout: "😀",
      stderr: "测",
    });
  });

  it("keeps captured stderr in command failures", async () => {
    await expect(
      defaultCommandRunner(
        process.execPath,
        ["-e", 'process.stderr.write("Permission denied (publickey)\\n"); process.exit(255)'],
        {},
      ),
    ).rejects.toThrow("Permission denied (publickey)");
  });

  it.each([
    {
      host: "ssh.proof.example",
      inspect: {
        sshFallbackPorts: ["22", "2222", " 2200 ", "22"],
        sshHost: "ssh.proof.example",
        sshPort: "2222",
      },
      ports: ["2222", "22", "2200"],
    },
    {
      host: "proof.example",
      inspect: { sshFallbackPorts: ["2200", "22", "2200"] },
      ports: ["22", "2200"],
    },
    { host: "proof.example", inspect: {}, ports: ["22"] },
  ])("selects ordered, deduplicated SSH candidates: $ports", async ({ host, inspect, ports }) => {
    const calls: Array<{ args: readonly string[]; command: string }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ args, command });
      if (command === "ssh" && !args.includes(ports.at(-1) ?? "22")) {
        throw new Error("Connection refused");
      }
      return { stderr: "", stdout: "" };
    };
    const transport = await sshCommand({
      cwd: "/repo",
      env: {},
      inspect: {
        host: "proof.example",
        ...inspect,
        sshKey: "/tmp/key",
        sshUser: "proof",
      },
      runner,
    });

    await runner("rsync", ["-e", transport.sshArgs], {});

    const expectedProbes = ports.length === 1 ? [] : ports;
    expect(calls.filter((call) => call.command === "ssh").map((call) => call.args[3])).toEqual(
      expectedProbes,
    );
    expect(calls.filter((call) => call.command === "ssh").map((call) => call.args[12])).toEqual(
      expectedProbes.map(() => `proof@${host}`),
    );
    expect(transport.host).toBe(host);
    expect(calls.filter((call) => call.command === "rsync")).toEqual([
      { args: ["-e", expect.stringContaining(`-p ${ports.at(-1)}`)], command: "rsync" },
    ]);
  });

  it("does not try a fallback after an SSH authentication failure", async () => {
    const probes: string[] = [];
    const runner: CommandRunner = async (command, args) => {
      if (command === "ssh") {
        probes.push(args[3] ?? "");
        throw new Error("Permission denied (publickey)");
      }
      return { stderr: "", stdout: "" };
    };

    await expect(
      sshCommand({
        cwd: "/repo",
        env: {},
        inspect: {
          host: "proof.example",
          sshFallbackPorts: ["22"],
          sshKey: "/tmp/key",
          sshPort: "2222",
          sshUser: "proof",
        },
        runner,
      }),
    ).rejects.toThrow("Permission denied");
    expect(probes).toEqual(["2222"]);
  });
});
