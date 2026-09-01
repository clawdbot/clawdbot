// TTS contract tests cover text-to-speech plugin capability and runtime behavior.
import {
  describeTtsAutoApplyContract,
  describeTtsConfigContract,
  describeTtsProviderRuntimeContract,
  describeTtsSummarizationContract,
} from "./tts-contract-suites.js";

describeTtsAutoApplyContract();
describeTtsConfigContract();
describeTtsProviderRuntimeContract();
describeTtsSummarizationContract();
