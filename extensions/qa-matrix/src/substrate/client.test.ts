import { describe, expect, it } from "vitest";
import { __testing, createMatrixQaClient, provisionMatrixQaRoom } from "./client.js";
import { buildDefaultMatrixQaTopologySpec } from "./topology.js";

function resolveRequestUrl(input: RequestInfo | URL) {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function parseJsonRequestBody(init?: RequestInit) {
  if (typeof init?.body !== "string") {
    return {};
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("matrix driver client", () => {
  it("builds Matrix HTML mentions for QA driver messages", () => {
    expect(
      __testing.buildMatrixQaMessageContent({
        body: "@sut:matrix-qa.test reply with exactly: TOKEN",
        mentionUserIds: ["@sut:matrix-qa.test"],
      }),
    ).toEqual({
      body: "@sut:matrix-qa.test reply with exactly: TOKEN",
      msgtype: "m.text",
      format: "org.matrix.custom.html",
      formatted_body:
        '<a href="https://matrix.to/#/%40sut%3Amatrix-qa.test">@sut:matrix-qa.test</a> reply with exactly: TOKEN',
      "m.mentions": {
        user_ids: ["@sut:matrix-qa.test"],
      },
    });
  });

  it("omits Matrix HTML markup when the body has no visible mention token", () => {
    expect(
      __testing.buildMatrixQaMessageContent({
        body: "reply with exactly: TOKEN",
        mentionUserIds: ["@sut:matrix-qa.test"],
      }),
    ).toEqual({
      body: "reply with exactly: TOKEN",
      msgtype: "m.text",
      "m.mentions": {
        user_ids: ["@sut:matrix-qa.test"],
      },
    });
  });

  it("builds trimmed Matrix reaction relations for QA driver events", () => {
    expect(__testing.buildMatrixReactionRelation(" $msg-1 ", " 👍 ")).toEqual({
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: "$msg-1",
        key: "👍",
      },
    });
  });

  it("builds Matrix replacement messages with replacement-local mention metadata", () => {
    expect(
      __testing.buildMatrixQaReplacementMessageContent({
        body: "@sut:matrix-qa.test updated prompt",
        mentionUserIds: ["@sut:matrix-qa.test"],
        targetEventId: " $msg-1 ",
      }),
    ).toEqual({
      body: "* @sut:matrix-qa.test updated prompt",
      msgtype: "m.text",
      "m.new_content": {
        body: "@sut:matrix-qa.test updated prompt",
        msgtype: "m.text",
        format: "org.matrix.custom.html",
        formatted_body:
          '<a href="https://matrix.to/#/%40sut%3Amatrix-qa.test">@sut:matrix-qa.test</a> updated prompt',
        "m.mentions": {
          user_ids: ["@sut:matrix-qa.test"],
        },
      },
      "m.relates_to": {
        rel_type: "m.replace",
        event_id: "$msg-1",
      },
    });
  });

  it("advances Matrix registration through token then dummy auth stages", () => {
    const firstStage = __testing.resolveNextRegistrationAuth({
      registrationToken: "reg-token",
      response: {
        session: "uiaa-session",
        flows: [{ stages: ["m.login.registration_token", "m.login.dummy"] }],
      },
    });

    expect(firstStage).toEqual({
      session: "uiaa-session",
      type: "m.login.registration_token",
      token: "reg-token",
    });

    expect(
      __testing.resolveNextRegistrationAuth({
        registrationToken: "reg-token",
        response: {
          session: "uiaa-session",
          completed: ["m.login.registration_token"],
          flows: [{ stages: ["m.login.registration_token", "m.login.dummy"] }],
        },
      }),
    ).toEqual({
      session: "uiaa-session",
      type: "m.login.dummy",
    });
  });

  it("rejects Matrix UIAA flows that require unsupported stages", () => {
    expect(() =>
      __testing.resolveNextRegistrationAuth({
        registrationToken: "reg-token",
        response: {
          session: "uiaa-session",
          flows: [{ stages: ["m.login.registration_token", "m.login.recaptcha", "m.login.dummy"] }],
        },
      }),
    ).toThrow("Matrix registration requires unsupported auth stages:");
  });

  it("logs in with Matrix password auth to create a secondary QA device", async () => {
    const requests: Array<{ body: Record<string, unknown>; url: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({
        body: parseJsonRequestBody(init),
        url: resolveRequestUrl(input),
      });
      return new Response(
        JSON.stringify({
          access_token: "secondary-token",
          device_id: "SECONDARYDEVICE",
          user_id: "@qa-driver:matrix-qa.test",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const client = createMatrixQaClient({
      baseUrl: "http://127.0.0.1:28008/",
      fetchImpl,
    });

    await expect(
      client.loginWithPassword({
        deviceName: "OpenClaw Matrix QA Stale Device",
        password: "driver-password",
        userId: "@qa-driver:matrix-qa.test",
      }),
    ).resolves.toMatchObject({
      accessToken: "secondary-token",
      deviceId: "SECONDARYDEVICE",
      password: "driver-password",
      userId: "@qa-driver:matrix-qa.test",
    });

    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:28008/_matrix/client/v3/login",
        body: {
          type: "m.login.password",
          identifier: {
            type: "m.id.user",
            user: "@qa-driver:matrix-qa.test",
          },
          initial_device_display_name: "OpenClaw Matrix QA Stale Device",
          password: "driver-password",
        },
      },
    ]);
  });

  it("issues Matrix room membership control requests for QA topology changes", async () => {
    const requests: Array<{ body: Record<string, unknown>; url: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({
        body: parseJsonRequestBody(init),
        url: resolveRequestUrl(input),
      });
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = createMatrixQaClient({
      accessToken: "token",
      baseUrl: "http://127.0.0.1:28008/",
      fetchImpl,
    });

    await client.inviteUserToRoom({
      roomId: "!room:matrix-qa.test",
      userId: "@observer:matrix-qa.test",
    });
    await client.kickUserFromRoom({
      reason: "topology reset",
      roomId: "!room:matrix-qa.test",
      userId: "@observer:matrix-qa.test",
    });
    await client.leaveRoom("!room:matrix-qa.test");

    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:28008/_matrix/client/v3/rooms/!room%3Amatrix-qa.test/invite",
        body: {
          user_id: "@observer:matrix-qa.test",
        },
      },
      {
        url: "http://127.0.0.1:28008/_matrix/client/v3/rooms/!room%3Amatrix-qa.test/kick",
        body: {
          reason: "topology reset",
          user_id: "@observer:matrix-qa.test",
        },
      },
      {
        url: "http://127.0.0.1:28008/_matrix/client/v3/rooms/!room%3Amatrix-qa.test/leave",
        body: {},
      },
    ]);
  });

  it("sends Matrix reactions through the protocol send endpoint", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(resolveRequestUrl(input)).toContain(
        "/_matrix/client/v3/rooms/!room%3Amatrix-qa.test/send/m.reaction/",
      );
      expect(parseJsonRequestBody(init)).toEqual({
        "m.relates_to": {
          rel_type: "m.annotation",
          event_id: "$msg-1",
          key: "👍",
        },
      });
      return new Response(JSON.stringify({ event_id: "$reaction-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = createMatrixQaClient({
      accessToken: "token",
      baseUrl: "http://127.0.0.1:28008/",
      fetchImpl,
    });

    await expect(
      client.sendReaction({
        emoji: "👍",
        messageId: "$msg-1",
        roomId: "!room:matrix-qa.test",
      }),
    ).resolves.toBe("$reaction-1");
  });

  it("sends Matrix replacements and redactions through protocol endpoints", async () => {
    const requests: Array<{ body: Record<string, unknown>; url: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({
        body: parseJsonRequestBody(init),
        url: resolveRequestUrl(input),
      });
      const eventId = requests.length === 1 ? "$replacement-1" : "$redaction-1";
      return new Response(JSON.stringify({ event_id: eventId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = createMatrixQaClient({
      accessToken: "token",
      baseUrl: "http://127.0.0.1:28008/",
      fetchImpl,
    });

    await expect(
      client.sendReplacementMessage({
        body: "@sut:matrix-qa.test updated prompt",
        mentionUserIds: ["@sut:matrix-qa.test"],
        roomId: "!room:matrix-qa.test",
        targetEventId: "$msg-1",
      }),
    ).resolves.toBe("$replacement-1");
    await expect(
      client.redactEvent({
        eventId: "$reaction-1",
        reason: "qa cleanup",
        roomId: "!room:matrix-qa.test",
      }),
    ).resolves.toBe("$redaction-1");

    expect(requests[0]?.url).toContain(
      "/_matrix/client/v3/rooms/!room%3Amatrix-qa.test/send/m.room.message/",
    );
    expect(requests[0]?.body).toMatchObject({
      "m.relates_to": {
        rel_type: "m.replace",
        event_id: "$msg-1",
      },
    });
    expect(requests[1]?.url).toMatch(
      /^http:\/\/127\.0\.0\.1:28008\/_matrix\/client\/v3\/rooms\/!room%3Amatrix-qa\.test\/redact\/%24reaction-1\/[0-9a-f-]{36}$/,
    );
    expect(requests[1]?.body).toEqual({
      reason: "qa cleanup",
    });
  });

  it("uploads Matrix media before sending the room event", async () => {
    const requests: Array<{
      body: RequestInit["body"];
      headers: HeadersInit | undefined;
      url: string;
    }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({
        body: init?.body,
        headers: init?.headers,
        url: resolveRequestUrl(input),
      });
      if (requests.length === 1) {
        return new Response(
          JSON.stringify({ content_uri: "mxc://matrix-qa.test/red-top-blue-bottom" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ event_id: "$media-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = createMatrixQaClient({
      accessToken: "token",
      baseUrl: "http://127.0.0.1:28008/",
      fetchImpl,
    });

    await expect(
      client.sendMediaMessage({
        body: "@sut:matrix-qa.test Image understanding check",
        buffer: Buffer.from("png-bytes"),
        contentType: "image/png",
        fileName: "red-top-blue-bottom.png",
        kind: "image",
        mentionUserIds: ["@sut:matrix-qa.test"],
        roomId: "!room:matrix-qa.test",
      }),
    ).resolves.toBe("$media-1");

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(
      "http://127.0.0.1:28008/_matrix/media/v3/upload?filename=red-top-blue-bottom.png",
    );
    expect(requests[0]?.body).toBeInstanceOf(Uint8Array);
    expect(Array.from(requests[0]?.body as Uint8Array)).toEqual(
      Array.from(Buffer.from("png-bytes")),
    );
    expect(requests[1]?.url).toContain(
      "/_matrix/client/v3/rooms/!room%3Amatrix-qa.test/send/m.room.message/",
    );
    expect(
      typeof requests[1]?.body === "string" ? JSON.parse(requests[1].body) : requests[1]?.body,
    ).toMatchObject({
      body: "@sut:matrix-qa.test Image understanding check",
      msgtype: "m.image",
      filename: "red-top-blue-bottom.png",
      url: "mxc://matrix-qa.test/red-top-blue-bottom",
      info: {
        mimetype: "image/png",
        size: "png-bytes".length,
      },
      "m.mentions": {
        user_ids: ["@sut:matrix-qa.test"],
      },
    });
  });

  it("adds Matrix room encryption state when provisioning encrypted QA rooms", async () => {
    const createRoomBodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      createRoomBodies.push(parseJsonRequestBody(init));
      expect(resolveRequestUrl(input)).toBe("http://127.0.0.1:28008/_matrix/client/v3/createRoom");
      return new Response(JSON.stringify({ room_id: "!encrypted:matrix-qa.test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = createMatrixQaClient({
      accessToken: "token",
      baseUrl: "http://127.0.0.1:28008/",
      fetchImpl,
    });

    await expect(
      client.createPrivateRoom({
        encrypted: true,
        inviteUserIds: ["@sut:matrix-qa.test"],
        name: "Encrypted QA Room",
      }),
    ).resolves.toBe("!encrypted:matrix-qa.test");

    expect(createRoomBodies[0]?.initial_state).toContainEqual({
      type: "m.room.encryption",
      state_key: "",
      content: { algorithm: "m.megolm.v1.aes-sha2" },
    });
  });

  it("provisions a three-member room so Matrix QA runs in a group context", async () => {
    const createRoomBodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = resolveRequestUrl(input);
      const body = parseJsonRequestBody(init);
      if (url.endsWith("/_matrix/client/v3/register")) {
        const username = typeof body.username === "string" ? body.username : "";
        const auth = typeof body.auth === "object" && body.auth ? body.auth : undefined;
        if (!auth) {
          return new Response(
            JSON.stringify({
              session: `session-${username}`,
              flows: [{ stages: ["m.login.registration_token", "m.login.dummy"] }],
            }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
        }
        if ((auth as { type?: string }).type === "m.login.registration_token") {
          return new Response(
            JSON.stringify({
              session: `session-${username}`,
              completed: ["m.login.registration_token"],
              flows: [{ stages: ["m.login.registration_token", "m.login.dummy"] }],
            }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            access_token: `token-${username}`,
            device_id: `device-${username}`,
            user_id: `@${username}:matrix-qa.test`,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/_matrix/client/v3/createRoom")) {
        createRoomBodies.push(body);
        return new Response(JSON.stringify({ room_id: "!room:matrix-qa.test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/_matrix/client/v3/join/")) {
        return new Response(JSON.stringify({ room_id: "!room:matrix-qa.test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const result = await provisionMatrixQaRoom({
      baseUrl: "http://127.0.0.1:28008/",
      driverLocalpart: "qa-driver",
      observerLocalpart: "qa-observer",
      registrationToken: "reg-token",
      roomName: "OpenClaw Matrix QA",
      sutLocalpart: "qa-sut",
      fetchImpl,
      topology: buildDefaultMatrixQaTopologySpec({
        defaultRoomName: "OpenClaw Matrix QA",
      }),
    });

    expect(result.roomId).toBe("!room:matrix-qa.test");
    expect(result.topology).toEqual({
      defaultRoomId: "!room:matrix-qa.test",
      defaultRoomKey: "main",
      rooms: [
        {
          key: "main",
          kind: "group",
          memberRoles: ["driver", "observer", "sut"],
          memberUserIds: [
            "@qa-driver:matrix-qa.test",
            "@qa-observer:matrix-qa.test",
            "@qa-sut:matrix-qa.test",
          ],
          requireMention: true,
          roomId: "!room:matrix-qa.test",
          name: "OpenClaw Matrix QA",
          encrypted: false,
        },
      ],
    });
    expect(result.observer.userId).toBe("@qa-observer:matrix-qa.test");
    expect(createRoomBodies).toEqual([
      {
        creation_content: { "m.federate": false },
        initial_state: [
          {
            type: "m.room.history_visibility",
            state_key: "",
            content: { history_visibility: "joined" },
          },
        ],
        invite: ["@qa-observer:matrix-qa.test", "@qa-sut:matrix-qa.test"],
        is_direct: false,
        name: "OpenClaw Matrix QA",
        preset: "private_chat",
      },
    ]);
  });

  it("provisions direct-message topology rooms with Matrix direct-room flags", async () => {
    const createRoomBodies: Array<Record<string, unknown>> = [];
    const roomIds = ["!group:matrix-qa.test", "!dm:matrix-qa.test"];
    let registerCount = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = resolveRequestUrl(input);
      const body = parseJsonRequestBody(init);
      if (url.endsWith("/_matrix/client/v3/register")) {
        registerCount += 1;
        const role = ["driver", "sut", "observer"][registerCount - 1];
        return new Response(
          JSON.stringify({
            access_token: `token-${role}`,
            user_id: `@qa-${role}:matrix-qa.test`,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/_matrix/client/v3/createRoom")) {
        createRoomBodies.push(body);
        return new Response(JSON.stringify({ room_id: roomIds.shift() }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/_matrix/client/v3/join/")) {
        return new Response(JSON.stringify({ room_id: "!joined:matrix-qa.test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const result = await provisionMatrixQaRoom({
      baseUrl: "http://127.0.0.1:28008/",
      driverLocalpart: "qa-driver",
      observerLocalpart: "qa-observer",
      registrationToken: "reg-token",
      roomName: "unused",
      sutLocalpart: "qa-sut",
      fetchImpl,
      topology: {
        defaultRoomKey: "group",
        rooms: [
          {
            key: "group",
            kind: "group",
            members: ["driver", "observer", "sut"],
            name: "Matrix Group",
            requireMention: true,
          },
          {
            key: "sut-dm",
            kind: "dm",
            members: ["driver", "sut"],
            name: "Matrix Driver/SUT DM",
          },
        ],
      },
    });

    expect(result.topology.rooms).toEqual([
      {
        encrypted: false,
        key: "group",
        kind: "group",
        memberRoles: ["driver", "observer", "sut"],
        memberUserIds: [
          "@qa-driver:matrix-qa.test",
          "@qa-observer:matrix-qa.test",
          "@qa-sut:matrix-qa.test",
        ],
        name: "Matrix Group",
        requireMention: true,
        roomId: "!group:matrix-qa.test",
      },
      {
        encrypted: false,
        key: "sut-dm",
        kind: "dm",
        memberRoles: ["driver", "sut"],
        memberUserIds: ["@qa-driver:matrix-qa.test", "@qa-sut:matrix-qa.test"],
        name: "Matrix Driver/SUT DM",
        requireMention: false,
        roomId: "!dm:matrix-qa.test",
      },
    ]);
    expect(createRoomBodies).toEqual([
      {
        creation_content: { "m.federate": false },
        initial_state: [
          {
            type: "m.room.history_visibility",
            state_key: "",
            content: { history_visibility: "joined" },
          },
        ],
        invite: ["@qa-observer:matrix-qa.test", "@qa-sut:matrix-qa.test"],
        is_direct: false,
        name: "Matrix Group",
        preset: "private_chat",
      },
      {
        creation_content: { "m.federate": false },
        initial_state: [
          {
            type: "m.room.history_visibility",
            state_key: "",
            content: { history_visibility: "joined" },
          },
        ],
        invite: ["@qa-sut:matrix-qa.test"],
        is_direct: true,
        name: "Matrix Driver/SUT DM",
        preset: "private_chat",
      },
    ]);
  });
});
