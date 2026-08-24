// Microsoft Teams process coverage protects real SDK CommonJS import ordering.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("sendMSTeamsActivityWithReference SDK import ordering", () => {
  it("keeps root exports intact when quoted behavior is the first SDK access", async () => {
    const proactiveModuleUrl = new URL("./sdk-proactive.ts", import.meta.url).href;
    const fixture = `
      import assert from "node:assert/strict";

      const { sendMSTeamsActivityWithReference } =
        await import(process.env.OPENCLAW_MSTEAMS_PROACTIVE_MODULE);
      const quotedCreates = [];
      const posts = [];
      const app = {
        client: {
          request: async () => ({}),
          post: async (url, activity) => {
            posts.push({ url, activity });
            return { data: { id: "normal-proactive" } };
          },
        },
        api: {
          serviceUrl: "https://smba.trafficmanager.net/amer",
          conversations: {
            activities: () => ({
              create: async (activity) => {
                quotedCreates.push(activity);
                return { id: "quoted-replay" };
              },
              update: async () => ({}),
              delete: async () => ({}),
            }),
          },
        },
      };
      const reference = {
        agent: { id: "28:bot", role: "bot" },
        user: { id: "29:user" },
        conversation: {
          id: "19:conversation@thread.v2",
          conversationType: "groupChat",
        },
      };

      // The structural app selects the quote path without loading the full Teams app first.
      await sendMSTeamsActivityWithReference(
        app,
        { ...reference, serviceUrl: "https://smba.trafficmanager.net/amer" },
        { type: "message", text: "Recovered reply" },
        { quoteActivityId: "incoming-activity" },
      );
      assert.equal(
        quotedCreates[0].text,
        '<quoted messageId="incoming-activity"/> Recovered reply',
      );

      const api = await import("@microsoft/teams.api");
      assert.equal(typeof api.Client, "function");
      assert.equal(typeof api.MessageActivityInput, "function");
      assert.equal(typeof api.toActivityParams, "function");
      assert.doesNotThrow(() =>
        api.toActivityParams({ type: "message", text: "Direct conversion" }),
      );

      await assert.doesNotReject(() =>
        sendMSTeamsActivityWithReference(
          app,
          { ...reference, serviceUrl: "https://smba.trafficmanager.net/teams" },
          { type: "message", text: "Normal send" },
        ),
      );
      assert.equal(posts.length, 1);
      assert.equal(
        posts[0].url,
        "https://smba.trafficmanager.net/teams/v3/conversations/19:conversation@thread.v2/activities",
      );
      assert.equal(posts[0].activity.text, "Normal send");
      process.stdout.write("root-sdk-ok");
    `;

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", fixture],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_DISABLE_COMPILE_CACHE: "1",
          OPENCLAW_MSTEAMS_PROACTIVE_MODULE: proactiveModuleUrl,
          VITEST: undefined,
        },
      },
    );

    expect(stderr).toBe("");
    expect(stdout).toBe("root-sdk-ok");
  });
});
