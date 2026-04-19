const EXTENSION_LOG_PREFIX = "[Browser Toolbox]";

/**
 * Each tab gets its own audio pipeline:
 * MediaStream -> MediaStreamAudioSourceNode -> GainNode -> AudioDestinationNode
 *
 * Chrome suppresses the tab's original playback while it is captured, so routing the
 * captured stream back to the AudioContext destination is what lets the user keep
 * hearing the tab. Gain changes then become real per-tab volume control.
 */
const pipelines = new Map();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") {
    return false;
  }

  handleMessage(message)
    .then((response) => sendResponse({ ok: true, ...response }))
    .catch((error) => {
      console.error(`${EXTENSION_LOG_PREFIX} Offscreen message failed:`, error);
      sendResponse({ ok: false, error: error.message || "Unknown offscreen error" });
    });

  return true;
});

async function handleMessage(message) {
  if (message.type === "INIT_TAB_AUDIO") {
    const state = await initializeTabAudio(message);
    return { state };
  }

  if (message.type === "SET_VOLUME") {
    const state = await setTabVolume(message.tabId, message.volume);
    return { state };
  }

  if (message.type === "TOGGLE_MUTE") {
    const state = await toggleTabMute(message.tabId);
    return { state };
  }

  if (message.type === "RESET_AUDIO") {
    const state = await resetTabAudio(message.tabId);
    return { state };
  }

  if (message.type === "GET_TAB_AUDIO_STATE") {
    return { state: getTabState(message.tabId) };
  }

  if (message.type === "CLEANUP_TAB_AUDIO") {
    await cleanupTabAudio(message.tabId);
    return {
      state: {
        tabId: message.tabId,
        volume: 100,
        muted: false,
        captureActive: false,
        pipelineInitialized: false,
        statusText: "Ready to control this tab",
        error: ""
      }
    };
  }

  throw new Error(`Unsupported offscreen message type: ${message.type}`);
}

async function initializeTabAudio({ tabId, streamId, volume, muted }) {
  validateTabId(tabId);

  if (!streamId) {
    throw new Error("Missing stream ID.");
  }

  const existingPipeline = pipelines.get(tabId);
  if (existingPipeline) {
    await cleanupPipeline(existingPipeline);
    pipelines.delete(tabId);
  }

  console.log(`${EXTENSION_LOG_PREFIX} Starting audio pipeline for tab ${tabId}`);

  let stream;
  let audioContext;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

    audioContext = new AudioContext();
    await audioContext.resume();

    const sourceNode = audioContext.createMediaStreamSource(stream);
    const gainNode = audioContext.createGain();

    sourceNode.connect(gainNode);
    gainNode.connect(audioContext.destination);

    const pipeline = {
      tabId,
      stream,
      audioContext,
      sourceNode,
      gainNode,
      volume: normalizeVolume(volume),
      muted: Boolean(muted)
    };

    applyGain(pipeline);

    stream.getAudioTracks().forEach((track) => {
      track.addEventListener("ended", () => {
        console.log(`${EXTENSION_LOG_PREFIX} Captured stream ended for tab ${tabId}`);
        cleanupTabAudio(tabId).catch((error) => {
          console.error(`${EXTENSION_LOG_PREFIX} Failed to clean up ended stream for tab ${tabId}:`, error);
        });
      });
    });

    pipelines.set(tabId, pipeline);

    const state = getTabState(tabId);
    await notifyBackground(state);
    console.log(`${EXTENSION_LOG_PREFIX} Audio control active for tab ${tabId}`);
    return state;
  } catch (error) {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }

    if (audioContext) {
      await audioContext.close().catch(() => {});
    }

    throw new Error(`Failed to initialize audio pipeline: ${error.message}`);
  }
}

async function setTabVolume(tabId, volume) {
  const pipeline = getPipeline(tabId);
  pipeline.volume = normalizeVolume(volume);
  applyGain(pipeline);

  const state = getTabState(tabId);
  await notifyBackground(state);
  console.log(`${EXTENSION_LOG_PREFIX} Volume updated for tab ${tabId}: ${pipeline.volume}%`);
  return state;
}

async function toggleTabMute(tabId) {
  const pipeline = getPipeline(tabId);
  pipeline.muted = !pipeline.muted;
  applyGain(pipeline);

  const state = getTabState(tabId);
  await notifyBackground(state);
  console.log(`${EXTENSION_LOG_PREFIX} Mute toggled for tab ${tabId}: ${pipeline.muted ? "muted" : "unmuted"}`);
  return state;
}

async function resetTabAudio(tabId) {
  const pipeline = getPipeline(tabId);
  pipeline.volume = 100;
  pipeline.muted = false;
  applyGain(pipeline);

  const state = getTabState(tabId);
  await notifyBackground(state);
  console.log(`${EXTENSION_LOG_PREFIX} Audio reset for tab ${tabId}`);
  return state;
}

function getTabState(tabId) {
  const pipeline = pipelines.get(tabId);

  if (!pipeline) {
    return {
      tabId,
      volume: 100,
      muted: false,
      captureActive: false,
      pipelineInitialized: false,
      statusText: "Ready to control this tab",
      error: ""
    };
  }

  return {
    tabId,
    volume: pipeline.volume,
    muted: pipeline.muted,
    captureActive: true,
    pipelineInitialized: true,
    statusText: "Audio control active",
    error: ""
  };
}

async function cleanupTabAudio(tabId) {
  const pipeline = pipelines.get(tabId);
  if (!pipeline) {
    return;
  }

  console.log(`${EXTENSION_LOG_PREFIX} Cleaning up offscreen pipeline for tab ${tabId}`);
  await cleanupPipeline(pipeline);
  pipelines.delete(tabId);

  await notifyBackground({
    tabId,
    volume: pipeline.volume,
    muted: pipeline.muted,
    captureActive: false,
    pipelineInitialized: false,
    statusText: "Ready to control this tab",
    error: ""
  });
}

async function cleanupPipeline(pipeline) {
  try {
    pipeline.sourceNode.disconnect();
  } catch {}

  try {
    pipeline.gainNode.disconnect();
  } catch {}

  if (pipeline.stream) {
    pipeline.stream.getTracks().forEach((track) => track.stop());
  }

  if (pipeline.audioContext && pipeline.audioContext.state !== "closed") {
    await pipeline.audioContext.close();
  }
}

function applyGain(pipeline) {
  const nextGain = pipeline.muted ? 0 : pipeline.volume / 100;
  pipeline.gainNode.gain.value = nextGain;
}

function getPipeline(tabId) {
  validateTabId(tabId);

  const pipeline = pipelines.get(tabId);
  if (!pipeline) {
    throw new Error("Audio pipeline is not initialized for this tab yet.");
  }

  return pipeline;
}

async function notifyBackground(state) {
  try {
    await chrome.runtime.sendMessage({
      type: "OFFSCREEN_STATE_UPDATE",
      tabId: state.tabId,
      state
    });
  } catch (error) {
    console.error(`${EXTENSION_LOG_PREFIX} Failed to notify background of tab state update:`, error);
  }
}

function validateTabId(tabId) {
  if (typeof tabId !== "number") {
    throw new Error("Missing or invalid tab id.");
  }
}

function normalizeVolume(value) {
  return Math.max(0, Math.min(200, Number(value) || 0));
}
