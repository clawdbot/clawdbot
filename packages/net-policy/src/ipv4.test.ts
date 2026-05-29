import { describe, expect, it } from "vitest";
import { validateDottedDecimalIPv4Input, validateIPv4AddressInput } from "./ipv4.js";

describe("net-policy/ipv4", () => {
  it("requires a value for custom bind mode", () => {
    expect(validateDottedDecimalIPv4Input(undefined)).toBe(
      "IP address is required for custom bind mode",
    );
    expect(validateDottedDecimalIPv4Input("")).toBe("IP address is required for custom bind mode");
    expect(validateDottedDecimalIPv4Input("   ")).toBe(
      "Invalid IPv4 address (e.g., 192.168.1.100)",
    );
  });

  it("accepts canonical dotted-decimal ipv4 only", () => {
    expect(validateDottedDecimalIPv4Input("0.0.0.0")).toBeUndefined();
    expect(validateDottedDecimalIPv4Input("192.168.1.100")).toBeUndefined();
    expect(validateDottedDecimalIPv4Input(" 192.168.1.100 ")).toBeUndefined();
    expect(validateDottedDecimalIPv4Input("0177.0.0.1")).toBe(
      "Invalid IPv4 address (e.g., 192.168.1.100)",
    );
    expect(validateDottedDecimalIPv4Input("[192.168.1.100]")).toBeUndefined();
    expect(validateDottedDecimalIPv4Input("127.1")).toBe(
      "Invalid IPv4 address (e.g., 192.168.1.100)",
    );
    expect(validateDottedDecimalIPv4Input("example.com")).toBe(
      "Invalid IPv4 address (e.g., 192.168.1.100)",
    );
  });

  it("keeps the backward-compatible alias wired to the same validation", () => {
    expect(validateIPv4AddressInput("192.168.1.100")).toBeUndefined();
    expect(validateIPv4AddressInput("bad-ip")).toBe("Invalid IPv4 address (e.g., 192.168.1.100)");
  });
});
