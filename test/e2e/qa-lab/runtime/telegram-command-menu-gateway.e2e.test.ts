import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { withServer, withTempDir } from "openclaw/plugin-sdk/test-env";
import { expect, test } from "vitest";
import {
  createQaGatewayChild,
  startQaMockOpenAiServer,
  writeJson,
} from "../../../../extensions/qa-lab/api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
type BotCommand = { command: string; description: string };
type Body = { commands?: BotCommand[]; language_code?: string; scope?: { type?: string } };
const LOCALIZED_PLUGIN_ID = "telegram-menu-localization-e2e";
const LOCALIZED_PLUGIN_COMMANDS = Array.from({ length: 24 }, (_, index) => ({
  name: `menu_locale_${String(index).padStart(3, "0")}`,
  description: `Menu locale ${index}`,
  descriptionLocalizations: {
    fr: `Menu français ${index}`,
    ko: "한".repeat(250),
  },
}));
const TOKENS = ["A", "B", "C", "D", "E"].map(
  (letter, index) => `${100001 + index}:${letter.repeat(35)}`,
) as [string, string, string, string, string];
const [COUNT_TOKEN, TEXT_TOKEN, RETRY_TOKEN, SKILL_TOKEN, LOCALIZED_TOKEN] = TOKENS;
function customCommands(prefix: string, count: number, description = "Configured command") {
  return Array.from({ length: count }, (_, index) => ({
    command: `${prefix}_${String(index).padStart(3, "0")}`,
    description,
  }));
}
const names = (commands: BotCommand[]) => commands.map(({ command }) => command);
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
  }
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}
const succeed = (res: ServerResponse, result: unknown = true) =>
  writeJson(res, 200, { ok: true, result });
const LIMIT = { ok: false, error_code: 400, description: "Bad Request: BOT_COMMANDS_TOO_MUCH" };
async function writeLocalizedCommandPlugin(params: { repoRoot: string; workspace: string }) {
  const pluginDir = path.join(params.workspace, "plugins", LOCALIZED_PLUGIN_ID);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    `${JSON.stringify(
      {
        name: `@openclaw/${LOCALIZED_PLUGIN_ID}`,
        version: "0.0.0",
        type: "module",
        openclaw: { extensions: ["./index.js"] },
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify(
      {
        id: LOCALIZED_PLUGIN_ID,
        name: "Telegram Menu Localization E2E",
        description: "Provides localized command-menu fixtures for Gateway proof.",
        activation: { onStartup: true },
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
      null,
      2,
    )}\n`,
  );
  const pluginEntryUrl = pathToFileURL(
    path.join(params.repoRoot, "dist", "plugin-sdk", "plugin-entry.js"),
  ).href;
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    [
      `import { definePluginEntry } from ${JSON.stringify(pluginEntryUrl)};`,
      `const commands = ${JSON.stringify(LOCALIZED_PLUGIN_COMMANDS, null, 2)};`,
      "export default definePluginEntry({",
      `  id: ${JSON.stringify(LOCALIZED_PLUGIN_ID)},`,
      "  name: 'Telegram Menu Localization E2E',",
      "  register(api) {",
      "    for (const command of commands) {",
      "      api.registerCommand({",
      "        ...command,",
      "        channels: ['telegram'],",
      "        handler: async () => ({ text: 'ok' }),",
      "      });",
      "    }",
      "  },",
      "});",
      "",
    ].join("\n"),
  );
  return pluginDir;
}
async function settleCleanup(...cleanups: Array<() => Promise<void>>) {
  const failures: unknown[] = [];
  for (const cleanup of cleanups) {
    await cleanup().catch((error: unknown) => failures.push(error));
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Telegram command-menu gateway cleanup failed");
  }
}
test("registers pressure-prioritized Telegram menus through a real Gateway", async () => {
  const calls: Array<{ token: string; body: Body }> = [];
  const polled = new Set<string>();
  let retryRejected = false;
  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const [, token = "", method = ""] =
      new URL(req.url ?? "/", "http://127.0.0.1").pathname.match(/^\/bot([^/]+)\/([^/]+)$/) ?? [];
    if (method === "getMe") {
      succeed(res, { id: Number(token.split(":")[0]), is_bot: true, first_name: "QA" });
      return;
    }
    const body = await readJson(req);
    if (method === "getUpdates") {
      if (!polled.has(token)) {
        polled.add(token);
        succeed(res, []);
      }
      return;
    }
    if (method === "setMyCommands") {
      calls.push({ token, body: body as Body });
      if (token === RETRY_TOKEN && !body.scope && !retryRejected) {
        retryRejected = true;
        writeJson(res, 400, LIMIT);
        return;
      }
      succeed(res);
      return;
    }
    if (method === "deleteWebhook" || method === "deleteMyCommands") {
      succeed(res);
      return;
    }
    writeJson(res, 404, { ok: false, error_code: 404, description: "Not Found" });
  };
  await withServer(
    (req, res) => {
      void handleRequest(req, res);
    },
    async (apiRoot) =>
      await withTempDir("openclaw-telegram-menu-", async (workspace) => {
        let mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;
        const gatewayOwner = createQaGatewayChild();
        try {
          const repoRoot = path.resolve(import.meta.dirname, "../../../..");
          const localizedPluginDir = await writeLocalizedCommandPlugin({ repoRoot, workspace });
          const skillDir = path.join(workspace, "skills", "menu-proof");
          await fs.mkdir(skillDir, { recursive: true });
          await fs.writeFile(
            path.join(skillDir, "SKILL.md"),
            "---\nname: menu-proof\ndescription: Proof\nuser-invocable: true\n---\n# Proof\n",
          );
          const countCustom = customCommands("count", 100);
          const textCustom = customCommands("text", 24, "x".repeat(256));
          const retryCustom = customCommands("retry", 2);
          const skillCustom = customCommands("skillcustom", 100);
          const localizedCustom = customCommands("localized", 1);
          const baseAccount = {
            enabled: true,
            dmPolicy: "disabled" as const,
            groupPolicy: "disabled" as const,
            commands: { native: true, nativeSkills: false },
          };
          const account = (token: string, commands: BotCommand[], nativeSkills = false) => ({
            enabled: true,
            botToken: token,
            apiRoot,
            commands: { native: true, nativeSkills },
            customCommands: commands,
          });
          mock = await startQaMockOpenAiServer();
          await gatewayOwner.start({
            repoRoot,
            useRepoCli: true,
            providerBaseUrl: `${mock.baseUrl}/v1`,
            transportBaseUrl: apiRoot,
            transport: {
              requiredPluginIds: ["telegram"],
              createGatewayConfig: () => ({
                channels: {
                  telegram: {
                    ...baseAccount,
                    defaultAccount: "count",
                    accounts: {
                      count: account(COUNT_TOKEN, countCustom),
                      text: account(TEXT_TOKEN, textCustom),
                      retry: account(RETRY_TOKEN, retryCustom),
                      skill: account(SKILL_TOKEN, skillCustom, true),
                      localized: account(LOCALIZED_TOKEN, localizedCustom),
                    },
                  },
                },
              }),
            },
            controlUiEnabled: false,
            runtimeEnvPatch: {
              OPENCLAW_SKIP_CHANNELS: undefined,
              OPENCLAW_SKIP_PROVIDERS: undefined,
              OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
              TELEGRAM_BOT_TOKEN: undefined,
            },
            mutateConfig: (cfg) => {
              cfg.agents!.defaults!.workspace = workspace;
              cfg.bindings = [
                ...(cfg.bindings ?? []),
                { agentId: "qa", match: { channel: "telegram", accountId: "skill" } },
              ];
              cfg.plugins = {
                ...cfg.plugins,
                allow: [...new Set([...(cfg.plugins?.allow ?? []), LOCALIZED_PLUGIN_ID])],
                entries: {
                  ...cfg.plugins?.entries,
                  [LOCALIZED_PLUGIN_ID]: { enabled: true },
                },
                load: {
                  ...cfg.plugins?.load,
                  paths: [...new Set([...(cfg.plugins?.load?.paths ?? []), localizedPluginDir])],
                },
              };
              return cfg;
            },
          });
          const scoped = (token: string, group = false, languageCode?: string) =>
            calls.filter((call) => {
              const isGroup = call.body.scope?.type === "all_group_chats";
              return (
                call.token === token &&
                isGroup === group &&
                call.body.language_code === languageCode
              );
            });
          const payload = (token: string, group = false, index = -1, languageCode?: string) =>
            scoped(token, group, languageCode).at(index)?.body.commands ?? [];
          await expect
            .poll(
              () =>
                TOKENS.every(
                  (token) => scoped(token).length >= 1 && scoped(token, true).length >= 1,
                ) &&
                scoped(RETRY_TOKEN).length >= 2 &&
                ["fr", "ko"].every(
                  (languageCode) =>
                    scoped(LOCALIZED_TOKEN, false, languageCode).length >= 1 &&
                    scoped(LOCALIZED_TOKEN, true, languageCode).length >= 1,
                ),
              { interval: 50, timeout: 30_000 },
            )
            .toBe(true);
          expect(payload(COUNT_TOKEN)).toEqual(countCustom);
          const textPayload = payload(TEXT_TOKEN);
          expect(textPayload.length).toBeLessThan(100);
          expect(names(textPayload).slice(0, textCustom.length)).toEqual(names(textCustom));
          expect(textPayload[0]?.description.length).toBeLessThan(256);
          const retryPayload = payload(RETRY_TOKEN, false, 1);
          expect(retryPayload).toHaveLength(
            Math.floor(payload(RETRY_TOKEN, false, 0).length * 0.8),
          );
          expect(retryPayload.slice(0, retryCustom.length)).toEqual(retryCustom);
          expect(retryPayload.some(({ command }) => command === "btw")).toBe(true);
          expect(retryPayload.some(({ command }) => command === "side")).toBe(false);
          expect(names(payload(SKILL_TOKEN))).toEqual([
            "skill",
            ...names(skillCustom.slice(0, 99)),
          ]);
          const localizedDefault = payload(LOCALIZED_TOKEN);
          const localizedFrench = payload(LOCALIZED_TOKEN, false, -1, "fr");
          const localizedKorean = payload(LOCALIZED_TOKEN, false, -1, "ko");
          const localizedKoreanNames = names(localizedKorean);
          expect(names(localizedFrench)).toEqual(names(localizedDefault));
          expect(localizedKoreanNames[0]).toBe(localizedCustom[0]?.command);
          expect(localizedKoreanNames.indexOf("help")).toBeGreaterThan(0);
          expect(localizedKoreanNames.indexOf(LOCALIZED_PLUGIN_COMMANDS[0]!.name)).toBeGreaterThan(
            localizedKoreanNames.indexOf("help"),
          );
          expect(localizedKoreanNames.indexOf("side")).toBeGreaterThan(
            localizedKoreanNames.indexOf(LOCALIZED_PLUGIN_COMMANDS.at(-1)!.name),
          );
          expect(
            localizedKorean.find(({ command }) => command === "menu_locale_000")?.description
              .length,
          ).toBeLessThan(250);
          for (const languageCode of ["fr", "ko"]) {
            expect(payload(LOCALIZED_TOKEN, true, -1, languageCode)).toEqual(
              payload(LOCALIZED_TOKEN, false, -1, languageCode),
            );
          }
          for (const token of TOKENS) {
            expect(payload(token, true)).toEqual(payload(token));
          }
          expect(
            calls.every(
              (call) =>
                call.body.language_code === undefined ||
                call.body.language_code === "fr" ||
                call.body.language_code === "ko",
            ),
          ).toBe(true);
          expect(
            calls
              .flatMap((call) => call.body.commands ?? [])
              .every(
                (command) => Object.keys(command).toSorted().join(",") === "command,description",
              ),
          ).toBe(true);
        } finally {
          await settleCleanup(
            async () => await stopQaGatewayFixture(gatewayOwner),
            async () => await mock?.stop(),
          );
        }
      }),
  );
}, 120_000);
