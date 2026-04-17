import { describe, expect, it } from "vitest";
import {
  collectMattermostSlashCallbackPaths,
  resolveMattermostGatewayAuthBypassPaths,
} from "./gateway-auth-bypass.js";

describe("Mattermost gateway auth bypass paths", () => {
  it("normalizes slash callback paths and callback URL paths", () => {
    expect(
      collectMattermostSlashCallbackPaths({
        callbackPath: "api/channels/mattermost/command",
        callbackUrl: "https://gateway.example.com/api/channels/mattermost/custom",
      }),
    ).toEqual(["/api/channels/mattermost/command", "/api/channels/mattermost/custom"]);
  });

  it("keeps only Mattermost channel callback paths", () => {
    expect(
      resolveMattermostGatewayAuthBypassPaths({
        channels: {
          mattermost: {
            commands: {
              callbackPath: "/api/channels/mattermost/command",
              callbackUrl: "https://gateway.example.com/api/channels/nostr/default/profile",
            },
            accounts: {
              work: {
                commands: {
                  callbackPath: "/api/channels/mattermost/work",
                },
              },
            },
          },
        },
      }),
    ).toEqual(["/api/channels/mattermost/command", "/api/channels/mattermost/work"]);
  });
});
