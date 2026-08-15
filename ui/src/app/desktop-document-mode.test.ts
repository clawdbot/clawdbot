import { describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { resolveDesktopDocumentTarget } from "../components/desktop/desktop-source.ts";
import { desktopDocumentOptions } from "./desktop-document-mode.ts";

describe("desktop document mode", () => {
  it("parses desktop source, session, and control options", () => {
    expect(
      desktopDocumentOptions({
        search: "?view=desktop&source=gateway&session=agent%3Amain%3Awork&control=1",
      }),
    ).toEqual({
      source: "gateway",
      session: "agent:main:work",
      control: true,
    });
  });

  it("prefers an explicit source over the session placement", () => {
    const session = {
      key: "agent:main:work",
      kind: "direct",
      updatedAt: 1,
      execNode: "workstation",
    } satisfies GatewaySessionRow;

    expect(
      resolveDesktopDocumentTarget(
        { source: "gateway", session: session.key, control: false },
        session,
      ),
    ).toBe("gateway");
  });

  it.each([
    [
      "cloud placement",
      {
        key: "agent:main:cloud",
        kind: "direct",
        updatedAt: 1,
        placement: { state: "active", environmentId: "worker:cloud-1" },
      } as GatewaySessionRow,
      "worker:cloud-1",
    ],
    [
      "execution node",
      {
        key: "agent:main:node",
        kind: "direct",
        updatedAt: 1,
        execNode: "workstation",
      } satisfies GatewaySessionRow,
      "node:workstation",
    ],
    [
      "gateway fallback",
      {
        key: "agent:main:gateway",
        kind: "direct",
        updatedAt: 1,
      } satisfies GatewaySessionRow,
      "gateway",
    ],
  ])("resolves a session's %s through the chat placement owner", (_label, session, expected) => {
    expect(
      resolveDesktopDocumentTarget({ source: null, session: session.key, control: false }, session),
    ).toBe(expected);
  });

  it("returns no target for an unknown session", () => {
    expect(
      resolveDesktopDocumentTarget(
        { source: null, session: "agent:main:missing", control: false },
        undefined,
      ),
    ).toBeNull();
  });
});
