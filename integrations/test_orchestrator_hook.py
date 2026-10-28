"""Unit tests for the Python ingestion hook's buffer behaviour.

Run: python -m pytest integrations/test_orchestrator_hook.py
Covers the re-queue-on-failure path that previously had only a
`compileall` syntax check in CI.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from orchestrator_hook import MemoriaHook  # noqa: E402


def make_hook(max_buffer=3):
    return MemoriaHook(
        memoria_url="http://127.0.0.1:9/ingest",
        api_key="test",
        max_buffer=max_buffer,
        flush_interval=0,
    )


def event(i):
    return {"id": f"e{i}", "source": "t", "content": f"event {i}"}


def test_failed_flush_requeues_at_front_in_order():
    hook = make_hook()
    hook._buffer = [event(1), event(2)]
    hook._send = lambda events: (_ for _ in ()).throw(RuntimeError("down"))
    result = hook.flush()
    assert "error" in result
    assert [e["id"] for e in hook._buffer] == ["e1", "e2"]


def test_failed_flush_caps_buffer_at_2x_dropping_oldest():
    hook = make_hook(max_buffer=2)
    hook._buffer = [event(i) for i in range(5)]
    hook._send = lambda events: (_ for _ in ()).throw(RuntimeError("down"))
    hook.flush()
    assert len(hook._buffer) == 4  # 2 * max_buffer
    assert hook._buffer[0]["id"] == "e1"  # oldest dropped


def test_successful_flush_clears_buffer():
    hook = make_hook()
    hook._buffer = [event(1)]
    hook._send = lambda events: {"accepted": len(events)}
    assert hook.flush() == {"accepted": 1}
    assert hook._buffer == []


def test_empty_flush_is_a_noop():
    hook = make_hook()
    assert hook.flush() == {"accepted": 0}


class _HTTPError(Exception):
    def __init__(self, status):
        super().__init__(f"HTTP {status}")
        self.response = type("R", (), {"status_code": status})()


def test_client_errors_are_dropped_not_retried_forever():
    hook = make_hook()
    hook._buffer = [event(1), event(2)]

    def reject(events):
        raise _HTTPError(401)

    hook._send = reject
    result = hook.flush()
    assert result["dropped"] == 2
    assert hook._buffer == []


def test_rate_limits_and_server_errors_are_retried():
    for status in (429, 503):
        hook = make_hook()
        hook._buffer = [event(1)]

        def fail(events, status=status):
            raise _HTTPError(status)

        hook._send = fail
        hook.flush()
        assert [e["id"] for e in hook._buffer] == ["e1"]


def test_recording_never_waits_on_a_slow_send():
    import threading
    import time

    hook = make_hook(max_buffer=2)
    release = threading.Event()

    def slow_send(events):
        release.wait(5)
        return {"accepted": len(events)}

    hook._send = slow_send
    hook._push(event(1))
    hook._push(event(2))  # fills the buffer: a background flush starts
    started = time.monotonic()
    for i in range(3, 10):
        hook._push(event(i))  # must not block behind the in-flight send
    assert time.monotonic() - started < 1.0
    release.set()
