/** Public SDK subpath for pinned secret reads and first-writer-wins creation. */
export {
  createSecretFileAtomic,
  readSecretFile,
  readSecretFileSync,
  tryReadSecretFileSync,
  type SecretFileReadOptions,
} from "../infra/secret-file.js";
