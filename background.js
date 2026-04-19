const EXTENSION_LOG_PREFIX = "[Browser Toolbox]";
const MENU_ROOT_ID = "browser-toolbox-image-convert";
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const MENU_ITEMS = [
  { id: "download-as-png", title: "Download as PNG", format: "png", mimeType: "image/png" },
  { id: "download-as-jpg", title: "Download as JPG", format: "jpg", mimeType: "image/jpeg" },
  { id: "download-as-webp", title: "Download as WebP", format: "webp", mimeType: "image/webp" }
];

let creatingOffscreenDocument = null;

/**
 * Lightweight state mirrored in the service worker so the popup can render quickly.
 * The offscreen document owns the real audio graph and reports the latest state back here.
 */
const tabAudioState = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await registerContextMenus();
  } catch (error) {
    console.error(`${EXTENSION_LOG_PREFIX} Failed to register context menus on install:`, error);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    await registerContextMenus();
  } catch (error) {
    console.error(`${EXTENSION_LOG_PREFIX} Failed to register context menus on startup:`, error);
  }
});

chrome.contextMenus.onClicked.addListener((info) => {
  const menuItem = MENU_ITEMS.find((item) => item.id === info.menuItemId);
  if (!menuItem) {
    return;
  }

  if (!info.srcUrl) {
    console.error(`${EXTENSION_LOG_PREFIX} Image conversion aborted: context menu click did not include an image URL.`, info);
    return;
  }

  convertAndDownloadImage(info.srcUrl, menuItem).catch((error) => {
    console.error(`${EXTENSION_LOG_PREFIX} Image conversion failed for ${info.srcUrl}:`, error);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target === "offscreen") {
    return false;
  }

  handleRuntimeMessage(message)
    .then((response) => sendResponse({ ok: true, ...response }))
    .catch((error) => {
      console.error(`${EXTENSION_LOG_PREFIX} Runtime message failed:`, error);
      sendResponse({ ok: false, error: error.message || "Unknown error" });
    });

  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cleanupTabAudio(tabId).catch((error) => {
    console.error(`${EXTENSION_LOG_PREFIX} Failed to clean up tab ${tabId}:`, error);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tabAudioState.has(tabId)) {
    return;
  }

  const currentState = tabAudioState.get(tabId);
  tabAudioState.set(tabId, {
    ...currentState,
    title: changeInfo.title || tab.title || currentState.title || "Untitled tab"
  });
});

chrome.tabCapture.onStatusChanged.addListener((info) => {
  const currentState = tabAudioState.get(info.tabId);
  if (!currentState) {
    return;
  }

  const captureActive = info.status === "active";
  tabAudioState.set(info.tabId, {
    ...currentState,
    captureActive,
    pipelineInitialized: captureActive ? currentState.pipelineInitialized : false,
    statusText: buildStatusText({
      ...currentState,
      captureActive,
      pipelineInitialized: captureActive ? currentState.pipelineInitialized : false
    })
  });

  console.log(`${EXTENSION_LOG_PREFIX} tabCapture status for tab ${info.tabId}: ${info.status}`);
});

async function handleRuntimeMessage(message) {
  if (!message?.type) {
    throw new Error("Missing message type.");
  }

  if (message.type === "GET_TAB_AUDIO_STATE") {
    return {
      state: await getOrCreateTabState(message.tabId)
    };
  }

  if (message.type === "SET_TAB_VOLUME") {
    return {
      state: await ensureAudioPipelineAndSetVolume(message.tabId, message.volume)
    };
  }

  if (message.type === "TOGGLE_TAB_MUTE") {
    return {
      state: await ensureAudioPipelineAndToggleMute(message.tabId)
    };
  }

  if (message.type === "RESET_TAB_VOLUME") {
    return {
      state: await resetTabAudio(message.tabId)
    };
  }

  if (message.type === "OFFSCREEN_STATE_UPDATE") {
    const state = mergeOffscreenState(message.state);
    return { state };
  }

  throw new Error(`Unsupported message type: ${message.type}`);
}

async function registerContextMenus() {
  await chrome.contextMenus.removeAll();

  chrome.contextMenus.create({
    id: MENU_ROOT_ID,
    title: "Browser Toolbox",
    contexts: ["image"]
  });

  for (const item of MENU_ITEMS) {
    chrome.contextMenus.create({
      id: item.id,
      parentId: MENU_ROOT_ID,
      title: item.title,
      contexts: ["image"]
    });
  }
}

async function getOrCreateTabState(tabId) {
  validateTabId(tabId);

  const tab = await chrome.tabs.get(tabId);
  const existingState = tabAudioState.get(tabId);
  const nextState = {
    tabId,
    title: tab.title || existingState?.title || "Untitled tab",
    volume: existingState?.volume ?? 100,
    muted: existingState?.muted ?? Boolean(tab.mutedInfo?.muted),
    captureActive: existingState?.captureActive ?? false,
    pipelineInitialized: existingState?.pipelineInitialized ?? false,
    statusText: existingState?.statusText || buildStatusText(existingState),
    error: existingState?.error || ""
  };

  nextState.statusText = buildStatusText(nextState);
  tabAudioState.set(tabId, nextState);
  return nextState;
}

async function ensureAudioPipelineAndSetVolume(tabId, volume) {
  const safeVolume = normalizeVolume(volume);
  const state = await getOrCreateTabState(tabId);

  if (!state.pipelineInitialized) {
    await startTabAudioControl(tabId, safeVolume, state.muted);
  } else {
    await sendMessageToOffscreen({
      type: "SET_VOLUME",
      target: "offscreen",
      tabId,
      volume: safeVolume
    });
  }

  const nextState = mergeOffscreenState({
    tabId,
    volume: safeVolume
  });

  console.log(`${EXTENSION_LOG_PREFIX} Volume updated for tab ${tabId}: ${safeVolume}%`);
  return nextState;
}

async function ensureAudioPipelineAndToggleMute(tabId) {
  const state = await getOrCreateTabState(tabId);

  if (!state.pipelineInitialized) {
    await startTabAudioControl(tabId, state.volume, !state.muted);
  } else {
    await sendMessageToOffscreen({
      type: "TOGGLE_MUTE",
      target: "offscreen",
      tabId
    });
  }

  const latestState = await requestOffscreenState(tabId);
  console.log(`${EXTENSION_LOG_PREFIX} Mute toggled for tab ${tabId}: ${latestState.muted ? "muted" : "unmuted"}`);
  return latestState;
}

async function resetTabAudio(tabId) {
  const state = await getOrCreateTabState(tabId);

  if (!state.pipelineInitialized) {
    await startTabAudioControl(tabId, 100, false);
  } else {
    await sendMessageToOffscreen({
      type: "RESET_AUDIO",
      target: "offscreen",
      tabId
    });
  }

  const latestState = await requestOffscreenState(tabId);
  console.log(`${EXTENSION_LOG_PREFIX} Audio reset for tab ${tabId}`);
  return latestState;
}

async function startTabAudioControl(tabId, volume, muted) {
  validateTabId(tabId);
  await ensureOffscreenDocument();

  console.log(`${EXTENSION_LOG_PREFIX} Starting tab capture for tab ${tabId}`);

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (error) {
    throw new Error(`Failed to get tab capture stream ID: ${error.message}`);
  }

  if (!streamId) {
    throw new Error("Failed to get tab capture stream ID.");
  }

  console.log(`${EXTENSION_LOG_PREFIX} Stream ID requested for tab ${tabId}`);

  const state = await getOrCreateTabState(tabId);
  tabAudioState.set(tabId, {
    ...state,
    volume,
    muted,
    error: "",
    statusText: "Starting audio control..."
  });

  try {
    const response = await sendMessageToOffscreen({
      type: "INIT_TAB_AUDIO",
      target: "offscreen",
      tabId,
      streamId,
      volume,
      muted
    });

    mergeOffscreenState(response.state);
  } catch (error) {
    const failedState = mergeOffscreenState({
      tabId,
      captureActive: false,
      pipelineInitialized: false,
      statusText: "Audio control unavailable",
      error: error.message
    });

    console.error(`${EXTENSION_LOG_PREFIX} Failed to initialize audio pipeline:`, error);
    throw new Error(failedState.error);
  }
}

async function cleanupTabAudio(tabId) {
  if (!tabAudioState.has(tabId)) {
    return;
  }

  console.log(`${EXTENSION_LOG_PREFIX} Cleaning up audio pipeline for tab ${tabId}`);

  try {
    await ensureOffscreenDocument();
    await sendMessageToOffscreen({
      type: "CLEANUP_TAB_AUDIO",
      target: "offscreen",
      tabId
    });
  } catch (error) {
    console.error(`${EXTENSION_LOG_PREFIX} Cleanup request failed for tab ${tabId}:`, error);
  } finally {
    tabAudioState.delete(tabId);
  }
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);

  if ("getContexts" in chrome.runtime) {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });

    if (existingContexts.length > 0) {
      console.log(`${EXTENSION_LOG_PREFIX} Offscreen document ready`);
      return;
    }
  }

  if (creatingOffscreenDocument) {
    await creatingOffscreenDocument;
    return;
  }

  console.log(`${EXTENSION_LOG_PREFIX} Creating offscreen document`);

  creatingOffscreenDocument = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ["USER_MEDIA"],
    justification: "Process captured tab audio through an AudioContext gain pipeline."
  });

  try {
    await creatingOffscreenDocument;
    console.log(`${EXTENSION_LOG_PREFIX} Offscreen document ready`);
  } finally {
    creatingOffscreenDocument = null;
  }
}

async function requestOffscreenState(tabId) {
  const response = await sendMessageToOffscreen({
    type: "GET_TAB_AUDIO_STATE",
    target: "offscreen",
    tabId
  });

  return mergeOffscreenState(response.state);
}

async function sendMessageToOffscreen(message) {
  await ensureOffscreenDocument();

  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error || "Offscreen document did not respond successfully.");
  }

  return response;
}

function mergeOffscreenState(partialState) {
  if (!partialState || typeof partialState.tabId !== "number") {
    throw new Error("Invalid tab audio state received.");
  }

  const currentState = tabAudioState.get(partialState.tabId) ?? {
    tabId: partialState.tabId,
    title: "Untitled tab",
    volume: 100,
    muted: false,
    captureActive: false,
    pipelineInitialized: false,
    statusText: "Ready",
    error: ""
  };

  const nextState = {
    ...currentState,
    ...partialState
  };

  nextState.volume = normalizeVolume(nextState.volume);
  nextState.muted = Boolean(nextState.muted);
  nextState.captureActive = Boolean(nextState.captureActive);
  nextState.pipelineInitialized = Boolean(nextState.pipelineInitialized);
  nextState.error = nextState.error || "";
  nextState.statusText = nextState.statusText || buildStatusText(nextState);

  tabAudioState.set(nextState.tabId, nextState);
  return nextState;
}

function buildStatusText(state) {
  if (!state) {
    return "Ready to control this tab";
  }

  if (state.error) {
    return "Audio control unavailable";
  }

  if (state.pipelineInitialized) {
    return "Audio control active";
  }

  if (state.captureActive) {
    return "Capture active";
  }

  return "Ready to control this tab";
}

function validateTabId(tabId) {
  if (typeof tabId !== "number") {
    throw new Error("Missing or invalid tab id.");
  }
}

function normalizeVolume(value) {
  return Math.max(0, Math.min(200, Number(value) || 0));
}

async function convertAndDownloadImage(imageUrl, output) {
  if (!imageUrl || typeof imageUrl !== "string") {
    throw new Error("Missing or invalid image URL.");
  }

  if (!output?.format || !output.mimeType) {
    throw new Error("Missing output format configuration.");
  }

  let response;
  let convertedBlob;

  try {
    response = await fetch(imageUrl, {
      credentials: "include",
      cache: "no-store"
    });
  } catch (error) {
    throw new Error(`Failed to fetch image URL: ${error.message}`);
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
  }

  const sourceBlob = await response.blob();
  if (!sourceBlob || sourceBlob.size === 0) {
    throw new Error("Fetched image blob is empty.");
  }

  try {
    convertedBlob = await convertImageBlob(sourceBlob, output);
  } catch (error) {
    throw new Error(`Image conversion failed: ${error.message}`);
  }

  if (!convertedBlob || convertedBlob.size === 0) {
    throw new Error("Canvas conversion returned an empty blob.");
  }

  const filename = buildConvertedFilename(imageUrl, response.url, output.format);
  const downloadUrl = await blobToDataUrl(convertedBlob);

  if (!downloadUrl) {
    throw new Error("Could not create a downloadable data URL.");
  }

  let downloadId;

  try {
    downloadId = await chrome.downloads.download({
      url: downloadUrl,
      filename,
      saveAs: true
    });
  } catch (error) {
    throw new Error(`Download failed: ${error.message}`);
  }

  if (typeof downloadId !== "number") {
    throw new Error("Download API did not return a valid download id.");
  }
}

async function convertImageBlob(sourceBlob, output) {
  const bitmap = await createImageBitmap(sourceBlob);

  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error("Could not create canvas rendering context.");
    }

    if (output.format === "jpg") {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
    }

    context.drawImage(bitmap, 0, 0);

    return canvas.convertToBlob({
      type: output.mimeType,
      quality: output.format === "jpg" ? 0.92 : 0.95
    });
  } finally {
    bitmap.close();
  }
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onloadend = () => {
      if (typeof reader.result !== "string" || !reader.result) {
        reject(new Error("FileReader did not produce a data URL."));
        return;
      }

      resolve(reader.result);
    };

    reader.onerror = () => {
      reject(reader.error || new Error("Failed to read converted blob as a data URL."));
    };

    reader.readAsDataURL(blob);
  });
}

function buildConvertedFilename(originalUrl, resolvedUrl, extension) {
  const candidateUrl = resolvedUrl || originalUrl;
  const rawName = extractFilenameFromUrl(candidateUrl);
  const decodedName = safelyDecodeURIComponent(rawName);
  const baseName = decodedName.replace(/\.(png|jpe?g|webp|gif|bmp|svg|avif|ico)$/i, "") || "image";
  const sanitizedBaseName = sanitizeFilename(baseName);

  return `${sanitizedBaseName}.${extension}`;
}

function extractFilenameFromUrl(url) {
  try {
    const parsedUrl = new URL(url);
    const pathname = parsedUrl.pathname || "";
    const lastSegment = pathname.split("/").pop();

    if (lastSegment) {
      return lastSegment;
    }
  } catch (error) {
    console.error(`${EXTENSION_LOG_PREFIX} Failed to parse image URL for filename, falling back to a generic name:`, error);
  }

  return "image";
}

function safelyDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sanitizeFilename(value) {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "image";
}
