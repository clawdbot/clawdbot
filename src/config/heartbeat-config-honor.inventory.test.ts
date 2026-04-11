import { describe, expect, it } from "vitest";
import {
  auditConfigHonorInventory,
  listSchemaLeafKeysForPrefixes,
} from "../../test/helpers/config/config-honor-audit.js";
import {
  HEARTBEAT_CONFIG_HONOR_INVENTORY,
  HEARTBEAT_CONFIG_PREFIXES,
} from "../../test/helpers/config/heartbeat-config-honor.inventory.js";

const EXPECTED_HEARTBEAT_KEYS = [
  "every",
  "model",
  "prompt",
  "includeSystemPromptSection",
  "ackMaxChars",
  "suppressToolErrorWarnings",
  "timeoutSeconds",
  "lightContext",
  "isolatedSession",
  "target",
  "to",
  "accountId",
  "directPolicy",
  "includeReasoning",
] as const;

describe("heartbeat config-honor inventory", () => {
  it("keeps the planned heartbeat audit slice aligned with schema leaf keys", () => {
    const schemaKeys = listSchemaLeafKeysForPrefixes([...HEARTBEAT_CONFIG_PREFIXES]);
    for (const key of EXPECTED_HEARTBEAT_KEYS) {
      expect(schemaKeys).toContain(key);
    }
  });

  it("covers the planned heartbeat keys with runtime, reload, and test proofs", () => {
    const audit = auditConfigHonorInventory({
      prefixes: [...HEARTBEAT_CONFIG_PREFIXES],
      expectedKeys: [...EXPECTED_HEARTBEAT_KEYS],
      rows: HEARTBEAT_CONFIG_HONOR_INVENTORY,
    });

    expect(audit.missingKeys).toEqual([]);
    expect(audit.extraKeys).toEqual([]);
    expect(audit.missingSchemaPaths).toEqual([]);
    expect(audit.missingFiles).toEqual([]);
    expect(audit.missingProofs).toEqual([]);
  });
});
