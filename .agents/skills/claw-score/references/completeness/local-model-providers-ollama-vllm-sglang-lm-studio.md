# Local model providers: Ollama, vLLM, SGLang, LM Studio Completeness

Use this rubric when assigning category Completeness scores for the
`local-model-providers-ollama-vllm-sglang-lm-studio` surface.

## Category Scope

- Provider Setup, Lifecycle, and Diagnostics: Provider Selection, Onboarding, localService configuration, Process startup and readiness, Request leases and idle shutdown, Health checks and restart, Provider recipes, Local provider status, Backend reachability probes, Model availability errors, Memory readiness diagnostics, Provider troubleshooting docs
- Native Provider Plugins: Ollama setup and model pulling, Model discovery, Streaming and vision, Ollama embeddings, Web-search support, LM Studio setup, Model discovery and auth, Model preload and JIT loading, Streaming compatibility, LM Studio embeddings
- OpenAI-Compatible Runtime Compatibility: Bundled provider setup, Model Discovery Endpoint, Non-interactive configuration, vLLM thinking controls, OpenAI-compatible chat and tool semantics, SGLang compatibility guidance, Request Stream Compatibility, Tool Calling
- Local Memory and Embeddings: Embedding provider selection, Memory search readiness, memoryFlush model override, Fallback lexical search, Provider mismatch guidance
- Network Safety and Prompt Controls: Safety Network, Prompt Pressure Controls
