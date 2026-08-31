import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  buildOpenShellPolicyYaml,
  cleanupOpenShellWorkspace,
  runCommand,
} from "./backend.e2e.test-support.js";

describe("OpenShell host policy", () => {
  const defaults = ["10.0.0.0/8", "172.0.0.0/8", "192.168.0.0/16", "fc00::/7"];
  it.each([
    { name: "default", hostIp: undefined, allowedIps: defaults },
    { name: "blank override", hostIp: "  ", allowedIps: defaults },
    { name: "custom IPv4 override", hostIp: " 198.51.100.42 ", allowedIps: ["198.51.100.42/32"] },
    { name: "shipped IPv6 override", hostIp: "2001:db8::1", allowedIps: ["2001:db8::1/32"] },
  ])("preserves $name without changing the endpoint or binary", ({ hostIp, allowedIps }) => {
    const params = { port: 17680, binaryPath: "/usr/bin/curl", hostIp };
    const policy: unknown = parse(buildOpenShellPolicyYaml(params));
    expect(policy).toMatchObject({
      network_policies: {
        host_echo: {
          endpoints: [
            {
              host: "host.openshell.internal",
              port: 17680,
              protocol: "rest",
              enforcement: "enforce",
              access: "full",
              allowed_ips: allowedIps,
            },
          ],
          binaries: [{ path: "/usr/bin/curl" }],
        },
      },
    });
  });
});

it.runIf(process.platform !== "win32")("reports a signal-killed probe as failure", async () => {
  const result = await runCommand({
    command: process.execPath,
    args: ["-e", "process.kill(process.pid, 'SIGTERM')"],
    allowFailure: true,
    timeoutMs: 10_000,
  });
  expect(result.code).not.toBe(0);
});

async function createCleanupFixture(
  options: { mode?: string; inventory?: string; names?: string[] } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openshell-cleanup-test-"));
  const stateFile = path.join(root, "state.json");
  const command = path.join(root, "openshell");
  const initial = {
    names: ["first", "second"],
    pending: "",
    observations: 0,
    listCalls: 0,
    deletes: [] as string[],
    workspaceDeletes: 0,
    ...options,
  };
  await fs.writeFile(stateFile, JSON.stringify(initial));
  await fs.writeFile(
    command,
    `#!${process.execPath}
const fs = require("node:fs");
const stateFile = process.env.FIXTURE_STATE;
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const args = process.argv.slice(2);
let failure;
if (args[0] === "workspace") {
  state.workspaceDeletes++;
  if (state.names.length) failure = "workspace still contains durable sandbox records";
  if (state.mode === "workspace-failure") failure = "workspace cleanup failed";
} else if (args[3] === "delete") {
  const name = args[4];
  state.deletes.push(name);
  state.pending = name;
  state.observations = 0;
  if (state.mode === "delete-failure" && name === "first") failure = "delete failed";
} else if (args[3] === "list") {
  state.listCalls++;
  if (state.pending && ++state.observations >= 2 && state.mode !== "stuck") {
    state.names = state.names.filter(name => name !== state.pending);
    state.pending = "";
  }
  if (state.mode === "read-failure" && state.deletes.length) failure = "database is locked";
  const limit = Number(args[args.indexOf("--limit") + 1]);
  console.log(state.inventory ?? JSON.stringify(state.names.slice(0, limit).map(name => ({ name }))));
} else {
  throw new Error("unexpected fixture command");
}
fs.writeFileSync(stateFile + ".next", JSON.stringify(state));
fs.renameSync(stateFile + ".next", stateFile);
if (failure) {
  console.error(failure);
  process.exit(1);
}
if ((state.mode === "slow-delete" && args[3] === "delete") ||
    (state.mode === "stuck" && state.observations > 0)) {
  fs.writeFileSync(stateFile + ".expired", "");
}
`,
    { mode: 0o755 },
  );
  return {
    cleanup: () =>
      cleanupOpenShellWorkspace({
        command,
        env: { ...process.env, FIXTURE_STATE: stateFile },
        workspace: "isolated",
        sandboxNames: ["first", "second", "never-created"],
      }),
    read: async () => JSON.parse(await fs.readFile(stateFile, "utf8")) as typeof initial,
    deadlineExpired: () => existsSync(stateFile + ".expired"),
    dispose: () => fs.rm(root, { recursive: true, force: true }),
  };
}

describe.runIf(process.platform !== "win32")("OpenShell workspace cleanup", () => {
  it("waits for durable sandbox deletion before deleting its workspace", async () => {
    const fixture = await createCleanupFixture();
    try {
      await fixture.cleanup();
      expect(await fixture.read()).toMatchObject({
        names: [],
        deletes: ["first", "second"],
        workspaceDeletes: 1,
      });
    } finally {
      await fixture.dispose();
    }
  });

  it("deletes an empty workspace without deleting never-created sandboxes", async () => {
    const fixture = await createCleanupFixture({ names: [] });
    try {
      await fixture.cleanup();
      expect(await fixture.read()).toMatchObject({
        listCalls: 1,
        deletes: [],
        workspaceDeletes: 1,
      });
    } finally {
      await fixture.dispose();
    }
  });

  it.each([
    ["non-JSON", "not json"],
    ["non-array", "{}"],
    ["null row", "[null]"],
    ["missing name", "[{}]"],
    ["empty name", '[{"name":""}]'],
    ["unexpected sandbox", '[{"name":"someone-else"}]'],
    ["duplicate sandbox", '[{"name":"first"},{"name":"first"}]'],
    ["full page", '[{"name":"first"},{"name":"second"},{"name":"never-created"},{"name":"extra"}]'],
  ])("rejects %s inventory without deleting resources", async (_label, inventory) => {
    const fixture = await createCleanupFixture({ inventory });
    try {
      await expect(fixture.cleanup()).rejects.toThrow();
      expect(await fixture.read()).toMatchObject({
        listCalls: 1,
        deletes: [],
        workspaceDeletes: 0,
      });
    } finally {
      await fixture.dispose();
    }
  });

  it.each([
    ["read-failure", "database is locked", 2],
    ["delete-failure", "delete failed", 1],
  ])(
    "retains %s while attempting remaining owned deletes once",
    async (mode, message, listCalls) => {
      const fixture = await createCleanupFixture({ mode });
      try {
        const failure = await fixture.cleanup().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors).toEqual([
          expect.objectContaining({ message: expect.stringContaining(message) }),
        ]);
        expect(await fixture.read()).toMatchObject({
          listCalls,
          deletes: ["first", "second"],
          workspaceDeletes: 0,
        });
      } finally {
        await fixture.dispose();
      }
    },
  );

  it.each(["slow-delete", "stuck"])("bounds %s by the original cleanup deadline", async (mode) => {
    const fixture = await createCleanupFixture({ mode });
    const startedAt = Date.now();
    // Advance at the real child operation boundary, not a wall-clock poll that
    // can expire before a loaded host starts the command.
    const clock = vi
      .spyOn(Date, "now")
      .mockImplementation(() => startedAt + (fixture.deadlineExpired() ? 120_000 : 0));
    try {
      const failure = await fixture.cleanup().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining("120 seconds") }),
      );
      expect(await fixture.read()).toMatchObject({
        listCalls: mode === "slow-delete" ? 1 : 2,
        deletes: ["first"],
        observations: mode === "slow-delete" ? 0 : 1,
        workspaceDeletes: 0,
      });
    } finally {
      clock.mockRestore();
      await fixture.dispose();
    }
  });

  it("keeps workspace deletion failure visible after sandbox absence", async () => {
    const fixture = await createCleanupFixture({ mode: "workspace-failure" });
    try {
      await expect(fixture.cleanup()).rejects.toThrow("workspace cleanup failed");
      expect(await fixture.read()).toMatchObject({ names: [], workspaceDeletes: 1 });
    } finally {
      await fixture.dispose();
    }
  });
});
