import EventKit

protocol EventKitPermissionStore: AnyObject {
    func requestWriteOnlyAccessToEvents(
        completion: @escaping @Sendable (Bool, (any Error)?) -> Void)
    func requestFullAccessToEvents(
        completion: @escaping @Sendable (Bool, (any Error)?) -> Void)
    func requestFullAccessToReminders(
        completion: @escaping @Sendable (Bool, (any Error)?) -> Void)
}

extension EKEventStore: EventKitPermissionStore {}

/// Keeps one event store alive while Calendar or Reminders permission sheets are active.
///
/// EventKit recommends retaining a long-lived store. A temporary store can disappear
/// before its asynchronous authorization callback completes, leaving the UI waiting
/// even though iOS persisted the user's choice.
/// `PermissionRequestBridge` starts every store request on the main actor; the unchecked
/// conformance only allows that private store owner to cross the bridge's sendable closure.
final class EventKitPermissionRequester: @unchecked Sendable {
    private let store: any EventKitPermissionStore

    init(store: any EventKitPermissionStore = EKEventStore()) {
        self.store = store
    }

    func requestWriteOnlyAccessToEvents() async -> Bool {
        await PermissionRequestBridge.awaitRequest { [self] completion in
            self.store.requestWriteOnlyAccessToEvents { granted, _ in
                completion(granted)
            }
        }
    }

    func requestFullAccessToEvents() async -> Bool {
        await PermissionRequestBridge.awaitRequest { [self] completion in
            self.store.requestFullAccessToEvents { granted, _ in
                completion(granted)
            }
        }
    }

    func requestFullAccessToReminders() async -> Bool {
        await PermissionRequestBridge.awaitRequest { [self] completion in
            self.store.requestFullAccessToReminders { granted, _ in
                completion(granted)
            }
        }
    }
}
