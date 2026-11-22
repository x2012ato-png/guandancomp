"""DanZero Deep Monte Carlo (DMC) AI Inference Microservice.

Exposes:
  1. `GET /health`
     Health check and model status.
  2. `POST /v1/chat/completions` & `POST /chat/completions`
     Drop-in compatible with `packages/server/src/externalAI.ts` (apiType: 'openai').
     Parses `messages[-1].content` JSON (`{view, choices}`) and returns `{"choice": best_idx}`
     inside an OpenAI-format completion response.
  3. `POST /api/v1/chat`
     Drop-in compatible with `packages/server/src/externalAI.ts` (apiType: 'lmstudio'),
     supporting stateful `snapshot` and `incremental` delta payloads!
  4. `POST /decide`
     Direct JSON endpoint accepting either:
       - `{ "view": PlayerView, "choices": [...] }` (returns `{"choice": idx, "q_value": float, "latency_ms": float}`)
"""

from __future__ import annotations

import copy
import json
import os
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from adapter import (
    build_danzero_batch_from_player_view,
    choose_tribute_or_return,
    expand_choices_for_danzero,
)
from model import DanZeroQNetwork


class DanZeroService:
    """Holds the pretrained DanZero Q-network and optional incremental session cache."""

    def __init__(self, ckpt_path: str | None = None) -> None:
        self.net = DanZeroQNetwork(ckpt_path)
        self.sessions: dict[str, dict[str, Any]] = {}
        self.max_sessions = 256

    def resolve_view_from_payload(
        self, payload: dict[str, Any], previous_response_id: str | None = None
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        """Resolve full `view` and `choices` from either `snapshot` or `incremental` payload."""
        choices = payload.get("choices") or []
        mode = payload.get("mode", "snapshot")
        if mode == "incremental" and previous_response_id and previous_response_id in self.sessions:
            view = copy.deepcopy(self.sessions[previous_response_id])
            for k, v in (payload.get("changes") or {}).items():
                view[k] = v
            if "publicHistoryAppend" in payload:
                view["publicHistory"] = list(view.get("publicHistory") or []) + list(
                    payload["publicHistoryAppend"]
                )
            if "playedCardsAppend" in payload:
                view["playedCards"] = list(view.get("playedCards") or []) + list(
                    payload["playedCardsAppend"]
                )
        else:
            view = payload.get("view") or {}
        return view, choices

    def store_session(self, view: dict[str, Any]) -> str:
        if len(self.sessions) >= self.max_sessions:
            oldest = next(iter(self.sessions))
            del self.sessions[oldest]
        resp_id = f"resp_{uuid.uuid4().hex[:16]}"
        self.sessions[resp_id] = view
        return resp_id

    def decide(
        self, view: dict[str, Any], choices: list[dict[str, Any]]
    ) -> dict[str, Any]:
        """Select the optimal action index from `choices` given `view`."""
        t0 = time.perf_counter()
        if not choices:
            return {"choice": 0, "q_value": 0.0, "latency_ms": 0.0}
        if len(choices) == 1:
            return {
                "choice": 0,
                "q_value": 0.0,
                "latency_ms": round((time.perf_counter() - t0) * 1000, 3),
            }

        duty = view.get("myDuty") or view.get("phase")
        if duty in ("tribute", "return"):
            idx = choose_tribute_or_return(view, choices)
            return {
                "choice": idx,
                "q_value": 0.0,
                "latency_ms": round((time.perf_counter() - t0) * 1000, 3),
            }

        expanded_choices, parent_indices = expand_choices_for_danzero(view, choices)
        x_batch = build_danzero_batch_from_player_view(view, expanded_choices)
        best_exp_idx, q_values = self.net.best_action_index(x_batch)
        best_idx = parent_indices[best_exp_idx]
        best_q = float(q_values[best_exp_idx]) if q_values.ndim > 0 else float(q_values)
        latency_ms = round((time.perf_counter() - t0) * 1000, 3)
        return {
            "choice": best_idx,
            "q_value": round(best_q, 4),
            "latency_ms": latency_ms,
        }


# Global singleton service
SERVICE = DanZeroService()


class DanZeroHTTPHandler(BaseHTTPRequestHandler):
    """Zero-dependency HTTP server handler supporting OpenAI, LM Studio, and direct `/decide` endpoints."""

    server_version = "DanZeroDMC/1.0"

    def log_message(self, format: str, *args: Any) -> None:
        if os.environ.get("DANZERO_QUIET") == "1":
            return
        super().log_message(format, *args)

    def _send_json(self, status: int, data: dict[str, Any]) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_GET(self) -> None:
        path = self.path.split("?")[0]
        if path in ("/health", "/"):
            self._send_json(200, {"status": "ok", "model": "danzero-dmc-567", "engine": "numpy"})
            return
        if path in ("/v1/models", "/models"):
            self._send_json(
                200,
                {
                    "object": "list",
                    "data": [{"id": "danzero", "object": "model", "owned_by": "guandan-dmc"}],
                },
            )
            return
        self._send_json(404, {"error": "NOT_FOUND"})

    def do_POST(self) -> None:
        path = self.path.split("?")[0].rstrip("/")
        length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(length) if length > 0 else b"{}"
        try:
            body = json.loads(raw_body.decode("utf-8"))
        except Exception as exc:
            self._send_json(400, {"error": f"Invalid JSON: {exc}"})
            return

        try:
            # 1. OpenAI Chat Completions compatible endpoint
            if path in ("/v1/chat/completions", "/chat/completions"):
                messages = body.get("messages") or []
                user_content = messages[-1].get("content", "{}") if messages else "{}"
                payload = json.loads(user_content) if isinstance(user_content, str) else user_content
                view, choices = SERVICE.resolve_view_from_payload(payload)
                res = SERVICE.decide(view, choices)
                self._send_json(
                    200,
                    {
                        "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
                        "object": "chat.completion",
                        "model": body.get("model", "danzero"),
                        "choices": [
                            {
                                "index": 0,
                                "message": {
                                    "role": "assistant",
                                    "content": json.dumps({"choice": res["choice"]}),
                                },
                                "finish_reason": "stop",
                            }
                        ],
                        "danzero_meta": res,
                    },
                )
                return

            # 2. LM Studio Stateful API compatible endpoint
            if path in ("/api/v1/chat", "/v1/chat"):
                raw_input = body.get("input", "{}")
                payload = json.loads(raw_input) if isinstance(raw_input, str) else raw_input
                prev_id = body.get("previous_response_id")
                view, choices = SERVICE.resolve_view_from_payload(payload, prev_id)
                res = SERVICE.decide(view, choices)
                resp_id = SERVICE.store_session(view)
                self._send_json(
                    200,
                    {
                        "response_id": resp_id,
                        "output": [
                            {
                                "type": "message",
                                "content": json.dumps({"choice": res["choice"]}),
                            }
                        ],
                        "danzero_meta": res,
                    },
                )
                return

            # 3. Direct native `/decide` endpoint
            if path == "/decide":
                view, choices = SERVICE.resolve_view_from_payload(body)
                res = SERVICE.decide(view, choices)
                self._send_json(200, res)
                return

            self._send_json(404, {"error": f"Unknown endpoint {path}"})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})


def run_server(host: str = "0.0.0.0", port: int = 8000) -> None:
    server = ThreadingHTTPServer((host, port), DanZeroHTTPHandler)
    print(f"DanZero DMC AI Service listening on http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8000"))
    run_server(host, port)
