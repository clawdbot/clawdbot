import { z } from "zod";
import { coerceSecretRef } from "../../config/types.secrets.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";

/** Provider-owned fields retained with OAuth material through storage and refresh. */
export const oauthCredentialMetadataSchema = z.strictObject({
  idToken: z.string().optional(),
  clientId: z.string().optional(),
  enterpriseUrl: z.string().optional(),
  projectId: z.string().optional(),
  accountId: z.string().optional(),
  chatgptPlanType: z.string().optional(),
  /** Non-secret subscription plan captured from external CLI logins. */
  subscriptionType: z.string().optional(),
  /** Non-secret rate-limit tier captured from external CLI logins. */
  rateLimitTier: z.string().optional(),
  tokenEndpoint: z.string().optional(),
  deviceAuthorizationEndpoint: z.string().optional(),
  issuer: z.string().optional(),
  authFlow: z.string().optional(),
});

export type OAuthCredentialMetadata = z.infer<typeof oauthCredentialMetadataSchema>;

const literalSecretSchema = z
  .string()
  .min(1)
  .refine((value) => coerceSecretRef(value) === null, "A literal credential is required.");
const normalizedSecretSchema = z.string().transform(normalizeSecretInput).pipe(literalSecretSchema);
const commonCredentialFields = {
  provider: z.string().min(1),
  email: z.string().optional(),
  displayName: z.string().optional(),
  copyToAgents: z.boolean().optional(),
};

/** Current inline credentials, without legacy aliases or host-owned secret references. */
export const inlineAuthProfileCredentialSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...commonCredentialFields,
    type: z.literal("api_key"),
    key: normalizedSecretSchema,
    metadata: z.record(z.string(), z.string()).optional(),
  }),
  z.strictObject({
    ...commonCredentialFields,
    type: z.literal("token"),
    token: normalizedSecretSchema,
    expires: z.number().positive().optional(),
  }),
  z.strictObject({
    ...commonCredentialFields,
    ...oauthCredentialMetadataSchema.shape,
    type: z.literal("oauth"),
    access: literalSecretSchema,
    refresh: literalSecretSchema,
    expires: z.number().positive(),
  }),
]);
