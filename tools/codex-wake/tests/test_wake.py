import asyncio
import json
from pathlib import Path
import sys
import tempfile
import unittest

from codex_wake.core import Broker, EventStore


class CoreTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "events.sqlite3"
        self.store = EventStore(self.path)
        self.broker = Broker(self.store, interval=0.01)
        self.pump = asyncio.create_task(self.broker.pump())

    async def asyncTearDown(self):
        self.pump.cancel()
        await asyncio.gather(self.pump, return_exceptions=True)
        self.store.close()
        self.tmp.cleanup()

    async def test_observer_broadcast_and_cursor_replay(self):
        first = asyncio.create_task(self.broker.wait(topics=["build.done"], timeout_seconds=1))
        second = asyncio.create_task(self.broker.wait(topics=["build.done"], timeout_seconds=1))
        await asyncio.sleep(0)
        self.broker.publish("other", {})
        event = self.broker.publish("build.done", {"ok": True})
        a, b = await asyncio.gather(first, second)
        self.assertEqual(a, b)
        self.assertEqual(a["events"], [event])
        replay = await self.broker.wait(after=event["id"], timeout_seconds=0)
        self.assertEqual(replay["reason"], "timeout")
        self.assertEqual(replay["cursor"], event["id"])
        self.assertFalse(self.broker.bus.observers)

    async def test_external_database_writer_wakes_subscriber(self):
        waiter = asyncio.create_task(self.broker.wait(timeout_seconds=1))
        await asyncio.sleep(0)
        external = EventStore(self.path)
        external.publish("external", {"value": 7})
        external.close()
        self.assertEqual((await waiter)["events"][0]["topic"], "external")

    async def test_durable_timer_restarts_and_fires_once(self):
        timer = self.store.schedule("reminder", {"message": "check"}, 0)
        other = EventStore(self.path)
        other.fire_due()
        self.store.fire_due()
        other.close()
        events = self.store.read()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["payload"]["timer_id"], timer["id"])
        self.assertEqual(events[0]["source"], "timer")

    async def test_timer_not_early_and_cancellation(self):
        timer = self.store.schedule("later", {}, 60)
        self.assertEqual(self.store.fire_due(), 0)
        self.assertTrue(self.store.cancel(timer["id"]))
        self.assertFalse(self.store.cancel(timer["id"]))

    async def test_timer_wakes_active_wait(self):
        self.store.schedule("reminder", {"x": 1}, 0.03)
        result = await self.broker.wait(topics=["reminder"], timeout_seconds=1)
        self.assertEqual(result["reason"], "event")
        self.assertEqual(result["events"][0]["payload"]["data"], {"x": 1})

    async def test_cancelled_wait_unsubscribes(self):
        waiter = asyncio.create_task(self.broker.wait())
        await asyncio.sleep(0)
        waiter.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiter
        self.assertFalse(self.broker.bus.observers)

    async def test_file_created_modified_deleted(self):
        file = Path(self.tmp.name) / "result.txt"
        self.pump.cancel()
        await asyncio.gather(self.pump, return_exceptions=True)
        self.broker = Broker(self.store, watch=[file], interval=0.01)
        self.pump = asyncio.create_task(self.broker.pump())
        cursor = 0
        for kind in ("created", "modified", "deleted"):
            if kind == "deleted":
                file.unlink()
            else:
                file.write_text(kind)
            result = await self.broker.wait(after=cursor, topics=["file.changed"], timeout_seconds=1)
            self.assertEqual(result["reason"], "event")
            self.assertEqual(result["events"][0]["payload"]["kind"], kind)
            cursor = result["cursor"]

    async def test_validation_and_large_timer_payload(self):
        for value in (float("nan"), float("inf"), -1, True):
            with self.assertRaises(ValueError):
                self.store.schedule("timer", {}, value)
        with self.assertRaises(ValueError):
            self.store.publish("", {})
        with self.assertRaises(ValueError):
            self.store.publish("big", "x" * 32768)
        with self.assertRaises(ValueError):
            self.store.read(topics="not-an-array")
        with self.assertRaises(ValueError):
            await self.broker.wait(timeout_seconds=26)
        self.store.schedule("big", "x" * 32760, 0)
        self.assertEqual(self.store.fire_due(), 1)

    async def test_cursor_batches_do_not_drop_events(self):
        for i in range(110):
            self.store.publish("batch", i)
        first = await self.broker.wait(timeout_seconds=0)
        second = await self.broker.wait(after=first["cursor"], timeout_seconds=0)
        self.assertEqual(len(first["events"]), 100)
        self.assertEqual(len(second["events"]), 10)


class ProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_stdio_handshake_concurrent_emit_cancel_and_cli(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = str(Path(tmp) / "events.sqlite3")
            process = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "codex_wake", "--db", db, "serve",
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            async def send(method, params=None, id=None):
                msg = {"jsonrpc": "2.0", "method": method, "params": params or {}}
                if id is not None:
                    msg["id"] = id
                process.stdin.write((json.dumps(msg) + "\n").encode())
                await process.stdin.drain()

            async def receive():
                return json.loads(await asyncio.wait_for(process.stdout.readline(), 3))

            def body(response):
                return json.loads(response["result"]["content"][0]["text"])

            try:
                await send("initialize", {"protocolVersion": "2025-03-26"}, 1)
                self.assertEqual((await receive())["result"]["protocolVersion"], "2025-03-26")
                await send("notifications/initialized")
                await send("tools/list", id=2)
                self.assertEqual(len((await receive())["result"]["tools"]), 5)
                await send("tools/call", {"name": "wait_for_event", "arguments": {"timeout_seconds": 2}}, 3)
                await send("tools/call", {"name": "publish_event", "arguments": {"topic": "done", "payload": {}}}, 4)
                replies = {r["id"]: r for r in [await receive(), await receive()]}
                self.assertEqual(body(replies[3])["reason"], "event")
                cursor = body(replies[3])["cursor"]
                await send("tools/call", {"name": "wait_for_event", "arguments": {"after": cursor}}, 5)
                await send("notifications/cancelled", {"requestId": 5})
                self.assertEqual((await receive())["error"]["code"], -32800)
                await send("tools/call", {"name": "wait_for_event", "arguments": {"after": cursor}}, 6)
                cli = await asyncio.create_subprocess_exec(
                    sys.executable, "-m", "codex_wake", "--db", db, "emit", "cli.done",
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                )
                output, errors = await asyncio.wait_for(cli.communicate(), 3)
                self.assertEqual(cli.returncode, 0, errors)
                self.assertEqual(json.loads(output)["topic"], "cli.done")
                self.assertEqual(body(await receive())["events"][0]["topic"], "cli.done")
                process.stdin.write(b"not json\n")
                await process.stdin.drain()
                self.assertEqual((await receive())["error"]["code"], -32700)
                await send("tools/call", {"name": "wait_for_event", "arguments": {"timeout_seconds": -1}}, 7)
                self.assertTrue((await receive())["result"]["isError"])
                process.stdin.close()
                await asyncio.wait_for(process.wait(), 3)
                self.assertEqual(process.returncode, 0, await process.stderr.read())
            finally:
                if process.returncode is None:
                    process.kill()
                    await process.wait()


if __name__ == "__main__":
    unittest.main()
