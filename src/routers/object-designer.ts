import { Hono } from "hono";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import {
  designer,
  ObjectGenerationOptionsSchema,
} from "../services/object-designer";
import { RealtimeRoom } from "../services/realtime/connection";

function resolveLanguageModel(model: string) {
  if (model.startsWith("gemini-")) return google(model);
  if (model.startsWith("gpt-")) return openai(model);
  if (model.startsWith("o")) return openai(model);
  // default to google
  return google(model);
}

const objectDesigner = new Hono();

objectDesigner.get("/objects/:id", async (c) => {
  const state = await designer.getObjectState(c.req.param("id"));
  if (state === null)
    return c.json({ success: false, error: "Object not found" }, 404);
  return c.json({ success: true, data: state }, 200);
});

objectDesigner.get("/objects/:id/versions/:version/code", async (c) => {
  const data = await designer.getObjectCode(
    c.req.param("id"),
    c.req.param("version"),
  );
  if (data === null)
    return c.json({ success: false, error: "Object not found" }, 404);
  if (data.error) return c.json({ success: false, error: data.error }, 404);
  if (!data.code)
    return c.json({ success: false, error: "Code not found" }, 404);
  return c.text(data.code);
});

objectDesigner.get("/objects/:id/versions/:version/content", async (c) => {
  const data = await designer.getObjectContent(
    c.req.param("id"),
    c.req.param("version"),
  );
  if (data === null)
    return c.json({ success: false, error: "Object not found" }, 404);
  if (data.error) return c.json({ success: false, error: data.error }, 404);
  if (!data.blob_content)
    return c.json({ success: false, error: "Content not found" }, 404);
  if (data.mime_type) c.header("Content-Type", data.mime_type);
  return c.body(new Uint8Array(data.blob_content));
});

objectDesigner.get("/objects/:id/versions/:version/snapshot", async (c) => {
  const id = c.req.param("id");
  const version = c.req.param("version");

  try {
    const data = await designer.getObjectSnapshot(id, version);
    if (data === null)
      return c.json({ success: false, error: "Snapshot not found" }, 404);
    c.header("Content-Type", data.mime_type);
    return c.body(new Uint8Array(data.blob_content));
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

objectDesigner.post("/generations", async (c) => {
  let jsonData: unknown = null;

  try {
    jsonData = await c.req.json();
    if (typeof jsonData !== "object" || jsonData === null) {
      return c.json({ success: false, error: "Invalid request body" }, 400);
    }
    if (
      !("languageModel" in jsonData) ||
      typeof jsonData.languageModel !== "string"
    ) {
      return c.json({ success: false, error: "Invalid language model" }, 400);
    }
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }

  jsonData.languageModel = resolveLanguageModel(jsonData.languageModel);
  const parsed = ObjectGenerationOptionsSchema.safeParse(jsonData);

  if (!parsed.success)
    return c.json({ success: false, error: "Invalid request parameters" }, 400);

  try {
    const task = designer.addTask(parsed.data);
    return c.json({ success: true, data: { id: task.id } }, 200);
  } catch {
    return c.json({ success: false, error: "Failed to create task" }, 500);
  }
});

objectDesigner.post("/generations/:id/cancel", async (c) => {
  const exists = designer.cancelTask(c.req.param("id"));
  if (exists) return c.json({ success: true }, 200);
  return c.json({ success: false, error: "Task not found" }, 404);
});

objectDesigner.get("/generations/:id/ended", async (c) => {
  const timeoutMs = parseInt(c.req.query("ms") ?? "NaN", 10) || undefined;
  const isEnded = await designer.waitForTaskEnded(c.req.param("id"), timeoutMs);
  if (isEnded) return c.json({ success: true }, 200);
  return c.json({ success: false, error: "Task is proccessing" }, 202);
});

objectDesigner.post("/_debug_add_prog_obj_rooms", async (c) => {
  try {
    RealtimeRoom._debug_add_prog_obj_rooms(await c.req.json());
    return c.json({ success: true }, 200);
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500);
  }
});

export default objectDesigner;
