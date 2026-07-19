import Foundation

public struct ChatModelProviderSection: Identifiable, Sendable, Equatable {
    public let id: String
    public let displayName: String
    public let models: [OpenClawChatModelChoice]
    public let isDefaultProvider: Bool
}

public struct ChatModelPickerSections: Sendable, Equatable {
    public let pinned: [OpenClawChatModelChoice]
    public let recent: [OpenClawChatModelChoice]
    public let providers: [ChatModelProviderSection]
}

@MainActor
public final class ChatModelPickerStore {
    private static let favoritesKey = "openclaw.chat.modelFavorites"
    private static let recentsKey = "openclaw.chat.modelRecents"
    private static let maxRecents = 5

    private let defaults: UserDefaults

    public private(set) var favorites: [String]
    public private(set) var recents: [String]

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.favorites = defaults.stringArray(forKey: Self.favoritesKey) ?? []
        self.recents = defaults.stringArray(forKey: Self.recentsKey) ?? []
    }

    public func isFavorite(_ selectionID: String) -> Bool {
        self.favorites.contains(selectionID)
    }

    public func toggleFavorite(_ selectionID: String) {
        self.favorites = self.defaults.stringArray(forKey: Self.favoritesKey) ?? []
        if self.isFavorite(selectionID) {
            self.favorites.removeAll { $0 == selectionID }
        } else {
            self.favorites.append(selectionID)
        }
        self.defaults.set(self.favorites, forKey: Self.favoritesKey)
    }

    public func recordRecent(_ selectionID: String) {
        guard !selectionID.isEmpty, selectionID != OpenClawChatViewModel.defaultModelSelectionID else { return }
        self.recents = self.defaults.stringArray(forKey: Self.recentsKey) ?? []
        self.recents.removeAll { $0 == selectionID }
        self.recents.insert(selectionID, at: 0)
        self.recents = Array(self.recents.prefix(Self.maxRecents))
        self.defaults.set(self.recents, forKey: Self.recentsKey)
    }

    public static func sections(
        choices: [OpenClawChatModelChoice],
        favorites: [String],
        recents: [String],
        defaultProvider: String? = nil) -> ChatModelPickerSections
    {
        var choicesByID: [String: OpenClawChatModelChoice] = [:]
        for choice in choices where choicesByID[choice.selectionID] == nil {
            choicesByID[choice.selectionID] = choice
        }

        var included = Set<String>()
        let pinned = favorites.compactMap { selectionID -> OpenClawChatModelChoice? in
            guard included.insert(selectionID).inserted else { return nil }
            return choicesByID[selectionID]
        }
        let recent = recents.compactMap { selectionID -> OpenClawChatModelChoice? in
            guard included.insert(selectionID).inserted else { return nil }
            return choicesByID[selectionID]
        }
        let remaining = choices.filter { included.insert($0.selectionID).inserted }
        let normalizedDefaultProvider = self.normalizedProviderIfPresent(defaultProvider)
        let grouped = Dictionary(grouping: remaining) { choice in
            let metadataProvider = self.normalizedProvider(choice.provider)
            if metadataProvider != "other" {
                return metadataProvider
            }
            return self.providerFromQualifiedModelID(choice.modelID) ?? metadataProvider
        }
        let providers = grouped.map { provider, models in
            ChatModelProviderSection(
                id: provider,
                displayName: self.providerDisplayName(provider),
                models: models,
                isDefaultProvider: normalizedDefaultProvider.map { provider == $0 } ?? false)
        }.sorted { lhs, rhs in
            if lhs.isDefaultProvider != rhs.isDefaultProvider {
                return lhs.isDefaultProvider
            }
            let nameOrder = lhs.displayName.localizedCaseInsensitiveCompare(rhs.displayName)
            if nameOrder != .orderedSame {
                return nameOrder == .orderedAscending
            }
            return lhs.id < rhs.id
        }
        return ChatModelPickerSections(pinned: pinned, recent: recent, providers: providers)
    }

    static func isDefaultModel(
        _ choice: OpenClawChatModelChoice,
        defaultProvider: String?,
        defaultModel: String?) -> Bool
    {
        guard let rawDefaultModel = self.trimmedValue(defaultModel) else { return false }
        let qualifiedDefault = self.splitQualifiedModelID(rawDefaultModel)
        let expectedProvider = self.normalizedProviderIfPresent(defaultProvider)
            ?? qualifiedDefault.map { self.normalizedProvider($0.provider) }
        let expectedModel = qualifiedDefault?.modelID ?? rawDefaultModel
        let choiceModel = self.splitQualifiedModelID(choice.modelID)?.modelID ?? choice.modelID
        guard choiceModel == expectedModel || choice.modelID == rawDefaultModel else { return false }
        guard let expectedProvider else { return true }
        return self.effectiveProvider(choice) == expectedProvider
    }

    static func resolvedDefaultProvider(provider: String?, model: String?) -> String? {
        self.normalizedProviderIfPresent(provider)
            ?? model.flatMap(self.providerFromQualifiedModelID)
    }

    private static func normalizedProvider(_ provider: String?) -> String {
        let normalized = self.trimmedValue(provider)?.lowercased() ?? ""
        return normalized.isEmpty ? "other" : normalized
    }

    private static func normalizedProviderIfPresent(_ provider: String?) -> String? {
        guard let provider = self.trimmedValue(provider) else { return nil }
        return self.normalizedProvider(provider)
    }

    private static func effectiveProvider(_ choice: OpenClawChatModelChoice) -> String {
        let metadataProvider = self.normalizedProvider(choice.provider)
        if metadataProvider != "other" {
            return metadataProvider
        }
        return self.providerFromQualifiedModelID(choice.modelID) ?? metadataProvider
    }

    private static func trimmedValue(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let trimmed, !trimmed.isEmpty else { return nil }
        return trimmed
    }

    private static func splitQualifiedModelID(_ modelID: String) -> (provider: String, modelID: String)? {
        let parts = modelID.split(separator: "/", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return nil }
        return (parts[0], parts[1])
    }

    private static func providerFromQualifiedModelID(_ modelID: String) -> String? {
        guard let parts = self.splitQualifiedModelID(modelID) else { return nil }
        let normalized = self.normalizedProvider(parts.provider)
        return normalized == "other" ? nil : normalized
    }

    private static func providerDisplayName(_ provider: String) -> String {
        switch provider {
        case "anthropic": "Anthropic"
        case "google", "google-gemini-cli": "Google"
        case "minimax", "minimax-portal": "MiniMax"
        case "openai": "OpenAI"
        case "xai": "xAI"
        case "other": String(localized: "Other")
        default:
            provider
                .split(separator: "-")
                .map(\.capitalized)
                .joined(separator: " ")
        }
    }
}
