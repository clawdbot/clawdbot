// Microsoft Teams process coverage protects real SDK CommonJS import ordering.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("sendMSTeamsActivityWithReference SDK import ordering", () => {
  it("keeps root exports intact when quoted behavior is the first SDK access", async () => {
    await execFileAsync(
      process.execPath,
      ["scripts/lib/plugin-npm-runtime-build.mjs", "extensions/msteams"],
      { cwd: process.cwd() },
    );
    const outDir = path.join(process.cwd(), "extensions/msteams/dist");
    const proactiveArtifact = fs
      .readdirSync(outDir)
      .filter((entry) => entry.endsWith(".cjs"))
      .map((entry) => path.join(outDir, entry))
      .find((entry) =>
        fs
          .readFileSync(entry, "utf8")
          .includes('Object.defineProperty(exports, "sendMSTeamsActivityWithReference"'),
      );
    if (!proactiveArtifact) {
      throw new Error("Microsoft Teams CommonJS runtime omitted the proactive send helper");
    }
    const proactiveArtifactSource = fs.readFileSync(proactiveArtifact, "utf8");
    expect(proactiveArtifactSource).toContain('import("@microsoft/teams.api")');
    expect(proactiveArtifactSource).not.toContain("@microsoft/teams.api/dist/");

    const fixture = `
      import assert from "node:assert/strict";
      import { createRequire } from "node:module";

      const require = createRequire(import.meta.url);
      const Module = require("node:module");
      const originalLoad = Module._load;
      const universalStub = new Proxy(
        function universalStub() {
          return universalStub;
        },
        {
          apply: () => universalStub,
          construct: () => universalStub,
          get: () => universalStub,
        },
      );
      const hostSdkStub = new Proxy(
        {},
        {
          get: (_target, key) => {
            if (key === "createLazyRuntimeModule") {
              return (importer) => {
                let pending;
                return () => (pending ??= importer());
              };
            }
            if (key === "getOrCreateGlobalSingleton") {
              return (_key, create) => create();
            }
            return universalStub;
          },
        },
      );
      // The built plugin expects an installed OpenClaw host. Stub unrelated host SDK exports so
      // this child isolates the emitted Teams loader and the real pinned Teams CommonJS package.
      Module._load = function load(request, parent, isMain) {
        if (request.startsWith("openclaw/plugin-sdk/")) {
          return hostSdkStub;
        }
        return originalLoad.call(this, request, parent, isMain);
      };

      const { sendMSTeamsActivityWithReference } =
        require(process.env.OPENCLAW_MSTEAMS_PROACTIVE_ARTIFACT);
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
        cwd: path.dirname(outDir),
        env: {
          ...process.env,
          NODE_DISABLE_COMPILE_CACHE: "1",
          OPENCLAW_MSTEAMS_PROACTIVE_ARTIFACT: proactiveArtifact,
          VITEST: undefined,
        },
      },
    );

    expect(stderr).toBe("");
    expect(stdout).toBe("root-sdk-ok");
  }, 30_000);
});
