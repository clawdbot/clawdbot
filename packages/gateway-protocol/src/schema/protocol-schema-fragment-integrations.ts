import * as push from "./push.js";
import * as secrets from "./secrets.js";
import * as uiCommand from "./ui-command.js";

export const IntegrationProtocolSchemas = {
  PushTestParams: push.PushTestParamsSchema,
  PushTestResult: push.PushTestResultSchema,
  UiSplitCommand: uiCommand.UiSplitCommandSchema,
  UiClosePaneCommand: uiCommand.UiClosePaneCommandSchema,
  UiFocusCommand: uiCommand.UiFocusCommandSchema,
  UiSidebarCommand: uiCommand.UiSidebarCommandSchema,
  UiPanelCommand: uiCommand.UiPanelCommandSchema,
  UiNavigateCommand: uiCommand.UiNavigateCommandSchema,
  UiCommand: uiCommand.UiCommandSchema,
  UiCommandParams: uiCommand.UiCommandParamsSchema,
  UiCommandResult: uiCommand.UiCommandResultSchema,
  SecretsReloadParams: secrets.SecretsReloadParamsSchema,
  SecretStoreSecretEntry: secrets.SecretStoreSecretEntrySchema,
  SecretStoreEnvEntry: secrets.SecretStoreEnvEntrySchema,
  SecretStoreEntry: secrets.SecretStoreEntrySchema,
  SecretsStoreListParams: secrets.SecretsStoreListParamsSchema,
  SecretsStoreListResult: secrets.SecretsStoreListResultSchema,
  SecretsStoreSetParams: secrets.SecretsStoreSetParamsSchema,
  SecretsStoreDeleteParams: secrets.SecretsStoreDeleteParamsSchema,
  SecretsStoreMutationResult: secrets.SecretsStoreMutationResultSchema,
  SecretsResolveParams: secrets.SecretsResolveParamsSchema,
  SecretsResolveAssignment: secrets.SecretsResolveAssignmentSchema,
  SecretsResolveResult: secrets.SecretsResolveResultSchema,
} as const;
