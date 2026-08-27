import { sha256Hex } from "../../infra/crypto-digest.js";
import type { PreparedCliRunContext } from "./types.js";

/** Fingerprints every process-stable input without retaining secrets or volatile artifact paths. */
export function buildCliLiveSessionFingerprint(params: {
  context: PreparedCliRunContext;
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
}): string {
  const context = params.context;
  const managedGrant = context.preparedBackend.mcpClientGrantCapture;
  const normalizeGrantToken = params.env.OPENCLAW_MCP_TOKEN === managedGrant?.transportToken;
  const normalizeMcpConfigPath = Boolean(context.preparedBackend.mcpConfigHash);
  const skillSnapshot = context.params.skillsSnapshot;
  const skillsFingerprint = skillSnapshot
    ? sha256Hex(
        JSON.stringify({
          promptHash: sha256Hex(skillSnapshot.prompt),
          skillFilter: skillSnapshot.skillFilter,
          skills: skillSnapshot.skills,
          resolvedSkills: (skillSnapshot.resolvedSkills ?? []).map((skill) => ({
            name: skill.name,
            description: skill.description,
            filePath: skill.filePath,
            sourceInfo: skill.sourceInfo,
          })),
          version: skillSnapshot.version,
        }),
      )
    : undefined;
  const omittedValueFlags = new Set(
    [
      context.preparedBackend.backend.systemPromptArg,
      context.preparedBackend.backend.systemPromptFileArg,
      "--session-id",
      "--resume",
      "-r",
    ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
  );
  const unstableValueFlags = new Set(
    [
      normalizeMcpConfigPath ? "--mcp-config" : undefined,
      skillsFingerprint ? "--plugin-dir" : undefined,
      skillsFingerprint ? "--plugin-dir-no-mcp" : undefined,
    ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
  );
  const argv: string[] = [];
  for (let index = 0; index < params.argv.length; index += 1) {
    const value = params.argv[index] ?? "";
    if (omittedValueFlags.has(value)) {
      index += 1;
      continue;
    }
    if ([...omittedValueFlags].some((flag) => value.startsWith(`${flag}=`))) {
      continue;
    }
    if (unstableValueFlags.has(value)) {
      argv.push("<unstable>");
      index += 1;
      continue;
    }
    if ([...unstableValueFlags].some((flag) => value.startsWith(`${flag}=`))) {
      argv.push("<unstable>");
      continue;
    }
    argv.push(value);
  }

  return sha256Hex(
    JSON.stringify({
      argv,
      workspaceDirHash: sha256Hex(context.workspaceDir),
      cwdHash: context.cwdHash ?? sha256Hex(context.cwd ?? context.workspaceDir),
      provider: context.params.provider,
      model: context.normalizedModel,
      // Official SDK sessions cannot update prompts in place: any changed byte requires restart.
      systemPromptHash: sha256Hex(context.systemPrompt),
      authProfileIdHash: context.effectiveAuthProfileId
        ? sha256Hex(context.effectiveAuthProfileId)
        : undefined,
      authEpochHash: context.authEpoch ? sha256Hex(context.authEpoch) : undefined,
      extraSystemPromptHash: context.extraSystemPromptHash,
      promptToolNamesHash: context.promptToolNamesHash,
      mcpResumeHash: context.preparedBackend.mcpResumeHash ?? context.preparedBackend.mcpConfigHash,
      credentialFingerprint: context.preparedBackend.secretInput?.fingerprint,
      skillsFingerprint,
      env: Object.keys(params.env)
        .toSorted()
        .filter((key) => key !== "OPENCLAW_MCP_CLI_CAPTURE_KEY")
        .map((key) => [
          key,
          key === "OPENCLAW_MCP_TOKEN" && normalizeGrantToken
            ? "<managed-mcp-grant>"
            : params.env[key]
              ? sha256Hex(params.env[key])
              : "",
        ]),
    }),
  );
}
