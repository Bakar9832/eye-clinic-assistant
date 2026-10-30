"""The agent loop, with a scripted model and fake tools."""

import json

from eye_agent.llm import LLM
from eye_agent.loop import MAX_TOOL_CALLS, TOO_MANY_STEPS, run_turn
from eye_agent.prompt import upcoming_days
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

    # default=str: unset options are sent as the library's `omit` marker, not JSON.
    everything_sent = json.dumps(fake.calls, default=str)
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


async def test_usage_is_counted_for_the_evals():
    fake = FakeOpenAI([tool_call("list_appointment_types", {}), answer("Done.")])
    tools = FakeTools({"list_appointment_types": ToolOutcome(text="{}")})

    result = await run_turn(turn_request(), llm_for(fake), tools)

    assert (result.usage.llm_calls, result.usage.tool_calls, result.usage.models) == (2, 1, ["main-model", "main-model"])


async def test_the_minimal_baseline_prompt_has_the_date_but_none_of_the_rules():
    fake = FakeOpenAI([answer("Hi")])
    await run_turn(turn_request(), llm_for(fake), FakeTools(), prompt="minimal")

    prompt = fake.calls[0]["messages"][0]["content"]
    assert "Tuesday 2030-01-01" in prompt
    assert "medical advice" not in prompt and "HARD RULES" not in prompt


async def test_the_prompt_separates_book_now_ask_first_and_offer_alternatives():
    # A 9B model asked "would you like me to book it?" even for "Book … at 3pm", so the
    # three cases are spelled out, and so is what counts as the patient's confirmation.
    fake = FakeOpenAI([answer("Hi")])
    await run_turn(turn_request(), llm_for(fake), FakeTools())

    prompt = fake.calls[0]["messages"][0]["content"]
    # Qwen 3.5 9B always stopped to ask after check_availability, so an instruction goes
    # straight to book, which checks the time itself.
    assert "Call book straight away, without check_availability" in prompt
    # Gemini 3.1 Flash-Lite booked "Can I book 2pm?" outright: a question gets its own tool.
    assert "Call propose_booking, never book" in prompt
    assert "If requested_time_free is true, say so and ask if you should book it" in prompt
    assert "offer up to four free times, the closest to what they asked for" in prompt
    assert "call book right away without asking again" in prompt
    assert "cancel it straight away. Ask only if two or more appointments could match" in prompt
    assert "check_availability with near set to that time" in prompt
    assert "Never use book to move" in prompt
    assert "Never book or move to a time the patient hasn't asked for or agreed to" in prompt
    assert "Hand each question to staff once" in prompt


def test_the_next_days_are_listed_so_the_model_never_counts_dates():
    # 2030-01-01 is a Tuesday: the list starts the next day and runs two weeks.
    days = upcoming_days("2030-01-01").split(", ")

    assert len(days) == 14
    assert days[0] == "Wed 2030-01-02"
    assert days[2] == "Fri 2030-01-04"
    assert days[-1] == "Tue 2030-01-15"


async def test_the_full_prompt_carries_the_day_list_and_the_baseline_does_not():
    fake = FakeOpenAI([answer("Hi"), answer("Hi")])
    await run_turn(turn_request(), llm_for(fake), FakeTools())
    await run_turn(turn_request(), llm_for(fake), FakeTools(), prompt="minimal")

    assert "Fri 2030-01-04" in fake.calls[0]["messages"][0]["content"]
    assert "Fri 2030-01-04" not in fake.calls[1]["messages"][0]["content"]
