"""Settings, read from the repo's shared .env file (or real environment variables).

Nothing about the model provider is written in code: switching from Gemini to Ollama
or LM Studio means changing LLM_BASE_URL and LLM_MODEL in .env.
"""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# This file is agent/src/eye_agent/config.py, so the repo root is three folders up.
ENV_FILE = Path(__file__).resolve().parents[3] / ".env"


class Settings(BaseSettings):
    """Each field is filled from the variable with the same name in capitals,
    e.g. llm_model <- LLM_MODEL. A missing required one stops the agent at start-up
    with a clear message, instead of failing later in the middle of a chat."""

    # extra="ignore": .env also holds the API's settings, which the agent doesn't use.
    model_config = SettingsConfigDict(env_file=ENV_FILE, extra="ignore")

    llm_base_url: str
    llm_api_key: str
    llm_model: str
    # Optional: tried when the main model keeps failing.
    llm_fallback_model: str | None = None

    # Only the clinic API may ask the agent to run a turn; it proves it with this key.
    agent_service_key: str
    # The agent reaches the tools at {clinic_api_url}/mcp.
    clinic_api_url: str = "http://localhost:3000"
