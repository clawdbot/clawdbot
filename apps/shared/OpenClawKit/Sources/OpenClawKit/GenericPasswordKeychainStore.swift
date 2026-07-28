import Foundation
import Security

public enum GenericPasswordKeychainStore {
    public struct MutationError: Error, Equatable, LocalizedError, Sendable {
        public enum Operation: String, Equatable, Sendable {
            case update
            case add
            case updateAfterAddConflict
            case delete
        }

        public let operation: Operation
        public let status: OSStatus

        public init(operation: Operation, status: OSStatus) {
            self.operation = operation
            self.status = status
        }

        public var errorDescription: String? {
            let message = SecCopyErrorMessageString(self.status, nil) as String? ?? "Unknown Security error"
            return "Keychain \(self.operation.rawValue) failed (OSStatus \(self.status)): \(message)"
        }
    }

    public static func loadString(service: String, account: String) -> String? {
        guard let data = self.loadData(service: service, account: account) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    public static func saveString(
        _ value: String,
        service: String,
        account: String,
        accessible: CFString = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly) -> Bool
    {
        switch self.saveStringResult(value, service: service, account: account, accessible: accessible) {
        case .success: true
        case .failure: false
        }
    }

    public static func saveStringResult(
        _ value: String,
        service: String,
        account: String,
        accessible: CFString = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
        -> Result<Void, MutationError>
    {
        self.saveDataResult(
            Data(value.utf8),
            service: service,
            account: account,
            accessible: accessible,
            updateItem: { SecItemUpdate($0, $1) },
            addItem: { SecItemAdd($0, nil) })
    }

    @discardableResult
    public static func delete(service: String, account: String) -> Bool {
        switch self.deleteResult(service: service, account: account) {
        case .success: true
        case .failure: false
        }
    }

    public static func deleteResult(
        service: String,
        account: String) -> Result<Void, MutationError>
    {
        self.deleteResult(
            service: service,
            account: account,
            deleteItem: { SecItemDelete($0) })
    }

    @discardableResult
    public static func deleteAll(service: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    private static func loadData(service: String, account: String) -> Data? {
        var query = self.baseQuery(service: service, account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return data
    }

    static func saveDataResult(
        _ data: Data,
        service: String,
        account: String,
        accessible: CFString,
        updateItem: (CFDictionary, CFDictionary) -> OSStatus,
        addItem: (CFDictionary) -> OSStatus) -> Result<Void, MutationError>
    {
        let query = self.baseQuery(service: service, account: account)
        let updates: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: accessible,
        ]
        let updateStatus = updateItem(query as CFDictionary, updates as CFDictionary)
        if updateStatus == errSecSuccess {
            return .success(())
        }
        guard updateStatus == errSecItemNotFound else {
            return .failure(MutationError(operation: .update, status: updateStatus))
        }

        var insert = query
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = accessible
        let addStatus = addItem(insert as CFDictionary)
        if addStatus == errSecSuccess {
            return .success(())
        }
        guard addStatus == errSecDuplicateItem else {
            return .failure(MutationError(operation: .add, status: addStatus))
        }

        // Another writer can create the item between update and add. Retry the
        // canonical update so the replacement stays atomic and no value is deleted.
        let retryStatus = updateItem(query as CFDictionary, updates as CFDictionary)
        guard retryStatus == errSecSuccess else {
            return .failure(MutationError(operation: .updateAfterAddConflict, status: retryStatus))
        }
        return .success(())
    }

    static func deleteResult(
        service: String,
        account: String,
        deleteItem: (CFDictionary) -> OSStatus) -> Result<Void, MutationError>
    {
        let status = deleteItem(self.baseQuery(service: service, account: account) as CFDictionary)
        guard status != errSecSuccess, status != errSecItemNotFound else {
            return .success(())
        }
        return .failure(MutationError(operation: .delete, status: status))
    }

    private static func baseQuery(service: String, account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
