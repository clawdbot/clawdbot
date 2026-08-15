import Foundation

final class ConfigFileWatcher: @unchecked Sendable, SimpleFileWatcherOwner {
    private let url: URL
    private let watchedDir: URL
    private let targetPath: String
    private let targetName: String
    let watcher: SimpleFileWatcher

    init(url: URL, onChange: @escaping () -> Void) {
        self.url = url
        self.watchedDir = url.deletingLastPathComponent()
        self.targetPath = url.path
        self.targetName = url.lastPathComponent
        let watchedDirPath = self.watchedDir.path
        let targetPath = self.targetPath
        let targetName = self.targetName
        self.watcher = SimpleFileWatcher(CoalescingFSEventsWatcher(
            paths: [watchedDirPath],
            queueLabel: "ai.openclaw.configwatcher",
            shouldNotify: { _, eventPaths in
                guard let eventPaths else { return true }
                let paths = unsafeBitCast(eventPaths, to: NSArray.self)
                for case let path as String in paths {
                    if path == targetPath { return true }
                    if path.hasSuffix("/\(targetName)") { return true }
                    if path == watchedDirPath { return true }
                }
                return false
            },
            onChange: onChange))
    }
}
