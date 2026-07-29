import Foundation

struct AssetMeter: Codable, Hashable {
    var meterType: String
    var currentValue: Double?
    var unit: String
    var latestReadingAt: Date?
    var updatedAt: Date?

    enum CodingKeys: String, CodingKey {
        case meterType = "meter_type"
        case currentValue = "current_value"
        case unit
        case latestReadingAt = "latest_reading_at"
        case updatedAt = "updated_at"
    }

    var updateButtonTitle: String {
        switch meterType {
        case "runtime_hours": return "Update Hours"
        case "mileage": return "Update Miles"
        case "cycles": return "Update Cycles"
        default: return "Update Meter"
        }
    }

    var hasMeter: Bool { meterType != "none" }
}

struct AssetTaskSummary: Codable, Hashable, Identifiable {
    var id: UUID
    var item: String
    var scheduleKind: String?
    var meterIntervalValue: Double?
    var meterIntervalUnit: String?
    var remainingMeter: Double?
    var overdueMeter: Bool?

    enum CodingKeys: String, CodingKey {
        case id, item
        case scheduleKind = "schedule_kind"
        case meterIntervalValue = "meter_interval_value"
        case meterIntervalUnit = "meter_interval_unit"
        case remainingMeter = "remaining_meter"
        case overdueMeter = "overdue_meter"
    }
}

struct AssetPMSummary: Codable, Hashable {
    var overdueMeterCount: Int
    var dueSoonCount: Int

    enum CodingKeys: String, CodingKey {
        case overdueMeterCount = "overdue_meter_count"
        case dueSoonCount = "due_soon_count"
    }
}

struct RanchAsset: Identifiable, Codable, Hashable {
    let id: UUID
    var externalId: String
    var name: String
    var manufacturer: String?
    var model: String?
    var category: String?
    var location: String?
    var aliases: [String]?
    var qrToken: String?
    var meter: AssetMeter?
    var tasks: [AssetTaskSummary]?
    var pmSummary: AssetPMSummary?

    enum CodingKeys: String, CodingKey {
        case id, name, manufacturer, model, category, location, aliases, tasks, meter
        case externalId = "external_id"
        case qrToken = "qr_token"
        case pmSummary = "pm_summary"
    }
}

struct MeterReading: Identifiable, Codable, Hashable {
    let id: UUID
    var assetId: UUID
    var value: Double
    var readingAt: Date
    var entryMethod: String?
    var note: String?
    var correctionReason: String?
    var usageSincePrevious: Double?
    var createdAt: Date?

    enum CodingKeys: String, CodingKey {
        case id, value, note
        case assetId = "asset_id"
        case readingAt = "reading_at"
        case entryMethod = "entry_method"
        case correctionReason = "correction_reason"
        case usageSincePrevious = "usage_since_previous"
        case createdAt = "created_at"
    }
}

struct MeterParseResult: Codable {
    var assetId: UUID
    var assetName: String?
    var value: Double
    var unit: String?
    var meterType: String?
    var confidence: Double?

    enum CodingKeys: String, CodingKey {
        case value, unit, confidence
        case assetId = "asset_id"
        case assetName = "asset_name"
        case meterType = "meter_type"
    }
}

struct LowerReadingError: Codable {
    var error: String
    var currentValue: Double?
    var submittedValue: Double?
    var options: [String]?

    enum CodingKeys: String, CodingKey {
        case error, options
        case currentValue = "current_value"
        case submittedValue = "submitted_value"
    }
}
