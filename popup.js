const elements = {
  tabTitle: document.getElementById("tab-title"),
  statusText: document.getElementById("status-text"),
  errorText: document.getElementById("error-text"),
  volumeSlider: document.getElementById("volume-slider"),
  volumeValue: document.getElementById("volume-value"),
  muteButton: document.getElementById("mute-button"),
  resetButton: document.getElementById("reset-button")
};

let activeTabId = null;
let currentState = null;
let isBusy = false;

document.addEventListener("DOMContentLoaded", initializePopup);

async function initializePopup() {
  try {
    const tab = await getActiveTab();
    activeTabId = tab.id;

    const response = await chrome.runtime.sendMessage({
      type: "GET_TAB_AUDIO_STATE",
      tabId: activeTabId
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not load tab audio state.");
    }

    currentState = response.state;
    renderState(currentState);
    bindEvents();
  } catch (error) {
    console.error("[Browser Toolbox] Failed to initialize popup:", error);
    elements.tabTitle.textContent = "Unable to load tab";
    setUiBusy(true);
    showError(error.message || "Unable to initialize popup.");
  }
}

function bindEvents() {
  elements.volumeSlider.addEventListener("input", () => {
    elements.volumeValue.textContent = `${elements.volumeSlider.value}%`;
  });

  elements.volumeSlider.addEventListener("change", async () => {
    await withBusyState(async () => {
      clearError();

      const response = await chrome.runtime.sendMessage({
        type: "SET_TAB_VOLUME",
        tabId: activeTabId,
        volume: Number(elements.volumeSlider.value)
      });

      if (!response?.ok) {
        throw new Error(response?.error || "Could not update tab volume.");
      }

      currentState = response.state;
      renderState(currentState);
    });
  });

  elements.muteButton.addEventListener("click", async () => {
    await withBusyState(async () => {
      clearError();

      const response = await chrome.runtime.sendMessage({
        type: "TOGGLE_TAB_MUTE",
        tabId: activeTabId
      });

      if (!response?.ok) {
        throw new Error(response?.error || "Could not update mute state.");
      }

      currentState = response.state;
      renderState(currentState);
    });
  });

  elements.resetButton.addEventListener("click", async () => {
    await withBusyState(async () => {
      clearError();

      const response = await chrome.runtime.sendMessage({
        type: "RESET_TAB_VOLUME",
        tabId: activeTabId
      });

      if (!response?.ok) {
        throw new Error(response?.error || "Could not reset tab audio.");
      }

      currentState = response.state;
      renderState(currentState);
    });
  });
}

function renderState(state) {
  currentState = state;
  elements.tabTitle.textContent = state.title || "Untitled tab";
  elements.statusText.textContent = state.statusText || "Ready to control this tab";
  elements.volumeSlider.value = String(state.volume ?? 100);
  elements.volumeValue.textContent = `${state.volume ?? 100}%`;
  elements.muteButton.textContent = state.muted ? "Unmute" : "Mute";
  elements.muteButton.classList.toggle("button--muted", Boolean(state.muted));

  if (state.error) {
    showError(state.error);
  } else {
    clearError();
  }

  setUiBusy(false);
}

function showError(message) {
  elements.errorText.hidden = false;
  elements.errorText.textContent = message;
}

function clearError() {
  elements.errorText.hidden = true;
  elements.errorText.textContent = "";
}

function setUiBusy(busy) {
  isBusy = busy;
  elements.volumeSlider.disabled = busy;
  elements.muteButton.disabled = busy;
  elements.resetButton.disabled = busy;
}

async function withBusyState(work) {
  if (isBusy) {
    return;
  }

  setUiBusy(true);

  try {
    await work();
  } catch (error) {
    console.error("[Browser Toolbox] Popup action failed:", error);
    showError(error.message || "Action failed.");

    if (currentState) {
      setUiBusy(false);
    }
  } finally {
    if (!currentState?.error) {
      setUiBusy(false);
    }
  }
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tabs.length || typeof tabs[0].id !== "number") {
    throw new Error("No active tab found.");
  }

  return tabs[0];
}
