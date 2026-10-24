"""The web service around the loop: who may call it, and what it returns."""

from contextlib import asynccontextmanager

from fastapi.testclient import TestClient

from eye_agent.app import create_app
from eye_agent.config import Settings
from eye_agent.llm import LLM
from eye_agent.tools import ToolOutcome, to_openai_tool

from .fakes import FakeOpenAI, FakeTools, answer, no_wait, overloaded, tool_call, turn_request

KEY = "test-service-key"


def make_client(script, tools: FakeTools, seen_tokens: list[str] | None = None) -> TestClient:
    settings = Settings(
        _env_file=None,
        llm_base_url="http://unused",
        llm_api_key="unused",
        llm_model="main",
        agent_service_key=KEY,
    )

    @asynccontextmanager
    async def open_tools(token: str):
        if seen_tokens is not None:
            seen_tokens.append(token)
        yield tools

    llm = LLM(FakeOpenAI(script), "main", sleep=no_wait)
    return TestClient(create_app(settings, llm=llm, open_tools=open_tools))


def body(text: str = "Hello") -> dict:
    return turn_request(text).model_dump(by_alias=True)


def test_only_the_clinic_api_may_run_turns():
    client = make_client([answer("Hi")], FakeTools())
    assert client.post("/turn", json=body()).status_code == 401
    assert client.post("/turn", json=body(), headers={"X-Agent-Service-Key": "wrong"}).status_code == 401
    assert client.post("/turn", json=body(), headers={"X-Agent-Service-Key": KEY}).status_code == 200


def test_a_turn_returns_the_reply_and_the_cards_and_uses_the_turn_token_for_tools():
    card = {"type": "ticket", "reference": "EC-ABC234"}
    tools = FakeTools({"book": ToolOutcome(text='{"status": "BOOKED"}', cards=[card])})
    seen: list[str] = []
    client = make_client([tool_call("book", {"type": "FOLLOW_UP"}), answer("Booked: EC-ABC234.")], tools, seen)

    res = client.post("/turn", json=body("Book me"), headers={"X-Agent-Service-Key": KEY})

    assert res.status_code == 200
    assert res.json() == {"reply": "Booked: EC-ABC234.", "cards": [card]}
    assert seen == ["SECRET-AGENT-TOKEN-123"]


def test_when_no_model_answers_the_api_gets_503():
    client = make_client([overloaded()] * 3, FakeTools())
    res = client.post("/turn", json=body(), headers={"X-Agent-Service-Key": KEY})
    assert res.status_code == 503


def test_tool_schemas_are_simplified_for_model_providers():
    schema = {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "date": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$", "description": "YYYY-MM-DD"},
        },
        "required": ["date"],
    }
    tool = to_openai_tool("book", "Book it", schema)

    assert tool == {
        "type": "function",
        "function": {
            "name": "book",
            "description": "Book it",
            "parameters": {
                "type": "object",
                "properties": {"date": {"type": "string", "description": "YYYY-MM-DD"}},
                "required": ["date"],
            },
        },
    }
