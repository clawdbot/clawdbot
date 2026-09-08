import type { UsersListResult } from "../../../packages/gateway-protocol/src/schema/users.js";
import { createContext, createGatewayHarness, createSessions } from "./app-sidebar.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "./gateway-client.ts";

export function sessionOwnerProfiles(...names: string[]): UsersListResult {
  return {
    profiles: names.map((displayName) => ({
      id: `profile-${displayName.toLowerCase().replaceAll(" ", "-")}`,
      displayName,
      avatarMime: null,
      mergedInto: null,
      createdAt: 1,
      updatedAt: 1,
      emails: [],
      githubIdentity: null,
      hasAvatar: false,
    })),
  };
}

export function createSessionOwnerMenuHarness(
  requestHandler: GatewayRequestHandler = () => sessionOwnerProfiles("Ada"),
  agentName = "Research",
) {
  const request = createGatewayRequestMock(requestHandler);
  const gateway = createGatewayHarness(createTestGatewayClient(request));
  gateway.publish({ selfUser: { id: "profile-ada", name: "Ada" } });
  const context = createContext(gateway.gateway, createSessions("main", []), {
    defaultId: "main",
    mainKey: "main",
    scope: "per-sender",
    agents: [{ id: "research:one", name: agentName }],
  });
  return { context, request, publish: gateway.publish.bind(gateway) };
}
