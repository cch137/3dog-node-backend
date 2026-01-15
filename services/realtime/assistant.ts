import {
  GoogleGenAI,
  LiveSendRealtimeInputParameters,
  LiveServerMessage,
  Modality,
  Session,
} from "@google/genai";
import debug from "debug";
import { SERVER_AUDIO_SAMPLE_RATE, resamplePcmAudioBuffer } from "../audio";
import z from "zod";

import { ProtectedTinyNotifier } from "../../lib/utils/tiny-notifier";
import { throttle } from "../../lib/utils/throttle";
import { generateRandomId } from "../../lib/utils/generate-random-id";
import { loadInstructionsTemplate } from "../instructions";

const log = debug("assistant");

const DEFAULT_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";
export const INPUT_CHANNEL_COUNT = 1;
export const INPUT_SAMPLE_RATE = 16_000;
export const OUTPUT_CHANNEL_COUNT = 1;
export const OUTPUT_SAMPLE_RATE = 24_000;
const AUDIO_THROTTLE_DELAY_MS = 100;
const MAX_PENDING_INPUT_PARAMS_LENGTH = 20;
const MAX_PENDING_AUDIO_INPUT_CHUNKS_LENGTH = 1_000;

const gai = new GoogleGenAI({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
});

export enum AssistantEventType {
  Interrupted = "Interrupted",
  AudioChunk = "AudioChunk",
  TextChunk = "TextChunk",
  ToolCall = "ToolCall",
}

export type InterruptedEvent = {
  type: AssistantEventType.Interrupted;
};

export type AudioChunkEvent = {
  type: AssistantEventType.AudioChunk;
  chunk: Buffer<ArrayBufferLike>;
};

export type TextChunkEvent = {
  type: AssistantEventType.TextChunk;
  chunk: string;
};

export type ToolCallEvent = {
  type: AssistantEventType.ToolCall;
  name: string;
};

export type AssistantEvent =
  | InterruptedEvent
  | AudioChunkEvent
  | TextChunkEvent
  | ToolCallEvent;

export class RealtimeAssistant extends ProtectedTinyNotifier<AssistantEvent> {
  private static readonly systemInstructionP =
    loadInstructionsTemplate("realtime-assistant");

  readonly id = generateRandomId();

  private session: Session | null = null;
  private reconnectKey: Symbol | null = null;
  private connecting = false;
  private connected = false;
  private destroyed = false;

  private readonly pendingInputParams: LiveSendRealtimeInputParameters[] = [];
  private readonly pendingAudioInputChunks: Buffer<ArrayBufferLike>[] = [];
  private readonly pendingAudioOutputChunks: Buffer<ArrayBufferLike>[] = [];

  constructor() {
    super();
  }

  async connect(key?: Symbol) {
    if (this.destroyed) {
      log(`[${this.id}] session already destroyed, connection cancelled.`);
      return this;
    }
    if (this.connected || this.connecting) {
      log(`[${this.id}] session already exists, connection cancelled.`);
      return this;
    }
    if (this.reconnectKey && this.reconnectKey !== key) {
      log(`[${this.id}] session is reconnecting, connection cancelled.`);
      return;
    }

    try {
      log(`[${this.id}] connecting...`);

      this.connecting = true;
      this.reconnectKey = null;

      this.session = await gai.live.connect({
        model: DEFAULT_MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          // thinkingConfig: {
          //   thinkingLevel: ThinkingLevel.HIGH,
          // },
          tools: [
            {
              functionDeclarations: [
                {
                  name: "make_3d_object",
                  description:
                    "Use it when the user wants to make a 3D object. Please declare a clear object_name and object_description.",
                  parametersJsonSchema: z.toJSONSchema(
                    z.object({
                      object_name: z.string(),
                      object_description: z.string(),
                    })
                  ),
                },
              ],
            },
          ],
          systemInstruction: (await RealtimeAssistant.systemInstructionP)({}),
        },
        callbacks: {
          onopen: () => {
            log(`[${this.id}] connected`);
            this.connected = true;
            this.connecting = false;
            // flush pending audio inputs
            this.flushAudioInput.finish();
            // flush pending text inputs
            for (const params of this.pendingInputParams.splice(0)) {
              this.sendInput(params);
            }
          },
          onmessage: (message) => this.handleMessage(message),
          onerror: (error) => {
            log(`[${this.id}] API error:`, error);
          },
          onclose: (event) => {
            log(`[${this.id}] connection closed:`, event.reason);
            this.session = null;
            this.connected = false;
            this.connecting = false;
            // reconnect automatically unless destroyed
            if (!this.destroyed) {
              const key = Symbol();
              this.reconnectKey = key;
              this.connect(key);
            }
          },
        },
      });
    } catch (error) {
      log(`[${this.id}] connection failed:`, error);
      this.session = null;
      this.connected = false;
      this.connecting = false;
      // retry after 1s
      const key = Symbol();
      this.reconnectKey = key;
      // 我們暫時不考慮重連風暴風險
      setTimeout(() => this.connect(key), 1_000);
    }
    return this;
  }

  protected sendInput(params: LiveSendRealtimeInputParameters) {
    if (!this.connected || !this.session) {
      if (this.pendingInputParams.length >= MAX_PENDING_INPUT_PARAMS_LENGTH) {
        this.pendingInputParams.shift();
      }
      this.pendingInputParams.push(params);
      return;
    }

    try {
      this.session.sendRealtimeInput(params);
      if (params.text) log(`[${this.id}] text input:`, params.text);
      if (params.audio)
        log(
          `[${this.id}] audio input: base64 length: ${params.audio.data?.length}`
        );
    } catch (error) {
      log(`[${this.id}] error sending input:`, error);
    }
  }

  sendTextInput(text: string): void {
    this.sendInput({ text });
  }

  sendAudioInput(buffer: Buffer) {
    if (
      this.pendingAudioInputChunks.length >=
      MAX_PENDING_AUDIO_INPUT_CHUNKS_LENGTH
    ) {
      this.flushAudioInput.finish();
    }
    this.pendingAudioInputChunks.push(buffer);
    this.flushAudioInput();
  }

  protected sendAudioOutput(buffer: Buffer) {
    this.pendingAudioOutputChunks.push(buffer);
    this.flushAudioOutput();
  }

  readonly flushAudioInput = throttle(() => {
    if (this.pendingAudioInputChunks.length === 0) return;

    const buffer = Buffer.concat(this.pendingAudioInputChunks.splice(0));
    const base64Audio = buffer.toString("base64");

    this.sendInput({
      audio: {
        data: base64Audio,
        mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`,
      },
    });
  }, AUDIO_THROTTLE_DELAY_MS);

  protected readonly flushAudioOutput = throttle(() => {
    if (this.pendingAudioOutputChunks.length === 0) return;

    const buffer = Buffer.concat(this.pendingAudioOutputChunks.splice(0));

    this.notify({
      type: AssistantEventType.AudioChunk,
      chunk: buffer,
    });

    log(`[${this.id}] audio output: ${buffer.length} bytes`);
  }, AUDIO_THROTTLE_DELAY_MS);

  private handleMessage(message: LiveServerMessage): void {
    const { serverContent } = message;

    if (!serverContent) return;

    if (serverContent.interrupted) {
      this.notify({ type: AssistantEventType.Interrupted });
      log(`[${this.id}] response interrupted`);
      return;
    }

    if (serverContent.modelTurn?.parts) {
      const parts = serverContent.modelTurn.parts;

      for (const part of parts) {
        if (part.inlineData?.data) {
          const audioBuffer = resamplePcmAudioBuffer(
            Buffer.from(part.inlineData.data, "base64"),
            OUTPUT_SAMPLE_RATE,
            SERVER_AUDIO_SAMPLE_RATE
          );

          this.sendAudioOutput(audioBuffer);
        }

        if (part.functionCall) {
          log(`[${this.id}] received function call:`, part.functionCall);
          this.notify({
            type: AssistantEventType.ToolCall,
            name: part.functionCall.name ?? "UNKNOWN_TOOL",
          });
        }

        if (part.functionResponse) {
          log(
            `[${this.id}] received function response:`,
            part.functionResponse
          );
        }

        if (part.text) {
          log(`[${this.id}] received transcript:`, part.text);
          this.notify({ type: AssistantEventType.TextChunk, chunk: part.text });
        }
      }
    }

    if (serverContent.turnComplete) {
      log(`[${this.id}] response complete`);
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    if (this.session) {
      try {
        // force close the session
        this.session.close();
      } catch {
        // ignore force closing error
      }
      this.session = null;
      this.connected = false;
    }
  }

  get isConnected() {
    return this.connected;
  }

  get isDestroyed() {
    return this.destroyed;
  }
}
