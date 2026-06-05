// Verifies image-generation tool registration through the shared generation harness.
import { describeOpenClawGenerationToolRegistration } from "./openclaw-tools.generation.test-support.js";

describeOpenClawGenerationToolRegistration({
  suiteName: "openclaw tools image generation registration",
  toolName: "image_generate",
  toolLabel: "an image-generation tool",
});
