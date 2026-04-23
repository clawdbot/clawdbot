import { Type } from "typebox";
import { ENV_SECRET_REF_ID_RE } from "../../../config/types.secrets.js";
import {
  EXEC_SECRET_REF_ID_JSON_SCHEMA_PATTERN,
  FILE_SECRET_REF_ID_PATTERN,
  SECRET_PROVIDER_ALIAS_PATTERN,
} from "../../../secrets/ref-contract.js";
import { INPUT_PROVENANCE_KIND_VALUES } from "../../../sessions/input-provenance.js";
import { SESSION_LABEL_MAX_LENGTH } from "../../../sessions/session-label.js";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../client-info.js";

export const NonEmptyString = Type.String({ minLength: 1 });
export const CHAT_SEND_SESSION_KEY_MAX_LENGTH = 512;
export const ChatSendSessionKeyString = Type.String({
  minLength: 1,
  maxLength: CHAT_SEND_SESSION_KEY_MAX_LENGTH,
});
export const SessionLabelString = Type.String({
  minLength: 1,
  maxLength: SESSION_LABEL_MAX_LENGTH,
});
export const InputProvenanceSchema = Type.Object(
  {
    kind: Type.String({ enum: [...INPUT_PROVENANCE_KIND_VALUES] }),
    originSessionId: Type.Optional(Type.String()),
    sourceSessionKey: Type.Optional(Type.String()),
    sourceChannel: Type.Optional(Type.String()),
    sourceTool: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const GatewayClientIdSchema = Type.Enum(GATEWAY_CLIENT_IDS);

export const GatewayClientModeSchema = Type.Enum(GATEWAY_CLIENT_MODES);

export const SecretRefSourceSchema = Type.Union([
  Type.Literal("env"),
  Type.Literal("file"),
  Type.Literal("exec"),
]);

const SecretProviderAliasString = Type.String({
  pattern: SECRET_PROVIDER_ALIAS_PATTERN.source,
});

const EnvSecretRefSchema = Type.Object(
  {
    source: Type.Literal("env"),
    provider: SecretProviderAliasString,
    id: Type.String({ pattern: ENV_SECRET_REF_ID_RE.source }),
  },
  { additionalProperties: false },
);

const FileSecretRefSchema = Type.Object(
  {
    source: Type.Literal("file"),
    provider: SecretProviderAliasString,
    id: Type.String({ pattern: FILE_SECRET_REF_ID_PATTERN.source }),
  },
  { additionalProperties: false },
);

const ExecSecretRefSchema = Type.Object(
  {
    source: Type.Literal("exec"),
    provider: SecretProviderAliasString,
    id: Type.String({ pattern: EXEC_SECRET_REF_ID_JSON_SCHEMA_PATTERN }),
  },
  { additionalProperties: false },
);

export const SecretRefSchema = Type.Union([
  EnvSecretRefSchema,
  FileSecretRefSchema,
  ExecSecretRefSchema,
]);

export const SecretInputSchema = Type.Union([Type.String(), SecretRefSchema]);
