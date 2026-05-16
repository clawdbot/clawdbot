import chalk from "chalk";
import { formatCliCommand } from "../cli/command-format.js";
import { t } from "./i18n/index.js";

const heading = (text: string) => chalk.bold(text);

export function getSecurityNoteTitle(): string {
  return t("wizard.security.title");
}

export function getSecurityConfirmMessage(): string {
  return t("wizard.security.confirm");
}

export function getSecurityNoteMessage(): string {
  return [
    t("wizard.security.beta"),
    t("wizard.security.personalAgent"),
    t("wizard.security.toolAccess"),
    t("wizard.security.promptRisk"),
    "",
    t("wizard.security.notMultitenant"),
    t("wizard.security.sharedAuthority"),
    "",
    t("wizard.security.hardeningRequired"),
    t("wizard.security.askForHelp"),
    "",
    heading(t("wizard.security.recommendedBaseline")),
    `- ${t("wizard.security.baselinePairing")}`,
    `- ${t("wizard.security.baselineSharedInbox")}`,
    `- ${t("wizard.security.baselineSandbox")}`,
    `- ${t("wizard.security.baselineDmSessions")}`,
    `- ${t("wizard.security.baselineSecrets")}`,
    `- ${t("wizard.security.baselineStrongModel")}`,
    "",
    heading(t("wizard.security.runRegularly")),
    formatCliCommand("openclaw security audit --deep"),
    formatCliCommand("openclaw security audit --fix"),
    "",
    heading(t("wizard.security.learnMore")),
    "- https://docs.openclaw.ai/gateway/security",
  ].join("\n");
}
