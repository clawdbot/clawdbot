import { describe, expect, it, vi } from "vitest";
import { createOpenClawTools } from "../openclaw-tools.js";
import "../test-helpers/fast-openclaw-tools.js";
import { createPerSenderSessionConfig } from "../test-helpers/session-config.js";

// This test transitively loads the full createOpenClawTools dependency graph,
// so keep its timeout above the default ceiling. The long-term direction is to
// keep static tool registration off heavyweight runtime imports.
describe("continuation tool registration", { timeout: 240000 }, () => {
  const config = {
    session: createPerSenderSessionConfig(),
    agents: {
      defaults: {
        continuation: {
          enabled: true,
        },
      },
    },
  } as const;

  it("exposes continue_delegate on normal turns when continuation is enabled", () => {
    const tools = createOpenClawTools({
      config,
      agentSessionKey: "main",
    });

    expect(tools.some((tool) => tool.name === "continue_delegate")).toBe(true);
  });

  it("exposes cross-session targeting fields on the continue_delegate schema descriptor", () => {
    const tools = createOpenClawTools({
      config,
      agentSessionKey: "main",
    });
    const tool = tools.find((candidate) => candidate.name === "continue_delegate");
    if (!tool) {
      throw new Error("continue_delegate tool not registered");
    }

    const params = tool.parameters as { properties?: Record<string, unknown> };
    expect(params.properties).toBeDefined();
    expect(params.properties).toHaveProperty("targetSessionKey");
    expect(params.properties).toHaveProperty("targetSessionKeys");
    expect(params.properties).toHaveProperty("fanoutMode");
  });

  it("description documents the five continuation return targeting modes", () => {
    const tools = createOpenClawTools({
      config,
      agentSessionKey: "main",
    });
    const tool = tools.find((candidate) => candidate.name === "continue_delegate");
    if (!tool) {
      throw new Error("continue_delegate tool not registered");
    }

    expect(tool.description).toContain("default returns to the dispatching session");
    expect(tool.description).toContain("targetSessionKey returns to one other session");
    expect(tool.description).toContain("targetSessionKeys returns byte-identical enrichment");
    expect(tool.description).toContain("fanoutMode=tree returns to all ancestors");
    expect(tool.description).toContain("fanoutMode=all returns to all known sessions");
  });

  it("hides continue_delegate when continuation is disabled", () => {
    const tools = createOpenClawTools({
      config: {
        ...config,
        agents: { defaults: { continuation: { enabled: false } } },
      },
      agentSessionKey: "main",
    });

    expect(tools.some((tool) => tool.name === "continue_delegate")).toBe(false);
  });

  it("exposes continue_work when continuation is enabled and the runner wires it", () => {
    const tools = createOpenClawTools({
      config,
      agentSessionKey: "main",
      continueWorkOpts: {
        requestContinuation: vi.fn(),
      },
    });

    expect(tools.some((tool) => tool.name === "continue_work")).toBe(true);
  });

  // Truth-table coverage for the drainsContinuationDelegateQueue gate predicate
  // in createOpenClawTools (`!== false`). Three states must be pinned so a future
  // refactor cannot silently regress to `=== true` (which broke the
  // "normal turns" case before the !== false fix landed.
  it("exposes continue_delegate when drainsContinuationDelegateQueue is undefined (default normal turns)", () => {
    const tools = createOpenClawTools({
      config,
      agentSessionKey: "main",
      // drainsContinuationDelegateQueue intentionally omitted to assert default behavior
    });

    expect(tools.some((tool) => tool.name === "continue_delegate")).toBe(true);
  });

  it("exposes continue_delegate when drainsContinuationDelegateQueue is explicitly true (explicit drainers)", () => {
    const tools = createOpenClawTools({
      config,
      agentSessionKey: "main",
      drainsContinuationDelegateQueue: true,
    });

    expect(tools.some((tool) => tool.name === "continue_delegate")).toBe(true);
  });

  it("hides continue_delegate when drainsContinuationDelegateQueue is explicitly false (e.g. llm-slug-generator)", () => {
    const tools = createOpenClawTools({
      config,
      agentSessionKey: "main",
      drainsContinuationDelegateQueue: false,
    });

    expect(tools.some((tool) => tool.name === "continue_delegate")).toBe(false);
  });

  // Exact-keys trap for continue_delegate descriptor.
  //
  // Bug-shape / risk:
  //   The mode-only trap pins that `mode` is exposed as an enum
  //   AND that boolean `silent`/`silentWake` are absent. This test extends
  //   that surface with the COMPLEMENTARY pin: the EXACT set of advertised
  //   parameter keys on the tool descriptor. A refactor that adds a new
  //   model-facing parameter (cross-session addressing, trace context, retry knobs, priority)
  //   without an ADR would slip past the mode-only trap because it only checks
  //   what MUST be absent (silent/silentWake) and what MUST be present (mode
  //   enum). This trap pins the closed set, including the resurrected
  //   cross-session return targeting fields.
  //
  // The canonical advertised keys are:
  //   - task              (required)
  //   - delaySeconds      (optional)
  //   - mode              (optional, enum)
  //   - attachments       (optional)
  //   - attachAs          (optional)
  //   - targetSessionKey  (optional)
  //   - targetSessionKeys (optional)
  //   - fanoutMode        (optional, enum)
  //   - model             (optional)
  // Diagnostic trace context is runtime-owned and intentionally not model-facing.
  //
  // Extension to the mode-only trap, not duplication: it lives in
  // `src/auto-reply/continuation/types.mode-shape.test.ts` and asserts
  // mode-as-enum + silent/silentWake-absent on the descriptor. This file
  // asserts the closed-set + cross-session targeting + boolean-runtime-absent.
  it("pins continue_delegate descriptor to mode enum and no boolean compatibility fields", () => {
    const tools = createOpenClawTools({
      config,
      agentSessionKey: "main",
    });
    const tool = tools.find((candidate) => candidate.name === "continue_delegate");
    if (!tool) {
      throw new Error("continue_delegate tool not registered");
    }

    const params = tool.parameters as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(params.type).toBe("object");
    const properties = params.properties ?? {};

    // Closed-set assertion: exactly these advertised keys, no more, no less.
    const expectedKeys = [
      "task",
      "delaySeconds",
      "mode",
      "attachments",
      "attachAs",
      "targetSessionKey",
      "targetSessionKeys",
      "fanoutMode",
      "model",
      "returnOptions",
      "recipientContext",
    ].toSorted();
    const actualKeys = Object.keys(properties).toSorted();
    expect(
      actualKeys,
      `continue_delegate descriptor must advertise exactly [${expectedKeys.join(", ")}]; got [${actualKeys.join(", ")}]`,
    ).toEqual(expectedKeys);

    // task is required (model-facing contract).
    expect(params.required).toContain("task");

    const delaySecondsProp = properties.delaySeconds as { description?: string };
    expect(delaySecondsProp.description).toContain("0 or omitted = immediate");
    expect(delaySecondsProp.description).not.toContain("omitted = default delay");

    // mode enum must include the four canonical values.
    const modeProp = properties.mode as {
      anyOf?: Array<{ const?: string; enum?: string[] }>;
      enum?: string[];
    };
    const modeEnumValues = new Set<string>();
    if (Array.isArray(modeProp.enum)) {
      for (const v of modeProp.enum) {
        modeEnumValues.add(v);
      }
    }
    if (Array.isArray(modeProp.anyOf)) {
      for (const branch of modeProp.anyOf) {
        if (typeof branch.const === "string") {
          modeEnumValues.add(branch.const);
        }
        if (Array.isArray(branch.enum)) {
          for (const v of branch.enum) {
            modeEnumValues.add(v);
          }
        }
      }
    }
    for (const expected of ["normal", "silent", "silent-wake", "post-compaction"]) {
      expect(
        modeEnumValues.has(expected),
        `mode enum must include '${expected}' (got: ${[...modeEnumValues].join(", ")})`,
      ).toBe(true);
    }

    const fanoutProp = properties.fanoutMode as {
      anyOf?: Array<{ const?: string; enum?: string[] }>;
      enum?: string[];
    };
    const fanoutEnumValues = new Set<string>();
    if (Array.isArray(fanoutProp.enum)) {
      for (const v of fanoutProp.enum) {
        fanoutEnumValues.add(v);
      }
    }
    if (Array.isArray(fanoutProp.anyOf)) {
      for (const branch of fanoutProp.anyOf) {
        if (typeof branch.const === "string") {
          fanoutEnumValues.add(branch.const);
        }
        if (Array.isArray(branch.enum)) {
          for (const v of branch.enum) {
            fanoutEnumValues.add(v);
          }
        }
      }
    }
    for (const expected of ["tree", "all"]) {
      expect(
        fanoutEnumValues.has(expected),
        `fanoutMode enum must include '${expected}' (got: ${[...fanoutEnumValues].join(", ")})`,
      ).toBe(true);
    }

    // Boolean-runtime compatibility fields MUST be absent at the descriptor.
    // (Their on-disk back-compat lives in the Zod state schema, not the tool surface.)
    for (const forbidden of ["silent", "silentWake", "postCompaction"]) {
      expect(
        Object.hasOwn(properties, forbidden),
        `continue_delegate descriptor must not expose boolean compatibility field '${forbidden}'`,
      ).toBe(false);
    }

    expect(properties).toHaveProperty("targetSessionKey");
    expect(properties).toHaveProperty("targetSessionKeys");
    expect(properties).toHaveProperty("fanoutMode");

    const attachmentsProp = properties.attachments as {
      type?: string;
      items?: { properties?: Record<string, unknown> };
    };
    expect(attachmentsProp.type).toBe("array");
    expect(attachmentsProp.items?.properties).toEqual(
      expect.objectContaining({
        name: expect.anything(),
        content: expect.anything(),
        encoding: expect.anything(),
        mimeType: expect.anything(),
      }),
    );
    const attachAsProp = properties.attachAs as {
      properties?: Record<string, unknown>;
    };
    expect(attachAsProp.properties).toHaveProperty("mountPath");
  });

  // Truth-table coverage for request_compaction registration. Pins the
  // three-state matrix (continuation enabled + opts present, continuation
  // disabled, opts omitted) so a future refactor cannot silently drop the
  // tool from normal runner wiring. Coverage shape mirrors the existing
  // `drainsContinuationDelegateQueue` truth-table for continue_delegate.
  describe("request_compaction registration truth-table", () => {
    const requestCompactionOpts = {
      sessionId: "sess-1",
      getContextUsage: () => 0.85,
      triggerCompaction: vi.fn(async () => ({ ok: true, compacted: true })),
    };

    it("exposes request_compaction when continuation enabled AND requestCompactionOpts wired", () => {
      const tools = createOpenClawTools({
        config,
        agentSessionKey: "main",
        requestCompactionOpts,
      });
      expect(tools.some((tool) => tool.name === "request_compaction")).toBe(true);
    });

    it("hides request_compaction when continuation disabled (regardless of opts)", () => {
      const tools = createOpenClawTools({
        config: {
          ...config,
          agents: { defaults: { continuation: { enabled: false } } },
        },
        agentSessionKey: "main",
        requestCompactionOpts,
      });
      expect(tools.some((tool) => tool.name === "request_compaction")).toBe(false);
    });

    it("hides request_compaction when continuation enabled but opts omitted", () => {
      const tools = createOpenClawTools({
        config,
        agentSessionKey: "main",
        // requestCompactionOpts intentionally omitted
      });
      expect(tools.some((tool) => tool.name === "request_compaction")).toBe(false);
    });

    it("descriptor name is stable across registrations", () => {
      const tools = createOpenClawTools({
        config,
        agentSessionKey: "main",
        requestCompactionOpts,
      });
      const tool = tools.find((candidate) => candidate.name === "request_compaction");
      if (!tool) {
        throw new Error("request_compaction tool not registered");
      }
      // Descriptor name + presence pinned; reason-schema stability lives in
      // the dedicated request-compaction-tool tests.
      expect(tool.name).toBe("request_compaction");
    });
  });
});
