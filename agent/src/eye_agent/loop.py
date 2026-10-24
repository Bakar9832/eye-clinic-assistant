"""The agent loop: ask the model, run the tools it asks for, repeat until it answers.

This is what makes it an agent rather than a chatbot. A chatbot answers once. An agent
can decide "I need to check availability first", act, read the result, and decide again.
"""

import json
import logging
from dataclasses import dataclass, field
from typing import Any

from .llm import LLM
from .models import TurnRequest
from .prompt import build_system_prompt
from .tools import ToolBox

log = logging.getLogger("eye_agent.loop")

# A guard against a model that keeps calling tools without ever answering.
MAX_TOOL_CALLS = 8

TOO_MANY_STEPS = (
    "Sorry, I couldn't finish that. Could you say it again more simply, "
    "or would you like me to pass it to a member of staff?"
)


@dataclass
class TurnResult:
    reply: str
    cards: list[dict[str, Any]] = field(default_factory=list)
    tool_calls: int = 0


async def run_turn(request: TurnRequest, llm: LLM, tools: ToolBox, max_tool_calls: int = MAX_TOOL_CALLS) -> TurnResult:
    # 1. What the model reads: the rules, then the conversation so far.
    #    Note what's NOT here: the agent token. It stays inside `tools`.
    messages: list[dict[str, Any]] = [{"role": "system", "content": build_system_prompt(request.context)}]
    messages += [{"role": m.role, "content": m.text} for m in request.messages]

    cards: list[dict[str, Any]] = []
    calls = 0

    while True:
        # 2. Ask the model. It either answers, or asks for one or more tools.
        completion = await llm.complete(messages, tools.schemas)

        if not completion.tool_calls:
            # 3a. An answer: the turn is done.
            return TurnResult(reply=(completion.text or "").strip(), cards=cards, tool_calls=calls)

        # 3b. Tool requests. The model's request goes into the history first, so it can
        #     match each result to what it asked for (by the call's id). It goes in
        #     exactly as the provider sent it: see llm._as_sent for why.
        messages.append(completion.assistant_message)

        for call in completion.tool_calls:
            if calls >= max_tool_calls:
                log.warning("Stopped after %d tool calls", calls)
                return TurnResult(reply=TOO_MANY_STEPS, cards=cards, tool_calls=calls)
            calls += 1

            # 4. Run the tool. Problems become results the model can read and react to
            #    ("that time is taken"), not crashes that end the conversation.
            try:
                arguments = json.loads(call.arguments or "{}")
                if not isinstance(arguments, dict):
                    raise ValueError("arguments must be a JSON object")
            except (json.JSONDecodeError, ValueError) as error:
                content = json.dumps({"error": "INVALID_ARGUMENTS", "message": f"Could not read the arguments: {error}"})
            else:
                try:
                    outcome = await tools.call(call.name, arguments)
                    content = outcome.text
                    # Cards go to the page, never back to the model.
                    cards += outcome.cards
                except Exception as error:  # a broken connection, not a refusal
                    log.exception("Tool %s failed", call.name)
                    content = json.dumps({"error": "TOOL_FAILED", "message": f"{call.name} is unavailable right now ({type(error).__name__})."})

            messages.append({"role": "tool", "tool_call_id": call.id, "content": content})
        # 5. Loop: the model now reads the results and decides what to do next.
