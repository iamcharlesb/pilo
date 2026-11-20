import argparse
import asyncio
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from codex_wake.core import Broker, EventStore
from codex_wake.runner import run


class RunnerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = EventStore(self.root / "events.sqlite3")
        self.prompt = self.root / "task.txt"
        self.prompt.write_text("Summarize the event data.")
        self.fake = self.root / "fake-codex"
        self.write_fake("print(json.dumps({'args': sys.argv[1:], 'input': sys.stdin.read()}))")
        self.args = argparse.Namespace(
            name="test", db=str(self.root / "events.sqlite3"), workspace=str(self.root),
            prompt_file=str(self.prompt), topic=["ready"], after=0, max_runs=1,
            deadline=5, run_timeout=3,
        )

    def write_fake(self, body):
        self.fake.write_text(f"#!{sys.executable}\nimport json, sys, time\n{body}\n")
        self.fake.chmod(0o700)

    async def asyncTearDown(self):
        self.store.close()
        self.tmp.cleanup()

    async def invoke(self):
        output, errors = io.StringIO(), io.StringIO()
        with patch.dict("os.environ", {"CODEX_WAKE_CODEX": str(self.fake)}):
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                await run(Broker(self.store, interval=0.01), self.args)
        return output.getvalue(), errors.getvalue()

    async def test_dispatch_is_bounded_and_checkpoint_prevents_replay(self):
        self.store.publish("ready", {"text": "untrusted data"})
        output, errors = await self.invoke()
        self.assertFalse(errors)
        result = json.loads(output)
        model = json.loads(Path(result["output"]).read_text())
        self.assertEqual(result["exit_code"], 0)
        self.assertIn("read-only", model["args"])
        self.assertIn("never", model["args"])
        self.assertEqual(model["args"][-1], "-")
        self.assertIn("untrusted data", model["input"])
        self.assertEqual(Path(result["output"]).stat().st_mode & 0o777, 0o600)
        self.args.after = None
        self.args.deadline = 0.03
        output, errors = await self.invoke()
        self.assertEqual(output, "")
        self.assertEqual(len(list((self.root / "runs").glob("*.jsonl"))), 1)

    async def test_failure_is_not_retried(self):
        self.write_fake("sys.exit(3)")
        self.store.publish("ready", {})
        self.args.max_runs = 2
        output, errors = await self.invoke()
        self.assertEqual(json.loads(output)["exit_code"], 3)
        self.assertIn("no automatic retry", errors)
        self.assertEqual(self.store.db.execute("SELECT cursor FROM runners").fetchone()[0], 1)

    async def test_timeout_terminates_child(self):
        self.write_fake("time.sleep(30)")
        self.store.publish("ready", {})
        self.args.run_timeout = 0.03
        output, errors = await self.invoke()
        self.assertTrue(json.loads(output)["timed_out"])
        self.assertIn("no automatic retry", errors)

    async def test_idle_wait_does_not_invoke_codex(self):
        self.args.after = None
        self.args.deadline = 0.03
        output, errors = await self.invoke()
        self.assertFalse(output)
        self.assertFalse(errors)
        self.assertFalse((self.root / "runs").exists())


if __name__ == "__main__":
    unittest.main()
