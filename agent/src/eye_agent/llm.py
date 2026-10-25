"""Talking to the model: one request, with retries and a fallback model.

Any OpenAI-compatible provider works (Gemini, Ollama, LM Studio); which one is decided
by the base URL and model name in .env, never here.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

import openai

log = logging.getLogger("eye_agent.llm")

# Worth trying again: the provider is busy (503 "overloaded"), rate-limiting us (429),
# or the network hiccupped. A 400 means our request is wrong, so retrying won't help.
RETRYABLE = (openai.RateLimitError, openai.InternalServerError, openai.APIConnectionError, openai.APITimeoutError)


@dataclass
class ToolCall:
    id: str
    name: str
    # The model sends arguments as a JSON string; the loop parses it (it can be malformed).
    arguments: str


@dataclass
class Completion:
    text: str | None
    tool_calls: list[ToolCall] = field(default_factory=list)
    model: str = ""
    # The model's message exactly as the provider sent it, for the conversation history.
    assistant_message: dict[str, Any] = field(default_factory=dict)
    prompt_tokens: int = 0
    completion_tokens: int = 0


class LLMUnavailable(Exception):
    """Every model, after every retry, failed."""


class LLM:
    """One call to the model, made robust.

    For each model in order (main, then fallback): try once, and on a retryable error
    wait a little and try again, waiting longer each time ("retry with backoff"). Only
    when the main model has used up its retries do we move to the fallback.
    """

    def __init__(
        self,
        client: Any,  # openai.AsyncOpenAI, or a fake with the same shape in tests
        model: str,
        fallback_model: str | None = None,
        retry_delays: Sequence[float] = (1.0, 3.0),
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self.client = client
        self.models = [model] + ([fallback_model] if fallback_model and fallback_model != model else [])
        self.retry_delays = list(retry_delays)
        # Injected so tests don't actually wait.
        self.sleep = sleep

    async def complete(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> Completion:
        for model in self.models:
            # One first try, then one retry per delay: (1s, 3s) means up to 3 tries.
            for attempt, delay in enumerate([*self.retry_delays, None]):
                try:
                    response = await self.client.chat.completions.create(
                        model=model,
                        messages=messages,
                        tools=tools or openai.omit,
                        # Low randomness: we want the same sensible tool use every time.
                        temperature=0.2,
                    )
                except RETRYABLE as error:
                    log.warning("Model %s failed (try %d): %s", model, attempt + 1, type(error).__name__)
                    if delay is None:
                        break  # out of retries for this model: try the next one
                    await self.sleep(delay)
                    continue

                message = response.choices[0].message
                tool_calls = [
                    ToolCall(id=call.id, name=call.function.name, arguments=call.function.arguments or "{}")
                    for call in (message.tool_calls or [])
                ]
                usage = getattr(response, "usage", None)  # some providers omit it
                return Completion(
                    text=message.content,
                    tool_calls=tool_calls,
                    model=model,
                    assistant_message=_as_sent(message, tool_calls),
                    prompt_tokens=getattr(usage, "prompt_tokens", 0) or 0,
                    completion_tokens=getattr(usage, "completion_tokens", 0) or 0,
                )
        raise LLMUnavailable(f"No model answered: {', '.join(self.models)}")


def _as_sent(message: Any, tool_calls: list[ToolCall]) -> dict[str, Any]:
    """The model's message, to send back in the next request exactly as received.

    Providers may attach fields of their own that must come back untouched. Gemini's
    thinking models sign each tool call (a "thought signature") and refuse the next
    request if the signature is missing. Rebuilding the message from just the name and
    arguments would drop it, so we keep everything the provider sent.
    """
    if hasattr(message, "model_dump"):  # a real openai response object
        sent = message.model_dump(exclude_none=True)
    else:  # a plain object (test fakes): rebuild the standard fields
        sent = {
            "content": message.content,
            "tool_calls": [
                {"id": c.id, "type": "function", "function": {"name": c.name, "arguments": c.arguments}} for c in tool_calls
            ],
        }
    sent["role"] = "assistant"
    return sent


def create_client(base_url: str, api_key: str) -> openai.AsyncOpenAI:
    # max_retries=0: the library would otherwise retry on its own, hidden from us.
    # We do it ourselves above, so the fallback logic and tests see every attempt.
    return openai.AsyncOpenAI(base_url=base_url, api_key=api_key, max_retries=0, timeout=60.0)
