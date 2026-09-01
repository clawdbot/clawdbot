import CoreServices
import Foundation

final class CoalescingFSEventsWatcher: @unchecked Sendable {
    private let queue: DispatchQueue
    private var stream: FSEventStreamRef?
    private var pending = false

    private let paths: [String]
    private let shouldNotify: (Int, UnsafeMutableRawPointer?) -> Bool
    private let onChange: () -> Void
    private let coalesceDelay: TimeInterval

    init(
        paths: [String],
        queueLabel: String,
        coalesceDelay: TimeInterval = 0.12,
        shouldNotify: @escaping (Int, UnsafeMutableRawPointer?) -> Bool = { _, _ in true },
        onChange: @escaping () -> Void)
    {
        self.paths = paths
        self.queue = DispatchQueue(label: queueLabel)
        self.coalesceDelay = coalesceDelay
        self.shouldNotify = shouldNotify
        self.onChange = onChange
    }

    deinit {
        self.stop()
    }

    func start() {
        guard self.stream == nil else { return }

        let retainedSelf = Unmanaged.passRetained(self)
        var context = FSEventStreamContext(
            version: 0,
            info: retainedSelf.toOpaque(),
            retain: nil,
            release: { pointer in
                guard let pointer else { return }
                Unmanaged<CoalescingFSEventsWatcher>.fromOpaque(pointer).release()
            },
            copyDescription: nil)

        let paths = self.paths as CFArray
        let flags = FSEventStreamCreateFlags(
            kFSEventStreamCreateFlagFileEvents |
                kFSEventStreamCreateFlagUseCFTypes |
                kFSEventStreamCreateFlagNoDefer)

        guard let stream = FSEventStreamCreate(
            kCFAllocatorDefault,
            Self.callback,
            &context,
            paths,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            0.05,
            flags)
        else {
            retainedSelf.release()
            return
        }

        self.stream = stream
        FSEventStreamSetDispatchQueue(stream, self.queue)
        if FSEventStreamStart(stream) == false {
            self.stream = nil
            FSEventStreamSetDispatchQueue(stream, nil)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
        }
    }

    func stop() {
        guard let stream = self.stream else { return }
        self.stream = nil
        FSEventStreamStop(stream)
        FSEventStreamSetDispatchQueue(stream, nil)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
    }
}

extension CoalescingFSEventsWatcher {
    private static let callback: FSEventStreamCallback = { _, info, numEvents, eventPaths, eventFlags, _ in
        guard let info else { return }
        let watcher = Unmanaged<CoalescingFSEventsWatcher>.fromOpaque(info).takeUnretainedValue()
        watcher.handleEvents(numEvents: numEvents, eventPaths: eventPaths, eventFlags: eventFlags)
    }

    private func handleEvents(
        numEvents: Int,
        eventPaths: UnsafeMutableRawPointer?,
        eventFlags: UnsafePointer<FSEventStreamEventFlags>?)
    {
        guard numEvents > 0 else { return }
        guard eventFlags != nil else { return }
        guard self.shouldNotify(numEvents, eventPaths) else { return }

        // Coalesce rapid changes (common during builds/atomic saves).
        if self.pending { return }
        self.pending = true
        self.queue.asyncAfter(deadline: .now() + self.coalesceDelay) { [weak self] in
            guard let self else { return }
            self.pending = false
            self.onChange()
        }
    }
}
