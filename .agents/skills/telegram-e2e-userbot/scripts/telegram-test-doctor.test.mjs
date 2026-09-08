import assert from "node:assert/strict";
import test from "node:test";
import { runTelegramTestDoctor } from "./telegram-test-doctor.mjs";

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
  const credential = {
    driverEnv: {},
    groupId: "-1001",
    sutBotId: "42",
    sutToken: "sut-token",
    sutUsername: "sut_bot",
    tdlibVersion: "1.8.56",
    testerUserId: "123",
    whenLeaseUnhealthy,
    assertLeaseHealthy: () => {
      if (!healthy) throw leaseError;
    },
    release: async () => {
      released = true;
    },
  };
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
      runCommandImpl: async () => ({
        status: 0,
        stdout: JSON.stringify({
          ok: true,
          authorized: true,
          testDc: true,
          tdlibVersion: "1.8.56",
          user: { id: 123 },
        }),
        stderr: "",
        timedOut: false,
      }),
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
