import Foundation

enum ConfigPathSegment: Hashable {
    case key(String)
    case index(Int)
}

typealias ConfigPath = [ConfigPathSegment]

struct ConfigUiHint {
    let label: String?
    let help: String?
    let order: Double?
    let advanced: Bool?
    let sensitive: Bool?
    let placeholder: String?

    init(raw: [String: Any]) {
        self.label = raw["label"] as? String
        self.help = raw["help"] as? String
        if let order = raw["order"] as? Double {
            self.order = order
        } else if let orderInt = raw["order"] as? Int {
            self.order = Double(orderInt)
        } else {
            self.order = nil
        }
        self.advanced = raw["advanced"] as? Bool
        self.sensitive = raw["sensitive"] as? Bool
        self.placeholder = raw["placeholder"] as? String
    }
}

struct ConfigSchemaNode {
    let raw: [String: Any]

    init?(raw: Any) {
        guard let dict = raw as? [String: Any] else { return nil }
        self.raw = dict
    }

    var title: String? { self.raw["title"] as? String }
    var description: String? { self.raw["description"] as? String }
    var enumValues: [Any]? { self.raw["enum"] as? [Any] }
    var constValue: Any? { self.raw["const"] }
    var explicitDefault: Any? { self.raw["default"] }
    var requiredKeys: Set<String> {
        Set((self.raw["required"] as? [String]) ?? [])
    }

    var typeList: [String] {
        if let type = self.raw["type"] as? String { return [type] }
        if let types = self.raw["type"] as? [String] { return types }
        return []
    }

    var schemaType: String? {
        let filtered = self.typeList.filter { $0 != "null" }
        if let first = filtered.first { return first }
        return self.typeList.first
    }

    var isNullSchema: Bool {
        let types = self.typeList
        return types.count == 1 && types.first == "null"
    }

    var properties: [String: ConfigSchemaNode] {
        guard let props = self.raw["properties"] as? [String: Any] else { return [:] }
        return props.compactMapValues { ConfigSchemaNode(raw: $0) }
    }

    var anyOf: [ConfigSchemaNode] {
        guard let raw = self.raw["anyOf"] as? [Any] else { return [] }
        return raw.compactMap { ConfigSchemaNode(raw: $0) }
    }

    var oneOf: [ConfigSchemaNode] {
        guard let raw = self.raw["oneOf"] as? [Any] else { return [] }
        return raw.compactMap { ConfigSchemaNode(raw: $0) }
    }

    var literalValue: Any? {
        if let constValue { return constValue }
        if let enumValues, enumValues.count == 1 { return enumValues[0] }
        return nil
    }

    var items: ConfigSchemaNode? {
        if let items = self.raw["items"] as? [Any], let first = items.first {
            return ConfigSchemaNode(raw: first)
        }
        if let items = self.raw["items"] {
            return ConfigSchemaNode(raw: items)
        }
        return nil
    }

    var additionalProperties: ConfigSchemaNode? {
        if let additional = self.raw["additionalProperties"] as? [String: Any] {
            return ConfigSchemaNode(raw: additional)
        }
        return nil
    }

    var allowsAdditionalProperties: Bool {
        if let allow = self.raw["additionalProperties"] as? Bool { return allow }
        return self.additionalProperties != nil
    }

    var defaultValue: Any {
        if let value = self.raw["default"] { return value }
        switch self.schemaType {
        case "object":
            return [String: Any]()
        case "array":
            return [Any]()
        case "boolean":
            return false
        case "integer":
            return 0
        case "number":
            return 0.0
        case "string":
            return ""
        default:
            return ""
        }
    }

    func node(at path: ConfigPath) -> ConfigSchemaNode? {
        var current: ConfigSchemaNode? = self
        for segment in path {
            guard let node = current else { return nil }
            switch segment {
            case let .key(key):
                if node.schemaType == "object" {
                    if let next = node.properties[key] {
                        current = next
                        continue
                    }
                    if let additional = node.additionalProperties {
                        current = additional
                        continue
                    }
                    return nil
                }
                return nil
            case .index:
                guard node.schemaType == "array" else { return nil }
                current = node.items
            }
        }
        return current
    }
}

func decodeUiHints(_ raw: [String: Any]) -> [String: ConfigUiHint] {
    raw.reduce(into: [:]) { result, entry in
        if let hint = entry.value as? [String: Any] {
            result[entry.key] = ConfigUiHint(raw: hint)
        }
    }
}

func hintForPath(_ path: ConfigPath, hints: [String: ConfigUiHint]) -> ConfigUiHint? {
    let key = pathKey(path)
    if let direct = hints[key] { return direct }
    let segments = key.split(separator: ".").map(String.init)
    for (hintKey, hint) in hints {
        guard hintKey.contains("*") else { continue }
        let hintSegments = hintKey.split(separator: ".").map(String.init)
        guard hintSegments.count == segments.count else { continue }
        var match = true
        for (index, seg) in segments.enumerated() {
            let hintSegment = hintSegments[index]
            if hintSegment != "*", hintSegment != seg {
                match = false
                break
            }
        }
        if match { return hint }
    }
    return nil
}

func isSensitivePath(_ path: ConfigPath) -> Bool {
    let key = pathKey(path).lowercased()
    return key.contains("token")
        || key.contains("password")
        || key.contains("secret")
        || key.contains("apikey")
        || key.hasSuffix("key")
}

func pathKey(_ path: ConfigPath) -> String {
    path.compactMap { segment -> String? in
        switch segment {
        case let .key(key): return key
        case .index: return nil
        }
    }
    .joined(separator: ".")
}
