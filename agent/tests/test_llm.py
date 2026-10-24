"""Retries, backoff and the fallback model; settings from the environment."""

import openai
import pytest

from eye_agent.config import Settings
from eye_agent.llm import LLM, LLMUnavailable, create_client

from .fakes import FakeOpenAI, answer, bad_request, overloaded


class Sleeps:
    """Records how long the LLM asked to wait, without waiting."""

    def __init__(self) -> None:
        self.waited: list[float] = []

    async def __call__(self, seconds: float) -> None:
        self.waited.append(seconds)


async def test_p6b_overloaded_twice_then_fine_the_main_model_answers_and_the_fallback_is_untouched():
    fake = FakeOpenAI([overloaded(), overloaded(), answer("Hello")])
    sleeps = Sleeps()
    llm = LLM(fake, "main", "fallback", retry_delays=(1.0, 3.0), sleep=sleeps)

    completion = await llm.complete([{"role": "user", "content": "Hi"}], [])

    assert completion.text == "Hello"
    assert completion.model == "main"
    assert [c["model"] for c in fake.calls] == ["main", "main", "main"]
    assert sleeps.waited == [1.0, 3.0]  # backoff: each wait longer than the last


async def test_p6_when_the_main_model_keeps_failing_the_fallback_answers():
    fake = FakeOpenAI([overloaded(), overloaded(), overloaded(), answer("From the fallback")])
    llm = LLM(fake, "main", "fallback", sleep=Sleeps())

    completion = await llm.complete([{"role": "user", "content": "Hi"}], [])

    assert completion.model == "fallback"
    assert [c["model"] for c in fake.calls] == ["main", "main", "main", "fallback"]


async def test_p6c_when_every_model_fails_the_caller_is_told():
    fake = FakeOpenAI([overloaded()] * 6)
    llm = LLM(fake, "main", "fallback", sleep=Sleeps())

    with pytest.raises(LLMUnavailable):
        await llm.complete([{"role": "user", "content": "Hi"}], [])
    assert len(fake.calls) == 6


async def test_a_bad_request_is_not_retried():
    # A 400 means our request is wrong; sending it again won't help.
    fake = FakeOpenAI([bad_request()])
    llm = LLM(fake, "main", "fallback", sleep=Sleeps())

    with pytest.raises(openai.BadRequestError):
        await llm.complete([{"role": "user", "content": "Hi"}], [])
    assert len(fake.calls) == 1


async def test_tools_are_sent_when_there_are_some_and_left_out_when_not():
    fake = FakeOpenAI([answer("a"), answer("b")])
    llm = LLM(fake, "main")
    tool = {"type": "function", "function": {"name": "x", "parameters": {"type": "object", "properties": {}}}}

    await llm.complete([], [tool])
    await llm.complete([], [])

    assert fake.calls[0]["tools"] == [tool]
    assert fake.calls[1]["tools"] is openai.omit


def test_p5_the_model_comes_only_from_settings_so_switching_is_a_config_change(monkeypatch):
    for name, value in {
        "LLM_BASE_URL": "http://localhost:11434/v1",
        "LLM_API_KEY": "ollama",
        "LLM_MODEL": "qwen3:14b",
        "AGENT_SERVICE_KEY": "k",
    }.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("LLM_FALLBACK_MODEL", raising=False)

    ollama = Settings(_env_file=None)
    client = create_client(ollama.llm_base_url, ollama.llm_api_key)

    assert str(client.base_url) == "http://localhost:11434/v1/"
    assert LLM(client, ollama.llm_model, ollama.llm_fallback_model).models == ["qwen3:14b"]

    monkeypatch.setenv("LLM_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai/")
    monkeypatch.setenv("LLM_MODEL", "gemini-3.5-flash-lite")
    monkeypatch.setenv("LLM_FALLBACK_MODEL", "gemini-3.1-flash-lite")
    gemini = Settings(_env_file=None)

    assert gemini.llm_base_url.startswith("https://generativelanguage.googleapis.com")
    assert LLM(client, gemini.llm_model, gemini.llm_fallback_model).models == ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]


def test_settings_refuse_to_start_without_a_model(monkeypatch):
    for name in ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "AGENT_SERVICE_KEY"]:
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(Exception, match="llm_model"):
        Settings(_env_file=None)
