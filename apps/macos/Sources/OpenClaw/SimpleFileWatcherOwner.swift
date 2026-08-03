import Foundation

protocol SimpleFileWatcherOwner: AnyObject {
    var watcher: SimpleFileWatcher { get }
}

extension SimpleFileWatcherOwner {
    func start() {
        self.watcher.start()
    }

    func stop() {
        self.watcher.stop()
    }
}
