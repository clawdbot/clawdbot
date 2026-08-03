import Foundation

@MainActor
enum PermissionMonitoringSupport {
    static func setMonitoring(_ shouldMonitor: Bool, monitoring: inout Bool) {
        if shouldMonitor, !monitoring {
            monitoring = true
            PermissionMonitor.shared.register()
        } else if !shouldMonitor, monitoring {
            monitoring = false
            PermissionMonitor.shared.unregister()
        }
    }

    static func stopMonitoring(_ monitoring: inout Bool) {
        guard monitoring else { return }
        monitoring = false
        PermissionMonitor.shared.unregister()
    }
}
