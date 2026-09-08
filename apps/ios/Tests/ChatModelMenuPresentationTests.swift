import OpenClawChatUI
import Testing
@testable import OpenClaw

struct ChatModelMenuPresentationTests {
    @Test func `provider identities resolve to bundled brand marks`() {
        #expect(ChatModelMenuPresentation.iconAssetName(providerID: "openai") == "ProviderIconOpenAI")
        #expect(ChatModelMenuPresentation.iconAssetName(providerID: "anthropic") == "ProviderIconAnthropic")
        #expect(ChatModelMenuPresentation.iconAssetName(providerID: "claude-cli") == "ProviderIconAnthropic")
        #expect(ChatModelMenuPresentation.iconAssetName(providerID: "google-gemini-cli") == "ProviderIconGoogle")
        #expect(ChatModelMenuPresentation.iconAssetName(providerID: "xai") == "ProviderIconXAI")
        #expect(ChatModelMenuPresentation.iconAssetName(providerID: "openrouter") == "ProviderIconOpenRouter")
        #expect(ChatModelMenuPresentation.iconAssetName(providerID: "minimax-portal") == "ProviderIconMiniMax")
        #expect(ChatModelMenuPresentation.iconAssetName(providerID: "openai-codex") == nil)
    }

    @Test func `provider identities use canonical repository brand palettes`() {
        #expect(ChatModelMenuPresentation.brandPalette(providerID: "openai") == .openAI)
        #expect(ChatModelMenuPresentation.brandPalette(providerID: "anthropic") == .anthropic)
        #expect(ChatModelMenuPresentation.brandPalette(providerID: "claude-cli") == .anthropic)
        #expect(ChatModelMenuPresentation.brandPalette(providerID: "google-gemini-cli") == .google)
        #expect(ChatModelMenuPresentation.brandPalette(providerID: "openrouter") == .adaptiveMonochrome)
    }

    @Test func `unknown provider keeps a stable branded fallback`() {
        #expect(ChatModelMenuPresentation.iconAssetName(providerID: "custom-lab") == nil)
        #expect(ChatModelMenuPresentation.fallbackMonogram(providerID: " custom-lab ") == "C")
        #expect(ChatModelMenuPresentation.fallbackMonogram(providerID: nil) == "?")
    }

    @Test func `model provider prefers metadata and falls back to qualified id`() {
        let metadata = OpenClawChatModelChoice(
            modelID: "gpt-5.6-sol",
            name: "GPT-5.6 Sol",
            provider: " OpenAI ",
            contextWindow: 200_000)
        let qualified = OpenClawChatModelChoice(
            modelID: "anthropic/claude-opus-4-7",
            name: "Claude Opus 4.7",
            provider: "",
            contextWindow: 200_000)
        let unqualified = OpenClawChatModelChoice(
            modelID: "custom-model",
            name: "Custom Model",
            provider: "",
            contextWindow: nil)

        #expect(ChatModelMenuPresentation.providerID(for: metadata) == "openai")
        #expect(ChatModelMenuPresentation.providerID(for: qualified) == "anthropic")
        #expect(ChatModelMenuPresentation.providerID(for: unqualified) == nil)
    }

    @Test func `agent model fills an unresolved default label`() {
        #expect(ChatModelMenuPresentation.resolvedDefaultLabel(
            sessionDefaultLabel: "Default",
            agentModelReference: " openai/gpt-5.6-sol ") == "Default: openai/gpt-5.6-sol")
        #expect(ChatModelMenuPresentation.resolvedDefaultLabel(
            sessionDefaultLabel: "Default: anthropic/claude-opus-4-7",
            agentModelReference: "openai/gpt-5.6-sol") == "Default: anthropic/claude-opus-4-7")
        #expect(ChatModelMenuPresentation.resolvedDefaultLabel(
            sessionDefaultLabel: "Default",
            agentModelReference: nil) == "Default")
    }

    @Test func `agent model reference carries provider identity into the default row`() {
        #expect(ChatModelMenuPresentation.qualifiedModelReference(
            modelID: "gpt-5.6-sol",
            providerID: "openai") == "openai/gpt-5.6-sol")
        #expect(ChatModelMenuPresentation.qualifiedModelReference(
            modelID: "openai/gpt-5.6-sol",
            providerID: "anthropic") == "openai/gpt-5.6-sol")
        #expect(ChatModelMenuPresentation.providerID(
            forModelReference: "openai/gpt-5.6-sol") == "openai")
    }

    @Test func `thinking slider maps gateway stops without inventing levels`() {
        let options = [
            OpenClawChatThinkingLevelOption(id: "low", label: "Low"),
            OpenClawChatThinkingLevelOption(id: "medium", label: "Medium"),
            OpenClawChatThinkingLevelOption(id: "high", label: "High"),
        ]

        #expect(ChatThinkingSliderPresentation.index(
            selectionID: OpenClawChatViewModel.inheritedThinkingSelectionID,
            effectiveLevelID: "high",
            options: options) == 2)
        #expect(ChatThinkingSliderPresentation.index(
            selectionID: "medium",
            effectiveLevelID: "high",
            options: options) == 1)
        #expect(ChatThinkingSliderPresentation.selectionID(index: 0, options: options) == "low")
        #expect(ChatThinkingSliderPresentation.selectionID(index: 2, options: options) == "high")
        #expect(ChatThinkingSliderPresentation.selectionID(index: 9, options: options) == nil)
    }

    @Test func `thinking slider labels inherited and explicit effort distinctly`() {
        let options = [
            OpenClawChatThinkingLevelOption(id: "low", label: "Low"),
            OpenClawChatThinkingLevelOption(id: "high", label: "High"),
        ]

        #expect(ChatThinkingSliderPresentation.valueLabel(
            selectionID: OpenClawChatViewModel.inheritedThinkingSelectionID,
            effectiveLevelID: "high",
            options: options) == "Default (High)")
        #expect(ChatThinkingSliderPresentation.valueLabel(
            selectionID: "low",
            effectiveLevelID: "high",
            options: options) == "Low")
        #expect(ChatThinkingSliderPresentation.valueLabel(
            selectionID: OpenClawChatViewModel.inheritedThinkingSelectionID,
            effectiveLevelID: "ultra",
            options: options) == "Default (Ultra)")
    }

    @Test func `thinking slider exposes one notch per gateway stop`() {
        let options = [
            OpenClawChatThinkingLevelOption(id: "off", label: "Off"),
            OpenClawChatThinkingLevelOption(id: "low", label: "Low"),
            OpenClawChatThinkingLevelOption(id: "medium", label: "Medium"),
            OpenClawChatThinkingLevelOption(id: "high", label: "High"),
        ]

        #expect(ChatThinkingSliderPresentation.notchIndices(options: options) == [0, 1, 2, 3])
    }

    @Test func `fast switch reflects effective inheritance and emits only binary values`() {
        let inherited = OpenClawChatViewModel.inheritedThinkingSelectionID

        #expect(ChatFastModeControlPresentation.isOn(
            selectionID: inherited,
            effectiveIsEnabled: true))
        #expect(!ChatFastModeControlPresentation.isOn(
            selectionID: inherited,
            effectiveIsEnabled: false))
        #expect(ChatFastModeControlPresentation.isOn(
            selectionID: "on",
            effectiveIsEnabled: false))
        #expect(!ChatFastModeControlPresentation.isOn(
            selectionID: "off",
            effectiveIsEnabled: true))
        #expect(ChatFastModeControlPresentation.selectionID(isOn: true) == "on")
        #expect(ChatFastModeControlPresentation.selectionID(isOn: false) == "off")
    }

    @Test func `verbosity segments resolve inheritance without inventing a fourth level`() {
        let inherited = OpenClawChatViewModel.inheritedThinkingSelectionID

        #expect(ChatVerbosityControlPresentation.resolvedSelectionID(
            selectionID: inherited,
            inheritedLevelID: "full") == "full")
        #expect(ChatVerbosityControlPresentation.resolvedSelectionID(
            selectionID: "on",
            inheritedLevelID: "full") == "on")
        #expect(ChatVerbosityControlPresentation.resolvedSelectionID(
            selectionID: inherited,
            inheritedLevelID: "unsupported") == "off")
        #expect(ChatVerbosityControlPresentation.levelIDs == ["off", "on", "full"])
        #expect(ChatVerbosityControlPresentation.label(levelID: "off") == "Off")
        #expect(ChatVerbosityControlPresentation.label(levelID: "on") == "Activity")
        #expect(ChatVerbosityControlPresentation.label(levelID: "full") == "Full")
    }
}
