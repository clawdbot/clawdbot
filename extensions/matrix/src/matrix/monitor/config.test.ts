import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../../runtime-api.js";
import type { CoreConfig, MatrixRoomConfig } from "../../types.js";
import { resolveMatrixMonitorConfig } from "./config.js";

type MatrixRoomsConfig = Record<string, MatrixRoomConfig>;

function createRuntime() {
  const runtime: RuntimeEnv = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
  return runtime;
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
      cfg: {} as CoreConfig,
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
    expect(resolveTargets).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        accountId: "ops",
        kind: "user",
        inputs: ["Bob"],
      }),
    );
    expect(resolveTargets).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        accountId: "ops",
        kind: "group",
        inputs: ["General"],
      }),
    );
    expect(resolveTargets).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        accountId: "ops",
        kind: "user",
        inputs: ["Dana"],
      }),
    );
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
      cfg: {} as CoreConfig,
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

    expect(result.allowFrom).toEqual([]);
    expect(result.groupAllowFrom).toEqual(["@known:example.org"]);
    expect(result.roomsConfig).toEqual({});
    expect(resolveTargets).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        accountId: "ops",
        kind: "user",
        inputs: ["Ghost"],
      }),
    );
    expect(resolveTargets).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        accountId: "ops",
        kind: "group",
        inputs: ["Project X"],
      }),
    );
    expect(resolveTargets).toHaveBeenCalledTimes(2);
    expect(runtime.log).toHaveBeenCalledWith("matrix dm allowlist unresolved: user:Ghost");
    expect(runtime.log).toHaveBeenCalledWith(
      "matrix dm allowlist entries must be full Matrix IDs (example: @user:server). Unresolved entries are ignored.",
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
      cfg: {} as CoreConfig,
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
    expect(resolveTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "ops",
        kind: "group",
        inputs: ["#allowed:example.org"],
      }),
    );
  });
});
