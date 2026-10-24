"""The agent loop, with a scripted model and fake tools."""

import json

from eye_agent.llm import LLM
from eye_agent.loop import MAX_TOOL_CALLS, TOO_MANY_STEPS, run_turn
from eye_agent.tools import ToolOutcome

from .fakes import FakeOpenAI, FakeTools, answer, no_wait, tool_call, turn_request


def llm_for(fake: FakeOpenAI) -> LLM:
    return LLM(fake, "main-model", sleep=no_wait)


async def test_p1_calls_the_tool_the_model_asks_for_then_returns_its_answer():
    fake = FakeOpenAI(
        [
            tool_call("check_availability", {"type": "FOLLOW_UP", "date_from": "2030-01-07"}),
            answer("Dr Ayesha is free at 09:00 on Monday."),
        ]
    )
    tools = FakeTools({"check_availability": ToolOutcome(text='{"days": []}')})

    result = await run_turn(turn_request("Is Dr Ayesha free on Monday?"), llm_for(fake), tools)

    assert result.reply == "Dr Ayesha is free at 09:00 on Monday."
    assert tools.calls == [("check_availability", {"type": "FOLLOW_UP", "date_from": "2030-01-07"})]
    # The second time, the model sees its own request and the tool's answer, linked by id.
    second = fake.calls[1]["messages"]
    assert second[-2]["tool_calls"][0]["id"] == "call_1"
    assert second[-1] == {"role": "tool", "tool_call_id": "call_1", "content": '{"days": []}'}


async def test_p2_a_model_that_keeps_calling_tools_is_stopped_politely():
    fake = FakeOpenAI([tool_call("list_appointment_types", {}, call_id=f"c{i}") for i in range(20)])
    tools = FakeTools({"list_appointment_types": ToolOutcome(text="{}")})

    result = await run_turn(turn_request(), llm_for(fake), tools)

    assert len(tools.calls) == MAX_TOOL_CALLS
    assert result.reply == TOO_MANY_STEPS


async def test_p3_a_tool_refusal_goes_back_to_the_model_to_explain():
    refusal = json.dumps({"error": "INVALID_SLOT", "reasons": [{"code": "NOT_AVAILABLE"}]})
    fake = FakeOpenAI([tool_call("book", {"type": "FOLLOW_UP", "date": "2030-01-07", "time": "09:00"}), answer("Sorry, 09:00 is taken.")])
    tools = FakeTools({"book": ToolOutcome(text=refusal, is_error=True)})

    result = await run_turn(turn_request(), llm_for(fake), tools)

    assert result.reply == "Sorry, 09:00 is taken."
    assert fake.calls[1]["messages"][-1]["content"] == refusal


async def test_p3b_a_broken_tool_connection_is_reported_to_the_model_not_crashed_on():
    fake = FakeOpenAI([tool_call("get_my_appointments", {}), answer("I can't reach your appointments right now.")])
    tools = FakeTools({"get_my_appointments": ConnectionError("reset")})

    result = await run_turn(turn_request(), llm_for(fake), tools)

    assert result.reply == "I can't reach your appointments right now."
    assert json.loads(fake.calls[1]["messages"][-1]["content"])["error"] == "TOOL_FAILED"


async def test_p3c_malformed_arguments_are_reported_and_the_tool_is_not_called():
    fake = FakeOpenAI([tool_call("book", "{not json"), answer("Let me try that again.")])
    tools = FakeTools({"book": ToolOutcome(text="{}")})

    await run_turn(turn_request(), llm_for(fake), tools)

    assert tools.calls == []
    assert json.loads(fake.calls[1]["messages"][-1]["content"])["error"] == "INVALID_ARGUMENTS"


async def test_p4_the_agent_token_and_the_cards_never_reach_the_model():
    note_card = {"type": "doctor_note", "note": "PRIVATE NOTE FROM THE DOCTOR"}
    fake = FakeOpenAI([tool_call("get_my_outcome", {}), answer("Your results are in; they're shown above.")])
    tools = FakeTools({"get_my_outcome": ToolOutcome(text='{"status": "READY"}', cards=[note_card])})
    request = turn_request("Are my results in?", token="SECRET-AGENT-TOKEN-123")

    result = await run_turn(request, llm_for(fake), tools)

    everything_sent = json.dumps(fake.calls)
    assert "SECRET-AGENT-TOKEN-123" not in everything_sent
    assert "PRIVATE NOTE FROM THE DOCTOR" not in everything_sent
    # ...but the page still gets the card.
    assert result.cards == [note_card]


async def test_p7_the_system_prompt_carries_the_date_the_zones_and_the_rules():
    fake = FakeOpenAI([answer("Hi")])
    await run_turn(turn_request(logged_in=False), llm_for(fake), FakeTools())

    system = fake.calls[0]["messages"][0]
    assert system["role"] == "system"
    prompt = system["content"]
    assert "Tuesday 2030-01-01" in prompt
    assert "Asia/Karachi" in prompt and "Europe/London" in prompt
    assert "not logged in" in prompt
    for rule in ["No medical advice", "Never interpret results", "emergency department", "Never ask for it in the chat"]:
        assert rule in prompt, rule


async def test_the_models_own_message_goes_back_exactly_as_the_provider_sent_it():
    """Gemini signs tool calls ("thought signatures") and refuses the next request
    if the signature doesn't come back. Found in the first real run against Gemini."""

    class ProviderMessage:
        """Like an openai response message, with a provider-specific extra field."""

        content = None
        tool_calls = [tool_call("list_appointment_types", {}).choices[0].message.tool_calls[0]]

        def model_dump(self, exclude_none: bool = False) -> dict:
            return {
                "role": "assistant",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "list_appointment_types", "arguments": "{}"},
                        "extra_content": {"google": {"thought_signature": "SIGNED-BY-GEMINI"}},
                    }
                ],
            }

    from types import SimpleNamespace

    first = SimpleNamespace(choices=[SimpleNamespace(message=ProviderMessage())])
    fake = FakeOpenAI([first, answer("We offer eight kinds of appointment.")])
    tools = FakeTools({"list_appointment_types": ToolOutcome(text="{}")})

    await run_turn(turn_request(), llm_for(fake), tools)

    echoed = fake.calls[1]["messages"][-2]
    assert echoed["tool_calls"][0]["extra_content"] == {"google": {"thought_signature": "SIGNED-BY-GEMINI"}}
