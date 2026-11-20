"""Storage is shared across processes; observers live in each server process."""

import asyncio
import json
import math
import sqlite3
import time
import uuid
from pathlib import Path


def number(value, name, minimum=0, maximum=86400 * 365):
    if isinstance(value, bool) or not isinstance(value, (float, int)):
        raise ValueError(f"{name} must be a number")
    if not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def integer(value, name, minimum=0, maximum=2**63 - 1):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be an integer between {minimum} and {maximum}")
    return value


def topic_name(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 128:
        raise ValueError("topic must be a nonempty string of at most 128 characters")
    return value


def encode(payload):
    value = json.dumps(payload, allow_nan=False, separators=(",", ":"))
    if len(value.encode()) > 32768:
        raise ValueError("payload exceeds 32 KiB")
    return value


class EventStore:
    def __init__(self, path):
        path = Path(path).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        # Create with private permissions before SQLite opens the database.
        import os
        fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
        self.db = sqlite3.connect(path, timeout=5)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                topic TEXT NOT NULL, payload TEXT NOT NULL,
                created_at REAL NOT NULL, source TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS events_topic ON events(topic, id);
            CREATE TABLE IF NOT EXISTS timers (
                id TEXT PRIMARY KEY, topic TEXT NOT NULL, payload TEXT NOT NULL,
                due_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS timers_due ON timers(due_at);
            CREATE TABLE IF NOT EXISTS runners (
                name TEXT PRIMARY KEY, cursor INTEGER NOT NULL
            );
        """)

    def close(self):
        self.db.close()

    @staticmethod
    def event(row):
        return {**dict(row), "payload": json.loads(row["payload"])}

    def publish(self, topic, payload, source="manual"):
        topic, payload = topic_name(topic), encode(payload)
        with self.db:
            cursor = self.db.execute(
                "INSERT INTO events(topic,payload,created_at,source) VALUES(?,?,?,?)",
                (topic, payload, time.time(), source),
            )
        return self.event(self.db.execute("SELECT * FROM events WHERE id=?", (cursor.lastrowid,)).fetchone())

    def schedule(self, topic, payload, delay_seconds):
        topic, payload = topic_name(topic), encode(payload)
        number(delay_seconds, "delay_seconds")
        timer = {"id": str(uuid.uuid4()), "topic": topic,
                 "payload": payload, "due_at": time.time() + delay_seconds}
        with self.db:
            self.db.execute("INSERT INTO timers VALUES(:id,:topic,:payload,:due_at)", timer)
        return {**timer, "payload": json.loads(payload)}

    def cancel(self, timer_id):
        if not isinstance(timer_id, str):
            raise ValueError("timer_id must be a string")
        with self.db:
            return self.db.execute("DELETE FROM timers WHERE id=?", (timer_id,)).rowcount > 0

    def fire_due(self):
        # Atomic claim + event insert: two servers cannot fire the same timer twice.
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            rows = self.db.execute("SELECT * FROM timers WHERE due_at<=? ORDER BY due_at LIMIT 100", (time.time(),)).fetchall()
            for row in rows:
                payload = json.dumps({"timer_id": row["id"], "due_at": row["due_at"],
                                      "data": json.loads(row["payload"])}, allow_nan=False)
                self.db.execute(
                    "INSERT INTO events(topic,payload,created_at,source) VALUES(?,?,?,?)",
                    (row["topic"], payload, time.time(), "timer"),
                )
                self.db.execute("DELETE FROM timers WHERE id=?", (row["id"],))
        return len(rows)

    def latest(self):
        return self.db.execute("SELECT COALESCE(MAX(id),0) FROM events").fetchone()[0]

    def read(self, after=0, topics=None, limit=100):
        integer(after, "after")
        integer(limit, "limit", 1, 100)
        if topics is not None:
            if not isinstance(topics, list) or len(topics) > 32:
                raise ValueError("topics must be an array of at most 32 strings")
            for topic in topics:
                topic_name(topic)
        args = [after]
        query = "SELECT * FROM events WHERE id>?"
        if topics:
            query += " AND topic IN (" + ",".join("?" for _ in topics) + ")"
            args.extend(topics)
        args.append(limit)
        return [self.event(row) for row in self.db.execute(query + " ORDER BY id LIMIT ?", args)]


class ObserverBus:
    """Subject/observer pattern: subscribe, notify, and unsubscribe on exit."""
    def __init__(self):
        self.observers = set()

    def subscribe(self, observer):
        self.observers.add(observer)
        return lambda: self.observers.discard(observer)

    def notify(self):
        for observer in tuple(self.observers):
            observer()


class Broker:
    def __init__(self, store, watch=(), interval=0.25):
        self.store = store
        self.bus = ObserverBus()
        self.interval = number(interval, "interval", 0.01, 60)
        self.files = {Path(path).expanduser().resolve(): None for path in watch}
        for path in self.files:
            if path.is_dir():
                raise ValueError("--watch accepts individual files, not directories")
            self.files[path] = self.signature(path)
        self.seen = store.latest()

    @staticmethod
    def signature(path):
        try:
            stat = path.stat()
            return stat.st_mtime_ns, stat.st_size, stat.st_ino
        except FileNotFoundError:
            return None

    async def pump(self):
        while True:
            self.store.fire_due()
            for path, previous in list(self.files.items()):
                current = self.signature(path)
                if current != previous:
                    kind = "created" if previous is None else "deleted" if current is None else "modified"
                    self.store.publish("file.changed", {"path": str(path), "kind": kind}, "file")
                    self.files[path] = current
            latest = self.store.latest()
            if latest != self.seen:
                self.seen = latest
                self.bus.notify()
            await asyncio.sleep(self.interval)

    def publish(self, topic, payload):
        event = self.store.publish(topic, payload)
        self.bus.notify()
        return event

    async def wait(self, after=0, topics=None, timeout_seconds=25):
        number(timeout_seconds, "timeout_seconds", 0, 25)
        ready = asyncio.Event()
        unsubscribe = self.bus.subscribe(ready.set)
        deadline = asyncio.get_running_loop().time() + timeout_seconds
        try:
            while True:
                ready.clear()
                events = self.store.read(after, topics)
                if events:
                    return {"reason": "event", "events": events, "cursor": events[-1]["id"]}
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    return {"reason": "timeout", "events": [], "cursor": after}
                try:
                    await asyncio.wait_for(ready.wait(), remaining)
                except asyncio.TimeoutError:
                    pass
        finally:
            unsubscribe()
