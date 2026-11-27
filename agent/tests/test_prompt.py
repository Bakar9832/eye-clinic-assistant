"""The system prompt's guardrail rules and the urgent-symptoms block."""

from eye_agent.models import TurnContext
from eye_agent.prompt import build_system_prompt


def context(**overrides) -> TurnContext:
    values = {
        "clinicName": "Eye Clinic",
        "clinicTimezone": "Asia/Karachi",
        "today": "2030-01-07",
        "weekday": "Monday",
        "viewerTimezone": "Asia/Karachi",
        "loggedIn": True,
    }
    values.update(overrides)
    return TurnContext.model_validate(values)


def test_urgent_block_only_when_the_api_says_so():
    calm = build_system_prompt(context())
    urgent = build_system_prompt(context(urgentSymptoms=True))

    assert "URGENT SYMPTOMS were mentioned" not in calm
    assert "URGENT SYMPTOMS were mentioned" in urgent
    assert "emergency department now" in urgent
    assert "staff have been told" in urgent


def test_urgent_flag_defaults_to_false_for_older_callers():
    assert context().urgent_symptoms is False
    assert context().stalled is False


def test_stalled_block_only_when_the_api_says_so():
    assert "WITHOUT PROGRESS" not in build_system_prompt(context())
    stalled = build_system_prompt(context(stalled=True))
    assert "WITHOUT PROGRESS" in stalled
    assert "sum up where things stand" in stalled
    assert "call back" in stalled


def test_guardrail_rules_are_in_the_prompt():
    prompt = build_system_prompt(context())

    assert "ONLY EYE CARE" in prompt
    assert "book only the eye part" in prompt
    assert "request_callback" in prompt
    assert "suggest_callback" in prompt
    assert "Patients can't book urgent visits" in prompt
    assert "no priority" in prompt
    # The old rule sent patients to an urgent slot they can no longer book.
    assert "earliest URGENT_VISIT" not in prompt
    # Times are tappable buttons on the page: no bulleted lists of them.
    assert "never as a bulleted list" in prompt


def test_prompt_asks_for_light_formatting_only():
    # The web renders light markdown (bold, lists); headings and tables would look heavy.
    assert "No headings, no tables." in build_system_prompt(context())
