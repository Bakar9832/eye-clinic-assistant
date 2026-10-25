"""The agent as a web service: the clinic API sends a turn to POST /turn.

Run with:  uvicorn eye_agent.app:create_app --factory --port 8001
"""

import logging
import secrets
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from typing import Annotated

from fastapi import FastAPI, Header, HTTPException

from .config import Settings
from .llm import LLM, LLMUnavailable, create_client
from .loop import run_turn
from .models import TurnRequest, TurnResponse
from .tools import McpToolBox, ToolBox

# Given the token for one turn, opens that turn's tool connection.
OpenTools = Callable[[str], AbstractAsyncContextManager[ToolBox]]


def create_app(settings: Settings | None = None, llm: LLM | None = None, open_tools: OpenTools | None = None) -> FastAPI:
    """Builds the app. Tests pass a fake model and fake tools; for real use everything
    comes from .env. A function instead of a module-level `app = FastAPI()` means
    importing this file has no side effects (like needing a .env)."""
    logging.basicConfig(level=logging.INFO)
    settings = settings or Settings()  # reads .env; stops here if something is missing
    llm = llm or LLM(create_client(settings.llm_base_url, settings.llm_api_key), settings.llm_model, settings.llm_fallback_model)
    mcp_url = settings.clinic_api_url.rstrip("/") + "/mcp"
    open_tools = open_tools or (lambda token: McpToolBox.open(mcp_url, token))

    app = FastAPI(title="Eye Clinic agent", docs_url=None, redoc_url=None)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/turn", response_model=TurnResponse, response_model_by_alias=True)
    async def turn(
        request: TurnRequest,
        x_agent_service_key: Annotated[str | None, Header()] = None,
    ) -> TurnResponse:
        # Only the clinic API may run turns. compare_digest takes the same time
        # whether the key is nearly right or completely wrong.
        if x_agent_service_key is None or not secrets.compare_digest(x_agent_service_key, settings.agent_service_key):
            raise HTTPException(status_code=401, detail="Unknown caller")

        try:
            async with open_tools(request.agent_token) as tools:
                result = await run_turn(request, llm, tools, prompt=settings.agent_prompt)
        except LLMUnavailable as error:
            # The API turns this into "The assistant is unavailable right now".
            raise HTTPException(status_code=503, detail="The language model is unavailable") from error

        return TurnResponse(reply=result.reply, cards=result.cards, usage=result.usage)

    return app
