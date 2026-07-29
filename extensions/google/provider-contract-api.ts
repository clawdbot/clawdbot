// Google API module exposes the plugin public contract.
import type { OpenClawConfig, ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";

const noopAuth = async () => ({ profiles: [] });

const VERTEX_DEFAULT_MODEL = "google-vertex/gemini-3.5-flash";
const VERTEX_DEFAULT_LOCATION = "global";

export function createGoogleProvider(): ProviderPlugin {
  return {
    id: "google",
    label: "Google AI Studio",
    docsPath: "/providers/models",
    hookAliases: ["google-antigravity", "google-vertex"],
    envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    auth: [
      {
        id: "api-key",
        kind: "api_key",
        label: "Google AI Studio API key",
        hint: "Supported API-key access from aistudio.google.com/apikey",
        run: noopAuth,
        wizard: {
          choiceId: "gemini-api-key",
          choiceLabel: "Google AI Studio API key",
          groupId: "google",
          groupLabel: "Google",
          groupHint: "Supported API-key setup",
        },
      },
    ],
  };
}

export function createGoogleVertexProvider(): ProviderPlugin {
  return {
    id: "google-vertex",
    label: "Google Vertex AI",
    docsPath: "/providers/google-vertex",
    envVars: [
      "GOOGLE_CLOUD_API_KEY",
      "GOOGLE_CLOUD_PROJECT",
      "GCLOUD_PROJECT",
      "GOOGLE_CLOUD_LOCATION",
      "GOOGLE_APPLICATION_CREDENTIALS",
    ],
    auth: [
      {
        id: "adc",
        kind: "api_key" as const,
        label: "Google Cloud ADC",
        hint: "Application Default Credentials (GCE, GKE, gcloud, service account)",
        run: async (ctx: ProviderAuthContext) => {
          // Try to auto-detect project via google-auth-library
          let detectedProject: string | undefined;
          try {
            const { GoogleAuth } = await import("google-auth-library");
            const auth = new GoogleAuth({
              scopes: ["https://www.googleapis.com/auth/cloud-platform"],
            });
            detectedProject = (await auth.getProjectId()) ?? undefined;
          } catch {
            // Auto-detection not available (not on GCE, no gcloud, etc.)
          }

          // Rerun-safe: prefer values already in config so re-running onboarding
          // over a working setup keeps its project/location instead of silently
          // redirecting later requests to the auto-detected/default region.
          const existingVars = ctx.config.env?.vars as Record<string, string> | undefined;
          const pickVar = (value: unknown) =>
            typeof value === "string" && value.trim() ? value.trim() : undefined;
          const existingProject =
            pickVar(existingVars?.GOOGLE_CLOUD_PROJECT) ?? pickVar(existingVars?.GCLOUD_PROJECT);
          const existingLocation = pickVar(existingVars?.GOOGLE_CLOUD_LOCATION);

          const projectDefault = existingProject ?? detectedProject;
          const projectPrompt = await ctx.prompter.text({
            message: "GCP project ID",
            ...(projectDefault
              ? {
                  placeholder: projectDefault,
                  initialValue: projectDefault,
                }
              : {
                  placeholder: "my-gcp-project",
                }),
          });
          const project =
            typeof projectPrompt === "string" && projectPrompt.trim()
              ? projectPrompt.trim()
              : projectDefault;
          if (!project) {
            await ctx.prompter.note(
              "A GCP project ID is required for Vertex AI. Set GOOGLE_CLOUD_PROJECT in your environment.",
              "Setup skipped",
            );
            return { profiles: [] };
          }

          const locationDefault = existingLocation ?? VERTEX_DEFAULT_LOCATION;
          const locationPrompt = await ctx.prompter.text({
            message: "GCP location",
            initialValue: locationDefault,
            placeholder: locationDefault,
          });
          const location =
            typeof locationPrompt === "string" && locationPrompt.trim()
              ? locationPrompt.trim()
              : locationDefault;

          // Onboarding writes are additive: env vars, marker profile, and
          // default model. Reruns preserve existing google-vertex models via the
          // configPatch merge below, and the project/location prompts default to
          // existing config so accepting them leaves a working setup unchanged.
          return {
            profiles: [
              {
                profileId: "google-vertex:default",
                credential: {
                  type: "api_key" as const,
                  provider: "google-vertex",
                  key: "gcp-vertex-credentials",
                },
              },
            ],
            defaultModel: VERTEX_DEFAULT_MODEL,
            configPatch: (() => {
              const existingVertexConfig = (
                ctx.config.models as Record<string, unknown> | undefined
              )?.providers as Record<string, Record<string, unknown>> | undefined;
              const existingModels = Array.isArray(existingVertexConfig?.["google-vertex"]?.models)
                ? (existingVertexConfig["google-vertex"].models as Array<{ id?: string }>)
                : [];
              const defaultModelId = "gemini-3.5-flash";
              const hasDefault = existingModels.some((m) => m.id === defaultModelId);
              const mergedModels = hasDefault
                ? existingModels
                : [...existingModels, { id: defaultModelId, name: "Gemini 3.5 Flash" }];
              return {
                env: {
                  vars: {
                    GOOGLE_CLOUD_PROJECT: project,
                    GOOGLE_CLOUD_LOCATION: location,
                  },
                },
                models: {
                  providers: {
                    "google-vertex": {
                      models: mergedModels,
                    },
                  },
                },
              } as unknown as Partial<OpenClawConfig>;
            })(),
            notes: [
              `Project: ${project}, Location: ${location}`,
              "Credentials will be resolved via Application Default Credentials (ADC).",
              "On GCE/GKE/Cloud Run, the metadata server provides credentials automatically.",
              "With gcloud CLI, run: gcloud auth application-default login",
            ],
          };
        },
        wizard: {
          choiceId: "google-vertex-adc",
          choiceLabel: "Google Vertex AI (ADC)",
          groupId: "google",
          groupLabel: "Google",
          groupHint: "Gemini API key + OAuth + Vertex AI",
        },
      },
    ],
  };
}

export function createGoogleGeminiCliProvider(): ProviderPlugin {
  return {
    id: "google-gemini-cli",
    label: "Gemini CLI runtime",
    docsPath: "/providers/models",
    aliases: ["gemini-cli"],
    envVars: [],
    auth: [],
  };
}
