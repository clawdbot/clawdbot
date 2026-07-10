// Plugin management descriptor tests keep read/admin scopes and write budgets explicit.
import { describe, expect, it } from "vitest";
import type { GatewayRequestHandler } from "../server-methods/types.js";
import { createCoreGatewayMethodDescriptors } from "./core-descriptors.js";

const handler: GatewayRequestHandler = ({ respond }) => respond(true, { ok: true });

describe("plugin management gateway descriptors", () => {
  it("keeps catalog reads separate from control-plane mutations", () => {
    const descriptors = createCoreGatewayMethodDescriptors({
      "plugins.list": handler,
      "plugins.search": handler,
      "plugins.install": handler,
      "plugins.setEnabled": handler,
      "plugins.uninstall": handler,
    });
    const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));

    expect(byName.get("plugins.list")?.scope).toBe("operator.read");
    expect(byName.get("plugins.search")?.scope).toBe("operator.read");
    expect(byName.get("plugins.install")).toMatchObject({
      scope: "operator.admin",
      controlPlaneWrite: true,
    });
    expect(byName.get("plugins.setEnabled")).toMatchObject({
      scope: "operator.admin",
      controlPlaneWrite: true,
    });
    expect(byName.get("plugins.uninstall")).toMatchObject({
      scope: "operator.admin",
      controlPlaneWrite: true,
    });
  });
});
