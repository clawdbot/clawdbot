import { Type, type Static } from "typebox";
import { NonEmptyString } from "./primitives.js";

const WorkerBundleHashSchema = Type.String({
  minLength: 64,
  maxLength: 64,
  pattern: "^[a-f0-9]{64}$",
});

/** Build identity presented by a worker before the gateway admits it. */
export const WorkerAdmissionHandshakeSchema = Type.Object(
  {
    bundleHash: WorkerBundleHashSchema,
    openclawVersion: NonEmptyString,
    protocolFeatures: Type.Array(NonEmptyString, { uniqueItems: true }),
  },
  { additionalProperties: false },
);

export type WorkerAdmissionHandshake = Static<typeof WorkerAdmissionHandshakeSchema>;
