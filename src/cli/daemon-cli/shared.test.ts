// Daemon shared tests cover shared daemon CLI helpers and validation.
import { describe, expect, it } from "vitest";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  filterContainerGenericHints,
  parsePortFromArgs,
  renderRuntimeHints,
  renderGatewayServiceStartHints,
  resolveDaemonContainerContext,
  resolveRuntimeStatusColor,
} from "./shared.js";

describe("resolveRuntimeStatusColor", () => {
  it("maps known runtime states to expected theme colors", () => {
    expect(resolveRuntimeStatusColor("running")).toBe(theme.success);
    expect(resolveRuntimeStatusColor("stopped")).toBe(theme.error);
    expect(resolveRuntimeStatusColor("unknown")).toBe(theme.muted);
  });

  it("falls back to warning color for unexpected states", () => {
    expect(resolveRuntimeStatusColor("degraded")).toBe(theme.warn);
    expect(resolveRuntimeStatusColor(undefined)).toBe(theme.muted);
  });
});

describe("parsePortFromArgs", () => {
  it("rejects inline port values with trailing equals-separated text", () => {
    expect(parsePortFromArgs(["--port=123=bad"])).toBeNull();
  });

  it("accepts valid inline and space-separated port values", () => {
    expect(parsePortFromArgs(["--port=14720"])).toBe(14_720);
    expect(parsePortFromArgs(["--port", "14721"])).toBe(14_721);
  });
});

describe("renderGatewayServiceStartHints", () => {
  it("uses GUI session wording for installed LaunchAgents that cannot access gui/$UID", () => {
    expect(
      renderRuntimeHints(
        { missingSupervision: true, missingGuiSession: true },
        {} as NodeJS.ProcessEnv,
      ).join("\n"),
    ).toContain("logged-in macOS GUI session");
  });

  it("resolves daemon container context from either env key", () => {
    expect(
      resolveDaemonContainerContext({
        OPENCLAW_CONTAINER: "openclaw-demo-container",
      } as NodeJS.ProcessEnv),
    ).toBe("openclaw-demo-container");
    expect(
      resolveDaemonContainerContext({
        OPENCLAW_CONTAINER_HINT: "openclaw-demo-container",
      } as NodeJS.ProcessEnv),
    ).toBe("openclaw-demo-container");
  });

  it("prepends a single container restart hint when OPENCLAW_CONTAINER is set", () => {
    expect(
      renderGatewayServiceStartHints({
        OPENCLAW_CONTAINER: "openclaw-demo-container",
      } as NodeJS.ProcessEnv),
    ).toContain(
      "Restart the container or the service that manages it for openclaw-demo-container.",
    );
  });

  it("prepends a single container restart hint when OPENCLAW_CONTAINER_HINT is set", () => {
    expect(
      renderGatewayServiceStartHints({
        OPENCLAW_CONTAINER_HINT: "openclaw-demo-container",
      } as NodeJS.ProcessEnv),
    ).toContain(
      "Restart the container or the service that manages it for openclaw-demo-container.",
    );
  });
});

describe("filterContainerGenericHints", () => {
  it("drops the generic container foreground hint when OPENCLAW_CONTAINER is set", () => {
    expect(
      filterContainerGenericHints(
        [
          "systemd user services are unavailable; install/enable systemd or run the gateway under your supervisor.",
          "If you're in a container, run the gateway in the foreground instead of `openclaw gateway`.",
        ],
        { OPENCLAW_CONTAINER: "openclaw-demo-container" } as NodeJS.ProcessEnv,
      ),
    ).toStrictEqual([]);
  });

  it("drops the generic container foreground hint when OPENCLAW_CONTAINER_HINT is set", () => {
    expect(
      filterContainerGenericHints(
        [
          "systemd user services are unavailable; install/enable systemd or run the gateway under your supervisor.",
          "If you're in a container, run the gateway in the foreground instead of `openclaw gateway`.",
        ],
        { OPENCLAW_CONTAINER_HINT: "openclaw-demo-container" } as NodeJS.ProcessEnv,
      ),
    ).toStrictEqual([]);
  });
});
