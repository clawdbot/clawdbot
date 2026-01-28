import Foundation

struct DevicePresentation: Sendable {
    let title: String
    let symbol: String?
}

enum DeviceModelCatalog {
    private static let modelIdentifierToName: [String: String] = loadModelIdentifierToName()
    private static let resourceBundle: Bundle? = locateResourceBundle()
    private static let resourceSubdirectory = "DeviceModels"

    static func presentation(deviceFamily: String?, modelIdentifier: String?) -> DevicePresentation? {
        let family = (deviceFamily ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let model = (modelIdentifier ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

        let friendlyName = model.isEmpty ? nil : self.modelIdentifierToName[model]
        let symbol = self.symbol(deviceFamily: family, modelIdentifier: model, friendlyName: friendlyName)

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

    static func symbol(
        deviceFamily familyRaw: String,
        modelIdentifier modelIdentifierRaw: String,
        friendlyName: String?) -> String?
    {
        let family = familyRaw.trimmingCharacters(in: .whitespacesAndNewlines)
        let modelIdentifier = modelIdentifierRaw.trimmingCharacters(in: .whitespacesAndNewlines)

        return self.symbolFor(modelIdentifier: modelIdentifier, friendlyName: friendlyName)
            ?? self.fallbackSymbol(for: family, modelIdentifier: modelIdentifier)
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
        if lower.hasPrefix("macstudio") { return "macstudio" }
        if lower.hasPrefix("macmini") { return "macmini" }
        if lower.hasPrefix("imac") || lower.hasPrefix("macpro") { return "desktopcomputer" }

        if lower.hasPrefix("mac"), let friendlyNameLower = friendlyName?.lowercased() {
            if friendlyNameLower.contains("macbook") { return "laptopcomputer" }
            if friendlyNameLower.contains("imac") { return "desktopcomputer" }
            if friendlyNameLower.contains("mac mini") { return "macmini" }
            if friendlyNameLower.contains("mac studio") { return "macstudio" }
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
            return "android"
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
        guard let url = self.resourceBundle?.url(
            forResource: resourceName,
            withExtension: "json",
            subdirectory: self.resourceSubdirectory)
        else { return [:] }

        do {
            let data = try Data(contentsOf: url)
            let decoded = try JSONDecoder().decode([String: NameValue].self, from: data)
            return decoded.compactMapValues { $0.normalizedName }
        } catch {
            return [:]
        }
    }

    private static func locateResourceBundle() -> Bundle? {
        // Prefer main bundle (packaged app), then module bundle (SwiftPM/tests).
        // Accessing Bundle.module in the packaged app can crash if the bundle isn't where SwiftPM expects it.
        if let bundle = self.bundleIfContainsDeviceModels(Bundle.main) {
            return bundle
        }

        if let bundle = self.bundleIfContainsDeviceModels(Bundle.module) {
            return bundle
        }
        return nil
    }

    private static func bundleIfContainsDeviceModels(_ bundle: Bundle) -> Bundle? {
        if bundle.url(
            forResource: "ios-device-identifiers",
            withExtension: "json",
            subdirectory: self.resourceSubdirectory) != nil
        {
            return bundle
        }
        if bundle.url(
            forResource: "mac-device-identifiers",
            withExtension: "json",
            subdirectory: self.resourceSubdirectory) != nil
        {
            return bundle
        }
        return nil
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
