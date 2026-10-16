const OVERLAY_ID = "livesub-overlay";
const HIDE_AFTER_MS = 6000;
let hideTimer = null;

// The overlay lives inside the YouTube player so it is visible in normal,
// theatre and full-screen modes (only the full-screen element's subtree is
// drawn in full screen, so appending to <body> would be invisible there).
function getHost() {
  return (
    document.querySelector("#movie_player") ||
    document.fullscreenElement ||
    document.body
  );
}

function getOverlay() {
  const host = getHost();
  let box = document.getElementById(OVERLAY_ID);

  if (!box) {
    box = document.createElement("div");
    box.id = OVERLAY_ID;
    box.style.cssText = `
      left: 50%;
      bottom: 12%;
      transform: translateX(-50%);
      z-index: 2147483647;
      background: rgba(0, 0, 0, 0.85);
      color: white;
      padding: 14px 22px;
      border-radius: 10px;
      text-align: center;
      font-family: Arial, sans-serif;
      font-size: 20px;
      min-width: 250px;
      max-width: 80%;
      pointer-events: none;
    `;
  }

  box.style.position = host === document.body ? "fixed" : "absolute";

  if (box.parentElement !== host) {
    host.appendChild(box);
  }

  return box;
}

function showTranslatedSubtitle(original, translated, sourceLang, targetLang) {
  const box = getOverlay();

  const originalLine = document.createElement("div");
  originalLine.textContent = sourceLang
    ? `${original}  [${sourceLang}]`
    : original;
  originalLine.style.cssText = "color:#93c5fd; margin-bottom:8px;";

  const translatedLine = document.createElement("div");
  translatedLine.textContent = translated;
  translatedLine.title = targetLang || "";

  box.replaceChildren(originalLine, translatedLine);

  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideLiveSub, HIDE_AFTER_MS);
}

function hideLiveSub() {
  clearTimeout(hideTimer);
  document.getElementById(OVERLAY_ID)?.remove();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "SHOW_TRANSLATED_SUBTITLE") {
    showTranslatedSubtitle(
      message.originalText,
      message.translatedText,
      message.sourceLanguage,
      message.targetLanguage
    );
  }

  if (message.action === "STOP_LIVESUB") {
    hideLiveSub();
  }
});

// YouTube changes videos without reloading the page: clear old subtitles.
document.addEventListener("yt-navigate-start", hideLiveSub);