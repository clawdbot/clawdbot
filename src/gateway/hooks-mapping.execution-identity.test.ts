// Hook mapping identity coverage keeps mapping IDs as ingress attribution only.
import { describe, expect, it } from "vitest";
import { applyHookMappings, resolveHookMappings } from "./hooks-mapping.js";

describe("hook mapping execution identity", () => {
  it("carries the configured mapping id on the resolved agent action", async () => {
    const mappings = resolveHookMappings({
      mappings: [
        {
          id: "source-gmail",
          match: { path: "gmail" },
          action: "agent",
          messageTemplate: "{{messages[0].subject}}",
        },
      ],
    });
    const result = await applyHookMappings(mappings, {
      payload: { messages: [{ subject: "Hello" }] },
      headers: {},
      url: new URL("http://127.0.0.1:18789/hooks/gmail"),
      path: "gmail",
    });
    expect(result).toMatchObject({
      ok: true,
      actions: [{ kind: "agent", mappingId: "source-gmail", message: "Hello" }],
    });
  });
});
