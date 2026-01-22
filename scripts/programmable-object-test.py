from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import sys
import time
from dataclasses import dataclass
from typing import Any, Literal
from urllib import error, request

API_BASE_URL = "https://40001.cch137.com/obj-dsgn"

# Per-request long-poll timeout for `?wait=true`
DEFAULT_WAIT_TIMEOUT_SEC = 30

# Safety net for the whole waiting loop (set to None to disable)
DEFAULT_OVERALL_WAIT_TIMEOUT_SEC = 10 * 60


# ---------- logging ----------
class _ElapsedFormatter(logging.Formatter):
    def __init__(self) -> None:
        super().__init__("%(message)s")
        self._t0 = time.perf_counter()

    def format(self, record: logging.LogRecord) -> str:
        elapsed = time.perf_counter() - self._t0
        return f"[{elapsed:7.2f}s] " + super().format(record)


logger = logging.getLogger("objgen")
_handler = logging.StreamHandler(sys.stdout)
_handler.setFormatter(_ElapsedFormatter())
logger.addHandler(_handler)
logger.setLevel(logging.INFO)


# ---------- http (stdlib) ----------
def _read_json_bytes(raw: bytes) -> dict[str, Any]:
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        raise RuntimeError(f"Non-JSON response: {raw[:200]!r}")


def _sync_http_json(method: str, url: str, payload: dict | None = None) -> tuple[int, dict[str, Any]]:
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = request.Request(url, method=method, data=data, headers=headers)
    try:
        with request.urlopen(req, timeout=DEFAULT_WAIT_TIMEOUT_SEC + 10) as resp:
            return resp.status, _read_json_bytes(resp.read())
    except error.HTTPError as e:
        body = e.read()
        try:
            return e.code, json.loads(body.decode("utf-8"))
        except Exception:
            return e.code, {"success": False, "error": body.decode("utf-8", "replace")}


def _sync_http_text(method: str, url: str) -> str:
    req = request.Request(url, method=method)
    with request.urlopen(req, timeout=DEFAULT_WAIT_TIMEOUT_SEC + 10) as resp:
        return resp.read().decode("utf-8")


def _sync_http_bytes_with_content_type(method: str, url: str) -> tuple[bytes, str | None]:
    req = request.Request(url, method=method)
    try:
        with request.urlopen(req, timeout=DEFAULT_WAIT_TIMEOUT_SEC + 10) as resp:
            return resp.read(), resp.headers.get("Content-Type")
    except error.HTTPError as e:
        body = e.read()
        try:
            j = json.loads(body.decode("utf-8"))
            raise RuntimeError(j.get("error") or str(j))
        except Exception:
            raise RuntimeError(body.decode("utf-8", "replace"))


async def http_json(method: str, url: str, payload: dict | None = None) -> tuple[int, dict[str, Any]]:
    return await asyncio.to_thread(_sync_http_json, method, url, payload)


async def http_text(method: str, url: str) -> str:
    return await asyncio.to_thread(_sync_http_text, method, url)


async def http_bytes_with_content_type(method: str, url: str) -> tuple[bytes, str | None]:
    return await asyncio.to_thread(_sync_http_bytes_with_content_type, method, url)


# ---------- domain ----------
def make_version() -> str:
    return str(int(time.time() * 1000))


@dataclass
class ObjectMetadata:
    id: str
    version: str
    name: str
    description: str


TaskStatus = Literal["processing", "succeeded", "failed"]


def get_version_task(state: dict[str, Any], version: str) -> dict[str, Any] | None:
    for t in (state.get("tasks") or []):
        if t.get("version") == version:
            return t
    return None


def get_version_status(state: dict[str, Any], version: str) -> TaskStatus | None:
    t = get_version_task(state, version)
    if not t:
        return None
    st = t.get("status")
    if st in ("processing", "succeeded", "failed"):
        return st
    return None


def raise_if_failed(state: dict[str, Any], version: str) -> None:
    t = get_version_task(state, version)
    if t and t.get("status") == "failed":
        raise RuntimeError(t.get("error") or "Generation failed")


async def _ticker(prefix: str, started_at: float) -> None:
    try:
        while True:
            elapsed = time.perf_counter() - started_at
            print(f"{prefix} waiting... {elapsed:0.1f}s".ljust(90), end="\r", flush=True)
            await asyncio.sleep(0.2)
    except asyncio.CancelledError:
        return


async def create_generation(object_name: str, object_description: str, model: str) -> ObjectMetadata:
    version = make_version()
    logger.info(f"[1/5] create generation  name={object_name!r}  version={version}  model={model}")

    status, resp = await http_json(
        "POST",
        f"{API_BASE_URL}/generations",
        payload={
            "version": version,
            "languageModel": model,
            "props": {"object_name": object_name, "object_description": object_description},
        },
    )
    if status != 200 or not resp.get("success"):
        raise RuntimeError(resp.get("error") or f"Failed to create generation: {resp}")

    task_id = resp["data"]["id"]
    if not isinstance(task_id, str):
        raise TypeError("id is not string")

    logger.info(f"      created task id={task_id}")
    return ObjectMetadata(task_id, version, object_name, object_description)


async def wait_until_version_final(
    task_id: str,
    version: str,
    *,
    per_request_timeout_sec: int = DEFAULT_WAIT_TIMEOUT_SEC,
    overall_timeout_sec: int | None = DEFAULT_OVERALL_WAIT_TIMEOUT_SEC,
) -> dict[str, Any]:
    """
    Uses `/objects/:id?wait=true` repeatedly.
    Even if server returns 200, keep waiting until the given `version` is not `processing`.
    """
    logger.info(
        f"[2/5] wait version final (wait-mode)  id={task_id}  version={version}  "
        f"poll_timeout={per_request_timeout_sec}s  overall_timeout={overall_timeout_sec}s"
    )

    started_at = time.perf_counter()
    deadline = None if overall_timeout_sec is None else started_at + overall_timeout_sec

    tick_task = asyncio.create_task(_ticker("     ", started_at))
    try:
        attempt = 0
        while True:
            attempt += 1
            if deadline is not None and time.perf_counter() > deadline:
                raise TimeoutError(f"Overall timeout reached ({overall_timeout_sec}s)")

            url = f"{API_BASE_URL}/objects/{task_id}?wait=true&timeout_sec={per_request_timeout_sec}"
            status, resp = await http_json("GET", url)

            if status == 404:
                raise RuntimeError(resp.get("error") or "Object not found")
            if status != 200 or not resp.get("success"):
                raise RuntimeError(resp.get("error") or f"Wait failed: {resp}")

            state = resp["data"]
            st = get_version_status(state, version)

            # If backend returns 200 but hasn't attached tasks yet, keep waiting.
            if st is None:
                logger.info(f"      poll#{attempt:02d}: version task not found yet; continue waiting")
                await asyncio.sleep(0.1)
                continue

            if st == "processing":
                logger.info(f"      poll#{attempt:02d}: status=processing; continue waiting")
                continue

            if st == "failed":
                raise_if_failed(state, version)
                raise RuntimeError("Generation failed")  # fallback

            # succeeded
            elapsed = time.perf_counter() - started_at
            logger.info(f"      done after {elapsed:0.1f}s  status=succeeded")
            return state
    finally:
        tick_task.cancel()
        with contextlib.suppress(BaseException):
            await tick_task
        print("".ljust(90), end="\r", flush=True)


async def get_object_content_glb(task_id: str, version: str) -> tuple[bytes, str | None]:
    logger.info(f"[4/5] fetch glb content  id={task_id}  version={version}")
    return await http_bytes_with_content_type(
        "GET", f"{API_BASE_URL}/objects/{task_id}/versions/{version}/content"
    )


async def debug_add_object_to_rooms(payload: dict[str, Any]) -> None:
    logger.info("[5/5] debug add to rooms")
    status, resp = await http_json("POST", f"{API_BASE_URL}/_debug_add_prog_obj_rooms", payload=payload)
    if status != 200 or not resp.get("success"):
        raise RuntimeError(resp.get("error") or f"debug add failed: {resp}")
    logger.info("      ok")


async def main() -> None:
    object_name = "戰鬥機"
    object_description = (
        "一架先進的戰鬥機一架現代噴射戰鬥機的 3D 物件：整體為流線型機身與尖鼻錐，左右後掠主翼與尾翼（可為單垂尾或雙垂尾），"
        "側/下方進氣道與尾部噴嘴結構清晰；座艙罩為透明件，可看到簡化的座椅與儀表輪廓；機身表面具備面板分件線、維修蓋與少量鉚釘等細節"
        "（偏寫實但不過度繁複），可選擇在翼下配置掛點與簡化導彈/副油箱作為附屬物件；整體風格寫實、軍用灰系塗裝，帶輕微使用磨損與警示標示，"
        "外形以「現代戰機輪廓」為主、避免特定機型的可辨識特徵。"
    )
    model = "gemini-3-flash-preview"

    obj = await create_generation(object_name, object_description, model)

    # keep waiting until THIS version is not processing (even if server returns 200 early)
    await wait_until_version_final(
        obj.id,
        obj.version,
        per_request_timeout_sec=DEFAULT_WAIT_TIMEOUT_SEC,
        overall_timeout_sec=DEFAULT_OVERALL_WAIT_TIMEOUT_SEC,
    )
    logger.info(f"[3/5] verify version  version={obj.version}  status=succeeded")

    glb, content_type = await get_object_content_glb(obj.id, obj.version)
    logger.info(f"      content-type={content_type or '(none)'}  glb_bytes={len(glb)}")
    logger.info(f"      snapshot={API_BASE_URL}/objects/{obj.id}/versions/{obj.version}/snapshot")

    await debug_add_object_to_rooms(
        {
            "props": {"object_name": obj.name, "object_description": obj.description},
            "url": f"{API_BASE_URL}/objects/{obj.id}/versions/{obj.version}/content",
        }
    )


if __name__ == "__main__":
    asyncio.run(main())