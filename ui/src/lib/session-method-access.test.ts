import { describe, expect, it } from "vitest";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { readSessionMethodAccess } from "./session-method-access.ts";

function snapshot(params: {
  connected?: boolean;
  methods?: string[];
  scopes?: string[];
  includeAuth?: boolean;
  includeScopes?: boolean;
}): Pick<ApplicationGatewaySnapshot, "client" | "hello" | "phase"> {
  const connected = params.connected ?? true;
  return {
    client: connected ? ({} as ApplicationGatewaySnapshot["client"]) : null,
    phase: connected ? "connected" : "offline",
    hello: {
      features: { methods: params.methods ?? ["sessions.create"] },
      ...(params.includeAuth === false
        ? {}
        : {
            auth: {
              role: "operator",
              ...(params.includeScopes === false
                ? {}
                : { scopes: params.scopes ?? ["operator.write"] }),
            },
          }),
    } as ApplicationGatewaySnapshot["hello"],
  };
}

describe("readSessionMethodAccess", () => {
  it("allows a write-scoped operator to create ordinary sessions", () => {
    expect(
      readSessionMethodAccess(snapshot({}), {
        method: "sessions.create",
        params: { agentId: "main" },
      }),
    ).toEqual({ allowed: true, requiredScope: "operator.write" });
  });

  it("requires admin for privileged create params", () => {
    const access = readSessionMethodAccess(snapshot({ scopes: ["operator.write"] }), {
      method: "sessions.create",
      params: { agentId: "main", incognito: true },
    });
    expect(access.allowed).toBe(false);
    expect(access).toMatchObject({
      cause: "missing-scope",
      requiredScope: "operator.admin",
    });
  });

  it("keeps model and effort patch access independent", () => {
    const writeOnly = snapshot({ methods: ["sessions.patch"], scopes: ["operator.write"] });
    expect(
      readSessionMethodAccess(writeOnly, {
        method: "sessions.patch",
        params: { key: "agent:main:main", model: null },
      }),
    ).toEqual({ allowed: true, requiredScope: "operator.write" });
    expect(
      readSessionMethodAccess(writeOnly, {
        method: "sessions.patch",
        params: { key: "agent:main:main", thinkingLevel: null },
      }),
    ).toMatchObject({
      allowed: false,
      cause: "missing-scope",
      requiredScope: "operator.admin",
    });
  });

  it("allows admin to satisfy write-scoped actions", () => {
    expect(
      readSessionMethodAccess(
        snapshot({ methods: ["sessions.groups.put"], scopes: ["operator.admin"] }),
        { method: "sessions.groups.put", requiredScope: "operator.write" },
      ).allowed,
    ).toBe(true);
  });

  it("allows read, write, and admin scopes to satisfy read-scoped actions", () => {
    for (const scope of ["operator.read", "operator.write", "operator.admin"]) {
      expect(
        readSessionMethodAccess(snapshot({ methods: ["session.members.list"], scopes: [scope] }), {
          method: "session.members.list",
          requiredScope: "operator.read",
        }).allowed,
      ).toBe(true);
    }
  });

  it("rejects a read-scoped action without a compatible operator scope", () => {
    expect(
      readSessionMethodAccess(
        snapshot({ methods: ["session.members.list"], scopes: ["operator.approvals"] }),
        { method: "session.members.list", requiredScope: "operator.read" },
      ),
    ).toMatchObject({
      allowed: false,
      cause: "missing-scope",
      requiredScope: "operator.read",
    });
  });

  it.each([
    ["auth", { includeAuth: false }],
    ["scopes", { includeScopes: false }],
  ])("rejects snapshots without advertised %s", (_name, params) => {
    expect(
      readSessionMethodAccess(snapshot(params), {
        method: "sessions.create",
        params: { agentId: "main" },
      }),
    ).toMatchObject({ allowed: false, cause: "missing-scope" });
  });

  it("rejects disconnected and unadvertised calls before scope checks", () => {
    expect(
      readSessionMethodAccess(snapshot({ connected: false }), {
        method: "sessions.create",
      }),
    ).toMatchObject({ allowed: false, cause: "disconnected" });
    expect(
      readSessionMethodAccess(snapshot({ methods: [] }), { method: "sessions.create" }),
    ).toMatchObject({ allowed: false, cause: "method-unavailable" });
  });

  it("rejects snapshots without method metadata", () => {
    const incomplete = snapshot({});
    incomplete.hello = { auth: incomplete.hello?.auth } as ApplicationGatewaySnapshot["hello"];
    expect(
      readSessionMethodAccess(incomplete, {
        method: "sessions.groups.put",
        requiredScope: "operator.write",
      }),
    ).toMatchObject({ allowed: false, cause: "method-unavailable" });
  });
});
