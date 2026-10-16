let audioStream = null;
let audioContext = null;
let processor = null;
let source = null;
let silentGain = null;
let sampleBuffer = [];
let sampleCount = 0;
let tabId = null;
let targetLanguage = "hi";

// Chunks wait in a queue instead of being dropped while the backend is busy.
let queue = [];
let workerRunning = false;
// Bumped on every start/stop so results from an old session are discarded.
let sessionId = 0;

const CHUNK_SECONDS = 5;
const MAX_QUEUE = 6; // if the backend falls behind, drop the oldest audio
const API = "http://127.0.0.1:8000";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "offscreen") return false;

  if (message.type === "START_CAPTURE") {
    startCapture(message.streamId, message.tabId, message.targetLanguage)
      .then(() => sendResponse({ success: true }))
      .catch((error) =>
        sendResponse({
          success: false,
          error: error.message || String(error)
        })
      );
    return true; // async response
  }

  if (message.type === "STOP_CAPTURE") {
    cleanup();
    sendResponse({ success: true });
    return false;
  }

  return false;
});

async function startCapture(streamId, activeTabId, language) {
  cleanup();

  tabId = activeTabId;
  targetLanguage = language || "hi";

  try {
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

    // If the tab closes or the stream ends by itself, tell the background.
    audioStream.getAudioTracks().forEach((track) => {
      track.onended = () => {
        cleanup();
        chrome.runtime.sendMessage({ type: "CAPTURE_STOPPED" }).catch(() => {});
      };
    });

    audioContext = new AudioContext();
    await audioContext.resume();

    source = audioContext.createMediaStreamSource(audioStream);

    // Capturing a tab mutes it, so play the audio back to keep it audible.
    source.connect(audioContext.destination);

    processor = audioContext.createScriptProcessor(4096, 1, 1);
    silentGain = audioContext.createGain();
    silentGain.gain.value = 0;

    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(audioContext.destination);

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      sampleBuffer.push(new Float32Array(input));
      sampleCount += input.length;

      if (sampleCount >= audioContext.sampleRate * CHUNK_SECONDS) {
        enqueueChunk(sampleBuffer, audioContext.sampleRate);
        sampleBuffer = [];
        sampleCount = 0;
      }
    };

    console.log("LiveSub capture active:", audioContext.sampleRate, "Hz");
  } catch (error) {
    console.error("Audio capture failed:", error);
    cleanup();
    throw error;
  }
}

function enqueueChunk(chunks, sampleRate) {
  queue.push({ chunks, sampleRate, session: sessionId });

  while (queue.length > MAX_QUEUE) {
    queue.shift();
    console.warn("Backend is behind; dropped the oldest audio chunk.");
  }

  runQueue();
}

async function runQueue() {
  if (workerRunning) return;
  workerRunning = true;

  try {
    while (queue.length > 0) {
      const job = queue.shift();
      if (job.session !== sessionId) continue; // stale

      try {
        await processAudio(job);
      } catch (error) {
        console.error("Audio processing failed:", error);
      }
    }
  } finally {
    workerRunning = false;
  }
}

async function processAudio(job) {
  const total = job.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const samples = new Float32Array(total);
  let offset = 0;

  for (const chunk of job.chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }

  const wav = createWav(samples, job.sampleRate);
  const form = new FormData();
  form.append("file", wav, "audio.wav");

  const response = await fetch(`${API}/transcribe-file`, {
    method: "POST",
    body: form
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error("Transcription API returned " + response.status + " " + detail);
  }

  const result = await response.json();
  if (job.session !== sessionId) return;

  // Join all segments of the chunk into one subtitle so they don't
  // replace each other within milliseconds.
  const original = (result.segments || [])
    .map((segment) => (segment.text || "").trim())
    .filter(Boolean)
    .join(" ");

  if (!original) return;

  const sourceLanguage = result.language || "auto";
  let translated = original;
  let translationError = "";

  try {
    const translationResponse = await fetch(`${API}/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: original,
        source_lang: sourceLanguage,
        target_lang: targetLanguage
      })
    });

    if (translationResponse.ok) {
      const translatedResult = await translationResponse.json();
      translated = translatedResult.translated_text || original;
    } else {
      // Log the backend's error text so the real cause is visible.
      const detail = await translationResponse.text().catch(() => "");
      console.error(
        "Translation API returned",
        translationResponse.status,
        detail
      );
      translationError = `Translation error ${translationResponse.status}`;
    }
  } catch (error) {
    console.error("Translation request failed:", error);
    translationError = "Cannot reach translation service";
  }

  if (job.session !== sessionId) return;

  // Offscreen documents cannot use chrome.tabs, so go through the
  // background service worker.
  chrome.runtime
    .sendMessage({
      type: "SUBTITLE",
      tabId,
      originalText: original,
      translatedText: translationError || translated,
      sourceLanguage: sourceLanguage.toUpperCase(),
      targetLanguage: targetLanguage.toUpperCase()
    })
    .catch(console.error);
}

function createWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  function writeString(offset, value) {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(
      44 + i * 2,
      sample < 0 ? sample * 32768 : sample * 32767,
      true
    );
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function cleanup() {
  sessionId++;
  queue = [];

  if (processor) {
    processor.disconnect();
    processor.onaudioprocess = null;
    processor = null;
  }

  source?.disconnect();
  silentGain?.disconnect();
  source = null;
  silentGain = null;

  if (audioStream) {
    audioStream.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    audioStream = null;
  }

  if (audioContext) {
    audioContext.close().catch(console.error);
    audioContext = null;
  }

  sampleBuffer = [];
  sampleCount = 0;
  console.log("LiveSub capture stopped.");
}