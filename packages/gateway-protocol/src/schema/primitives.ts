// Gateway Protocol schema module defines protocol validation shapes.
import { Type } from "typebox";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../client-info.js";
import {
  EXEC_SECRET_REF_ID_JSON_SCHEMA_PATTERN,
  FILE_SECRET_REF_ID_ABSOLUTE_JSON_SCHEMA_PATTERN,
  FILE_SECRET_REF_ID_INVALID_ESCAPE_JSON_SCHEMA_PATTERN,
  SECRET_PROVIDER_ALIAS_PATTERN,
  SINGLE_VALUE_FILE_REF_ID,
} from "../secret-ref-contract.js";
import { closedObject } from "./closed-object.js";

/**
 * Shared schema primitives reused by gateway protocol request/result schemas.
 *
 * Keep these schemas small and transport-oriented; feature-specific validation
 * belongs in the owning schema module or runtime handler.
 */
const ENV_SECRET_REF_ID_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
const INPUT_PROVENANCE_KIND_VALUES = ["external_user", "inter_session", "internal_system"] as const;
const SESSION_LABEL_MAX_LENGTH = 512;

/** Non-empty string primitive for protocol fields that reject blank values. */
export const NonEmptyString = Type.String({ minLength: 1 });
/** Maximum stable session key length accepted by chat-send protocol requests. */
export const CHAT_SEND_SESSION_KEY_MAX_LENGTH = 512;
/** Chat-send session key string primitive with bounded length. */
export const ChatSendSessionKeyString = Type.String({
  minLength: 1,
  maxLength: CHAT_SEND_SESSION_KEY_MAX_LENGTH,
});
/** Human-readable session label primitive with bounded display length. */
export const SessionLabelString = Type.String({
  minLength: 1,
  maxLength: SESSION_LABEL_MAX_LENGTH,
});
/** Provenance marker for content copied from another user/session/system source. */
export const InputProvenanceSchema = closedObject({
  kind: Type.String({ enum: [...INPUT_PROVENANCE_KIND_VALUES] }),
  originSessionId: Type.Optional(Type.String()),
  sourceSessionKey: Type.Optional(Type.String()),
  sourceChannel: Type.Optional(Type.String()),
  sourceTool: Type.Optional(Type.String()),
});

/** Closed gateway client id schema aligned with `GATEWAY_CLIENT_IDS`. */
export const GatewayClientIdSchema = Type.Enum(GATEWAY_CLIENT_IDS);

/** Closed gateway client mode schema aligned with `GATEWAY_CLIENT_MODES`. */
export const GatewayClientModeSchema = Type.Enum(GATEWAY_CLIENT_MODES);

const SecretProviderAliasString = Type.String({
  pattern: SECRET_PROVIDER_ALIAS_PATTERN.source,
});

const EnvSecretRefSchema = closedObject({
  source: Type.Literal("env"),
  provider: SecretProviderAliasString,
  id: Type.String({ pattern: ENV_SECRET_REF_ID_RE.source }),
});

const FileSecretRefIdSchema = Type.Unsafe<string>({
  type: "string",
  anyOf: [
    { const: SINGLE_VALUE_FILE_REF_ID },
    {
      allOf: [
        { pattern: FILE_SECRET_REF_ID_ABSOLUTE_JSON_SCHEMA_PATTERN },
        { not: { pattern: FILE_SECRET_REF_ID_INVALID_ESCAPE_JSON_SCHEMA_PATTERN } },
      ],
    },
  ],
});

const FileSecretRefSchema = closedObject({
  source: Type.Literal("file"),
  provider: SecretProviderAliasString,
  id: FileSecretRefIdSchema,
});

const ExecSecretRefSchema = closedObject({
  source: Type.Literal("exec"),
  provider: SecretProviderAliasString,
  id: Type.String({ pattern: EXEC_SECRET_REF_ID_JSON_SCHEMA_PATTERN }),
});

/** Structured secret reference accepted by config and channel protocol payloads. */
export const SecretRefSchema = Type.Union([
  EnvSecretRefSchema,
  FileSecretRefSchema,
  ExecSecretRefSchema,
]);

/** Secret input value: either an inline string or a structured SecretRef. */
export const SecretInputSchema = Type.Union([Type.String(), SecretRefSchema]);
