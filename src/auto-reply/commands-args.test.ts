/** Tests serialization of structured command arguments into slash-command text. */
import { describe, expect, it } from "vitest";
import { COMMAND_ARG_FORMATTERS } from "./commands-args.js";
import type { CommandArgValues } from "./commands-registry.types.js";

function formatArgs(key: keyof typeof COMMAND_ARG_FORMATTERS, values: Record<string, unknown>) {
  const formatter = COMMAND_ARG_FORMATTERS[key];
  return formatter?.(values as unknown as CommandArgValues);
}

describe("COMMAND_ARG_FORMATTERS", () => {
  it("formats config args (show/get/unset/set) and normalizes values", () => {
    expect(formatArgs("config", {})).toBeUndefined();

    expect(formatArgs("config", { action: "  SHOW " })).toBe("show");
    expect(formatArgs("config", { action: "get", path: " a.b " })).toBe("get a.b");
    expect(formatArgs("config", { action: "unset", path: "x" })).toBe("unset x");

    expect(formatArgs("config", { action: "set" })).toBe("set");
    expect(formatArgs("config", { action: "set", path: "x" })).toBe("set x");
    expect(formatArgs("config", { action: "set", path: "x", value: 1 })).toBe("set x=1");
    expect(formatArgs("config", { action: "set", path: "x", value: { ok: true } })).toBe(
      'set x={"ok":true}',
    );

    expect(formatArgs("config", { action: "whoami", path: "ignored" })).toBe("whoami");
  });

  it("formats debug args (show/reset/unset/set)", () => {
    expect(formatArgs("debug", { action: "show", path: "x" })).toBe("show");
    expect(formatArgs("debug", { action: "reset", path: "x" })).toBe("reset");
    expect(formatArgs("debug", { action: "unset" })).toBe("unset");
    expect(formatArgs("debug", { action: "unset", path: "x" })).toBe("unset x");
    expect(formatArgs("debug", { action: "set", path: "x" })).toBe("set x");
    expect(formatArgs("debug", { action: "set", path: "x", value: true })).toBe("set x=true");
  });

  it("formats queue args (order + omission)", () => {
    expect(formatArgs("queue", {})).toBeUndefined();
    expect(formatArgs("queue", { mode: "fifo" })).toBe("fifo");
    expect(
      formatArgs("queue", {
        mode: "fifo",
        debounce: 10,
        cap: 2n,
        drop: Symbol("tail"),
      }),
    ).toBe("fifo debounce:10 cap:2 drop:Symbol(tail)");
  });
});
