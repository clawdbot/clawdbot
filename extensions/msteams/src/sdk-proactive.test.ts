import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendMSTeamsActivityWithReference } from "./sdk-proactive.js";
import type { MSTeamsApp } from "./sdk.js";

const clientState = vi.hoisted(() => ({
  created: [] as Array<{ serviceUrl: string; http: unknown }>,
  create: vi.fn(async (_payload: { conversationId: string; activity: unknown }) => ({
    id: "activity-1",
  })),
}));

vi.mock("@microsoft/teams.api", () => ({
  Client: vi.fn(function MockClient(this: unknown, serviceUrl: string, http: unknown) {
    clientState.created.push({ serviceUrl, http });
    return {
      serviceUrl,
      conversations: {
        activities: (conversationId: string) => ({
          create: (activity: unknown) =>
            clientState.create({
              conversationId,
              activity,
            }),
        }),
      },
    };
  }),
}));

describe("sendMSTeamsActivityWithReference", () => {
  beforeEach(() => {
    clientState.created.length = 0;
    clientState.create.mockClear().mockResolvedValue({ id: "activity-1" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sends through a reference-scoped API client without the protected SDK activitySender", async () => {
    vi.stubEnv("SERVICE_URL", "https://bot.example.com/api/messages");
    const httpClient = { request: vi.fn() };
    const app = {
      client: httpClient,
      api: {
        serviceUrl: "https://smba.trafficmanager.net/teams",
        conversations: {
          activities: () => ({
            create: vi.fn(),
            update: vi.fn(),
            delete: vi.fn(),
          }),
        },
      },
    } as unknown as MSTeamsApp;

    const result = await sendMSTeamsActivityWithReference(
      app,
      {
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        agent: { id: "28:bot", name: "OpenClaw", role: "bot" },
        user: { id: "29:user", aadObjectId: "aad-user" },
        conversation: {
          id: "19:conversation@thread.tacv2",
          conversationType: "personal",
          tenantId: "tenant-1",
        },
        channelId: "msteams",
      },
      { type: "message", text: "hello" },
      { serviceUrlBoundary: { cloud: "Public" } },
    );

    expect(result).toMatchObject({ id: "activity-1" });
    expect(clientState.created).toEqual([
      {
        serviceUrl: "https://smba.trafficmanager.net/amer",
        http: httpClient,
      },
    ]);
    expect(clientState.create).toHaveBeenCalledWith({
      conversationId: "19:conversation@thread.tacv2",
      activity: expect.objectContaining({
        type: "message",
        text: "hello",
        from: { id: "28:bot", name: "OpenClaw", role: "bot" },
        conversation: {
          id: "19:conversation@thread.tacv2",
          conversationType: "personal",
          tenantId: "tenant-1",
        },
        channelData: { tenant: { id: "tenant-1" } },
      }),
    });
  });
});
