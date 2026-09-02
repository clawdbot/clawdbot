import Foundation
import Testing
@testable import OpenClawChatUI

private func pickerModel(_ selectionID: String) -> OpenClawChatModelChoice {
    let parts = selectionID.split(separator: "/", maxSplits: 1).map(String.init)
    return OpenClawChatModelChoice(
        modelID: parts.count == 2 ? parts[1] : selectionID,
        name: selectionID,
        provider: parts.count == 2 ? parts[0] : "test",
        contextWindow: nil)
}

@MainActor
private func withPickerStore(_ body: (ChatModelPickerStore, UserDefaults) throws -> Void) throws {
    let suiteName = "ChatModelPickerStoreTests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    try body(ChatModelPickerStore(defaults: defaults), defaults)
}

@MainActor
@Suite struct ChatModelPickerStoreTests {
    @Test func `favorites and recents round trip through defaults`() throws {
        try withPickerStore { store, defaults in
            store.toggleFavorite("anthropic/opus")
            store.recordRecent("openai/gpt")

            let reloaded = ChatModelPickerStore(defaults: defaults)
            #expect(reloaded.favorites == ["anthropic/opus"])
            #expect(reloaded.recents == ["openai/gpt"])
        }
    }

    @Test func `recents dedupe move to front cap and skip invalid ids`() throws {
        try withPickerStore { store, _ in
            store.recordRecent("")
            store.recordRecent(OpenClawChatViewModel.defaultModelSelectionID)
            for id in ["one", "two", "three", "four", "five", "six"] {
                store.recordRecent(id)
            }
            #expect(store.recents == ["six", "five", "four", "three", "two"])

            store.recordRecent("four")
            #expect(store.recents == ["four", "six", "five", "three", "two"])
        }
    }

    @Test func `favorites preserve pin order and remove unpinned ids`() throws {
        try withPickerStore { store, _ in
            store.toggleFavorite("one")
            store.toggleFavorite("two")
            store.toggleFavorite("three")
            #expect(store.favorites == ["one", "two", "three"])

            store.toggleFavorite("two")
            #expect(store.favorites == ["one", "three"])

            store.toggleFavorite("two")
            #expect(store.favorites == ["one", "three", "two"])
        }
    }

    @Test func `separate stores preserve each others updates`() throws {
        try withPickerStore { first, defaults in
            let second = ChatModelPickerStore(defaults: defaults)

            first.toggleFavorite("one")
            second.toggleFavorite("two")
            #expect(second.favorites == ["one", "two"])

            first.recordRecent("one")
            second.recordRecent("two")
            #expect(second.recents == ["two", "one"])
        }
    }

    @Test func `ordering preserves sections and skips missing models`() {
        let choices = [pickerModel("a/one"), pickerModel("b/two"), pickerModel("c/three"), pickerModel("d/four")]
        let sections = ChatModelPickerStore.sections(
            choices: choices,
            favorites: ["c/three", "missing/model", "a/one"],
            recents: ["a/one", "d/four", "missing/recent"],
            defaultProvider: "b")

        #expect(sections.pinned.map(\.selectionID) == ["c/three", "a/one"])
        #expect(sections.recent.map(\.selectionID) == ["d/four"])
        #expect(sections.providers.flatMap(\.models).map(\.selectionID) == ["b/two"])
        #expect(sections.providers.map(\.id) == ["b"])
        #expect(sections.providers.first?.isDefaultProvider == true)
    }

    @Test func `ordering handles empty inputs`() {
        let sections = ChatModelPickerStore.sections(choices: [], favorites: [], recents: [])
        #expect(sections.pinned.isEmpty)
        #expect(sections.recent.isEmpty)
        #expect(sections.providers.flatMap(\.models).isEmpty)
    }

    @Test func `missing default provider does not mark other as default`() {
        let unqualified = OpenClawChatModelChoice(
            modelID: "local-model",
            name: "Local",
            provider: "",
            contextWindow: nil)
        let sections = ChatModelPickerStore.sections(choices: [unqualified], favorites: [], recents: [])

        #expect(sections.providers.map(\.id) == ["other"])
        #expect(sections.providers.first?.isDefaultProvider == false)
    }

    @Test func `remaining models group by provider with default provider first`() {
        let choices = [
            pickerModel("xai/grok"),
            pickerModel("openai/gpt"),
            pickerModel("anthropic/opus"),
            pickerModel("openai/o3"),
        ]
        let sections = ChatModelPickerStore.sections(
            choices: choices,
            favorites: [],
            recents: [],
            defaultProvider: "openai")

        #expect(sections.providers.map(\.id) == ["openai", "anthropic", "xai"])
        #expect(sections.providers[0].models.map(\.selectionID) == ["openai/gpt", "openai/o3"])
        #expect(sections.providers.map(\.displayName) == ["OpenAI", "Anthropic", "xAI"])
    }

    @Test func `qualified global default matches provider model pair`() {
        let model = pickerModel("openai/gpt")
        let qualifiedModelID = OpenClawChatModelChoice(
            modelID: "openai/gpt",
            name: "GPT",
            provider: "openai",
            contextWindow: nil)

        #expect(ChatModelPickerStore.isDefaultModel(
            model,
            defaultProvider: nil,
            defaultModel: "openai/gpt"))
        #expect(ChatModelPickerStore.isDefaultModel(
            model,
            defaultProvider: "openai",
            defaultModel: "gpt"))
        #expect(!ChatModelPickerStore.isDefaultModel(
            model,
            defaultProvider: "anthropic",
            defaultModel: "gpt"))
        #expect(ChatModelPickerStore.isDefaultModel(
            qualifiedModelID,
            defaultProvider: "openai",
            defaultModel: "gpt"))
    }

    @Test func `qualified default model supplies missing default provider`() {
        #expect(ChatModelPickerStore.resolvedDefaultProvider(
            provider: nil,
            model: "openai/gpt") == "openai")
        #expect(ChatModelPickerStore.resolvedDefaultProvider(
            provider: "anthropic",
            model: "openai/gpt") == "anthropic")
    }
}
