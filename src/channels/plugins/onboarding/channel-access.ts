import type { WizardPrompter } from "../../../wizard/prompts.js";

export type ChannelAccessPolicy = "allowlist" | "open" | "disabled";

export function parseAllowlistEntries(raw: string): string[] {
  return String(raw ?? "")
    .split(/[,\n]/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function formatAllowlistEntries(entries: string[]): string {
  return entries
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join(", ");
}

export async function promptChannelAccessPolicy(params: {
  prompter: WizardPrompter;
  label: string;
  currentPolicy?: ChannelAccessPolicy;
  allowOpen?: boolean;
  allowDisabled?: boolean;
}): Promise<ChannelAccessPolicy> {
  const options: Array<{ value: ChannelAccessPolicy; label: string }> = [
    { value: "allowlist", label: "Allowlist (recommended)" },
  ];
  if (params.allowOpen !== false) {
    options.push({ value: "open", label: "Open (allow all channels)" });
  }
  if (params.allowDisabled !== false) {
    options.push({ value: "disabled", label: "Disabled (block all channels)" });
  }
  const initialValue = params.currentPolicy ?? "allowlist";
  return (await params.prompter.select({
    message: `${params.label} access`,
    options,
    initialValue,
  })) as ChannelAccessPolicy;
}

export async function promptChannelAllowlist(params: {
  prompter: WizardPrompter;
  label: string;
  currentEntries?: string[];
  placeholder?: string;
}): Promise<string[]> {
  const initialValue =
    params.currentEntries && params.currentEntries.length > 0
      ? formatAllowlistEntries(params.currentEntries)
      : undefined;
  const raw = await params.prompter.text({
    message: `${params.label} allowlist (comma-separated)`,
    placeholder: params.placeholder,
    initialValue,
  });
  return parseAllowlistEntries(raw);
}

export async function promptChannelAccessConfig(params: {
  prompter: WizardPrompter;
  label: string;
  currentPolicy?: ChannelAccessPolicy;
  currentEntries?: string[];
  placeholder?: string;
  allowOpen?: boolean;
  allowDisabled?: boolean;
  defaultPrompt?: boolean;
  updatePrompt?: boolean;
}): Promise<{ policy: ChannelAccessPolicy; entries: string[] } | null> {
  const hasEntries = (params.currentEntries ?? []).length > 0;
  const shouldPrompt = params.defaultPrompt ?? !hasEntries;
  const wants = await params.prompter.confirm({
    message: params.updatePrompt
      ? `Update ${params.label} access?`
      : `Configure ${params.label} access?`,
    initialValue: shouldPrompt,
  });
  if (!wants) return null;
  const policy = await promptChannelAccessPolicy({
    prompter: params.prompter,
    label: params.label,
    currentPolicy: params.currentPolicy,
    allowOpen: params.allowOpen,
    allowDisabled: params.allowDisabled,
  });
  if (policy !== "allowlist") return { policy, entries: [] };
  const entries = await promptChannelAllowlist({
    prompter: params.prompter,
    label: params.label,
    currentEntries: params.currentEntries,
    placeholder: params.placeholder,
  });
  return { policy, entries };
}
