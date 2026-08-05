import EventKit
@testable import OpenClaw
import Testing

@Suite(.serialized) struct EventKitPermissionRequesterTests {
    @Test func `requester retains its event store`() throws {
        var store: TestEventKitPermissionStore? = TestEventKitPermissionStore()
        let weakStore = WeakEventKitPermissionStore(store)

        let requester = EventKitPermissionRequester(store: try #require(store))
        store = nil

        withExtendedLifetime(requester) {
            #expect(weakStore.value != nil)
        }
    }

    @Test func `requester routes every EventKit grant through its retained store`() async {
        let store = TestEventKitPermissionStore()
        let requester = EventKitPermissionRequester(store: store)

        #expect(await requester.requestWriteOnlyAccessToEvents())
        #expect(await requester.requestFullAccessToEvents())
        #expect(await requester.requestFullAccessToReminders())
        #expect(store.requests == [.writeOnlyEvents, .fullEvents, .fullReminders])
    }
}

private final class WeakEventKitPermissionStore {
    weak var value: TestEventKitPermissionStore?

    init(_ value: TestEventKitPermissionStore?) {
        self.value = value
    }
}

private final class TestEventKitPermissionStore: EventKitPermissionStore {
    enum Request: Equatable {
        case writeOnlyEvents
        case fullEvents
        case fullReminders
    }

    private(set) var requests: [Request] = []

    func requestWriteOnlyAccessToEvents(
        completion: @escaping @Sendable (Bool, (any Error)?) -> Void
    ) {
        requests.append(.writeOnlyEvents)
        completion(true, nil)
    }

    func requestFullAccessToEvents(
        completion: @escaping @Sendable (Bool, (any Error)?) -> Void
    ) {
        requests.append(.fullEvents)
        completion(true, nil)
    }

    func requestFullAccessToReminders(
        completion: @escaping @Sendable (Bool, (any Error)?) -> Void
    ) {
        requests.append(.fullReminders)
        completion(true, nil)
    }
}
