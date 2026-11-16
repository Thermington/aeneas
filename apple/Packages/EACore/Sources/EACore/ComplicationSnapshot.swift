import Foundation

/// What the Watch complications show (Now, the running activity, Next up), as the iPhone has it. The iPhone sends it
/// to the Watch over WatchConnectivity whenever it changes (`SyncEngine.onComplicationSnapshot`), so the complications
/// are current without waiting for the Watch app's own sync.
public struct ComplicationSnapshot: Equatable, Sendable {
    public var nowTitle: String?
    public var activity: String?
    public var activityStart: Date?
    public var nextUpTitle: String?
    public var nextUpAt: Date?

    public init(nowTitle: String?, activity: String?, activityStart: Date?, nextUpTitle: String?, nextUpAt: Date?) {
        self.nowTitle = nowTitle
        self.activity = activity
        self.activityStart = activityStart
        self.nextUpTitle = nextUpTitle
        self.nextUpAt = nextUpAt
    }

    /// From the snapshot this device keeps for its own widgets.
    public init(config: SharedConfig) {
        self.init(nowTitle: config.nowTaskTitle, activity: config.currentActivity, activityStart: config.currentActivityStart,
                  nextUpTitle: config.nextUpTitle, nextUpAt: config.nextUpAt)
    }

    static let kind = "complications"

    /// As a WatchConnectivity user info dictionary: property list values only.
    public var message: [String: Any] {
        var m: [String: Any] = ["kind": Self.kind]
        if let nowTitle { m["now"] = nowTitle }
        if let activity { m["activity"] = activity }
        if let activityStart { m["activityStart"] = activityStart.timeIntervalSince1970 }
        if let nextUpTitle { m["nextUp"] = nextUpTitle }
        if let nextUpAt { m["nextUpAt"] = nextUpAt.timeIntervalSince1970 }
        return m
    }

    /// Nil for any other message (a hum's result).
    public init?(message m: [String: Any]) {
        guard m["kind"] as? String == Self.kind else { return nil }
        self.init(nowTitle: m["now"] as? String, activity: m["activity"] as? String,
                  activityStart: (m["activityStart"] as? Double).map(Date.init(timeIntervalSince1970:)),
                  nextUpTitle: m["nextUp"] as? String, nextUpAt: (m["nextUpAt"] as? Double).map(Date.init(timeIntervalSince1970:)))
    }

    /// The Watch keeps it where its complications read it.
    public func apply(to config: SharedConfig) {
        config.nowTaskTitle = nowTitle
        config.currentActivity = activity
        config.currentActivityStart = activityStart
        config.nextUpTitle = nextUpTitle
        config.nextUpAt = nextUpAt
    }
}
