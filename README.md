# Browser Toolbox

Browser Toolbox is a Chrome extension built with Manifest V3 that gives you two practical browser utilities in one place:

- Per-tab audio control with real volume adjustment from `0%` to `200%`
- Right-click image conversion and download as `PNG`, `JPG`, or `WebP`

It is built with plain JavaScript, a background service worker, and an offscreen audio pipeline for tab volume control.

## Features

### Per-tab volume control

- Adjust the active tab's volume from `0%` to `200%`
- Mute and unmute the current tab
- Reset the active tab back to normal volume
- Uses `chrome.tabCapture` with an offscreen document and `AudioContext`
- Keeps audio playing to the user while the tab is being processed

### Image converter

Right-click any image in Chrome and choose:

- `Download as PNG`
- `Download as JPG`
- `Download as WebP`

The extension fetches the image, converts it with canvas, and downloads it with the selected format.

## Installation

To install Browser Toolbox as an unpacked extension:

1. Download or clone this repository.
2. Open Chrome and go to `chrome://extensions/`.
3. Turn on `Developer mode` in the top-right corner.
4. Click `Load unpacked`.
5. Select this project folder.

After loading, the Browser Toolbox icon should appear in your Chrome toolbar.

## How To Use

### Control tab volume

1. Open the tab you want to control.
2. Click the Browser Toolbox extension icon.
3. Move the volume slider to set the tab from `0%` to `200%`.
4. Use `Mute` to silence the tab without losing the current slider position.
5. Use `Reset` to return the tab to `100%` volume and clear mute.

Note:
The first volume or mute interaction starts secure tab capture for that tab so the extension can route its audio through a gain control.

### Convert and download images

1. Right-click an image on any web page.
2. Open the `Browser Toolbox` context menu.
3. Choose `Download as PNG`, `Download as JPG`, or `Download as WebP`.
4. Save the converted image when Chrome prompts you.

## Permissions

Browser Toolbox uses the following Chrome permissions:

- `activeTab`
  Used to work with the current tab from the popup.
- `tabs`
  Used to read tab information and track tab lifecycle for audio cleanup.
- `tabCapture`
  Used for real per-tab audio capture and volume control.
- `offscreen`
  Used to run audio processing in an offscreen document.
- `contextMenus`
  Used to show right-click image conversion options.
- `downloads`
  Used to save converted images to the user's device.
- `host_permissions: <all_urls>`
  Used so the extension can fetch images from sites for format conversion.

## Project Structure

```text
manifest.json
background.js
popup.html
popup.js
styles.css
offscreen.html
offscreen.js
README.md
```

## Technical Notes

- Built for Chrome using Manifest V3
- Uses a background service worker for extension coordination
- Uses an offscreen document for audio processing because service workers do not have DOM or Web Audio access
- Uses `AudioContext`, `MediaStreamAudioSourceNode`, and `GainNode` for per-tab volume control
- Uses canvas-based image conversion for PNG, JPG, and WebP downloads

## Limitations

- Tab volume control depends on Chrome's tab capture support
- Some image URLs may refuse fetch requests from extensions because of remote server restrictions
- The extension is currently designed for Chrome and Chromium-based browsers with MV3 support

## Development

If you want to edit or test the extension locally:

1. Make your changes in the project files.
2. Open `chrome://extensions/`.
3. Click `Reload` on the Browser Toolbox extension card.
4. Test the popup and the right-click image tools.

## License

Add your preferred license here if you want others to know how they can use or modify this project.
