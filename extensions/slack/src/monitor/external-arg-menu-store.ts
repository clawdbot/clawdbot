import { generateSecureToken } from "openclaw/plugin-sdk/secure-random-runtime";

const SLACK_EXTERNAL_ARG_MENU_TOKEN_BYTES = 18;
const SLACK_EXTERNAL_ARG_MENU_TOKEN_LENGTH = Math.ceil(
  (SLACK_EXTERNAL_ARG_MENU_TOKEN_BYTES * 8) / 6,
);
const SLACK_EXTERNAL_ARG_MENU_TOKEN_PATTERN = new RegExp(
  `^[A-Za-z0-9_-]{${SLACK_EXTERNAL_ARG_MENU_TOKEN_LENGTH}}$`,
);
const SLACK_EXTERNAL_ARG_MENU_TTL_MS = 10 * 60 * 1000;

export const SLACK_EXTERNAL_ARG_MENU_PREFIX = "openclaw_cmdarg_ext:";

export type SlackExternalArgMenuChoice = { label: string; value: string };
type SlackExternalArgMenuEntry = {
  choices: SlackExternalArgMenuChoice[];
  userId: string;
  expiresAt: number;
};

function pruneSlackExternalArgMenuStore(
  store: Map<string, SlackExternalArgMenuEntry>,
  now: number,
): void {
  for (const [token, entry] of store.entries()) {
    if (entry.expiresAt <= now) {
      store.delete(token);
    }
  }
}

function createSlackExternalArgMenuToken(store: Map<string, SlackExternalArgMenuEntry>): string {
  let token = "";
  do {
    token = generateSecureToken(SLACK_EXTERNAL_ARG_MENU_TOKEN_BYTES);
  } while (store.has(token));
  return token;
}

export function createSlackExternalArgMenuStore() {
  const store = new Map<string, SlackExternalArgMenuEntry>();

  return {
    create(
      params: { choices: SlackExternalArgMenuChoice[]; userId: string },
      now = Date.now(),
    ): string {
      pruneSlackExternalArgMenuStore(store, now);
      const token = createSlackExternalArgMenuToken(store);
      store.set(token, {
        choices: params.choices,
        userId: params.userId,
        expiresAt: now + SLACK_EXTERNAL_ARG_MENU_TTL_MS,
      });
      return token;
    },
    readToken(raw: unknown): string | undefined {
      if (typeof raw !== "string" || !raw.startsWith(SLACK_EXTERNAL_ARG_MENU_PREFIX)) {
        return undefined;
      }
      const token = raw.slice(SLACK_EXTERNAL_ARG_MENU_PREFIX.length).trim();
      return SLACK_EXTERNAL_ARG_MENU_TOKEN_PATTERN.test(token) ? token : undefined;
    },
    get(token: string, now = Date.now()): SlackExternalArgMenuEntry | undefined {
      pruneSlackExternalArgMenuStore(store, now);
      return store.get(token);
    },
  };
}
