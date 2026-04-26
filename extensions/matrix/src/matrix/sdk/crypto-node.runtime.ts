import { createRequire } from "node:module";

// Load via createRequire so the CJS package gets __dirname (its index.js
// uses __dirname to locate platform-specific native .node bindings).
const require = createRequire(import.meta.url);
type MatrixCryptoNodePackage = typeof import("@matrix-org/matrix-sdk-crypto-nodejs");

export type MatrixCryptoNodeBindings = Pick<
  MatrixCryptoNodePackage,
  "Attachment" | "EncryptedAttachment"
>;

export function loadMatrixCryptoNodeBindings(): MatrixCryptoNodeBindings {
  const { Attachment, EncryptedAttachment } =
    require("@matrix-org/matrix-sdk-crypto-nodejs") as MatrixCryptoNodePackage;
  return { Attachment, EncryptedAttachment };
}
