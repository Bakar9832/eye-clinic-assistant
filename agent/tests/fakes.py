"""Stand-ins for the model and the tools, so tests run without internet or quota."""

import json
from types import SimpleNamespace
from typing import Any

import httpx
import openai

from eye_agent.models import TurnRequest
from eye_agent.tools import ToolOutcome


def answer(text: str) -> SimpleNamespace:
    """A model response that just answers."""
    return _response(SimpleNamespace(content=text, tool_calls=None))


def tool_call(name: str, arguments: dict[str, Any] | str, call_id: str = "call_1") -> SimpleNamespace:
    """A model response that asks for one tool."""
    raw = arguments if isinstance(arguments, str) else json.dumps(arguments)
    call = SimpleNamespace(id=call_id, function=SimpleNamespace(name=name, arguments=raw))
    return _response(SimpleNamespace(content=None, tool_calls=[call]))


def _response(message: SimpleNamespace) -> SimpleNamespace:
    # The same shape as the openai library's response: response.choices[0].message
    return SimpleNamespace(choices=[SimpleNamespace(message=message)])


def overloaded() -> openai.InternalServerError:
    """What a busy provider answers: HTTP 503."""
    request = httpx.Request("POST", "https://llm.example/chat/completions")
    return openai.InternalServerError("overloaded", response=httpx.Response(503, request=request), body=None)


def bad_request() -> openai.BadRequestError:
    request = httpx.Request("POST", "https://llm.example/chat/completions")
    return openai.BadRequestError("bad schema", response=httpx.Response(400, request=request), body=None)


class FakeOpenAI:
    """Plays back a script, one entry per call: a response to return, or an error to raise.
    Each entry can also be a dict {model: entry} to answer differently per model.
    Every call is recorded, so tests can check exactly what the model was sent."""

    def __init__(self, script: list[Any]) -> None:
        self.script = list(script)
        self.calls: list[dict[str, Any]] = []
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    async def _create(self, **kwargs: Any) -> Any:
        # Copy the messages: the loop keeps appending to the same list afterwards.
        self.calls.append({**kwargs, "messages": json.loads(json.dumps(kwargs["messages"]))})
        if not self.script:
            raise AssertionError("The fake model was called more times than scripted")
        entry = self.script.pop(0)
        if isinstance(entry, dict):
            entry = entry[kwargs["model"]]
        if isinstance(entry, Exception):
            raise entry
        return entry


class FakeTools:
    """Tools that answer from a dict of handlers and record every call."""

    def __init__(self, handlers: dict[str, Any] | None = None) -> None:
        self.handlers = handlers or {}
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.schemas = [
            {"type": "function", "function": {"name": name, "description": "", "parameters": {"type": "object", "properties": {}}}}
            for name in self.handlers
        ]

    async def call(self, name: str, arguments: dict[str, Any]) -> ToolOutcome:
        self.calls.append((name, arguments))
        handler = self.handlers[name]
        result = handler(arguments) if callable(handler) else handler
        if isinstance(result, Exception):
            raise result
        return result


def turn_request(text: str = "Hello", logged_in: bool = True, token: str = "SECRET-AGENT-TOKEN-123") -> TurnRequest:
    return TurnRequest.model_validate(
        {
            "messages": [{"role": "user", "text": text}],
            "agentToken": token,
            "context": {
                "clinicName": "Demo Eye Clinic",
                "clinicTimezone": "Asia/Karachi",
                "today": "2030-01-01",
                "weekday": "Tuesday",
                "viewerTimezone": "Europe/London",
                "loggedIn": logged_in,
            },
        }
    )


async def no_wait(_seconds: float) -> None:
    """Replaces asyncio.sleep in tests, so retries don't actually wait."""
