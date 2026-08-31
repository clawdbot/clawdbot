import {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveImapConfig } from "./src/config.js";
import { createImapState } from "./src/state.js";
import { ImapAccountWatcher } from "./src/watcher.js";

const imapConfigSchema = { parse: resolveImapConfig };

export default definePluginEntry({
  id: "imap",
  name: "IMAP email trigger",
  description: "Dispatch authenticated incoming IMAP email to isolated agent sessions.",
  configSchema: imapConfigSchema,
  register(api: OpenClawPluginApi) {
    if (api.registrationMode !== "full") {
      return;
    }
    let generation = 0;
    let watchers: ImapAccountWatcher[] = [];
    api.registerService({
      id: "imap-watch",
      start(context: OpenClawPluginServiceContext) {
        const previous = watchers;
        const activeGeneration = ++generation;
        watchers = [];
        const start = async () => {
          await Promise.all(previous.map((watcher) => watcher.stop()));
          if (activeGeneration !== generation) {
            return;
          }
          const config = imapConfigSchema.parse(api.pluginConfig, (accountId) => {
            context.logger.warn(
              `imap: account=${accountId} unavailable; resolve its IMAP password and reload configuration`,
            );
          });
          const accounts = Object.entries(config.accounts);
          if (!accounts.length) {
            context.logger.warn(
              "imap: no accounts configured; add plugins.entries.imap.config.accounts",
            );
            return;
          }
          const state = createImapState(api.runtime);
          watchers = accounts.map(
            ([accountId, account]) =>
              new ImapAccountWatcher({ accountId, account, runtime: api.runtime, state, context }),
          );
          for (const watcher of watchers) {
            watcher.start();
          }
        };
        void start().catch((error: unknown) => {
          if (activeGeneration === generation) {
            context.serviceHealth?.reportFailure(error);
          }
        });
      },
      async stop() {
        generation++;
        const active = watchers;
        watchers = [];
        await Promise.all(active.map((watcher) => watcher.stop()));
      },
    });
  },
});
