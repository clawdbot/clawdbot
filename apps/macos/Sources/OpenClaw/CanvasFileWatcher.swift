import Foundation

final class CanvasFileWatcher: @unchecked Sendable, SimpleFileWatcherOwner {
    let watcher: SimpleFileWatcher
    private let pollingWatcher: PollingDirectoryWatcher

    init(url: URL, onChange: @escaping () -> Void) {
        self.watcher = SimpleFileWatcher(CoalescingFSEventsWatcher(
            paths: [url.path],
            queueLabel: "ai.openclaw.canvaswatcher",
            onChange: onChange))
        self.pollingWatcher = PollingDirectoryWatcher(
            url: url,
            queueLabel: "ai.openclaw.canvaswatcher.poll",
            onChange: onChange)
    }

    func start() {
        self.watcher.start()
        self.pollingWatcher.start()
    }

    func stop() {
        self.watcher.stop()
        self.pollingWatcher.stop()
    }
}

private final class PollingDirectoryWatcher: @unchecked Sendable {
    private struct FileSignature: Equatable {
        let modifiedAt: TimeInterval
        let size: Int
    }

    private let url: URL
    private let queue: DispatchQueue
    private let onChange: () -> Void
    private var timer: DispatchSourceTimer?
    private var lastSnapshot: [String: FileSignature] = [:]

    init(url: URL, queueLabel: String, onChange: @escaping () -> Void) {
        self.url = url
        self.queue = DispatchQueue(label: queueLabel)
        self.onChange = onChange
    }

    deinit {
        self.stop()
    }

    func start() {
        self.queue.sync {
            guard self.timer == nil else { return }
            self.lastSnapshot = self.snapshot()

            let timer = DispatchSource.makeTimerSource(queue: self.queue)
            timer.schedule(deadline: .now() + 0.15, repeating: 0.25)
            timer.setEventHandler { [weak self] in
                self?.poll()
            }
            self.timer = timer
            timer.resume()
        }
    }

    func stop() {
        self.queue.sync {
            self.timer?.cancel()
            self.timer = nil
            self.lastSnapshot = [:]
        }
    }

    private func poll() {
        let next = self.snapshot()
        guard next != self.lastSnapshot else { return }
        self.lastSnapshot = next
        self.onChange()
    }

    private func snapshot() -> [String: FileSignature] {
        let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey, .isRegularFileKey]
        guard let enumerator = FileManager.default.enumerator(
            at: self.url,
            includingPropertiesForKeys: keys,
            options: [.skipsPackageDescendants])
        else { return [:] }

        var result: [String: FileSignature] = [:]
        for case let fileURL as URL in enumerator {
            guard let values = try? fileURL.resourceValues(forKeys: Set(keys)),
                  values.isRegularFile == true
            else { continue }

            let relativePath = String(fileURL.path.dropFirst(self.url.path.count + 1))
            result[relativePath] = FileSignature(
                modifiedAt: values.contentModificationDate?.timeIntervalSinceReferenceDate ?? 0,
                size: values.fileSize ?? 0)
        }
        return result
    }
}
