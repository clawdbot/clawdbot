import { describe, expect, it } from "vitest";
import { ensureControlUiAllowedOriginsForNonLoopbackBind } from "./gateway-control-ui-origins.js";

describe("ensureControlUiAllowedOriginsForNonLoopbackBind", () => {
  it("seeds Fly-style runtime bind and port when config is empty", () => {
    const result = ensureControlUiAllowedOriginsForNonLoopbackBind(
      { gateway: {} },
      {
        runtimeBind: "lan",
        runtimePort: 3000,
        isContainerEnvironment: () => false,
      },
    );

    expect(result.bind).toBe("lan");
    expect(result.seededOrigins).toEqual(["http://localhost:3000", "http://127.0.0.1:3000"]);
    expect(result.config.gateway?.controlUi?.allowedOrigins).toEqual(result.seededOrigins);
  });

  it("uses runtime bind before config bind to match gateway startup precedence", () => {
    const result = ensureControlUiAllowedOriginsForNonLoopbackBind(
      { gateway: { bind: "loopback" } },
      {
        runtimeBind: "lan",
        isContainerEnvironment: () => false,
      },
    );

    expect(result.bind).toBe("lan");
    expect(result.seededOrigins).toContain("http://localhost:18789");
    expect(result.seededOrigins).toContain("http://127.0.0.1:18789");
  });

  it("uses runtime loopback before config non-loopback and avoids seeding", () => {
    const result = ensureControlUiAllowedOriginsForNonLoopbackBind(
      { gateway: { bind: "lan" } },
      {
        runtimeBind: "loopback",
        isContainerEnvironment: () => false,
      },
    );

    expect(result.bind).toBeNull();
    expect(result.seededOrigins).toBeNull();
  });

  it("uses runtime port before config port to match gateway startup precedence", () => {
    const result = ensureControlUiAllowedOriginsForNonLoopbackBind(
      { gateway: { bind: "lan", port: 18789 } },
      {
        runtimePort: 3000,
        isContainerEnvironment: () => false,
      },
    );

    expect(result.seededOrigins).toEqual(["http://localhost:3000", "http://127.0.0.1:3000"]);
  });

  it("keeps container fallback when runtime and config bind are unset", () => {
    const result = ensureControlUiAllowedOriginsForNonLoopbackBind(
      { gateway: {} },
      { isContainerEnvironment: () => true },
    );

    expect(result.bind).toBe("auto");
    expect(result.seededOrigins).toEqual(["http://localhost:18789", "http://127.0.0.1:18789"]);
  });

  it("does not overwrite explicit allowed origins", () => {
    const result = ensureControlUiAllowedOriginsForNonLoopbackBind(
      {
        gateway: {
          controlUi: { allowedOrigins: ["https://control.example.com"] },
        },
      },
      {
        runtimeBind: "lan",
        runtimePort: 3000,
        isContainerEnvironment: () => false,
      },
    );

    expect(result.bind).toBe("lan");
    expect(result.seededOrigins).toBeNull();
    expect(result.config.gateway?.controlUi?.allowedOrigins).toEqual([
      "https://control.example.com",
    ]);
  });
});
