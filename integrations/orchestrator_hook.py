"""
Memoria ingestion hook for Python agent systems.

Buffers events from your agents (results, metrics, conversation turns,
evaluations, prompt changes, discovery) and pushes them to Memoria's /ingest
endpoint for persistent cross-session memory. Originally written for a
multi-agent "Orchestrator"; the API is generic. Best-effort by design: a
Memoria outage never breaks the caller.

Usage in Orchestrator:
    from integrations.orchestrator_hook import MemoriaHook

    hook = MemoriaHook(
        memoria_url="https://your-memoria-instance/ingest",
        api_key="your-memoria-api-key",
    )

    # In AgentExecutor.run() after getting a result:
    hook.record_agent_result(agent_id, task, result, metrics)

    # In MetricsStore.record():
    hook.record_metric(agent_id, success, response_time_ms, cost_usd, user_id)

    # In ConversationStore.append():
    hook.record_conversation(user_id, role, content, channel_id)

    # In SelfEvaluator after evaluation:
    hook.record_training_eval(agent_id, score, routing_correct, issues)

    # Flush buffered events (call periodically or on shutdown):
    hook.flush()
"""

import hashlib
import json
import logging
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any, Optional

try:
    import httpx

    _HAS_HTTPX = True
except ImportError:
    _HAS_HTTPX = False

try:
    import requests

    _HAS_REQUESTS = True
except ImportError:
    _HAS_REQUESTS = False

logger = logging.getLogger("memoria_hook")


def _http_status(exc: Exception) -> Optional[int]:
    """The HTTP status behind an httpx/requests error, if there is one."""
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None)
    return status if isinstance(status, int) else None


class MemoriaHook:
    """Buffers Orchestrator events and flushes them to Memoria's /ingest endpoint."""

    def __init__(
        self,
        memoria_url: Optional[str] = None,
        api_key: Optional[str] = None,
        flush_interval: int = 30,
        max_buffer: int = 200,
        auto_flush: bool = True,
    ):
        self.url = memoria_url or os.environ.get(
            "MEMORIA_URL", "http://localhost:3100/ingest"
        )
        self.api_key = api_key or os.environ.get("MEMORIA_API_KEY", "")
        self.max_buffer = max_buffer
        self._buffer: list[dict] = []
        # _lock guards the buffer only and is never held across network I/O,
        # so record_* calls never wait on Memoria. _send_lock serializes
        # sends (one batch in flight at a time).
        self._lock = threading.Lock()
        self._send_lock = threading.Lock()

        if auto_flush and flush_interval > 0:
            self._timer = threading.Timer(flush_interval, self._auto_flush)
            self._timer.daemon = True
            self._timer.start()
            self._flush_interval = flush_interval
        else:
            self._timer = None
            self._flush_interval = 0

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    def _event_id(self, *parts: str) -> str:
        raw = "|".join(parts) + "|" + str(time.time_ns())
        return hashlib.sha256(raw.encode()).hexdigest()[:16]

    def _push(self, event: dict) -> None:
        with self._lock:
            self._buffer.append(event)
            full = len(self._buffer) >= self.max_buffer
        if full:
            self._flush_in_background()

    def _flush_in_background(self) -> None:
        # The send used to run inline, under the buffer lock, in whichever
        # agent thread happened to fill the buffer: during an outage every
        # record_* call then blocked for up to the 10s timeout.
        if self._send_lock.locked():
            return  # a send is in flight; the next flush takes these events
        threading.Thread(target=self._safe_flush, daemon=True).start()

    def _safe_flush(self) -> None:
        try:
            self.flush()
        except Exception as e:  # never let a background flush raise
            logger.debug(f"Background flush error: {e}")

    # ── Data collection methods ──────────────────────────────

    def record_agent_result(
        self,
        agent_id: str,
        task: str,
        result: str,
        metrics: Optional[dict] = None,
    ) -> None:
        """Record an agent execution result."""
        importance = 6
        if metrics and not metrics.get("success", True):
            importance = 8  # failures are more important to remember

        self._push(
            {
                "id": self._event_id("agent_result", agent_id, task[:50]),
                "source": f"orchestrator-{agent_id}",
                "eventType": "agent_result",
                "content": f"[{agent_id}] Task: {task[:200]}\n\nResult: {result[:500]}",
                "timestamp": self._now(),
                "importance": importance,
                "meta": {
                    "agent_id": agent_id,
                    "task_preview": task[:200],
                    "success": metrics.get("success") if metrics else True,
                    "latency_ms": metrics.get("response_time_ms") if metrics else None,
                    "cost_usd": metrics.get("cost_usd") if metrics else None,
                },
            }
        )

    def record_metric(
        self,
        agent_id: str,
        success: bool,
        response_time_ms: float,
        cost_usd: float,
        user_id: Optional[str] = None,
        routing_confidence: Optional[float] = None,
    ) -> None:
        """Record an agent performance metric."""
        importance = 4 if success else 7
        status = "success" if success else "FAILURE"

        self._push(
            {
                "id": self._event_id("metric", agent_id, status),
                "source": "orchestrator-metrics",
                "eventType": "agent_metric",
                "content": (
                    f"Agent {agent_id}: {status} | "
                    f"{response_time_ms:.0f}ms | ${cost_usd:.4f}"
                ),
                "timestamp": self._now(),
                "importance": importance,
                "meta": {
                    "agent_id": agent_id,
                    "success": success,
                    "response_time_ms": response_time_ms,
                    "cost_usd": cost_usd,
                    "user_id": user_id,
                    "routing_confidence": routing_confidence,
                },
            }
        )

    def record_conversation(
        self,
        user_id: str,
        role: str,
        content: str,
        channel_id: Optional[str] = None,
    ) -> None:
        """Record a conversation turn (user or assistant)."""
        # Only record substantive messages
        if len(content.strip()) < 10:
            return

        self._push(
            {
                "id": self._event_id("convo", user_id, content[:30]),
                "source": "orchestrator-conversations",
                "eventType": "conversation_turn",
                "content": f"[{role}] {content[:500]}",
                "timestamp": self._now(),
                "importance": 3 if role == "assistant" else 5,
                "meta": {
                    "user_id": user_id,
                    "role": role,
                    "channel_id": channel_id,
                },
            }
        )

    def record_training_eval(
        self,
        agent_id: str,
        score: float,
        routing_correct: bool,
        issues: Optional[str] = None,
    ) -> None:
        """Record a training evaluation result."""
        importance = 5 if score >= 3.5 else 8

        self._push(
            {
                "id": self._event_id("eval", agent_id, str(score)),
                "source": "orchestrator-training",
                "eventType": "training_evaluation",
                "content": (
                    f"Training eval for {agent_id}: score={score:.1f}, "
                    f"routing={'correct' if routing_correct else 'INCORRECT'}"
                    + (f"\nIssues: {issues}" if issues else "")
                ),
                "timestamp": self._now(),
                "importance": importance,
                "meta": {
                    "agent_id": agent_id,
                    "score": score,
                    "routing_correct": routing_correct,
                },
            }
        )

    def record_prompt_change(
        self,
        agent_id: str,
        field: str,
        old_value: str,
        new_value: str,
        applied: bool,
    ) -> None:
        """Record a prompt improvement application."""
        self._push(
            {
                "id": self._event_id("prompt_change", agent_id, field),
                "source": "orchestrator-training",
                "eventType": "prompt_change",
                "content": (
                    f"Prompt change for {agent_id}.{field}: "
                    f"{'APPLIED' if applied else 'proposed'}\n"
                    f"Old: {old_value[:200]}\nNew: {new_value[:200]}"
                ),
                "timestamp": self._now(),
                "importance": 7 if applied else 5,
                "meta": {
                    "agent_id": agent_id,
                    "field": field,
                    "applied": applied,
                },
            }
        )

    def record_discovery(
        self, repo_name: str, agent_id: str, description: str
    ) -> None:
        """Record an agent auto-discovery event."""
        self._push(
            {
                "id": self._event_id("discovery", repo_name, agent_id),
                "source": "orchestrator-discovery",
                "eventType": "agent_discovered",
                "content": f"Discovered agent '{agent_id}' from repo {repo_name}: {description[:300]}",
                "timestamp": self._now(),
                "importance": 7,
                "meta": {
                    "repo_name": repo_name,
                    "agent_id": agent_id,
                },
            }
        )

    # ── Flush ─────────────────────────────────────────────────

    def flush(self) -> dict:
        """Flush all buffered events to Memoria. Returns ingestion result."""
        with self._send_lock:
            with self._lock:
                if not self._buffer:
                    return {"accepted": 0}
                events = self._buffer[:]
                self._buffer.clear()

            try:
                return self._send(events)
            except Exception as e:
                status = _http_status(e)
                if status is not None and 400 <= status < 500 and status not in (408, 429):
                    # A client error (bad key, payload rejected) fails the same
                    # way on every retry; re-queueing it retried forever and
                    # crowded out newer events.
                    logger.error(
                        "Memoria rejected %d event(s) with HTTP %d; dropping them: %s",
                        len(events),
                        status,
                        e,
                    )
                    return {"error": str(e), "dropped": len(events)}
                logger.error(f"Memoria flush failed: {e}")
                # Re-queue failed events at the FRONT so retry preserves chronological
                # order (extend() would interleave them after newer pushes). Cap the
                # buffer at 2x max_buffer, dropping the OLDEST on overflow, so a long
                # Memoria outage can't grow the buffer unbounded.
                with self._lock:
                    self._buffer[:0] = events
                    hard_cap = self.max_buffer * 2
                    if len(self._buffer) > hard_cap:
                        dropped = len(self._buffer) - hard_cap
                        self._buffer = self._buffer[-hard_cap:]
                        logger.warning(
                            "Memoria buffer over %d after failed flush; dropped %d oldest event(s)",
                            hard_cap,
                            dropped,
                        )
                return {"error": str(e)}

    def _send(self, events: list[dict]) -> dict:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        body = json.dumps({"events": events})

        if _HAS_HTTPX:
            resp = httpx.post(self.url, content=body, headers=headers, timeout=10)
            resp.raise_for_status()
            return resp.json()
        elif _HAS_REQUESTS:
            resp = requests.post(self.url, data=body, headers=headers, timeout=10)
            resp.raise_for_status()
            return resp.json()
        else:
            raise RuntimeError(
                "No HTTP client available. Install httpx or requests: pip install httpx"
            )

    def _auto_flush(self) -> None:
        try:
            self.flush()
        except Exception as e:
            logger.debug(f"Auto-flush error: {e}")
        finally:
            if self._flush_interval > 0:
                self._timer = threading.Timer(
                    self._flush_interval, self._auto_flush
                )
                self._timer.daemon = True
                self._timer.start()

    def shutdown(self) -> None:
        """Flush remaining events and stop auto-flush timer."""
        if self._timer:
            self._timer.cancel()
        self.flush()
