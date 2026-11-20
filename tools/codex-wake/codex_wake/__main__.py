import argparse
import asyncio
import json
import os
from pathlib import Path

from .core import Broker, EventStore
from .server import Server


def main():
    parser = argparse.ArgumentParser(description="Codex Wake: durable local observer events and timers")
    default = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / "codex-wake/events.sqlite3"
    parser.add_argument("--db", default=os.environ.get("CODEX_WAKE_DB", str(default)))
    sub = parser.add_subparsers(dest="command", required=True)
    serve = sub.add_parser("serve", help="Run the MCP stdio server")
    serve.add_argument("--watch", action="append", default=[], metavar="FILE")
    emit = sub.add_parser("emit", help="Persist an event for connected observers")
    emit.add_argument("topic")
    emit.add_argument("--payload", default="{}", help="JSON data")
    schedule = sub.add_parser("schedule", help="Schedule a durable one-shot event")
    schedule.add_argument("topic")
    schedule.add_argument("--after", type=float, required=True, help="Delay in seconds")
    schedule.add_argument("--payload", default="{}")
    cancel = sub.add_parser("cancel")
    cancel.add_argument("timer_id")
    sub.add_parser("status")
    runner = sub.add_parser("run", help="Explicitly authorize bounded headless Codex runs on matching events")
    runner.add_argument("--name", required=True, help="Persistent cursor identity")
    runner.add_argument("--workspace", required=True)
    runner.add_argument("--prompt-file", required=True)
    runner.add_argument("--topic", action="append", required=True)
    runner.add_argument("--after", type=int, help="Explicitly replay after this event ID")
    runner.add_argument("--max-runs", type=int, default=1)
    runner.add_argument("--deadline", type=float, default=3600, help="Total lifetime in seconds")
    runner.add_argument("--run-timeout", type=float, default=300)
    runner.add_argument("--watch", action="append", default=[], metavar="FILE")
    args = parser.parse_args()
    store = EventStore(args.db)
    try:
        if args.command == "serve":
            asyncio.run(Server(Broker(store, args.watch)).serve())
            return
        if args.command == "run":
            from .runner import run
            asyncio.run(run(Broker(store, args.watch), args))
            return
        if args.command == "emit":
            result = store.publish(args.topic, json.loads(args.payload))
        elif args.command == "schedule":
            result = store.schedule(args.topic, json.loads(args.payload), args.after)
        elif args.command == "cancel":
            result = {"cancelled": store.cancel(args.timer_id)}
        else:
            result = {"cursor": store.latest()}
        print(json.dumps(result))
    except (ValueError, OSError) as error:
        parser.error(str(error))
    except KeyboardInterrupt:
        pass
    finally:
        store.close()


if __name__ == "__main__":
    main()
