import Foundation

enum TaskFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case due = "Due"
    case overdue = "Overdue"

    var id: String { rawValue }
}

enum DueStatus: String, Codable {
    case ok
    case dueSoon = "due_soon"
    case overdue
    case critical

    var sortRank: Int {
        switch self {
        case .critical: return 0
        case .overdue: return 1
        case .dueSoon: return 2
        case .ok: return 3
        }
    }
}

struct MaintenanceCategory: Identifiable, Codable, Hashable {
    let id: UUID
    var name: String
    var icon: String?
    var colorName: String?

    enum CodingKeys: String, CodingKey {
        case id, name, icon
        case colorName = "color_name"
    }
}

struct MaintenanceTask: Identifiable, Codable, Hashable {
    let id: UUID
    var area: String
    var item: String
    var categoryName: String
    var priority: String
    var frequency: String
    var taskDescription: String?
    var notes: String?
    var suppliesNeeded: String?
    var partNumber: String?
    var vendor: String?
    var warningDays: Int
    var criticalDays: Int
    var lastDone: Date?
    var nextDue: Date
    var scheduleKind: String?
    var meterIntervalValue: Double?
    var meterIntervalUnit: String?
    var assetId: UUID?
    var remainingMeter: Double?
    var overdueMeter: Bool?
    var parts: [MaintenancePart]?

    enum CodingKeys: String, CodingKey {
        case id, area, item, priority, frequency, notes, vendor, parts
        case categoryName = "category_name"
        case taskDescription = "task_description"
        case suppliesNeeded = "supplies_needed"
        case partNumber = "part_number"
        case warningDays = "warning_days"
        case criticalDays = "critical_days"
        case lastDone = "last_done"
        case nextDue = "next_due"
        case scheduleKind = "schedule_kind"
        case meterIntervalValue = "meter_interval_value"
        case meterIntervalUnit = "meter_interval_unit"
        case assetId = "asset_id"
        case remainingMeter = "remaining_meter"
        case overdueMeter = "overdue_meter"
    }

    var dueStatus: DueStatus {
        let now = Date()
        if nextDue < now {
            let daysPast = Calendar.current.dateComponents([.day], from: nextDue, to: now).day ?? 0
            if daysPast >= criticalDays { return .critical }
            return .overdue
        }
        let daysUntil = Calendar.current.dateComponents([.day], from: now, to: nextDue).day ?? 999
        if daysUntil <= warningDays { return .dueSoon }
        return .ok
    }

    var requiresMeterOnComplete: Bool {
        scheduleKind == "meter" || scheduleKind == "both"
    }
}

struct MaintenancePart: Identifiable, Codable, Hashable {
    let id: UUID
    var name: String
    var partNumber: String?
    var cost: Double?
    var quantity: Double?

    enum CodingKeys: String, CodingKey {
        case id, name, cost, quantity
        case partNumber = "part_number"
    }
}
