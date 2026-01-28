import CoreServices
import Foundation

final class CanvasFileWatcher: @unchecked Sendable {
    private let url: URL
    private let queue: DispatchQueue
    private var stream: FSEventStreamRef?
    private var pending = false
    private let onChange: () -> Void

    init(url: URL, onChange: @escaping () -> Void) {
        self.url = url
        self.queue = DispatchQueue(label: "bot.molt.canvaswatcher")
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
                Unmanaged<CanvasFileWatcher>.fromOpaque(pointer).release()
            },
            copyDescription: nil)

        let paths = [self.url.path] as CFArray
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

extension CanvasFileWatcher {
    private static let callback: FSEventStreamCallback = { _, info, numEvents, _, eventFlags, _ in
        guard let info else { return }
        let watcher = Unmanaged<CanvasFileWatcher>.fromOpaque(info).takeUnretainedValue()
        watcher.handleEvents(numEvents: numEvents, eventFlags: eventFlags)
    }

    private func handleEvents(numEvents: Int, eventFlags: UnsafePointer<FSEventStreamEventFlags>?) {
        guard numEvents > 0 else { return }
        guard eventFlags != nil else { return }

        // Coalesce rapid changes (common during builds/atomic saves).
        if self.pending { return }
        self.pending = true
        self.queue.asyncAfter(deadline: .now() + 0.12) { [weak self] in
            guard let self else { return }
            self.pending = false
            self.onChange()
        }
    }
}
