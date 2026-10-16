const startButton = document.getElementById("start");
const languageSelect = document.getElementById("language");
const status = document.getElementById("status");

const testSpeechButton = document.getElementById("testSpeech");
const sourceLanguage = document.getElementById("sourceLanguage");
const transcript = document.getElementById("transcript");

let isRunning = false;

function renderState() {
  startButton.textContent = isRunning ? "Stop LiveSub" : "Start LiveSub";
}

// The popup closes whenever it loses focus, so ask the background whether
// a capture is already running each time it opens.
async function refreshState() {
  try {
    const res = await chrome.runtime.sendMessage({ action: "GET_STATUS" });
    isRunning = !!res?.running;
    if (isRunning) {
      status.textContent = "Listening to the video audio...";
    }
  } catch (error) {
    isRunning = false;
  }
  renderState();
}

refreshState();

startButton.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab?.id || !tab.url?.startsWith("https://www.youtube.com/")) {
    status.textContent = "Please open a YouTube video first.";
    return;
  }

  try {
    if (!isRunning) {
      status.textContent = "Starting...";

      const res = await chrome.runtime.sendMessage({
        action: "START_AUDIO_CAPTURE",
        tabId: tab.id,
        targetLanguage: languageSelect.value
      });

      if (!res?.success) {
        status.textContent = res?.error || "Could not start capture.";
        return;
      }

      isRunning = true;
      status.textContent = "Listening to the video audio...";
    } else {
      await chrome.runtime.sendMessage({ action: "STOP_AUDIO_CAPTURE" });

      // The overlay may not exist if the page was never refreshed.
      await chrome.tabs
        .sendMessage(tab.id, { action: "STOP_LIVESUB" })
        .catch(() => {});

      isRunning = false;
      status.textContent = "LiveSub stopped.";
    }
  } catch (error) {
    status.textContent = "Error: " + (error.message || error);
  }

  renderState();
});

// Speech recognition test (unchanged)
testSpeechButton.addEventListener("click", () => {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    transcript.textContent = "Speech recognition is not supported here.";
    return;
  }

  const recognition = new SpeechRecognition();

  recognition.lang = sourceLanguage.value;
  recognition.continuous = false;
  recognition.interimResults = true;

  transcript.textContent = "Listening... Please speak.";

  recognition.onresult = (event) => {
    let words = "";

    for (let i = 0; i < event.results.length; i++) {
      words += event.results[i][0].transcript + " ";
    }

    transcript.textContent = words.trim();
  };

  recognition.onerror = (event) => {
    transcript.textContent = "Recognition error: " + event.error;
  };

  recognition.onend = () => {
    if (transcript.textContent === "Listening... Please speak.") {
      transcript.textContent = "No speech detected. Please try again.";
    }
  };

  try {
    recognition.start();
  } catch (error) {
    transcript.textContent = "Could not start. Close and reopen LiveSub.";
  }
});