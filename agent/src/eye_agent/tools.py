"""The clinic's tools, reached over MCP with the turn's agent token.

The token goes in the HTTP Authorization header and nowhere else. The model sees the
tools' names, descriptions and input schemas, and each tool's answer for the model.
It never sees the token, and it never sees the "cards" meant for the web page.
"""

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, Protocol

from mcp import ClientSession
from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client


@dataclass
class ToolOutcome:
    text: str  # the tool's answer, for the model
    cards: list[dict[str, Any]] = field(default_factory=list)  # for the web page only
    is_error: bool = False


class ToolBox(Protocol):
    """Anything that can list tools and call them. The loop only needs this much,
    so tests can pass a fake instead of a real MCP connection."""

    schemas: list[dict[str, Any]]

    async def call(self, name: str, arguments: dict[str, Any]) -> ToolOutcome: ...


# JSON-schema keywords the model providers accept in a tool definition. Others
# (like "$schema") can make some providers reject the whole request. The MCP server
# still enforces the full schema, including "no unknown fields", on every call.
_KEEP = {"type", "description", "properties", "required", "enum", "items", "format"}


def _simplify(schema: Any) -> Any:
    if isinstance(schema, list):
        return [_simplify(item) for item in schema]
    if not isinstance(schema, dict):
        return schema
    out = {key: value for key, value in schema.items() if key in _KEEP}
    if "properties" in out:
        out["properties"] = {name: _simplify(sub) for name, sub in out["properties"].items()}
    if "items" in out:
        out["items"] = _simplify(out["items"])
    return out


def to_openai_tool(name: str, description: str | None, input_schema: dict[str, Any]) -> dict[str, Any]:
    """An MCP tool, in the format OpenAI-compatible APIs expect."""
    parameters = _simplify(input_schema) or {"type": "object", "properties": {}}
    parameters.setdefault("type", "object")
    parameters.setdefault("properties", {})
    return {"type": "function", "function": {"name": name, "description": description or "", "parameters": parameters}}


class McpToolBox:
    """A live MCP connection for one chat turn."""

    def __init__(self, session: ClientSession, schemas: list[dict[str, Any]]) -> None:
        self.session = session
        self.schemas = schemas

    @classmethod
    @asynccontextmanager
    async def open(cls, mcp_url: str, agent_token: str) -> AsyncIterator["McpToolBox"]:
        """Connects for the length of an `async with` block, then closes everything.

        `async with` guarantees the clean-up runs even if the turn fails halfway.
        """
        http = create_mcp_http_client(headers={"Authorization": f"Bearer {agent_token}"})
        async with http:
            # terminate_on_close=False: the clinic's MCP server keeps no sessions to end.
            async with streamable_http_client(mcp_url, http_client=http, terminate_on_close=False) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    listed = await session.list_tools()
                    schemas = [to_openai_tool(t.name, t.description, t.input_schema) for t in listed.tools]
                    yield cls(session, schemas)

    async def call(self, name: str, arguments: dict[str, Any]) -> ToolOutcome:
        result = await self.session.call_tool(name, arguments)
        text = "\n".join(part.text for part in result.content if getattr(part, "type", None) == "text")
        # Cards travel in the result's _meta, beside the content the model reads.
        cards = (result.meta or {}).get("cards", [])
        return ToolOutcome(text=text or json.dumps({"status": "OK"}), cards=list(cards), is_error=bool(result.is_error))
