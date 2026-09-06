import Foundation
import Photos
import Synchronization
import Testing
@testable import OpenClaw

@Suite(.serialized) struct PermissionRequestBridgeTests {
    @Test func `box resumes immediately when cancelled before install`() async {
        let box = PermissionRequestBridge.Box()
        box.resume(false)
        let granted: Bool = await withCheckedContinuation { continuation in
            _ = box.install(continuation)
        }
        #expect(granted == false)
        #expect(box.canStartRequest() == false)
    }

    @Test func `box resumes installed continuation once`() async {
        let box = PermissionRequestBridge.Box()

        let granted: Bool = await withCheckedContinuation { continuation in
            _ = box.install(continuation)
            box.resume(true)
            box.resume(false)
        }

        #expect(granted == true)
    }
}

struct PhotoLibraryAccessTests {
    @Test(arguments: [PHAuthorizationStatus.authorized, .limited])
    func `read access includes full and limited authorization`(_ status: PHAuthorizationStatus) {
        #expect(PhotoLibraryAccess.canRead(status))
    }

    @Test(arguments: [PHAuthorizationStatus.notDetermined, .denied, .restricted])
    func `read access excludes unavailable authorization`(_ status: PHAuthorizationStatus) {
        #expect(!PhotoLibraryAccess.canRead(status))
    }
}

@MainActor
struct IOSPermissionInitiationTests {
    @Test func `retired document cannot initiate queued permission`() async {
        await Self.checkDeferredInitiation { $0.document.retire() }
    }

    @Test(arguments: ["connection", "admin", "generation"])
    func `lost operator authority cannot initiate queued permission`(_ change: String) async {
        await Self.checkDeferredInitiation {
            switch change {
            case "connection": $0.connected = false
            case "admin": $0.admin = false
            default: $0.generation += 1
            }
        }
    }

    @Test func `in flight permission drops retired result without prompting again`() async {
        let authority = PermissionInitiationAuthority()
        let store = PermissionInitiationStore(holdsCompletion: true)
        let requester = EventKitPermissionRequester(store: store)
        let queue = IOSDeviceSettingsRequestQueue()
        let (finished, completion) = AsyncStream<Void>.makeStream()
        var applied = false
        var replies: [String?] = []
        let reply = IOSDeviceSettingsReply { _, error in replies.append(error) }

        queue.enqueue(operation: {
            let granted = await requester.requestFullAccessToEvents(isCurrent: { authority.isCurrent })
            applied = granted
            if granted { reply.finish(NSNull()) } else { reply.retire() }
            completion.yield()
            completion.finish()
        }, onCancel: { reply.retire() })
        for await _ in store.started {
            break
        }
        authority.document.retire()
        reply.retire()
        store.complete(true)
        for await _ in finished {
            break
        }

        #expect(store.requestCount == 1)
        #expect(!applied)
        #expect(replies.count == 1)
        #expect(replies.first.flatMap(\.self) != nil)
    }

    @Test func `current permission initiates once and applies completion`() async {
        let authority = PermissionInitiationAuthority()
        let store = PermissionInitiationStore()
        let requester = EventKitPermissionRequester(store: store)

        #expect(await requester.requestFullAccessToEvents(isCurrent: { authority.isCurrent }))
        #expect(store.requestCount == 1)
    }

    @Test func `cancelled permission keeps native store alive until OS completion`() async throws {
        var store: PermissionInitiationStore? = PermissionInitiationStore(holdsCompletion: true)
        weak var retainedStore = store
        let started = try #require(store).started
        var requester: EventKitPermissionRequester? = try EventKitPermissionRequester(store: #require(store))
        var operation: Task<Bool, Never>? = Task { [requester] in
            await requester?.requestFullAccessToEvents() ?? false
        }
        for await _ in started {
            break
        }
        operation?.cancel()
        #expect(await operation?.value == false)
        operation = nil
        requester = nil
        store = nil

        #expect(retainedStore != nil)
        retainedStore?.complete(true)
        #expect(retainedStore == nil)
    }

    private static func checkDeferredInitiation(
        revoke: @MainActor (PermissionInitiationAuthority) -> Void) async
    {
        let authority = PermissionInitiationAuthority()
        let store = PermissionInitiationStore()
        let requester = EventKitPermissionRequester(store: store)
        let queue = IOSDeviceSettingsRequestQueue()
        let (admitted, admission) = AsyncStream<Void>.makeStream()
        let (proceed, resume) = AsyncStream<Void>.makeStream()
        let (finished, completion) = AsyncStream<Void>.makeStream()
        var applied = false
        var replies: [String?] = []
        let reply = IOSDeviceSettingsReply { _, error in replies.append(error) }

        queue.enqueue(operation: {
            #expect(authority.isCurrent)
            admission.yield()
            admission.finish()
            for await _ in proceed {
                break
            }
            let granted = await requester.requestFullAccessToEvents(isCurrent: { authority.isCurrent })
            applied = granted
            if granted { reply.finish(NSNull()) } else { reply.retire() }
            completion.yield()
            completion.finish()
        }, onCancel: { reply.retire() })
        for await _ in admitted {
            break
        }
        revoke(authority)
        resume.yield()
        resume.finish()
        for await _ in finished {
            break
        }

        #expect(store.requestCount == 0)
        #expect(!applied)
        #expect(replies.count == 1)
        #expect(replies.first.flatMap(\.self) != nil)
    }
}

@MainActor
private final class PermissionInitiationAuthority {
    var document: IOSDeviceSettingsDocument
    var connected = true
    var admin = true
    var generation: UInt64 = 0
    private let admitted: IOSDeviceSettingsDocument.RequestIdentity

    init() {
        var document = IOSDeviceSettingsDocument()
        document.commitNavigation()
        self.document = document
        self.admitted = document.requestIdentity(authorityGeneration: 0)
    }

    var isCurrent: Bool {
        self.connected && self.admin && self.document.accepts(self.admitted, authorityGeneration: self.generation)
    }
}

private final class PermissionInitiationStore: EventKitPermissionStore, Sendable {
    private struct State {
        var requestCount = 0
        var completion: (@Sendable (Bool, (any Error)?) -> Void)?
    }

    let started: AsyncStream<Void>
    private let start: AsyncStream<Void>.Continuation
    private let state = Mutex(State())
    private let holdsCompletion: Bool

    init(holdsCompletion: Bool = false) {
        (self.started, self.start) = AsyncStream<Void>.makeStream()
        self.holdsCompletion = holdsCompletion
    }

    var requestCount: Int {
        self.state.withLock { $0.requestCount }
    }

    func requestWriteOnlyAccessToEvents(completion: @escaping @Sendable (Bool, (any Error)?) -> Void) {
        self.request(completion)
    }

    func requestFullAccessToEvents(completion: @escaping @Sendable (Bool, (any Error)?) -> Void) {
        self.request(completion)
    }

    func requestFullAccessToReminders(completion: @escaping @Sendable (Bool, (any Error)?) -> Void) {
        self.request(completion)
    }

    func complete(_ granted: Bool) {
        let completion = self.state.withLock {
            let completion = $0.completion
            $0.completion = nil
            return completion
        }
        completion?(granted, nil)
    }

    private func request(_ completion: @escaping @Sendable (Bool, (any Error)?) -> Void) {
        self.state.withLock {
            $0.requestCount += 1
            $0.completion = completion
        }
        self.start.yield()
        self.start.finish()
        if !self.holdsCompletion { self.complete(true) }
    }
}
