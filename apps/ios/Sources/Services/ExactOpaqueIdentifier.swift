import Foundation

struct ExactOpaqueIdentifierKey: Hashable, Sendable {
    let rawValue: String
    private let bytes: [UInt8]

    init(_ rawValue: String) {
        self.rawValue = rawValue
        self.bytes = Array(rawValue.utf8)
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.bytes == rhs.bytes
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(self.bytes)
    }

    var notificationComponent: String {
        let hexDigits = Array("0123456789ABCDEF".utf8)
        // Keep dots encoded so gateway and approval components cannot collapse into
        // the same notification identifier when their separator moves.
        let encoded = self.bytes.flatMap { byte -> [UInt8] in
            switch byte {
            case 0x30...0x39, 0x41...0x5A, 0x61...0x7A, 0x2D, 0x5F, 0x7E:
                [byte]
            default:
                [0x25, hexDigits[Int(byte >> 4)], hexDigits[Int(byte & 0x0F)]]
            }
        }
        return String(encoded.map { Character(UnicodeScalar($0)) })
    }
}

enum ExactOpaqueIdentifier {
    static func exact(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }

    static func key(_ value: String?) -> ExactOpaqueIdentifierKey? {
        self.exact(value).map(ExactOpaqueIdentifierKey.init)
    }
}

enum ExecApprovalIdentifier {
    typealias Key = ExactOpaqueIdentifierKey

    static func exact(_ value: String?) -> String? {
        guard let value = ExactOpaqueIdentifier.exact(value), value != ".", value != ".." else {
            return nil
        }
        return value
    }

    static func key(_ value: String?) -> Key? {
        self.exact(value).map(Key.init)
    }

    static func matches(_ lhs: String, _ rhs: String) -> Bool {
        guard let lhsKey = self.key(lhs), let rhsKey = self.key(rhs) else { return false }
        return lhsKey == rhsKey
    }

    static func sortsBefore(_ lhs: String, _ rhs: String) -> Bool {
        Array(lhs.utf8).lexicographicallyPrecedes(Array(rhs.utf8))
    }
}

enum GatewayStableIdentifier {
    typealias Key = ExactOpaqueIdentifierKey

    static func exact(_ value: String?) -> String? {
        ExactOpaqueIdentifier.exact(value)
    }

    static func key(_ value: String?) -> Key? {
        ExactOpaqueIdentifier.key(value)
    }

    static func matches(_ lhs: String, _ rhs: String) -> Bool {
        guard let lhsKey = self.key(lhs), let rhsKey = self.key(rhs) else { return false }
        return lhsKey == rhsKey
    }

    static func matches(_ lhs: String?, _ rhs: String?) -> Bool {
        guard let lhsKey = self.key(lhs), let rhsKey = self.key(rhs) else { return false }
        return lhsKey == rhsKey
    }

    static func sortsBefore(_ lhs: String, _ rhs: String) -> Bool {
        Array(lhs.utf8).lexicographicallyPrecedes(Array(rhs.utf8))
    }

    /// Storage attributes can apply Unicode equivalence. Encode the original UTF-8
    /// bytes so canonically equivalent gateway owners remain separate persisted keys.
    static func storageComponent(_ value: String) -> String? {
        guard let value = self.exact(value) else { return nil }
        return Data(value.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
