"""SQLite storage for the failover dashboard.

One file (dashboard.db), three tables: readings, events and speed. Writes come
from the MQTT thread and reads from Flask/Socket.IO handlers, so every call opens
its own connection (check_same_thread=False) and access is guarded by a lock.
"""

import json
import os
import sqlite3
import threading

DB_PATH = os.getenv("DB_PATH", os.path.join(os.path.dirname(__file__), "dashboard.db"))
_lock = threading.Lock()

# Columns added after the first release; init() adds any that are missing.
_READING_COLUMNS = {
    "temp": "REAL", "hum": "REAL", "lux": "REAL",
    "rssi": "REAL", "up": "INTEGER", "ip": "TEXT", "fw": "TEXT", "pref": "TEXT",
}


def _conn():
    c = sqlite3.connect(DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def init():
    with _lock, _conn() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS readings (
                id     INTEGER PRIMARY KEY AUTOINCREMENT,
                ts     REAL    NOT NULL,
                link   TEXT    NOT NULL,
                temp   REAL,
                hum    REAL,
                lux    REAL,
                count  INTEGER,
                wifi   INTEGER,
                eth    INTEGER,
                rssi   REAL,
                up     INTEGER,
                ip     TEXT,
                fw     TEXT,
                pref   TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings(ts);

            CREATE TABLE IF NOT EXISTS events (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                ts        REAL    NOT NULL,
                type      TEXT    NOT NULL,
                from_link TEXT,
                to_link   TEXT
            );

            CREATE TABLE IF NOT EXISTS speed (
                id     INTEGER PRIMARY KEY AUTOINCREMENT,
                ts     REAL    NOT NULL,
                mbps   REAL,
                raw    TEXT
            );
            """
        )
        have = {r["name"] for r in c.execute("PRAGMA table_info(readings)")}
        for col, kind in _READING_COLUMNS.items():
            if col not in have:
                c.execute(f"ALTER TABLE readings ADD COLUMN {col} {kind}")


def insert_reading(r):
    """r: dict with ts, link, temp, hum, lux, count, wifi, eth, rssi, up, ip, fw."""
    with _lock, _conn() as c:
        c.execute(
            "INSERT INTO readings (ts, link, temp, hum, lux, count, wifi, eth, rssi, up, ip, fw, pref)"
            " VALUES (:ts, :link, :temp, :hum, :lux, :count, :wifi, :eth, :rssi, :up, :ip, :fw, :pref)",
            r,
        )


def insert_event(ts, type_, from_link, to_link):
    with _lock, _conn() as c:
        c.execute(
            "INSERT INTO events (ts, type, from_link, to_link) VALUES (?,?,?,?)",
            (ts, type_, from_link, to_link),
        )


def insert_speed(ts, payload):
    with _lock, _conn() as c:
        c.execute(
            "INSERT INTO speed (ts, mbps, raw) VALUES (?,?,?)",
            (ts, payload.get("mbps"), json.dumps(payload)),
        )


def readings_since(ts):
    with _lock, _conn() as c:
        rows = c.execute(
            "SELECT ts, link, temp, hum, lux, count, wifi, eth, rssi, up, ip, fw, pref"
            " FROM readings WHERE ts >= ? ORDER BY ts",
            (ts,),
        ).fetchall()
    return [dict(r) for r in rows]


def last_reading():
    with _lock, _conn() as c:
        row = c.execute(
            "SELECT ts, link, temp, hum, lux, count, wifi, eth, rssi, up, ip, fw, pref"
            " FROM readings ORDER BY id DESC LIMIT 1"
        ).fetchone()
    return dict(row) if row else None


def recent_events(limit=50):
    with _lock, _conn() as c:
        rows = c.execute(
            "SELECT ts, type, from_link, to_link FROM events ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def stats():
    with _lock, _conn() as c:
        total = c.execute("SELECT COUNT(*) AS n FROM readings").fetchone()["n"]
        failovers = c.execute(
            "SELECT COUNT(*) AS n FROM events WHERE type='failover'"
        ).fetchone()["n"]
        last_speed = c.execute(
            "SELECT ts, mbps FROM speed ORDER BY id DESC LIMIT 1"
        ).fetchone()
    return {
        "total_readings": total,
        "failovers": failovers,
        "last_speed_mbps": last_speed["mbps"] if last_speed else None,
    }
