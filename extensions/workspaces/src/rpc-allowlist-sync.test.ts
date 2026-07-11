// Keep-in-sync guard: the UI's browser-safe RPC allowlist mirror
// (ui/src/lib/workspace/bridge.ts RPC_METHOD_ALLOWLIST) must match the canonical
// server allowlist (DATA_READ_RPC_ALLOWLIST) exactly. The mirror exists because
// binding-contract.ts pulls in node:path and must never enter the browser bundle;
// this node-rooted test can import BOTH and fails loudly if they drift.
import { describe, expect, it } from "vitest";
import { RPC_METHOD_ALLOWLIST } from "../../../ui/src/lib/workspace/bridge.ts";
import { DATA_READ_RPC_ALLOWLIST } from "./binding-contract.js";

describe("rpc allowlist mirror stays in sync with the server", () => {
  it("UI RPC_METHOD_ALLOWLIST equals the server DATA_READ_RPC_ALLOWLIST", () => {
    expect([...RPC_METHOD_ALLOWLIST]).toEqual([...DATA_READ_RPC_ALLOWLIST]);
  });
});
