// Pending pairing render tests cover crash-safety for malformed pairing-list scalars.
import { describe, expect, it } from "vitest";
import { parsePairingList } from "../../shared/node-list-parse.js";
import { renderPendingPairingRequestsTable } from "./pairing-render.js";

const theme = {
  heading: (text: string) => text,
  warn: (text: string) => text,
  muted: (text: string) => text,
};

describe("cli/nodes-cli/pairing-render", () => {
  it("renders pending rows parsed from malformed scalars without throwing", () => {
    // node.pair.list rows are blind-cast from the pairing file; non-string requestId/nodeId/
    // displayName/remoteIp once crashed the renderer's .trim()/sanitizeTerminalText calls.
    const { pending } = parsePairingList({
      pending: [{ requestId: 7, nodeId: {}, displayName: 42, remoteIp: 99, ts: 1 }],
    });

    expect(() =>
      renderPendingPairingRequestsTable({ pending, now: 1000, tableWidth: 80, theme }),
    ).not.toThrow();
  });

  it("keeps a valid pending label after normalization", () => {
    const { pending } = parsePairingList({
      pending: [
        { requestId: "r1", nodeId: "n1", displayName: "Phone", remoteIp: "10.0.0.1", ts: 1 },
      ],
    });

    const { table } = renderPendingPairingRequestsTable({
      pending,
      now: 1000,
      tableWidth: 80,
      theme,
    });
    expect(table).toContain("Phone");
    expect(table).toContain("10.0.0.1");
  });
});
