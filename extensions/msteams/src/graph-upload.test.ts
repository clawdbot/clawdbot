import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { buildTeamsFileInfoCard } from "./graph-chat.js";
import { resolveGraphChatId, uploadToOneDrive, uploadToSharePoint } from "./graph-upload.js";

describe("graph upload helpers", () => {
  const tokenProvider = {
    getAccessToken: vi.fn(async () => "graph-token"),
  };

  it("uploads to OneDrive with the personal drive path", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: "item-1", webUrl: "https://example.com/1", name: "a.txt" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );

    const result = await uploadToOneDrive({
      buffer: Buffer.from("hello"),
      filename: "a.txt",
      tokenProvider,
      fetchFn: withFetchPreconnect(fetchFn),
    });

    expect(fetchFn).toHaveBeenCalledWith(
      "https://graph.microsoft.com/v1.0/me/drive/root:/OpenClawShared/a.txt:/content",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: "Bearer graph-token",
          "Content-Type": "application/octet-stream",
          "User-Agent": expect.stringMatching(/^teams\.ts\[apps\]\/.+ OpenClaw\/.+$/),
        }),
      }),
    );
    expect(result).toEqual({
      id: "item-1",
      webUrl: "https://example.com/1",
      name: "a.txt",
    });
  });

  it("uploads to SharePoint with the site drive path", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: "item-2", webUrl: "https://example.com/2", name: "b.txt" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );

    const result = await uploadToSharePoint({
      buffer: Buffer.from("world"),
      filename: "b.txt",
      siteId: "site-123",
      tokenProvider,
      fetchFn: withFetchPreconnect(fetchFn),
    });

    expect(fetchFn).toHaveBeenCalledWith(
      "https://graph.microsoft.com/v1.0/sites/site-123/drive/root:/OpenClawShared/b.txt:/content",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: "Bearer graph-token",
          "Content-Type": "application/octet-stream",
          "User-Agent": expect.stringMatching(/^teams\.ts\[apps\]\/.+ OpenClaw\/.+$/),
        }),
      }),
    );
    expect(result).toEqual({
      id: "item-2",
      webUrl: "https://example.com/2",
      name: "b.txt",
    });
  });

  it("rejects upload responses missing required fields", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "item-3" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(
      uploadToSharePoint({
        buffer: Buffer.from("world"),
        filename: "bad.txt",
        siteId: "site-123",
        tokenProvider,
        fetchFn: withFetchPreconnect(fetchFn),
      }),
    ).rejects.toThrow("SharePoint upload response missing required fields");
  });
});

describe("resolveGraphChatId", () => {
  const tokenProvider = {
    getAccessToken: vi.fn(async () => "graph-token"),
  };

  it("returns the ID directly when it already starts with 19:", async () => {
    const fetchFn = vi.fn();
    const result = await resolveGraphChatId({
      botFrameworkConversationId: "19:abc123@thread.tacv2",
      tokenProvider,
      fetchFn: withFetchPreconnect(fetchFn),
    });
    // Should short-circuit without making any API call
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result).toBe("19:abc123@thread.tacv2");
  });

  it("resolves personal DM chat ID via Graph API using user AAD object ID", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ value: [{ id: "19:dm-chat-id@unq.gbl.spaces" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await resolveGraphChatId({
      botFrameworkConversationId: "a:1abc_bot_framework_dm_id",
      userAadObjectId: "user-aad-object-id-123",
      tokenProvider,
      fetchFn: withFetchPreconnect(fetchFn),
    });

    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining("/me/chats"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer graph-token",
          "User-Agent": expect.stringMatching(/^teams\.ts\[apps\]\/.+ OpenClaw\/.+$/),
        }),
      }),
    );
    const firstCall = fetchFn.mock.calls[0];
    if (!firstCall) {
      throw new Error("expected Graph chat lookup request");
    }
    const [callUrlRaw] = firstCall as unknown as [string, RequestInit?];
    const callUrl = new URL(callUrlRaw);
    expect(callUrl.origin).toBe("https://graph.microsoft.com");
    expect(callUrl.pathname).toBe("/v1.0/me/chats");
    expect(callUrl.searchParams.get("$filter")).toBe(
      "chatType eq 'oneOnOne' and members/any(m:m/microsoft.graph.aadUserConversationMember/userId eq 'user-aad-object-id-123')",
    );
    expect(callUrl.searchParams.get("$select")).toBe("id");
    expect(result).toBe("19:dm-chat-id@unq.gbl.spaces");
  });

  it("resolves personal DM chat ID without user AAD object ID (lists all 1:1 chats)", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ value: [{ id: "19:fallback-chat@unq.gbl.spaces" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await resolveGraphChatId({
      botFrameworkConversationId: "8:orgid:user-object-id",
      tokenProvider,
      fetchFn: withFetchPreconnect(fetchFn),
    });

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(result).toBe("19:fallback-chat@unq.gbl.spaces");
  });

  it("returns null when Graph API returns no chats", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ value: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await resolveGraphChatId({
      botFrameworkConversationId: "a:1unknown_dm",
      userAadObjectId: "some-user",
      tokenProvider,
      fetchFn: withFetchPreconnect(fetchFn),
    });

    expect(result).toBeNull();
  });

  it("returns null when Graph API call fails", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response("Unauthorized", {
          status: 401,
          headers: { "content-type": "text/plain" },
        }),
    );

    const result = await resolveGraphChatId({
      botFrameworkConversationId: "a:1some_dm_id",
      userAadObjectId: "some-user",
      tokenProvider,
      fetchFn: withFetchPreconnect(fetchFn),
    });

    expect(result).toBeNull();
  });
});

describe("buildTeamsFileInfoCard", () => {
  it("extracts a unique id from quoted etags and lowercases file extensions", () => {
    expect(
      buildTeamsFileInfoCard({
        eTag: '"{ABC-123},42"',
        name: "Quarterly.Report.PDF",
        webDavUrl: "https://sharepoint.example.com/file.pdf",
      }),
    ).toEqual({
      contentType: "application/vnd.microsoft.teams.card.file.info",
      contentUrl: "https://sharepoint.example.com/file.pdf",
      name: "Quarterly.Report.PDF",
      content: {
        uniqueId: "ABC-123",
        fileType: "pdf",
      },
    });
  });

  it("keeps the raw etag when no version suffix exists and handles extensionless files", () => {
    expect(
      buildTeamsFileInfoCard({
        eTag: "plain-etag",
        name: "README",
        webDavUrl: "https://sharepoint.example.com/readme",
      }),
    ).toEqual({
      contentType: "application/vnd.microsoft.teams.card.file.info",
      contentUrl: "https://sharepoint.example.com/readme",
      name: "README",
      content: {
        uniqueId: "plain-etag",
        fileType: "",
      },
    });
  });
});
