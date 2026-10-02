"""Central configuration. Every value can be overridden with an environment variable.

Timings are deliberately short so the whole story can be shown in a 3-minute demo.
"""
import os


def _int(name, default):
    return int(os.getenv(name, default))


def _float(name, default):
    return float(os.getenv(name, default))


# --- Storage / security -------------------------------------------------------
DB_PATH = os.getenv("HOMEWARD_DB", "homeward.db")
# Shared secret the home hub must send in the X-Device-Key header.
DEVICE_API_KEY = os.getenv("HOMEWARD_DEVICE_KEY", "dev-device-key")
SERVER_URL = os.getenv("HOMEWARD_SERVER", "http://127.0.0.1:8000")

# --- Simulation clock -----------------------------------------------------------
# One simulator tick = this many minutes of "patient time".
# With 1 tick/second, 48 hours of patient time play out in under 5 minutes.
SIM_MINUTES_PER_TICK = _float("HOMEWARD_SIM_MINUTES_PER_TICK", 10)
SIM_TICK_SECONDS = _float("HOMEWARD_SIM_TICK_SECONDS", 1.0)

# --- Risk engine ----------------------------------------------------------------
TREND_WINDOW_HOURS = _float("HOMEWARD_TREND_WINDOW_HOURS", 6)  # history used for trend fitting
PREDICTION_HORIZON_HOURS = _int("HOMEWARD_PREDICTION_HORIZON_HOURS", 48)
NOTE_RELEVANCE_SECONDS = _int("HOMEWARD_NOTE_RELEVANCE_SECONDS", 3600)  # how long a note influences risk

# --- Alerting / resilience (real seconds) ---------------------------------------------
DEVICE_OFFLINE_SECONDS = _int("HOMEWARD_DEVICE_OFFLINE_SECONDS", 12)
BACKFILL_THRESHOLD_SECONDS = _int("HOMEWARD_BACKFILL_THRESHOLD_SECONDS", 8)
ESCALATION_SECONDS = {
    "high": _int("HOMEWARD_ESCALATE_HIGH_SECONDS", 45),
    "medium": _int("HOMEWARD_ESCALATE_MEDIUM_SECONDS", 120),
}
CHECKIN_INTERVAL_SECONDS = _int("HOMEWARD_CHECKIN_INTERVAL_SECONDS", 600)
LOW_BATTERY_PERCENT = _int("HOMEWARD_LOW_BATTERY_PERCENT", 20)

ESCALATION_CHAIN = [
    "Primary caregiver (app notification)",
    "Family member + on-call nurse (SMS / phone call)",
    "Doctor / emergency services (call 108)",
]
