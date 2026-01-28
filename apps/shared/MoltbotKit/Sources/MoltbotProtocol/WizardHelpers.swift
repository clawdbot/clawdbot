import Foundation

public struct WizardOption: Sendable {
    public let value: AnyCodable?
    public let label: String
    public let hint: String?

    public init(value: AnyCodable?, label: String, hint: String?) {
        self.value = value
        self.label = label
        self.hint = hint
    }
}

public func decodeWizardStep(_ raw: [String: AnyCodable]?) -> WizardStep? {
    guard let raw else { return nil }
    do {
        let data = try JSONEncoder().encode(raw)
        return try JSONDecoder().decode(WizardStep.self, from: data)
    } catch {
        return nil
    }
}

public func parseWizardOptions(_ raw: [[String: AnyCodable]]?) -> [WizardOption] {
    guard let raw else { return [] }
    return raw.map { entry in
        let value = entry["value"]
        let label = (entry["label"]?.value as? String) ?? ""
        let hint = entry["hint"]?.value as? String
        return WizardOption(value: value, label: label, hint: hint)
    }
}

public func wizardStatusString(_ value: AnyCodable?) -> String? {
    (value?.value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
}

public func wizardStepType(_ step: WizardStep) -> String {
    (step.type.value as? String) ?? ""
}

public func anyCodableString(_ value: AnyCodable?) -> String {
    switch value?.value {
    case let string as String:
        string
    case let int as Int:
        String(int)
    case let double as Double:
        String(double)
    case let bool as Bool:
        bool ? "true" : "false"
    default:
        ""
    }
}

public func anyCodableBool(_ value: AnyCodable?) -> Bool {
    switch value?.value {
    case let bool as Bool:
        return bool
    case let int as Int:
        return int != 0
    case let double as Double:
        return double != 0
    case let string as String:
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return trimmed == "true" || trimmed == "1" || trimmed == "yes"
    default:
        return false
    }
}

public func anyCodableArray(_ value: AnyCodable?) -> [AnyCodable] {
    switch value?.value {
    case let arr as [AnyCodable]:
        return arr
    case let arr as [Any]:
        return arr.map { AnyCodable($0) }
    default:
        return []
    }
}

public func anyCodableEqual(_ lhs: AnyCodable?, _ rhs: AnyCodable?) -> Bool {
    switch (lhs?.value, rhs?.value) {
    case let (l as String, r as String):
        l == r
    case let (l as Int, r as Int):
        l == r
    case let (l as Double, r as Double):
        l == r
    case let (l as Bool, r as Bool):
        l == r
    case let (l as String, r as Int):
        l == String(r)
    case let (l as Int, r as String):
        String(l) == r
    case let (l as String, r as Double):
        l == String(r)
    case let (l as Double, r as String):
        String(l) == r
    default:
        false
    }
}
