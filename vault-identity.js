/*
 * Who this extension is, and where this copy of it lives.
 *
 * These four values used to be constants at the top of index.js, and everything
 * in that file could simply see them. Splitting index.js into modules broke that
 * arrangement: the About card needs the display name, the cat needs the folder
 * path for its artwork, and a module cannot import those back out of index.js
 * without creating a cycle. Identity therefore moved to the one place with no
 * reason to import anything — this file depends on nothing, so everything may
 * depend on it.
 *
 * Nothing here is behaviour. If a change to this file does more than rename the
 * extension or bump its version, it is in the wrong file.
 *
 * Renamed from vault-env.js in 1.5.2: "env" reads as a secrets file to anyone
 * who has ever seen a .env, and this file must never be mistakable for one —
 * it holds nothing but the four public identity values below. If a value is
 * ever secret, it does not belong in this file, or in this repository at all.
 */

// Settings key. This is an identity, not a location: it must stay stable forever,
// because every user's saved settings live under this key. Renaming it would
// orphan their settings and silently reset the extension to defaults.
export const extensionName = "sillytavern-chat-vault";

// Bumped on every release. The value feeds the ?v= cache-busting query on the
// files the extension fetches by path, so a release that forgets to change it is
// a release whose users keep seeing the previous settings panel and artwork.
// (Release checklists that said index.js for this value now mean this file.)
export const extensionVersion = "1.5.2";

// The name the user sees — menu headings, toast titles, the settings panel.
// Deliberately separate from extensionName above: that one is a storage key and
// must never move, this one is free to be rebranded.
export const extensionDisplayName = "Pocky chat vault";

// Where this copy is actually installed. Derived from this module's own URL
// rather than assembled from extensionName, because the install folder is named
// after whatever repository or ZIP the user installed from — it is not ours to
// predict. Getting this wrong costs the cat artwork and the settings panel, both
// of which are fetched by path. Assumes this file sits in the extension root
// beside index.js, which is where the split put it.
function resolveExtensionFolderPath() {
    try {
        return new URL(".", import.meta.url).pathname.replace(/\/+$/, "");
    } catch (error) {
        return `scripts/extensions/third-party/${extensionName}`;
    }
}

export const extensionFolderPath = resolveExtensionFolderPath();
