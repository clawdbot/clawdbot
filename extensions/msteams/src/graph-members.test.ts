import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { getMemberInfoMSTeams } from "./graph-members.js";

const mockState = vi.hoisted(() => ({
  resolveGraphToken: vi.fn(),
  fetchGraphJson: vi.fn(),
}));

vi.mock("./graph.js", () => {
  return {
    resolveGraphToken: mockState.resolveGraphToken,
    fetchGraphJson: mockState.fetchGraphJson,
  };
});

const TOKEN = "test-graph-token";

describe("getMemberInfoMSTeams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.resolveGraphToken.mockResolvedValue(TOKEN);
  });

  it("fetches user profile and maps all fields", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      id: "user-123",
      displayName: "Alice Smith",
      mail: "alice@contoso.com",
      jobTitle: "Engineer",
      userPrincipalName: "alice@contoso.com",
      officeLocation: "Building 1",
    });

    const result = await getMemberInfoMSTeams({
      cfg: {} as OpenClawConfig,
      userId: "user-123",
    });

    expect(result).toEqual({
      user: {
        id: "user-123",
        displayName: "Alice Smith",
        mail: "alice@contoso.com",
        jobTitle: "Engineer",
        userPrincipalName: "alice@contoso.com",
        officeLocation: "Building 1",
      },
    });
    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/users/${encodeURIComponent("user-123")}?$select=id,displayName,mail,jobTitle,userPrincipalName,officeLocation`,
    });
  });

  it("handles sparse data with some fields undefined", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      id: "user-456",
      displayName: "Bob",
    });

    const result = await getMemberInfoMSTeams({
      cfg: {} as OpenClawConfig,
      userId: "user-456",
    });

    expect(result).toEqual({
      user: {
        id: "user-456",
        displayName: "Bob",
        mail: undefined,
        jobTitle: undefined,
        userPrincipalName: undefined,
        officeLocation: undefined,
      },
    });
  });

  it("propagates Graph API errors", async () => {
    mockState.fetchGraphJson.mockRejectedValue(new Error("Graph API 404: user not found"));

    await expect(
      getMemberInfoMSTeams({
        cfg: {} as OpenClawConfig,
        userId: "nonexistent-user",
      }),
    ).rejects.toThrow("Graph API 404: user not found");
  });
});
