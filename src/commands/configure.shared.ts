// Shared prompt wrappers and section metadata for the configure wizard.
import {
  confirm as clackConfirm,
  intro as clackIntro,
  outro as clackOutro,
  password as clackPassword,
  select as clackSelect,
  text as clackText,
} from "@clack/prompts";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { styleSelectParams } from "../../packages/terminal-core/src/prompt-select-styled-params.js";
import {
  stylePromptMessage,
  stylePromptTitle,
} from "../../packages/terminal-core/src/prompt-style.js";

export const CONFIGURE_WIZARD_SECTIONS = [
  "workspace",
  "model",
  "web",
  "gateway",
  "daemon",
  "channels",
  "plugins",
  "skills",
  "health",
] as const;

export type WizardSection = (typeof CONFIGURE_WIZARD_SECTIONS)[number];

/** Parse repeated `--section` values into known configure wizard sections and invalid entries. */
export function parseConfigureWizardSections(raw: unknown): {
  sections: WizardSection[];
  invalid: string[];
} {
  const sectionsRaw: string[] = Array.isArray(raw) ? normalizeStringEntries(raw) : [];
  if (sectionsRaw.length === 0) {
    return { sections: [], invalid: [] };
  }

  const invalid = sectionsRaw.filter((s) => !CONFIGURE_WIZARD_SECTIONS.includes(s as never));
  const sections = sectionsRaw.filter((s): s is WizardSection =>
    CONFIGURE_WIZARD_SECTIONS.includes(s as never),
  );
  return { sections, invalid };
}

export type ChannelsWizardMode = "configure" | "remove";

export type ConfigureWizardParams = {
  command: "configure" | "update";
  sections?: WizardSection[];
};

export const CONFIGURE_SECTION_OPTIONS: Array<{
  value: WizardSection;
  label: string;
  hint: string;
}> = [
  { value: "workspace", label: "Workspace", hint: "Set workspace + sessions" },
  { value: "model", label: "Model", hint: "Pick provider + credentials" },
  { value: "web", label: "Web tools", hint: "Configure web search (Perplexity/Brave) + fetch" },
  { value: "gateway", label: "Gateway", hint: "Port, bind, auth, tailscale" },
  {
    value: "daemon",
    label: "Daemon",
    hint: "Install/manage the background service",
  },
  {
    value: "channels",
    label: "Channels",
    hint: "Link WhatsApp/Telegram/etc and defaults",
  },
  { value: "plugins", label: "Plugins", hint: "Configure plugin settings (sandbox, tools, etc.)" },
  { value: "skills", label: "Skills", hint: "Install/enable workspace skills" },
  {
    value: "health",
    label: "Health check",
    hint: "Run gateway + channel checks",
  },
];

/** Styled configure wizard intro wrapper. */
export const intro = (message: string) => clackIntro(stylePromptTitle(message) ?? message);
/** Styled configure wizard outro wrapper. */
export const outro = (message: string) => clackOutro(stylePromptTitle(message) ?? message);
/** Styled text prompt wrapper. */
export const text = (params: Parameters<typeof clackText>[0]) =>
  clackText({
    ...params,
    message: stylePromptMessage(params.message),
  });
/** Styled password prompt wrapper. Echoes bullets so secrets never appear in cleartext. */
export const password = (params: Parameters<typeof clackPassword>[0]) =>
  clackPassword({
    ...params,
    message: stylePromptMessage(params.message),
  });
/** Styled confirm prompt wrapper. */
export const confirm = (params: Parameters<typeof clackConfirm>[0]) =>
  clackConfirm({
    ...params,
    message: stylePromptMessage(params.message),
  });
/** Styled select prompt wrapper that also normalizes option hints. */
export const select = <T>(params: Parameters<typeof clackSelect<T>>[0]) =>
  clackSelect(styleSelectParams(params));
