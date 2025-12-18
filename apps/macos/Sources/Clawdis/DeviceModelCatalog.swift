import Foundation

struct DevicePresentation: Sendable {
    let title: String
    let symbol: String?
}

enum DeviceModelCatalog {
    private static let modelIdentifierToName: [String: String] = loadModelIdentifierToName()

    static func presentation(deviceFamily: String?, modelIdentifier: String?) -> DevicePresentation? {
        let family = (deviceFamily ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let model = (modelIdentifier ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

        let friendlyName = model.isEmpty ? nil : self.modelIdentifierToName[model]
        let symbol = self.symbolFor(modelIdentifier: model, friendlyName: friendlyName)
            ?? self.fallbackSymbol(for: family, modelIdentifier: model)

        let title = if let friendlyName, !friendlyName.isEmpty {
            friendlyName
        } else if !family.isEmpty, !model.isEmpty {
            "\(family) (\(model))"
        } else if !family.isEmpty {
            family
        } else if !model.isEmpty {
            model
        } else {
            ""
        }

        if title.isEmpty { return nil }
        return DevicePresentation(title: title, symbol: symbol)
    }

    private static func symbolFor(modelIdentifier rawModelIdentifier: String, friendlyName: String?) -> String? {
        let modelIdentifier = rawModelIdentifier.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !modelIdentifier.isEmpty else { return nil }

        let lower = modelIdentifier.lowercased()
        if lower.hasPrefix("ipad") { return "ipad" }
        if lower.hasPrefix("iphone") { return "iphone" }
        if lower.hasPrefix("ipod") { return "iphone" }
        if lower.hasPrefix("watch") { return "applewatch" }
        if lower.hasPrefix("appletv") { return "appletv" }
        if lower.hasPrefix("audio") || lower.hasPrefix("homepod") { return "speaker" }

        if lower.hasPrefix("macbook") || lower.hasPrefix("macbookpro") || lower.hasPrefix("macbookair") {
            return "laptopcomputer"
        }
        if lower.hasPrefix("imac") || lower.hasPrefix("macmini") || lower.hasPrefix("macpro") || lower
            .hasPrefix("macstudio")
        {
            return "desktopcomputer"
        }

        if lower.hasPrefix("mac"), let friendlyNameLower = friendlyName?.lowercased() {
            if friendlyNameLower.contains("macbook") { return "laptopcomputer" }
            if friendlyNameLower.contains("imac") { return "desktopcomputer" }
            if friendlyNameLower.contains("mac mini") { return "desktopcomputer" }
            if friendlyNameLower.contains("mac studio") { return "desktopcomputer" }
            if friendlyNameLower.contains("mac pro") { return "desktopcomputer" }
        }

        return nil
    }

    private static func fallbackSymbol(for familyRaw: String, modelIdentifier: String) -> String? {
        let family = familyRaw.trimmingCharacters(in: .whitespacesAndNewlines)
        if family.isEmpty { return nil }
        switch family.lowercased() {
        case "ipad":
            return "ipad"
        case "iphone":
            return "iphone"
        case "mac":
            return "laptopcomputer"
        case "android":
            // Prefer tablet glyph when we know it's an Android tablet. (No attempt to infer phone/tablet here.)
            return "cpu"
        case "linux":
            return "cpu"
        default:
            return "cpu"
        }
    }

    private static func loadModelIdentifierToName() -> [String: String] {
        var combined: [String: String] = [:]
        combined.merge(
            self.loadMapping(resourceName: "ios-device-identifiers"),
            uniquingKeysWith: { current, _ in current })
        combined.merge(
            self.loadMapping(resourceName: "mac-device-identifiers"),
            uniquingKeysWith: { current, _ in current })
        return combined
    }

    private static func loadMapping(resourceName: String) -> [String: String] {
        guard let url = Bundle.module.url(
            forResource: resourceName,
            withExtension: "json",
            subdirectory: "DeviceModels")
        else {
            return [:]
        }

        do {
            let data = try Data(contentsOf: url)
            let decoded = try JSONDecoder().decode([String: NameValue].self, from: data)
            return decoded.compactMapValues { $0.normalizedName }
        } catch {
            return [:]
        }
    }

    private enum NameValue: Decodable {
        case string(String)
        case stringArray([String])

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let s = try? container.decode(String.self) {
                self = .string(s)
                return
            }
            if let arr = try? container.decode([String].self) {
                self = .stringArray(arr)
                return
            }
            throw DecodingError.typeMismatch(
                String.self,
                .init(codingPath: decoder.codingPath, debugDescription: "Expected string or string array"))
        }

        var normalizedName: String? {
            switch self {
            case let .string(s):
                let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? nil : trimmed
            case let .stringArray(arr):
                let values = arr
                    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }
                guard !values.isEmpty else { return nil }
                return values.joined(separator: " / ")
            }
        }
    }
}
