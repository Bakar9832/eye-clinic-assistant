"""The shapes of what the clinic API sends the agent and what it gets back.

These mirror AgentTurnRequest / AgentTurnResponse in api/src/chat/agent-client.ts.
The JSON uses camelCase (agentToken); Python uses snake_case (agent_token). The
alias generator translates between them, so each side keeps its own style.
"""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class ApiModel(BaseModel):
    # Read and write JSON in camelCase; let Python code use snake_case names.
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class Message(ApiModel):
    role: Literal["user", "assistant"]
    text: str


class TurnContext(ApiModel):
    """Facts for the system prompt. The model needs today's date to turn
    "next Monday" into a date; the clinic's zone says what "9am" means."""

    clinic_name: str
    clinic_timezone: str
    today: str  # e.g. "2030-01-01", in clinic time
    weekday: str  # e.g. "Tuesday"
    viewer_timezone: str
    logged_in: bool


class TurnRequest(ApiModel):
    messages: list[Message] = Field(min_length=1)
    # Passed to the MCP server in a header. Never put into anything the model sees.
    agent_token: str
    context: TurnContext


class TurnResponse(ApiModel):
    reply: str
    # Shown by the web page next to the reply (ticket, doctor's note, date-of-birth box).
    cards: list[dict[str, Any]] = []
