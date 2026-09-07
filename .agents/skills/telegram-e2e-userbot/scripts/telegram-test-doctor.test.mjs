import assert from "node:assert/strict";
import test from "node:test";
import { runTelegramTestDoctor } from "./telegram-test-doctor.mjs";

function credentialFixture(overrides = {}) {
  return {
    driverEnv: {},
    groupId: "-1001",
    sutBotId: "42",
    sutToken: "sut-token",
    sutUsername: "sut_bot",
    tdlibVersion: "1.8.67",
    testerUserId: "123",
    whenLeaseUnhealthy: new Promise(() => {}),
    assertLeaseHealthy() {},
    async release() {},
    ...overrides,
  };
}

function statusFixture(overrides = {}, resultOverrides = {}) {
  return {
    status: 0,
    stdout: JSON.stringify({
      ok: true,
      authorized: true,
      testDc: true,
      tdlibVersion: "1.8.67",
      user: { id: 123 },
      testerGroupMembership: true,
      testerCanSendBasicMessages: true,
      ...overrides,
    }),
    stderr: "",
    timedOut: false,
    ...resultOverrides,
  };
}

function botApiFixture({ membershipStatus = "member", onGetMe } = {}) {
  const methods = [];
  const fetchImpl = async (url) => {
    const method = new URL(url).pathname.split("/").at(-1);
    methods.push(method);
    if (method === "getMe") {
      onGetMe?.();
      return Response.json({
        ok: true,
        result: {
          id: 42,
          username: "sut_bot",
          can_read_all_group_messages: true,
        },
      });
    }
    return Response.json({ ok: true, result: { status: membershipStatus } });
  };
  return { fetchImpl, methods };
}

test("doctor revocation after getMe prevents later Bot API calls and releases", async () => {
  const leaseError = new Error("doctor lease revoked");
  let healthy = true;
  let revoke;
  let released = false;
  let proxyClosed = false;
  const methods = [];
  const whenLeaseUnhealthy = new Promise((resolve) => {
    revoke = () => {
      healthy = false;
      resolve(leaseError);
    };
  });
  const credential = credentialFixture({
    whenLeaseUnhealthy,
    assertLeaseHealthy: () => {
      if (!healthy) throw leaseError;
    },
    release: async () => {
      released = true;
    },
  });
  const fetchImpl = async (url) => {
    methods.push(new URL(url).pathname.split("/").at(-1));
    return {
      ok: true,
      status: 200,
      json: async () => {
        revoke();
        return {
          ok: true,
          result: {
            id: 42,
            username: "sut_bot",
            can_read_all_group_messages: true,
          },
        };
      },
    };
  };

  await assert.rejects(
    runTelegramTestDoctor({
      acquireCredential: async () => credential,
      fetchImpl,
      runCommandImpl: async () => statusFixture(),
      startProxy: async () => ({
        apiRoot: "http://127.0.0.1:19881",
        close: async () => {
          proxyClosed = true;
        },
      }),
    }),
    (error) => error === leaseError,
  );
  assert.deepEqual(methods, ["getMe"]);
  assert.equal(proxyClosed, true);
  assert.equal(released, true);
});

test("doctor preserves tester writability diagnostics and releases", async () => {
  let released = false;
  let proxyClosed = false;
  const { fetchImpl, methods } = botApiFixture();
  const result = await runTelegramTestDoctor({
    acquireCredential: async () =>
      credentialFixture({
        release: async () => {
          released = true;
        },
      }),
    fetchImpl,
    runCommandImpl: async (_command, args) => {
      assert.deepEqual(args.slice(-4), ["status", "--json", "--chat", "-1001"]);
      return statusFixture(
        {
          ok: false,
          testerGroupMembership: true,
          testerCanSendBasicMessages: false,
        },
        { status: 1 },
      );
    },
    startProxy: async () => ({
      apiRoot: "http://127.0.0.1:19881",
      close: async () => {
        proxyClosed = true;
      },
    }),
  });

  assert.deepEqual(methods, ["getMe", "getChatMember"]);
  assert.deepEqual(result, {
    ok: false,
    credentialSource: "convex",
    credentialLoaded: true,
    isolatedTdlibState: true,
    testDc: true,
    tdlibAuthorized: true,
    botApiProxy: true,
    sutBot: true,
    groupPrivacyDisabled: true,
    groupMembership: true,
    testerGroupMembership: true,
    testerCanSendBasicMessages: false,
  });
  assert.equal(proxyClosed, true);
  assert.equal(released, true);
});

test("doctor preserves operational user status failures and releases", async () => {
  let released = false;
  await assert.rejects(
    runTelegramTestDoctor({
      acquireCredential: async () =>
        credentialFixture({
          release: async () => {
            released = true;
          },
        }),
      runCommandImpl: async () => ({
        status: 1,
        stdout: "",
        stderr: "searchPublicChat failed (500): unavailable",
        timedOut: false,
      }),
      startProxy: async () => assert.fail("proxy must not start"),
    }),
    /searchPublicChat failed \(500\): unavailable/u,
  );
  assert.equal(released, true);
});
