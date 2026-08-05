"""
Centralized settings via pydantic-settings. Reads from environment variables
(set in docker-compose.yml / .env).
"""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Database
    database_url: str = "postgresql+psycopg2://chatrag:chatrag@localhost:5432/chatrag"

    # LiteLLM
    litellm_base_url: str = "http://localhost:4000"
    litellm_master_key: str = "sk-local-dev-key"
    default_model: str = "llama3.2"

    # OpenSearch (used starting Fase 3)
    opensearch_url: str = "http://localhost:9200"
    opensearch_index: str = "documents"

    # Embeddings model (Fase 3) — local, no API key
    embeddings_model: str = "sentence-transformers/all-MiniLM-L6-v2"

    # Auth (Fase 2 — stubbed for now)
    auth_enabled: bool = False


settings = Settings()
