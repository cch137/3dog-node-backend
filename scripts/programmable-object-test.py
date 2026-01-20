from __future__ import annotations

from urllib import request, error
import json
import time
from dataclasses import dataclass


API_BASE_URL = "https://40001.cch137.com/obj-dsgn"


def make_version() -> str:
    # Digits only (avoid symbols). Example: "1700000000123"
    return str(int(time.time() * 1000))


def _read_json_response(resp) -> dict:
    raw = resp.read()
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        raise RuntimeError(f"Non-JSON response: {raw[:200]!r}")


def http_json(method: str, url: str, payload: dict | None = None) -> tuple[int, dict]:
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = request.Request(url, method=method, data=data, headers=headers)
    try:
        with request.urlopen(req) as resp:
            return resp.status, _read_json_response(resp)
    except error.HTTPError as e:
        body = e.read()
        try:
            return e.code, json.loads(body.decode("utf-8"))
        except Exception:
            return e.code, {"success": False, "error": body.decode("utf-8", "replace")}


def http_text(method: str, url: str) -> str:
    req = request.Request(url, method=method)
    with request.urlopen(req) as resp:
        return resp.read().decode("utf-8")


def http_bytes_with_content_type(method: str, url: str) -> tuple[bytes, str | None]:
    req = request.Request(url, method=method)
    try:
        with request.urlopen(req) as resp:
            return resp.read(), resp.headers.get("Content-Type")
    except error.HTTPError as e:
        body = e.read()
        try:
            j = json.loads(body.decode("utf-8"))
            raise RuntimeError(j.get("error") or str(j))
        except Exception:
            raise RuntimeError(body.decode("utf-8", "replace"))


@dataclass
class ObjectMetadata:
    id: str
    version: str
    name: str
    description: str


def create_generation(
    object_name: str, object_description: str, model: str
) -> ObjectMetadata:
    version = make_version()
    print(
        f"[1/5] create generation: name={object_name!r}, version={version}, model={model}"
    )

    status, resp = http_json(
        "POST",
        f"{API_BASE_URL}/generations",
        payload={
            "version": version,
            "languageModel": model,  # string; backend will resolve to provider
            "props": {
                "object_name": object_name,
                "object_description": object_description,
            },
        },
    )
    if status != 200 or not resp.get("success"):
        raise RuntimeError(resp.get("error") or f"Failed to create generation: {resp}")

    task_id = resp["data"]["id"]
    if not isinstance(task_id, str):
        raise TypeError("id is not string")

    print(f"      created task id: {task_id}")
    return ObjectMetadata(task_id, version, object_name, object_description)


def wait_generation_ended(
    task_id: str,
    poll_interval_s: float = 0.5,
    long_poll_ms: int = 10000,
) -> None:
    print(f"[2/5] wait generation ended: id={task_id} (long-poll={long_poll_ms}ms)")

    start = time.time()
    last_print = 0.0

    while True:
        status, resp = http_json(
            "GET",
            f"{API_BASE_URL}/generations/{task_id}/ended?ms={long_poll_ms}",
        )

        elapsed = time.time() - start
        if elapsed - last_print >= 1.0:
            print(f"      waiting... {elapsed:.1f}s elapsed", end="\r", flush=True)
            last_print = elapsed

        if status == 200 and resp.get("success"):
            print(f"      ended after {elapsed:.1f}s".ljust(60))
            return

        if status == 404:
            print("".ljust(60))
            raise RuntimeError(resp.get("error") or "Task not found")

        # 202: still processing
        time.sleep(poll_interval_s)


def get_object_state(task_id: str) -> dict:
    print(f"[3/5] fetch object state: id={task_id}")
    status, resp = http_json("GET", f"{API_BASE_URL}/objects/{task_id}")
    if status != 200 or not resp.get("success"):
        raise RuntimeError(resp.get("error") or f"Failed to get object state: {resp}")
    return resp["data"]


def assert_version_succeeded(state: dict, version: str) -> None:
    tasks = state.get("tasks") or []
    for t in tasks:
        if t.get("version") == version:
            st = t.get("status")
            if st == "succeeded":
                print(f"      version={version} status=succeeded")
                return
            if st == "failed":
                raise RuntimeError(t.get("error") or "Generation failed")
            raise RuntimeError(f"Version status is not final: {st}")
    raise RuntimeError(f"Version not found in state: {version}")


def get_object_code(task_id: str, version: str) -> str:
    print(f"[optional] fetch code: id={task_id} version={version}")
    return http_text("GET", f"{API_BASE_URL}/objects/{task_id}/versions/{version}/code")


def get_object_content_glb(task_id: str, version: str) -> tuple[bytes, str | None]:
    print(f"[4/5] fetch glb content: id={task_id} version={version}")
    return http_bytes_with_content_type(
        "GET", f"{API_BASE_URL}/objects/{task_id}/versions/{version}/content"
    )


def debug_add_object_to_rooms(payload: dict) -> None:
    print("[5/5] debug add to rooms")
    status, resp = http_json(
        "POST", f"{API_BASE_URL}/_debug_add_prog_obj_rooms", payload=payload
    )
    if status != 200 or not resp.get("success"):
        raise RuntimeError(resp.get("error") or f"debug add failed: {resp}")
    print("      ok")


if __name__ == "__main__":
    object_name = "戰鬥機"
    object_description = "一架先進的戰鬥機一架現代噴射戰鬥機的 3D 物件：整體為流線型機身與尖鼻錐，左右後掠主翼與尾翼（可為單垂尾或雙垂尾），側/下方進氣道與尾部噴嘴結構清晰；座艙罩為透明件，可看到簡化的座椅與儀表輪廓；機身表面具備面板分件線、維修蓋與少量鉚釘等細節（偏寫實但不過度繁複），可選擇在翼下配置掛點與簡化導彈/副油箱作為附屬物件；整體風格寫實、軍用灰系塗裝，帶輕微使用磨損與警示標示，外形以「現代戰機輪廓」為主、避免特定機型的可辨識特徵。"
    model = "gemini-3-flash-preview"

    obj = create_generation(object_name, object_description, model)

    wait_generation_ended(obj.id)

    state = get_object_state(obj.id)
    assert_version_succeeded(state, obj.version)

    glb, content_type = get_object_content_glb(obj.id, obj.version)
    print(f"      content-type: {content_type or '(none)'}")
    print(f"      received glb bytes: {len(glb)}")
    print(f"      check snapshot at {API_BASE_URL}/objects/{obj.id}/versions/{obj.version}/snapshot")

    debug_add_object_to_rooms(
        {
            "props": {"object_name": obj.name, "object_description": obj.description},
            "url": f"{API_BASE_URL}/objects/{obj.id}/versions/{obj.version}/content",
        }
    )
