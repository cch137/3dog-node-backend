(async () => {
  const startButton = document.getElementById("start-btn");
  const micButton = document.getElementById("mic-btn");
  const volumeSlider = document.getElementById("volume-slider");
  if (!startButton) throw new Error("start button not found");
  if (!micButton) throw new Error("mic button not found");
  if (!volumeSlider) throw new Error("Volume slider not found");

  startButton.addEventListener("click", start, { once: true });
  micButton.disabled = true;

  const url = `${location.origin.replace(/^http/, "ws")}/monitor/audio`;

  async function start() {
    startButton.disabled = true;
    micButton.disabled = true; // disabled until WS open
    await connect();
  }

  async function connect(isReconnect = false) {
    // PCM spec (must match server)
    const sampleRate = 16000;
    const channels = 1;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx({ sampleRate });

    const gainNode = ctx.createGain();

    gainNode.gain.value = parseFloat(volumeSlider.value) / 100;
    gainNode.connect(ctx.destination);

    const handleVolumeChange = () => {
      const volumeFraction = parseFloat(volumeSlider.value) / 100;
      gainNode.gain.setTargetAtTime(volumeFraction, ctx.currentTime, 0.01);
    };

    volumeSlider.addEventListener("input", handleVolumeChange);

    let isClosed = false;
    let nextStartTime = 0;
    let heartbeatInterval = null;

    let isMicOn = false;
    let micStream = null;
    let micSource = null;
    let workletNode = null;

    const updateStatus = (text) => {
      if (isClosed) return;
      startButton.textContent = text;
    };

    const setMicUi = () => {
      micButton.textContent = isMicOn ? "Mic: ON" : "Mic: OFF";
    };

    const setMicEnabled = (enabled) => {
      micButton.disabled = !enabled;
    };

    // Some browsers require a user gesture to start audio.
    const resume = async () => {
      if (ctx.state !== "running") await ctx.resume();
    };

    const reconnect = async () => {
      if (isClosed) return;
      isClosed = true;
      clearInterval(heartbeatInterval);

      await stopMic(); // WS down -> mic off

      ctx.close();
      window.removeEventListener("pointerdown", resume);
      window.removeEventListener("keydown", resume);

      await new Promise((r) => setTimeout(r, 1_000));
      await connect(true);
    };

    const heartbeat = () => {
      if (isClosed) return clearInterval(heartbeatInterval);
      if (ws.readyState === WebSocket.OPEN) ws.send(new Uint8Array());
    };

    const setHeartbeat = () => {
      clearInterval(heartbeatInterval);
      heartbeatInterval = setInterval(heartbeat, 20_000);
    };

    window.addEventListener("pointerdown", resume, { once: true });
    window.addEventListener("keydown", resume, { once: true });

    const ws = new WebSocket(url);
    updateStatus(isReconnect ? "Reconnecting..." : "Connecting...");
    ws.binaryType = "arraybuffer";

    // initial: WS not open => mic disabled
    setMicEnabled(false);
    setMicUi();

    const SEND_INTERVAL_MS = 250;

    let sendTimer = null;
    /** @type {ArrayBuffer[]} */
    let pendingChunks = [];
    let pendingBytes = 0;

    function enqueuePcm16(pcm16Buffer) {
      // pcm16Buffer: ArrayBuffer (Int16Array.buffer)
      if (!isMicOn) return;
      if (ws.readyState !== WebSocket.OPEN) return;

      pendingChunks.push(pcm16Buffer);
      pendingBytes += pcm16Buffer.byteLength;
    }

    function flushAudio() {
      if (!isMicOn) return;
      if (ws.readyState !== WebSocket.OPEN) return;
      if (pendingBytes === 0) return;

      // Concatenate all pending chunks into one ArrayBuffer
      const out = new Uint8Array(pendingBytes);
      let offset = 0;
      for (const ab of pendingChunks) {
        out.set(new Uint8Array(ab), offset);
        offset += ab.byteLength;
      }

      pendingChunks = [];
      pendingBytes = 0;

      ws.send(out.buffer);
    }

    function startSendLoop() {
      if (sendTimer) return;
      sendTimer = setInterval(flushAudio, SEND_INTERVAL_MS);
    }

    function stopSendLoop() {
      if (sendTimer) clearInterval(sendTimer);
      sendTimer = null;
      pendingChunks = [];
      pendingBytes = 0;
    }

    function pcm16leToFloat32(int16) {
      const out = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) out[i] = int16[i] / 0x8000;
      return out;
    }

    function float32ToPcm16le(float32) {
      const out = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        let s = float32[i];
        if (s > 1) s = 1;
        else if (s < -1) s = -1;
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return out;
    }

    async function ensureWorklet() {
      const code = `
        class PcmTapProcessor extends AudioWorkletProcessor {
          process(inputs) {
            const input = inputs[0];
            if (!input || !input[0]) return true;
            this.port.postMessage(input[0]); // Float32Array (mono)
            return true;
          }
        }
        registerProcessor('pcm-tap', PcmTapProcessor);
      `;
      const blobUrl = URL.createObjectURL(
        new Blob([code], { type: "text/javascript" })
      );
      await ctx.audioWorklet.addModule(blobUrl);
      URL.revokeObjectURL(blobUrl);
    }

    async function startMic() {
      if (isMicOn) return;
      if (ws.readyState !== WebSocket.OPEN) return;

      await resume();
      await ensureWorklet();

      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: channels,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      micSource = ctx.createMediaStreamSource(micStream);
      workletNode = new AudioWorkletNode(ctx, "pcm-tap", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: channels,
      });

      workletNode.port.onmessage = (ev) => {
        if (!isMicOn) return;
        if (ws.readyState !== WebSocket.OPEN) return;
        const float32 = ev.data; // Float32Array
        const pcm16 = float32ToPcm16le(float32);
        enqueuePcm16(pcm16.buffer);
      };

      micSource.connect(workletNode);

      isMicOn = true;
      startSendLoop();
      setMicUi();
    }

    async function stopMic() {
      if (!isMicOn && !micStream && !micSource && !workletNode) {
        setMicUi();
        return;
      }

      isMicOn = false;

      stopSendLoop();

      if (workletNode) {
        try {
          workletNode.port.onmessage = null;
          workletNode.disconnect();
        } catch {}
        workletNode = null;
      }

      if (micSource) {
        try {
          micSource.disconnect();
        } catch {}
        micSource = null;
      }

      if (micStream) {
        micStream.getTracks().forEach((t) => t.stop());
        micStream = null;
      }

      setMicUi();
    }

    micButton.onclick = async () => {
      try {
        if (micButton.disabled) return;
        if (!isMicOn) await startMic();
        else await stopMic();
      } catch (e) {
        await stopMic();
        console.error(e);
        alert("Failed to start microphone. Check permissions / HTTPS.");
      }
    };

    ws.addEventListener("open", () => {
      updateStatus("Connected");
      setHeartbeat();
      setMicEnabled(true); // WS open => allow mic
      setMicUi();
    });

    ws.addEventListener("message", async (ev) => {
      setHeartbeat();
      await resume();

      const ab = ev.data; // ArrayBuffer
      const int16 = new Int16Array(ab);
      const float32 = pcm16leToFloat32(int16);

      const frameCount = float32.length / channels;
      if (!Number.isInteger(frameCount)) return;

      const buffer = ctx.createBuffer(channels, frameCount, sampleRate);
      buffer.getChannelData(0).set(float32);

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(gainNode);

      const now = ctx.currentTime;
      if (nextStartTime < now + 0.02) nextStartTime = now + 0.02;
      src.start(nextStartTime);
      nextStartTime += buffer.duration;
    });

    ws.addEventListener("error", async () => {
      updateStatus("Error");
      if (
        ws.readyState !== WebSocket.CLOSING &&
        ws.readyState !== WebSocket.CLOSED
      ) {
        ws.close();
      }
    });

    ws.addEventListener("close", async () => {
      updateStatus("Disconnected");
      setMicEnabled(false); // WS closed => disallow mic
      await stopMic(); // WS closed => auto close mic
      await reconnect();
    });
  }
})();
