"""HTTP fetch layer with a mandatory on-disk cache.

Every response is cached to disk keyed by its full URL (including query
params). A cache hit costs zero requests and zero sleep -- re-running the
scraper, or re-parsing already-fetched pages, should never re-hit the network.
"""

import hashlib
import json
import time
from pathlib import Path

import requests

from config import BASE_URL, CACHE_DIR, CATOID, NAVOID, RATE_LIMIT_SECONDS, USER_AGENT

COOKIE_FILE = "cookies.txt"


class ChallengeError(RuntimeError):
    """Raised when content.php responds with an AWS WAF challenge instead of content.

    That means the aws-waf-token in cookies.txt has expired. Get a fresh one from a
    real browser (DevTools -> Network -> content.php request -> Cookie request
    header) and overwrite cookies.txt.
    """


def _load_cookies() -> dict:
    path = Path(COOKIE_FILE)
    if not path.exists():
        return {}
    raw = path.read_text(encoding="utf-8").strip()
    cookies = {}
    for part in raw.split(";"):
        if "=" in part:
            k, v = part.strip().split("=", 1)
            cookies[k] = v
    return cookies


_session = requests.Session()
_session.headers["User-Agent"] = USER_AGENT
_session.cookies.update(_load_cookies())
_last_request_monotonic = None


def _cache_key(params: dict) -> str:
    canonical = "&".join(f"{k}={params[k]}" for k in sorted(params))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _cache_paths(params: dict) -> tuple[Path, Path]:
    cache_dir = Path(CACHE_DIR)
    cache_dir.mkdir(parents=True, exist_ok=True)
    key = _cache_key(params)
    return cache_dir / f"{key}.html", cache_dir / f"{key}.meta.json"


def _throttle() -> None:
    global _last_request_monotonic
    if _last_request_monotonic is not None:
        elapsed = time.monotonic() - _last_request_monotonic
        remaining = RATE_LIMIT_SECONDS - elapsed
        if remaining > 0:
            time.sleep(remaining)
    _last_request_monotonic = time.monotonic()


def get(params: dict, url: str = BASE_URL, force_refresh: bool = False) -> str:
    """GET url with params, transparently caching the response body to disk."""
    html_path, meta_path = _cache_paths(params)

    if html_path.exists() and not force_refresh:
        return html_path.read_text(encoding="utf-8")

    _throttle()
    resp = _session.get(url, params=params, timeout=30)
    resp.raise_for_status()

    if resp.headers.get("x-amzn-waf-action") == "challenge" or not resp.text:
        raise ChallengeError(
            f"WAF challenge on {resp.url} -- refresh {COOKIE_FILE} from a real browser session."
        )

    html_path.write_text(resp.text, encoding="utf-8")
    meta_path.write_text(
        json.dumps({"url": resp.url, "params": params, "status": resp.status_code}, indent=2),
        encoding="utf-8",
    )
    return resp.text


def is_cached(params: dict) -> bool:
    html_path, _ = _cache_paths(params)
    return html_path.exists()


def listing_params(prefix: str, cpage: int = 1) -> dict:
    """Query params for the expanded course-listing page for one subject prefix."""
    return {
        "catoid": CATOID,
        "navoid": NAVOID,
        "cur_cat_oid": CATOID,
        "filter[27]": prefix,
        "filter[29]": "",
        "filter[keyword]": "",
        "filter[32]": 1,
        "filter[cpage]": cpage,
        "search_database": "Filter",
        "expand": 1,
        "print": "",
    }


def get_listing_page(prefix: str, cpage: int = 1, force_refresh: bool = False) -> str:
    return get(listing_params(prefix, cpage), force_refresh=force_refresh)
