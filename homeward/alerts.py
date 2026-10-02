"""Alert lifecycle: raise -> (escalate) -> acknowledge -> resolve.

* One active alert per patient per kind - no alert storms.
* If risk worsens while an alert is active, the alert is upgraded and re-opened.
* Clinical alerts are never auto-resolved - a human must acknowledge and resolve them.
  Technical alerts (device offline, battery) clear themselves when the problem goes away.
* Unacknowledged alerts escalate up a chain of contacts on a timer.
* Every step is written to an audit trail (events table).
"""
import time

from . import config

SEVERITY_RANK = {"info": 0, "medium": 1, "high": 2}
ACTIVE = ("open", "acknowledged")


class AlertManager:
    def __init__(self, db):
        self.db = db

    # --- audit trail ---------------------------------------------------------------
    def event(self, patient_id, kind, message):
        self.db.insert("INSERT INTO events (patient_id, created_at, kind, message) VALUES (?,?,?,?)",
                       (patient_id, time.time(), kind, message))

    # --- queries -------------------------------------------------------------------
    def active(self, patient_id, kind):
        return self.db.one(
            "SELECT * FROM alerts WHERE patient_id=? AND kind=? AND status IN ('open','acknowledged') "
            "ORDER BY id DESC LIMIT 1", (patient_id, kind))

    def get(self, alert_id):
        return self.db.one("SELECT * FROM alerts WHERE id=?", (alert_id,))

    def list_active(self):
        return self.db.query(
            "SELECT a.*, p.name AS patient_name FROM alerts a JOIN patients p ON p.id=a.patient_id "
            "WHERE a.status IN ('open','acknowledged') ORDER BY "
            "CASE a.status WHEN 'open' THEN 0 ELSE 1 END, "
            "CASE a.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, a.id DESC")

    # --- lifecycle -----------------------------------------------------------------
    def raise_alert(self, patient_id, kind, severity, title, reason):
        """Create, upgrade or refresh an alert. Returns True if something user-visible changed."""
        now = time.time()
        existing = self.active(patient_id, kind)
        if existing is None:
            alert_id = self.db.insert(
                "INSERT INTO alerts (patient_id, kind, severity, title, reason, status, created_at, "
                "updated_at, escalation_level, last_escalated_at) VALUES (?,?,?,?,?, 'open', ?,?,0,?)",
                (patient_id, kind, severity, title, reason, now, now, now))
            self.event(patient_id, "alert", f"Alert #{alert_id} raised [{severity.upper()}] {title} -> "
                                            f"notifying {config.ESCALATION_CHAIN[0]}")
            return True
        if SEVERITY_RANK[severity] > SEVERITY_RANK[existing["severity"]]:
            self.db.execute(
                "UPDATE alerts SET severity=?, title=?, reason=?, status='open', updated_at=?, "
                "last_escalated_at=? WHERE id=?", (severity, title, reason, now, now, existing["id"]))
            self.event(patient_id, "alert", f"Alert #{existing['id']} upgraded to {severity.upper()} and re-opened: {title}")
            return True
        if reason != existing["reason"]:
            self.db.execute("UPDATE alerts SET reason=?, title=?, updated_at=? WHERE id=?",
                            (reason, title if severity == existing["severity"] else existing["title"],
                             now, existing["id"]))
        return False

    def auto_resolve(self, patient_id, kind, note):
        existing = self.active(patient_id, kind)
        if not existing:
            return False
        self.db.execute("UPDATE alerts SET status='resolved', resolved_by='system', resolved_at=?, "
                        "resolve_note=?, updated_at=? WHERE id=?",
                        (time.time(), note, time.time(), existing["id"]))
        self.event(patient_id, "alert", f"Alert #{existing['id']} auto-resolved: {note}")
        return True

    def acknowledge(self, alert_id, by, note):
        alert = self.get(alert_id)
        if alert is None or alert["status"] not in ACTIVE:
            return None
        now = time.time()
        self.db.execute("UPDATE alerts SET status='acknowledged', acked_by=?, acked_at=?, ack_note=?, "
                        "updated_at=? WHERE id=?", (by, now, note, now, alert_id))
        took = int(now - alert["created_at"])
        self.event(alert["patient_id"], "response",
                   f"Alert #{alert_id} acknowledged by {by} after {took}s - action: {note or 'n/a'}")
        return self.get(alert_id)

    def resolve(self, alert_id, by, note):
        alert = self.get(alert_id)
        if alert is None or alert["status"] not in ACTIVE:
            return None
        now = time.time()
        self.db.execute("UPDATE alerts SET status='resolved', resolved_by=?, resolved_at=?, resolve_note=?, "
                        "updated_at=?, acked_by=COALESCE(acked_by, ?), acked_at=COALESCE(acked_at, ?) "
                        "WHERE id=?", (by, now, note, now, by, now, alert_id))
        self.event(alert["patient_id"], "response", f"Alert #{alert_id} resolved by {by}: {note or 'n/a'}")
        return self.get(alert_id)

    def escalate_overdue(self):
        """Move unacknowledged alerts up the escalation chain. Returns True if any escalated."""
        now = time.time()
        changed = False
        for a in self.db.query("SELECT * FROM alerts WHERE status='open'"):
            wait = config.ESCALATION_SECONDS.get(a["severity"])
            if wait is None or a["escalation_level"] >= len(config.ESCALATION_CHAIN) - 1:
                continue
            if now - (a["last_escalated_at"] or a["created_at"]) >= wait:
                lvl = a["escalation_level"] + 1
                self.db.execute("UPDATE alerts SET escalation_level=?, last_escalated_at=?, updated_at=? "
                                "WHERE id=?", (lvl, now, now, a["id"]))
                self.event(a["patient_id"], "escalation",
                           f"Alert #{a['id']} not acknowledged in {wait}s - escalated to level {lvl}: "
                           f"{config.ESCALATION_CHAIN[lvl]}")
                changed = True
        return changed
