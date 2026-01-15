import { config as dotenv } from "dotenv";
import debug from "debug";

dotenv();

import { app, upgradeWebSocket } from "./server";
import { realtimeHandler } from "./services/realtime/connection";
import dss from "./routers/dss";
import monitor from "./routers/monitor";
import objectDesigner from "./routers/object-designer";
export * as objg from "./services/workflows/object-move";

const log = debug("server");

app.route("", dss);
app.route("/monitor/", monitor);
app.route("/obj-dsgn/", objectDesigner);

app.get("/", (c) => {
  return c.json({ status: "OK" });
});

app.get("/mr-realtime", upgradeWebSocket(realtimeHandler));

app.onError((err, c) => {
  log("app error:", err);
  return c.text("Service Unavailable", 503);
});

process.on("uncaughtException", (error) => {
  log("uncaughtException:", error);
});

process.on("unhandledRejection", (error) => {
  log("unhandledRejection:", error);
});

export default app;
