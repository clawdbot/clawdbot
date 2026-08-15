// Parity contract: every config surface an operator can edit is either
// agent-writable through the approval gate or sits on the explicit,
// documented denylist. A new top-level config key must be classified here
// on purpose instead of silently becoming operator-only or agent-writable.
import { describe, expect, it } from "vitest";
import { OpenClawSchemaShape } from "../config/zod-schema.root-shape.js";
import {
  SYSTEM_AGENT_CONFIG_WRITE_DENYLIST,
  classifyInferenceRouteConfigPath,
} from "./config-write-policy.js";

// Roots with a partial policy: some subpaths are agent-writable, the rest are
// blocked. Their fine-grained rules are asserted individually below.
const PARTIAL_ROOTS = new Set(["plugins", "agents"]);

describe("system-agent config write parity", () => {
  it("classifies every top-level config key as agent-writable or explicitly denied", () => {
    for (const key of Object.keys(OpenClawSchemaShape)) {
      const verdict = classifyInferenceRouteConfigPath([key]);
      if (key in SYSTEM_AGENT_CONFIG_WRITE_DENYLIST) {
        expect(verdict, `${key} is on the denylist and must stay blocked`).toBe("blocked");
      } else if (PARTIAL_ROOTS.has(key)) {
        expect(verdict, `${key} root writes must stay blocked`).toBe("blocked");
      } else {
        expect(verdict, `${key} must stay agent-writable behind approval`).toBe("allowed");
      }
    }
  });

  it("documents a reason for every denylisted root", () => {
    for (const [key, reason] of Object.entries(SYSTEM_AGENT_CONFIG_WRITE_DENYLIST)) {
      expect(reason.trim().length, `${key} needs a denial reason`).toBeGreaterThan(0);
    }
    // The denylist stays scoped to credential/inclusion/routing surfaces.
    expect(Object.keys(SYSTEM_AGENT_CONFIG_WRITE_DENYLIST).toSorted()).toEqual([
      "$include",
      "auth",
      "env",
      "models",
      "secrets",
    ]);
  });

  it("keeps operator-parity surfaces agent-writable", () => {
    // tools (profiles, exec policy) and ui prefs are freely editable in the
    // Control UI; the approval gate is the guard, not a path ban.
    expect(classifyInferenceRouteConfigPath(["tools", "profile"])).toBe("allowed");
    expect(classifyInferenceRouteConfigPath(["tools", "exec", "security"])).toBe("allowed");
    expect(classifyInferenceRouteConfigPath(["ui", "seamColor"])).toBe("allowed");
    expect(classifyInferenceRouteConfigPath(["agents", "defaults", "heartbeat"])).toBe("allowed");
    expect(classifyInferenceRouteConfigPath(["agents", "defaults", "thinkingDefault"])).toBe(
      "allowed",
    );
  });

  it("allows installed-plugin toggles but not install/load policy", () => {
    // plugin-entry writes still get the active-route ownership check in
    // assertConfigWriteDoesNotBypassInferenceVerification before applying.
    expect(classifyInferenceRouteConfigPath(["plugins", "entries", "memory-wiki", "enabled"])).toBe(
      "plugin-entry",
    );
    expect(classifyInferenceRouteConfigPath(["plugins"])).toBe("blocked");
    expect(classifyInferenceRouteConfigPath(["plugins", "load"])).toBe("blocked");
    expect(classifyInferenceRouteConfigPath(["plugins", "installs"])).toBe("blocked");
  });

  it("blocks default-route agent fields and defers per-agent routing to the config check", () => {
    expect(classifyInferenceRouteConfigPath(["agents"])).toBe("blocked");
    expect(classifyInferenceRouteConfigPath(["agents", "defaults", "model"])).toBe("blocked");
    expect(classifyInferenceRouteConfigPath(["agents", "defaults", "models"])).toBe("blocked");
    expect(classifyInferenceRouteConfigPath(["agents", "list"])).toBe("blocked");
    expect(classifyInferenceRouteConfigPath(["agents", "list", "0"])).toBe("blocked");
    for (const field of ["model", "models", "params", "agentRuntime"]) {
      expect(classifyInferenceRouteConfigPath(["agents", "list", "1", field])).toBe("agent-route");
    }
    for (const field of ["id", "default", "agentDir"]) {
      expect(classifyInferenceRouteConfigPath(["agents", "list", "1", field])).toBe("blocked");
    }
    expect(classifyInferenceRouteConfigPath(["agents", "list", "1", "name"])).toBe("allowed");
    expect(classifyInferenceRouteConfigPath(["agents", "list", "1", "tools"])).toBe("allowed");
  });
});
