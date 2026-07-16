import Foundation
import Security
import Testing
@testable import OpenClawKit

struct GenericPasswordKeychainStoreTests {
    @Test func `existing item is replaced with update only`() {
        var updateCalls = 0
        var addCalls = 0

        let result = GenericPasswordKeychainStore.saveDataResult(
            Data("replacement".utf8),
            service: "test-service",
            account: "test-account",
            accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            updateItem: { _, _ in
                updateCalls += 1
                return errSecSuccess
            },
            addItem: { _ in
                addCalls += 1
                return errSecSuccess
            })

        guard case .success = result else {
            Issue.record("expected successful update")
            return
        }
        #expect(updateCalls == 1)
        #expect(addCalls == 0)
    }

    @Test func `missing item is added after update miss`() {
        var addCalls = 0

        let result = GenericPasswordKeychainStore.saveDataResult(
            Data("new-value".utf8),
            service: "test-service",
            account: "test-account",
            accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            updateItem: { _, _ in errSecItemNotFound },
            addItem: { _ in
                addCalls += 1
                return errSecSuccess
            })

        guard case .success = result else {
            Issue.record("expected successful add")
            return
        }
        #expect(addCalls == 1)
    }

    @Test func `add race retries atomic update`() {
        var updateCalls = 0

        let result = GenericPasswordKeychainStore.saveDataResult(
            Data("raced-value".utf8),
            service: "test-service",
            account: "test-account",
            accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            updateItem: { _, _ in
                updateCalls += 1
                return updateCalls == 1 ? errSecItemNotFound : errSecSuccess
            },
            addItem: { _ in errSecDuplicateItem })

        guard case .success = result else {
            Issue.record("expected retry update to succeed")
            return
        }
        #expect(updateCalls == 2)
    }

    @Test func `update failure preserves exact operation and status`() {
        let result = GenericPasswordKeychainStore.saveDataResult(
            Data("replacement".utf8),
            service: "test-service",
            account: "test-account",
            accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            updateItem: { _, _ in errSecInteractionNotAllowed },
            addItem: { _ in
                Issue.record("add must not run after a non-missing update failure")
                return errSecSuccess
            })

        guard case let .failure(error) = result else {
            Issue.record("expected update failure")
            return
        }
        #expect(error == .init(operation: .update, status: errSecInteractionNotAllowed))
        #expect(error.localizedDescription.contains("OSStatus \(errSecInteractionNotAllowed)"))
    }

    @Test func `delete failure preserves exact status`() {
        let result = GenericPasswordKeychainStore.deleteResult(
            service: "test-service",
            account: "test-account",
            deleteItem: { _ in errSecAuthFailed })

        guard case let .failure(error) = result else {
            Issue.record("expected delete failure")
            return
        }
        #expect(error == .init(operation: .delete, status: errSecAuthFailed))
    }
}
