#!/usr/bin/env python3
# /// script
# dependencies = [
#     "httpx>=0.28.1",
#     "openai>=2.14.0",
#     "pydantic>=2.12.5",
#     "pydantic-settings>=2.12.0",
#     "rich>=14.2.0",
# ]
# ///
import asyncio
import base64
import datetime as dt
import json
import random
import re
from pathlib import Path
from typing import Annotated

import httpx
from openai import AsyncOpenAI, OpenAIError
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from rich.console import Console
from rich.progress import Progress, SpinnerColumn, TextColumn

console = Console()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    openai_api_key: str = Field(..., description="OpenAI API Key")
    openai_base_url: str | None = Field(None, description="OpenAI Base URL")


class AppConfig(BaseSettings):
    """
    Application configuration via CLI args or environment variables.
    Note: We are parsing CLI args manually into this model in main() for simplicity in this single-file script,
    or we could use a library like Typer for a full CLI experience.
    For now, we'll stick to argparse for the interface to keep it similar to the original,
    but use Pydantic for validation.
    """

    prompt: str | None = Field(None, description="Single prompt to generate")
    count: int = Field(8, ge=1, le=50, description="How many images to generate")
    model: str = Field("gpt-image-1-mini", description="Image model ID")
    size: str = Field("1024x1024", description="Image size")
    quality: str = Field("high", description="Image quality")
    out_dir: Path | None = Field(None, description="Output directory")


def slugify(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    text = re.sub(r"-{2,}", "-", text).strip("-")
    return text or "image"


def default_out_dir() -> Path:
    now = dt.datetime.now().strftime("%Y-%m-%d-%H-%M-%S")
    preferred = Path.home() / "Projects" / "tmp"
    base = preferred if preferred.is_dir() else Path("./tmp")
    base.mkdir(parents=True, exist_ok=True)
    return base / f"openai-image-gen-{now}"


def pick_prompts(count: int) -> list[str]:
    subjects = [
        "a lobster astronaut",
        "a brutalist lighthouse",
        "a cozy reading nook",
        "a cyberpunk noodle shop",
        "a Vienna street at dusk",
        "a minimalist product photo",
        "a surreal underwater library",
        "a futuristic solarpunk city",
        "a retro vaporwave landscape",
    ]
    styles = [
        "ultra-detailed studio photo",
        "35mm film still",
        "isometric illustration",
        "editorial photography",
        "soft watercolor",
        "architectural render",
        "high-contrast monochrome",
        "low-poly 3d render",
        "oil painting",
    ]
    lighting = [
        "golden hour",
        "overcast soft light",
        "neon lighting",
        "dramatic rim light",
        "candlelight",
        "foggy atmosphere",
        "bioluminescent glow",
    ]
    prompts: list[str] = []
    for _ in range(count):
        prompts.append(
            f"{random.choice(styles)} of {random.choice(subjects)}, {random.choice(lighting)}"
        )
    return prompts


async def request_image(
    client: AsyncOpenAI,
    http_client: httpx.AsyncClient,
    prompt: str,
    idx: int,
    config: "AppConfig",
    out_dir: Path,
    progress: Progress,
    task_id: int,
) -> dict | None:
    try:
        progress.update(task_id, description=f"Generating [{idx}]: {prompt[:40]}...")
        
        # Determine if we should use response_format based on model
        # gpt-image-1-mini might not support b64_json yet or the response_format param
        params = {
            "model": config.model,
            "prompt": prompt,
            "size": config.size,  # type: ignore
            "quality": config.quality,  # type: ignore
            "n": 1,
        }
        
        # gpt-image-1* models don't support response_format; only dall-e-* does
        if config.model.startswith("dall-e"):
            params["response_format"] = "b64_json"

        response = await client.images.generate(**params)
        
        res_dict = response.model_dump()
        data_item = res_dict.get("data", [{}])[0]
        b64 = data_item.get("b64_json")
        url = data_item.get("url")
        
        filename = f"{idx:03d}-{slugify(prompt)[:40]}.png"
        
        if b64:
            png = base64.b64decode(b64)
            (out_dir / filename).write_bytes(png)
        elif url:
            resp = await http_client.get(url, follow_redirects=True)
            resp.raise_for_status()
            (out_dir / filename).write_bytes(resp.content)
        else:
            console.print(f"[red]Warning:[/red] No image data returned for: {prompt[:20]}...")
            return None

        progress.advance(task_id)
        return {"prompt": prompt, "file": filename}

    except OpenAIError as e:
        console.print(f"[bold red]OpenAI Error for image {idx}:[/bold red] {e}")
    except Exception as e:
        console.print(f"[bold red]Error for image {idx}:[/bold red] {e}")
    
    progress.advance(task_id)
    return None


def write_gallery(out_dir: Path, items: list[dict]) -> None:
    thumbs = "\n".join(
        [
            f"""
<figure>
  <a href="{it["file"]}"><img src="{it["file"]}" loading="lazy" /></a>
  <figcaption>{it["prompt"]}</figcaption>
</figure>
""".strip()
            for it in items
        ]
    )
    html = f"""<!doctype html>
<meta charset="utf-8" />
<title>openai-image-gen</title>
<style>
  :root {{ color-scheme: dark; }}
  body {{ margin: 24px; font: 14px/1.4 ui-sans-serif, system-ui; background: #0b0f14; color: #e8edf2; }}
  h1 {{ font-size: 18px; margin: 0 0 16px; }}
  .grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }}
  figure {{ margin: 0; padding: 12px; border: 1px solid #1e2a36; border-radius: 14px; background: #0f1620; }}
  img {{ width: 100%; height: auto; border-radius: 10px; display: block; }}
  figcaption {{ margin-top: 10px; color: #b7c2cc; word-wrap: break-word; }}
  code {{ color: #9cd1ff; }}
</style>
<h1>openai-image-gen</h1>
<p>Output: <code>{out_dir.as_posix()}</code></p>
<div class="grid">
{thumbs}
</div>
"""
    (out_dir / "index.html").write_text(html, encoding="utf-8")


async def async_main() -> int:
    import argparse

    # 1. Load Settings
    try:
        settings = Settings()
    except Exception as e:
        console.print(f"[bold red]Configuration Error:[/bold red] {e}")
        console.print("Please set [bold]OPENAI_API_KEY[/bold] environment variable.")
        return 1

    # 2. Parse CLI Args
    ap = argparse.ArgumentParser(description="Generate images via OpenAI Images API.")
    ap.add_argument("--prompt", help="Single prompt. If omitted, random prompts are generated.")
    ap.add_argument("--count", type=int, default=8, help="How many images to generate.")
    ap.add_argument(
        "--model", default="gpt-image-1-mini", help="Image model id (default: gpt-image-1-mini)."
    )
    ap.add_argument(
        "--size",
        default="1024x1024",
        help="Image size (e.g. 1024x1024, 1536x1024). Default depends on model.",
    )
    ap.add_argument(
        "--quality", default="high", help="Image quality (low, medium, high, auto). Default: high."
    )
    ap.add_argument(
        "--out-dir", default="", help="Output directory (default: ./tmp/openai-image-gen-<ts>)."
    )
    args = ap.parse_args()

    # 3. Validate Config
    try:
        config = AppConfig(
            prompt=args.prompt,
            count=args.count,
            model=args.model,
            size=args.size,
            quality=args.quality,
            out_dir=Path(args.out_dir) if args.out_dir else None,
        )
    except Exception as e:
        console.print(f"[bold red]Invalid Arguments:[/bold red] {e}")
        return 2

    # 4. Initialize Client
    client = AsyncOpenAI(api_key=settings.openai_api_key, base_url=settings.openai_base_url)

    # 5. Prepare Output
    out_dir = config.out_dir if config.out_dir else default_out_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    console.print(f"[green]Output directory:[/green] {out_dir}")

    # 6. Generate Images
    prompts = [config.prompt] * config.count if config.prompt else pick_prompts(config.count)
    
    async with httpx.AsyncClient() as http_client:
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            transient=True,
        ) as progress:
            task_id = progress.add_task("Generating images...", total=len(prompts))
            
            tasks = [
                request_image(client, http_client, prompt, idx, config, out_dir, progress, task_id)
                for idx, prompt in enumerate(prompts, start=1)
            ]
            results = await asyncio.gather(*tasks)
            items = [r for r in results if r is not None]

    # 7. Write Gallery
    (out_dir / "prompts.json").write_text(json.dumps(items, indent=2), encoding="utf-8")
    write_gallery(out_dir, items)
    console.print(f"\n[bold green]Gallery created:[/bold green] {(out_dir / 'index.html').as_posix()}")
    return 0


def main():
    return asyncio.run(async_main())


if __name__ == "__main__":
    import sys
    sys.exit(main())

