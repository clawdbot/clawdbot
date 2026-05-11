import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../../runtime-api.js";
import type { CoreConfig, MatrixRoomConfig } from "../../types.js";
import { resolveMatrixMonitorConfig, resolveMatrixMonitorLiveUserAllowlist } from "./config.js";

type MatrixRoomsConfig = Record<string, MatrixRoomConfig>;

function createRuntime() {
  const runtime: RuntimeEnv = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
  return runtime;
}

function createConfig(params?: { dangerouslyAllowNameMatching?: boolean }): CoreConfig {
  return {
    channels: {
      matrix: {
        dangerouslyAllowNameMatching: params?.dangerouslyAllowNameMatching,
      },
    },
  } as CoreConfig;
}

function resolveTargetCall(
  resolveTargets: { mock: { calls: unknown[][] } },
  index: number,
): { accountId?: string; kind?: string; inputs?: string[] } {
  const [arg] = resolveTargets.mock.calls[index] ?? [];
  if (!arg || typeof arg !== "object") {
    throw new Error(`expected resolveTargets call ${index + 1}`);
  }
  return arg as { accountId?: string; kind?: string; inputs?: string[] };
}

function expectResolveTargetCall(
  resolveTargets: { mock: { calls: unknown[][] } },
  index: number,
  expected: { accountId: string; kind: string; inputs: string[] },
): void {
  const call = resolveTargetCall(resolveTargets, index);
  expect(call.accountId).toBe(expected.accountId);
  expect(call.kind).toBe(expected.kind);
  expect(call.inputs).toEqual(expected.inputs);
}

describe("resolveMatrixMonitorConfig", () => {
  it("canonicalizes resolved user aliases and room keys without keeping stale aliases", async () => {
    const runtime = createRuntime();
    const resolveTargets = vi.fn(
      async ({ inputs, kind }: { inputs: string[]; kind: "user" | "group" }) => {
        if (kind === "user") {
          return inputs.map((input) => {
            if (input === "Bob") {
              return { input, resolved: true, id: "@bob:example.org" };
            }
            if (input === "Dana") {
              return { input, resolved: true, id: "@dana:example.org" };
            }
            return { input, resolved: false };
          });
        }
        return inputs.map((input) =>
          input === "General"
            ? { input, resolved: true, id: "!general:example.org" }
            : { input, resolved: false },
        );
      },
    );

    const roomsConfig: MatrixRoomsConfig = {
      "*": { enabled: true },
      "room:!ops:example.org": {
        enabled: true,
        users: ["Dana", "user:@Erin:Example.org"],
      },
      General: {
        enabled: true,
      },
    };

    const result = await resolveMatrixMonitorConfig({
      cfg: createConfig({ dangerouslyAllowNameMatching: true }),
      accountId: "ops",
      allowFrom: ["matrix:@Alice:Example.org", "Bob"],
      groupAllowFrom: ["user:@Carol:Example.org"],
      roomsConfig,
      runtime,
      resolveTargets,
    });

    expect(result.allowFrom).toEqual(["@alice:example.org", "@bob:example.org"]);
    expect(result.groupAllowFrom).toEqual(["@carol:example.org"]);
    expect(result.roomsConfig).toEqual({
      "*": { enabled: true },
      "!ops:example.org": {
        enabled: true,
        users: ["@dana:example.org", "@erin:example.org"],
      },
      "!general:example.org": {
        enabled: true,
      },
    });
    expect(resolveTargets).toHaveBeenCalledTimes(3);
    expectResolveTargetCall(resolveTargets, 0, {
      accountId: "ops",
      kind: "user",
      inputs: ["Bob"],
    });
    expectResolveTargetCall(resolveTargets, 1, {
      accountId: "ops",
      kind: "group",
      inputs: ["General"],
    });
    expectResolveTargetCall(resolveTargets, 2, {
      accountId: "ops",
      kind: "user",
      inputs: ["Dana"],
    });
  });

  it("strips config prefixes before lookups and logs unresolved guidance once per section", async () => {
    const runtime = createRuntime();
    const resolveTargets = vi.fn(
      async ({ kind, inputs }: { inputs: string[]; kind: "user" | "group" }) =>
        inputs.map((input) => ({
          input,
          resolved: false,
          ...(kind === "group" ? { note: `missing ${input}` } : {}),
        })),
    );

    const result = await resolveMatrixMonitorConfig({
      cfg: createConfig({ dangerouslyAllowNameMatching: true }),
      accountId: "ops",
      allowFrom: ["user:Ghost"],
      groupAllowFrom: ["matrix:@known:example.org"],
      roomsConfig: {
        "channel:Project X": {
          enabled: true,
          users: ["matrix:Ghost"],
        },
      },
      runtime,
      resolveTargets,
    });

    expect(result.allowFrom).toStrictEqual([]);
    expect(result.groupAllowFrom).toEqual(["@known:example.org"]);
    expect(result.roomsConfig).toStrictEqual({});
    expectResolveTargetCall(resolveTargets, 0, {
      accountId: "ops",
      kind: "user",
      inputs: ["Ghost"],
    });
    expectResolveTargetCall(resolveTargets, 1, {
      accountId: "ops",
      kind: "group",
      inputs: ["Project X"],
    });
    expect(resolveTargets).toHaveBeenCalledTimes(2);
    expect(runtime.log).toHaveBeenCalledWith("matrix dm allowlist unresolved: user:Ghost");
    expect(runtime.log).toHaveBeenCalledWith(
      "matrix dm allowlist entries must be full Matrix IDs (example: @user:server). Unresolved entries will not match any sender.",
    );
    expect(runtime.log).toHaveBeenCalledWith("matrix rooms unresolved: channel:Project X");
    expect(runtime.log).toHaveBeenCalledWith(
      "matrix rooms must be room IDs or aliases (example: !room:server or #alias:server). Unresolved entries are ignored.",
    );
  });

  it("resolves exact room aliases to canonical room ids instead of trusting alias keys directly", async () => {
    const runtime = createRuntime();
    const resolveTargets = vi.fn(
      async ({ kind, inputs }: { inputs: string[]; kind: "user" | "group" }) => {
        if (kind === "group") {
          return inputs.map((input) =>
            input === "#allowed:example.org"
              ? { input, resolved: true, id: "!allowed-room:example.org" }
              : { input, resolved: false },
          );
        }
        return [];
      },
    );

    const result = await resolveMatrixMonitorConfig({
      cfg: createConfig({ dangerouslyAllowNameMatching: true }),
      accountId: "ops",
      roomsConfig: {
        "#allowed:example.org": {
          enabled: true,
        },
      },
      runtime,
      resolveTargets,
    });

    expect(result.roomsConfig).toEqual({
      "!allowed-room:example.org": {
        enabled: true,
      },
    });
    expectResolveTargetCall(resolveTargets, 0, {
      accountId: "ops",
      kind: "group",
      inputs: ["#allowed:example.org"],
    });
  });

  it("does not resolve mutable allowlist entries or room names by default", async () => {
    const runtime = createRuntime();
    const resolveTargets = vi.fn(
      async ({ kind, inputs }: { inputs: string[]; kind: "user" | "group" }) => {
        if (kind === "group") {
          return inputs.map((input) =>
            input === "#ops:example.org"
              ? { input, resolved: true, id: "!ops:example.org" }
              : { input, resolved: false },
          );
        }
        return inputs.map((input) => ({ input, resolved: true, id: `@${input}:example.org` }));
      },
    );

    const result = await resolveMatrixMonitorConfig({
      cfg: createConfig(),
      accountId: "ops",
      allowFrom: ["Alice", "matrix:@Bob:Example.org"],
      groupAllowFrom: ["Carol"],
      roomsConfig: {
        General: {
          enabled: true,
          users: ["Dana"],
        },
        "#ops:example.org": {
          enabled: true,
          users: ["user:@Erin:Example.org", "Frank"],
        },
      },
      runtime,
      resolveTargets,
    });

    expect(result.allowFrom).toEqual(["@bob:example.org"]);
    expect(result.allowFromResolvedEntries).toEqual([
      { input: "matrix:@Bob:Example.org", id: "@bob:example.org" },
    ]);
    expect(result.groupAllowFrom).toEqual(["Carol"]);
    expect(result.roomsConfig).toEqual({
      "!ops:example.org": {
        enabled: true,
        users: ["@erin:example.org", "Frank"],
      },
    });
    expect(resolveTargets).toHaveBeenCalledTimes(1);
    expectResolveTargetCall(resolveTargets, 0, {
      accountId: "ops",
      kind: "group",
      inputs: ["#ops:example.org"],
    });
    expect(runtime.log).toHaveBeenCalledWith("matrix dm allowlist unresolved: Alice");
    expect(runtime.log).toHaveBeenCalledWith(
      "matrix dm allowlist entries must be full Matrix IDs (example: @user:server). Unresolved entries will not match any sender. To match Matrix display names, set channels.matrix.dangerouslyAllowNameMatching=true.",
    );
    expect(runtime.log).toHaveBeenCalledWith("matrix group allowlist unresolved: Carol");
    expect(runtime.log).toHaveBeenCalledWith(
      "matrix group allowlist entries must be full Matrix IDs (example: @user:server). Unresolved entries will not match any sender. To match Matrix display names, set channels.matrix.dangerouslyAllowNameMatching=true.",
    );
    expect(runtime.log).toHaveBeenCalledWith("matrix room users unresolved: Frank");
    expect(runtime.log).toHaveBeenCalledWith(
      "matrix room users entries must be full Matrix IDs (example: @user:server). Unresolved entries will not match any sender. To match Matrix display names, set channels.matrix.dangerouslyAllowNameMatching=true.",
    );
  });

  it("does not resolve mutable live allowlist entries by default", async () => {
    const runtime = createRuntime();
    const resolveTargets = vi.fn(async () => [
      { input: "Alice", resolved: true, id: "@alice:example.org" },
    ]);

    const result = await resolveMatrixMonitorLiveUserAllowlist({
      cfg: createConfig(),
      accountId: "ops",
      entries: ["Alice", "matrix:@Bob:Example.org", "*"],
      startupResolvedEntries: [{ input: "Alice", id: "@startup-alice:example.org" }],
      runtime,
      resolveTargets,
    });

    expect(result).toEqual(["@bob:example.org", "*"]);
    expect(resolveTargets).not.toHaveBeenCalled();
  });

  it("keeps unresolved live group allowlist entries configured for fail-closed matching", async () => {
    const runtime = createRuntime();
    const resolveTargets = vi.fn(async () => [
      { input: "Alice", resolved: true, id: "@alice:example.org" },
    ]);

    const result = await resolveMatrixMonitorLiveUserAllowlist({
      cfg: createConfig(),
      accountId: "ops",
      entries: ["Alice", "matrix:@Bob:Example.org"],
      failClosedOnUnresolved: true,
      startupResolvedEntries: [{ input: "Alice", id: "@startup-alice:example.org" }],
      runtime,
      resolveTargets,
    });

    expect(result).toEqual(["Alice", "@bob:example.org"]);
    expect(resolveTargets).not.toHaveBeenCalled();
  });

  it("resolves mutable live allowlist entries when name matching is enabled", async () => {
    const runtime = createRuntime();
    const resolveTargets = vi.fn(async () => [
      { input: "Alice", resolved: true, id: "@alice:example.org" },
    ]);

    const result = await resolveMatrixMonitorLiveUserAllowlist({
      cfg: createConfig({ dangerouslyAllowNameMatching: true }),
      accountId: "ops",
      entries: ["Alice", "matrix:@Bob:Example.org", "*"],
      runtime,
      resolveTargets,
    });

    expect(result).toEqual(["@bob:example.org", "*", "@alice:example.org"]);
    expectResolveTargetCall(resolveTargets, 0, {
      accountId: "ops",
      kind: "user",
      inputs: ["Alice"],
    });
  });
});
