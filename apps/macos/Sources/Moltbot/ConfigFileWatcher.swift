import CoreServices
import Foundation

final class ConfigFileWatcher: @unchecked Sendable {
    private let url: URL
    private let queue: DispatchQueue
    private var stream: FSEventStreamRef?
    private var pending = false
    private let onChange: () -> Void
    private let watchedDir: URL
    private let targetPath: String
    private let targetName: String

    init(url: URL, onChange: @escaping () -> Void) {
        self.url = url
        self.queue = DispatchQueue(label: "bot.molt.configwatcher")
        self.onChange = onChange
        self.watchedDir = url.deletingLastPathComponent()
        self.targetPath = url.path
        self.targetName = url.lastPathComponent
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
                Unmanaged<ConfigFileWatcher>.fromOpaque(pointer).release()
            },
            copyDescription: nil)

        let paths = [self.watchedDir.path] as CFArray
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

extension ConfigFileWatcher {
    private static let callback: FSEventStreamCallback = { _, info, numEvents, eventPaths, eventFlags, _ in
        guard let info else { return }
        let watcher = Unmanaged<ConfigFileWatcher>.fromOpaque(info).takeUnretainedValue()
        watcher.handleEvents(
            numEvents: numEvents,
            eventPaths: eventPaths,
            eventFlags: eventFlags)
    }

    private func handleEvents(
        numEvents: Int,
        eventPaths: UnsafeMutableRawPointer?,
        eventFlags: UnsafePointer<FSEventStreamEventFlags>?)
    {
        guard numEvents > 0 else { return }
        guard eventFlags != nil else { return }
        guard self.matchesTarget(eventPaths: eventPaths) else { return }

        if self.pending { return }
        self.pending = true
        self.queue.asyncAfter(deadline: .now() + 0.12) { [weak self] in
            guard let self else { return }
            self.pending = false
            self.onChange()
        }
    }

    private func matchesTarget(eventPaths: UnsafeMutableRawPointer?) -> Bool {
        guard let eventPaths else { return true }
        let paths = unsafeBitCast(eventPaths, to: NSArray.self)
        for case let path as String in paths {
            if path == self.targetPath { return true }
            if path.hasSuffix("/\(self.targetName)") { return true }
            if path == self.watchedDir.path { return true }
        }
        return false
    }
}
