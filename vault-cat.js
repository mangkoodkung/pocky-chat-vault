/*
 * The cat's body: which drawing each health state gets, and where the cat sits
 * on screen.
 *
 * What is deliberately NOT here is the cat's behaviour — the drag handling, the
 * tap-to-open-menu wiring, and the menu itself stay in index.js, because they
 * are tangled with the menu's own state and will move out in a later, more
 * careful step. This module is only the parts with clean edges: artwork lookup
 * (pure given the identity constants) and position persistence (touches
 * settings, nothing else).
 */

import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";
import { extensionFolderPath, extensionName, extensionVersion } from "./vault-env.js";
import { clamp } from "./vault-format.js";

// One drawing per health state. The file names describe what the user sees,
// while the keys stay tied to the health states in vault-health.js.
const CAT_HEALTH_IMAGE_FILES = {
    idle: "idle.png",
    healthy: "online.png",
    pending: "offline.png",
    attention: "disconnect.png",
};

export function getCatHealthImageUrl(state) {
    const fileName = CAT_HEALTH_IMAGE_FILES[state] || CAT_HEALTH_IMAGE_FILES.idle;

    return `${extensionFolderPath}/image/${fileName}?v=${extensionVersion}`;
}

// Warm the browser cache so the first state change swaps instantly instead of
// blanking the cat while the next drawing downloads.
export function preloadCatHealthImages() {
    for (const state of Object.keys(CAT_HEALTH_IMAGE_FILES)) {
        const preloaded = new Image();

        preloaded.src = getCatHealthImageUrl(state);
    }
}

/*
 * Position is stored as ratios of the available room, not as pixels, so the cat
 * keeps its relative place when the viewport changes — a phone rotating, a
 * desktop window resizing — instead of ending up stranded off-screen where it
 * can never be tapped again.
 */
export function placeCatFromSettings(cat) {
    const position = extension_settings[extensionName].catPosition;
    const maxLeft = Math.max(0, window.innerWidth - cat.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - cat.offsetHeight);
    const hasSavedPosition = Number.isFinite(position?.xRatio)
        && Number.isFinite(position?.yRatio);
    const left = hasSavedPosition
        ? clamp(position.xRatio * maxLeft, 0, maxLeft)
        : Math.max(0, maxLeft - 8);
    const top = hasSavedPosition
        ? clamp(position.yRatio * maxTop, 0, maxTop)
        : clamp(maxTop * 0.58, 0, maxTop);

    cat.style.left = `${Math.round(left)}px`;
    cat.style.top = `${Math.round(top)}px`;
}

export function saveCatPosition(cat) {
    const maxLeft = Math.max(0, window.innerWidth - cat.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - cat.offsetHeight);
    const left = clamp(Number.parseFloat(cat.style.left) || 0, 0, maxLeft);
    const top = clamp(Number.parseFloat(cat.style.top) || 0, 0, maxTop);

    extension_settings[extensionName].catPosition = {
        xRatio: maxLeft > 0 ? left / maxLeft : 0,
        yRatio: maxTop > 0 ? top / maxTop : 0,
    };
    saveSettingsDebounced();

    console.log(`[${extensionName}] Cat position saved`);
}
