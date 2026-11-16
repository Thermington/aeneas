import XCTest
@testable import EACore

final class ReminderPlanTests: XCTestCase {
    private func reminder(_ id: String, at: Date, repeat: String? = nil, snoozed: Date? = nil, acked: Date? = nil, friction: Friction = .none, deleted: Bool = false) -> Entity {
        var f: [String: JSONValue] = ["title": .string("R \(id)"), "at": .string(ISO.string(at)), "friction": .string(friction.rawValue)]
        if let r = `repeat` { f["repeat"] = .string(r) }
        if let s = snoozed { f["snoozed_until"] = .string(ISO.string(s)) }
        if let a = acked { f["acknowledged_at"] = .string(ISO.string(a)) }
        return Entity(id: id, kind: .reminder, deleted_at: deleted ? ISO.now() : nil, fields: f)
    }

    func testPlanning() {
        let now = Date(timeIntervalSince1970: 1_792_000_000) // fixed instant
        let soon = now.addingTimeInterval(3600)
        let past = now.addingTimeInterval(-3600)
        let snoozeUntil = now.addingTimeInterval(600)

        let oneShot = reminder("a", at: soon)
        let pastOneShot = reminder("b", at: past)                     // overdue, hub fires it; nothing to schedule
        let snoozedPast = reminder("c", at: past, snoozed: snoozeUntil) // fires at snoozed_until
        let acked = reminder("d", at: soon, acked: now)                 // acknowledged one shot: skip
        let repeating = reminder("e", at: past, repeat: "every 1 hours") // next occurrences only
        let deleted = reminder("f", at: soon, deleted: true)
        let needsReason = reminder("g", at: soon.addingTimeInterval(60), friction: .reason)

        let plan = ReminderPlanner.plan(reminders: [oneShot, pastOneShot, snoozedPast, acked, repeating, deleted, needsReason], now: now, perReminder: 3)
        let byReminder = Dictionary(grouping: plan, by: \.reminderId)

        XCTAssertEqual(byReminder["a"]?.map(\.fireAt), [soon])
        XCTAssertNil(byReminder["b"])
        XCTAssertEqual(byReminder["c"]?.map(\.fireAt), [snoozeUntil])
        XCTAssertNil(byReminder["d"])
        XCTAssertNil(byReminder["f"])
        XCTAssertEqual(byReminder["g"]?.first?.friction, .reason)
        // A reminder saved with the removed "witness" option still needs a reason.
        XCTAssertEqual(try JSONDecoder().decode([Friction].self, from: Data(#"["witness","none"]"#.utf8)), [.reason, .none])

        let e = byReminder["e"]!.map(\.fireAt)
        XCTAssertEqual(e.count, 3)
        XCTAssertEqual(e[0], past.addingTimeInterval(2 * 3600))
        XCTAssertEqual(e[1], past.addingTimeInterval(3 * 3600))
        XCTAssertTrue(e.allSatisfy { $0 > now })

        // sorted by fire time and ids unique
        XCTAssertEqual(plan.map(\.fireAt), plan.map(\.fireAt).sorted())
        XCTAssertEqual(Set(plan.map(\.id)).count, plan.count)
    }

    func testLimit() {
        let now = Date()
        let many = (0..<100).map { reminder("r\($0)", at: now.addingTimeInterval(Double($0 + 1) * 60)) }
        XCTAssertEqual(ReminderPlanner.plan(reminders: many, now: now, limit: 60).count, 60)
    }
}

final class TaskReminderTests: XCTestCase {
    func testTaskWithRemindAtIsPlannedAndDoneTaskIsNot() {
        let now = ISO.date("2026-10-28T12:00:00.000Z")!
        let open = Entity(kind: .task, fields: ["title": "Call the vet", "status": "scheduled", "order": 1, "remind_at": "2026-10-28T15:00:00.000Z", "friction": "reason"])
        let done = Entity(kind: .task, fields: ["title": "Old", "status": "done", "order": 2, "remind_at": "2026-10-28T16:00:00.000Z"])
        let plain = Entity(kind: .task, fields: ["title": "No reminder", "status": "next", "order": 3, "due": "2026-10-28T16:00:00.000Z"])
        XCTAssertEqual(open.reminderFields?.friction, .reason)
        XCTAssertNil(done.reminderFields)
        XCTAssertNil(plain.reminderFields)
        let plan = ReminderPlanner.plan(reminders: [open, done, plain], now: now)
        XCTAssertEqual(plan.map(\.title), ["Call the vet"])
        XCTAssertEqual(plan.first?.reminderId, open.id)
    }

    func testCompleteTaskRollsARepeatAndFinishesAOneOff() {
        let now = ISO.date("2026-10-21T09:00:00.000Z")!
        let weekly = Entity(kind: .task, fields: ["title": "B12", "status": "scheduled", "order": 1, "remind_at": "2026-10-20T13:00:00.000Z", "due": "2026-10-20T15:00:00.000Z", "repeat": "every 1 weeks"])
        let p = ReminderMath.completeTask(weekly, now: now)
        XCTAssertEqual(p["remind_at"]?.stringValue, "2026-10-27T13:00:00.000Z")
        XCTAssertEqual(p["due"]?.stringValue, "2026-10-27T15:00:00.000Z")
        XCTAssertNil(p["status"])
        let once = Entity(kind: .task, fields: ["title": "Vet", "status": "scheduled", "order": 1, "remind_at": "2026-10-20T13:00:00.000Z"])
        XCTAssertEqual(ReminderMath.completeTask(once, now: now)["status"]?.stringValue, "done")
    }

    /// The hub announces a due reminder at the time it fired for; the device planned its own alert for that time.
    /// One reminder is one alert: the announcement only alerts when this device has nothing for it.
    func testHubAnnouncementOfAPlannedReminderDoesNotAlertAgain() {
        let due = ISO.date("2026-11-14T15:00:00.000Z")!
        let now = due.addingTimeInterval(20) // the hub's loop runs every 30 s
        let task = Entity(kind: .task, fields: ["title": "Water the plants", "status": "scheduled", "order": 1, "remind_at": .string(ISO.string(due))])
        let planned = ReminderPlanner.plan(reminders: [task], now: due.addingTimeInterval(-3600))
        XCTAssertEqual(planned.map(\.id), [ReminderPlanner.requestId(reminderId: task.id, fireAt: due)])
        let id = planned[0].id

        // Planned here: it showed by itself, on screen or already swiped away.
        XCTAssertFalse(ReminderPlanner.announcementNeedsAlert(reminderId: task.id, at: due, now: now, planned: [id], delivered: [(id: id, date: due)]))
        XCTAssertFalse(ReminderPlanner.announcementNeedsAlert(reminderId: task.id, at: due, now: now, planned: [id], delivered: []))
        // Not planned in this run (the app started after it fired) but on screen.
        XCTAssertFalse(ReminderPlanner.announcementNeedsAlert(reminderId: task.id, at: due, now: now, planned: [], delivered: [(id: id, date: due)]))
        // A snooze made on another device moved the time; the alert for the old time showed 5 minutes ago.
        XCTAssertFalse(ReminderPlanner.announcementNeedsAlert(reminderId: task.id, at: due, now: now, planned: [],
                                                              delivered: [(id: ReminderPlanner.requestId(reminderId: task.id, fireAt: due.addingTimeInterval(-300)), date: now.addingTimeInterval(-300))]))
        // An announcement shown by the app before this change.
        XCTAssertFalse(ReminderPlanner.announcementNeedsAlert(reminderId: task.id, at: due, now: now, planned: [], delivered: [(id: "live|\(task.id)|123", date: now.addingTimeInterval(-60))]))

        // Nothing here for it: made on another device moments ago, or past the plan's cap. It alerts.
        XCTAssertTrue(ReminderPlanner.announcementNeedsAlert(reminderId: task.id, at: due, now: now, planned: [], delivered: []))
        XCTAssertTrue(ReminderPlanner.announcementNeedsAlert(reminderId: task.id, at: nil, now: now, planned: [], delivered: []))
        // Another reminder's alert, or this one's from an hour ago, does not stop it.
        XCTAssertTrue(ReminderPlanner.announcementNeedsAlert(reminderId: task.id, at: due, now: now, planned: ["other|1"],
                                                             delivered: [(id: "other|1", date: now), (id: ReminderPlanner.requestId(reminderId: task.id, fireAt: due.addingTimeInterval(-3600)), date: now.addingTimeInterval(-3600))]))
    }
}
