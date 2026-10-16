const CAPTURE_KEY = "captureTabId";

// The service worker can be stopped and restarted by Chrome at any time,
// so the active capture tab is kept in session storage, not in a variable.
async function getCaptureTabId() {
  const data = await chrome.storage.session.get(CAPTURE_KEY);
  return data[CAPTURE_KEY] ?? null;
}

async function setCaptureTabId(id) {
  if (id === null) {
    await chrome.storage.session.remove(CAPTURE_KEY);
  } else {
    await chrome.storage.session.set({ [CAPTURE_KEY]: id });
  }
}

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"]
  });
  return contexts.length > 0;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Messages meant for the offscreen document are not ours.
  if (message.target === "offscreen") return false;

  if (message.action === "START_AUDIO_CAPTURE") {
    startAudioCapture(message.tabId, message.targetLanguage)
      .then(() => sendResponse({ success: true }))
      .catch((error) => {
        console.error("Audio capture failed:", error);
        sendResponse({
          success: false,
          error: error.message || "Could not start audio capture."
        });
      });
    return true;
  }

  if (message.action === "STOP_AUDIO_CAPTURE") {
    stopAudioCapture()
      .then(() => sendResponse({ success: true }))
      .catch((error) => {
        console.error("Audio stop failed:", error);
        sendResponse({
          success: false,
          error: error.message || "Could not stop audio capture."
        });
      });
    return true;
  }

  if (message.action === "GET_STATUS") {
    getCaptureTabId().then((id) => sendResponse({ running: id !== null }));
    return true;
  }

  // The offscreen document cannot use chrome.tabs, so it sends finished
  // subtitles here and we forward them to the YouTube tab.
  if (message.type === "SUBTITLE") {
    chrome.tabs
      .sendMessage(message.tabId, {
        action: "SHOW_TRANSLATED_SUBTITLE",
        originalText: message.originalText,
        translatedText: message.translatedText,
        sourceLanguage: message.sourceLanguage,
        targetLanguage: message.targetLanguage
      })
      .catch((error) => {
        console.warn(
          "Subtitle not delivered (refresh the YouTube tab?):",
          error.message
        );
      });
    return false;
  }

  // The tab stream ended on its own (tab closed, etc.).
  if (message.type === "CAPTURE_STOPPED") {
    setCaptureTabId(null);
    return false;
  }

  return false;
});

async function startAudioCapture(tabId, targetLanguage = "hi") {
  if (!tabId) {
    throw new Error("YouTube tab ID is missing.");
  }

  if ((await getCaptureTabId()) !== null) {
    await stopAudioCapture();
  }

  if (!(await hasOffscreenDocument())) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA"],
      justification: "Capture YouTube audio for LiveSub transcription."
    });
  }

  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tabId
  });

  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "START_CAPTURE",
    streamId,
    tabId,
    targetLanguage
  });

  if (!response?.success) {
    throw new Error(response?.error || "Offscreen capture did not start.");
  }

  await setCaptureTabId(tabId);
  console.log("NOVARQ audio capture started for tab:", tabId);
}

async function stopAudioCapture() {
  // Always tell the offscreen document to stop if it exists, even if the
  // service worker lost its own state after a restart.
  if (await hasOffscreenDocument()) {
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "STOP_CAPTURE"
    });
  }

  await setCaptureTabId(null);
  console.log("NOVARQ audio capture stopped.");
}