#!/usr/bin/env python3
"""Generate images with the Gemini API without storing the API key in code."""

from __future__ import annotations

import argparse
import base64
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


API_ROOT = "https://generativelanguage.googleapis.com/v1/models"
DEFAULT_MODEL = "gemini-3.1-flash-lite-image"
VALID_RATIOS = {
    "1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3",
    "4:5", "5:4", "8:1", "9:16", "16:9", "21:9",
}
RATIO_ENUMS = {
    "1:1": "ASPECT_RATIO_ONE_BY_ONE",
    "1:4": "ASPECT_RATIO_ONE_BY_FOUR",
    "1:8": "ASPECT_RATIO_ONE_BY_EIGHT",
    "2:3": "ASPECT_RATIO_TWO_BY_THREE",
    "3:2": "ASPECT_RATIO_THREE_BY_TWO",
    "3:4": "ASPECT_RATIO_THREE_BY_FOUR",
    "4:1": "ASPECT_RATIO_FOUR_BY_ONE",
    "4:3": "ASPECT_RATIO_FOUR_BY_THREE",
    "4:5": "ASPECT_RATIO_FOUR_BY_FIVE",
    "5:4": "ASPECT_RATIO_FIVE_BY_FOUR",
    "8:1": "ASPECT_RATIO_EIGHT_BY_ONE",
    "9:16": "ASPECT_RATIO_NINE_BY_SIXTEEN",
    "16:9": "ASPECT_RATIO_SIXTEEN_BY_NINE",
    "21:9": "ASPECT_RATIO_TWENTY_ONE_BY_NINE",
}


def ssl_context() -> ssl.SSLContext:
    """Use certifi's CA bundle when Python.org's default CA store is missing."""
    try:
        import certifi  # type: ignore[import-not-found]
    except ImportError:
        return ssl.create_default_context()
    return ssl.create_default_context(cafile=certifi.where())


def slug(text: str, limit: int = 48) -> str:
    clean = "".join(char.lower() if char.isalnum() else "-" for char in text)
    return "-".join(filter(None, clean.split("-")))[:limit] or "image"


def request_image(api_key: str, model: str, prompt: str, ratio: str, retries: int) -> dict:
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseModalities": ["IMAGE"],
            "responseFormat": {"image": {"aspectRatio": RATIO_ENUMS[ratio]}},
        },
    }
    request = urllib.request.Request(
        f"{API_ROOT}/{model}:generateContent",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": api_key,
        },
        method="POST",
    )

    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(request, timeout=180, context=ssl_context()) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            if error.code in {429, 500, 502, 503, 504} and attempt < retries:
                time.sleep(2 ** attempt)
                continue
            try:
                message = json.loads(detail)["error"]["message"]
            except (KeyError, TypeError, json.JSONDecodeError):
                message = detail or str(error)
            raise RuntimeError(f"Gemini API HTTP {error.code}: {message}") from error
        except urllib.error.URLError as error:
            if attempt < retries:
                time.sleep(2 ** attempt)
                continue
            raise RuntimeError(f"Không kết nối được Gemini API: {error.reason}") from error

    raise RuntimeError("Gemini API không phản hồi")


def save_response(response: dict, output_dir: Path, prompt: str, index: int, model: str) -> list[Path]:
    candidates = response.get("candidates") or []
    parts = candidates[0].get("content", {}).get("parts", []) if candidates else []
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    stem = f"{timestamp}-{index:03d}-{slug(prompt)}"
    saved: list[Path] = []

    for part_index, part in enumerate(parts, start=1):
        inline = part.get("inlineData") or part.get("inline_data")
        if not inline or not inline.get("data"):
            continue
        mime = inline.get("mimeType") or inline.get("mime_type") or "image/png"
        extension = {"image/jpeg": ".jpg", "image/webp": ".webp"}.get(mime, ".png")
        suffix = f"-{part_index}" if len(parts) > 1 else ""
        path = output_dir / f"{stem}{suffix}{extension}"
        path.write_bytes(base64.b64decode(inline["data"], validate=True))
        saved.append(path)

    if not saved:
        reason = response.get("promptFeedback", {}).get("blockReason")
        raise RuntimeError(f"API không trả về ảnh{f' (block reason: {reason})' if reason else ''}")

    metadata = {
        "prompt": prompt,
        "model": model,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "images": [path.name for path in saved],
        "usage": response.get("usageMetadata", {}),
    }
    (output_dir / f"{stem}.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return saved


def load_prompts(args: argparse.Namespace) -> list[str]:
    prompts = list(args.prompt or [])
    if args.prompt_file:
        prompts.extend(
            line.strip()
            for line in args.prompt_file.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        )
    return prompts


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Tạo ảnh hàng loạt bằng Gemini Image API")
    parser.add_argument("prompt", nargs="*", help="Một hoặc nhiều prompt (đặt trong dấu nháy)")
    parser.add_argument("--prompt-file", type=Path, help="File UTF-8, mỗi dòng là một prompt")
    parser.add_argument("--output", type=Path, default=Path("output"), help="Thư mục lưu ảnh")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Gemini image model")
    parser.add_argument("--ratio", default="1:1", choices=sorted(VALID_RATIOS), help="Tỉ lệ ảnh")
    parser.add_argument("--delay", type=float, default=1.0, help="Số giây nghỉ giữa các prompt")
    parser.add_argument("--retries", type=int, default=3, help="Số lần thử lại khi API quá tải")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        print("Lỗi: chưa đặt biến môi trường GEMINI_API_KEY", file=sys.stderr)
        return 2
    prompts = load_prompts(args)
    if not prompts:
        print("Lỗi: cần truyền prompt hoặc --prompt-file", file=sys.stderr)
        return 2

    args.output.mkdir(parents=True, exist_ok=True)
    failures = 0
    for index, prompt in enumerate(prompts, start=1):
        try:
            response = request_image(api_key, args.model, prompt, args.ratio, args.retries)
            paths = save_response(response, args.output, prompt, index, args.model)
            for path in paths:
                print(path.resolve())
        except (RuntimeError, ValueError) as error:
            failures += 1
            print(f"[{index}/{len(prompts)}] Thất bại: {error}", file=sys.stderr)
        if index < len(prompts) and args.delay > 0:
            time.sleep(args.delay)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
