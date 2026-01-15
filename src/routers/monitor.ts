import { Hono } from "hono";
import { WSContext } from "hono/ws";
import debug from "debug";

import { upgradeWebSocket } from "../server";
import { serverMic, serverSpeaker } from "../services/audio";
import {
  AssistantEventType,
  RealtimeAssistant,
} from "../services/realtime/assistant";

const log = debug("monitor");

const monitor = new Hono();

const clients = new Set<WSContext<WebSocket>>();

let assistant: RealtimeAssistant | null = null;

serverMic.subscribe((pcm) => {
  if (!assistant) {
    assistant = new RealtimeAssistant();
    assistant.subscribe((event) => {
      switch (event.type) {
        case AssistantEventType.AudioChunk: {
          serverSpeaker.play(event.chunk);
          break;
        }
      }
    });
    assistant.connect();
  }
  assistant.sendAudioInput(pcm);
});

serverSpeaker.subscribe((pcm) => {
  for (const client of clients) {
    try {
      client.send(new Uint8Array(pcm));
    } catch (err) {
      log("audio sending error:", err);
    }
  }
});

let monitorConnectionCounter = 0;

monitor.get(
  "/audio",
  upgradeWebSocket((_c) => {
    const id = `monitor${++monitorConnectionCounter}`;
    return {
      async onOpen(_evt, ws) {
        clients.add(ws);
        log(`[${id}] connected`);
      },
      onClose(_evt, ws) {
        clients.delete(ws);
        log(`[${id}] disconnected`);
      },
      onError(_evt, _ws) {
        log(`[${id}] an error occurred`);
      },
      async onMessage(event, _ws) {
        const buffer =
          typeof event.data === "string"
            ? Buffer.from(event.data, "binary")
            : event.data instanceof Blob
            ? Buffer.from(await event.data.bytes())
            : event.data instanceof ArrayBuffer
            ? Buffer.from(event.data)
            : null;
        if (buffer && buffer.length) serverMic.play(buffer);
        else log(`[${id}] sent a heartbeat`);
      },
    };
  })
);

export default monitor;
