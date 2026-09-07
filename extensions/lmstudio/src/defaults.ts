/** Shared LM Studio defaults used by setup, runtime discovery, and embeddings paths. */
export const LMSTUDIO_DEFAULT_BASE_URL = "http://localhost:1234";
export const LMSTUDIO_DEFAULT_INFERENCE_BASE_URL = `${LMSTUDIO_DEFAULT_BASE_URL}/v1`;
export const LMSTUDIO_DOCKER_HOST_BASE_URL = "http://host.docker.internal:1234";
export const LMSTUDIO_DOCKER_HOST_INFERENCE_BASE_URL = `${LMSTUDIO_DOCKER_HOST_BASE_URL}/v1`;
export const LMSTUDIO_DEFAULT_EMBEDDING_MODEL = "text-embedding-nomic-embed-text-v1.5";
export const LMSTUDIO_PROVIDER_LABEL = "LM Studio";
export const LMSTUDIO_DEFAULT_API_KEY_ENV_VAR = "LM_API_TOKEN";
export const LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER = "lmstudio-local";
export const LMSTUDIO_MODEL_PLACEHOLDER = "model-key-from-api-v1-models";
// Default context length sent when requesting LM Studio to load a model.
export const LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH = 64000;
export const LMSTUDIO_DEFAULT_MODEL_ID = "qwen/qwen3.5-9b";
export const LMSTUDIO_PROVIDER_ID = "lmstudio";
