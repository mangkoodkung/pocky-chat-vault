/*
 * Pokki's calling card — the note installers meet in Settings → เกี่ยวกับพ็อกกี้.
 *
 * First module carved out of index.js, and picked to go first for the same
 * reason it is safe: nothing in here reads settings, talks to Drive, or holds
 * state. It builds one DOM subtree from constants and hands it back. The
 * creator's details live in this one obvious place.
 */

import { extensionDisplayName, extensionVersion } from "./vault-env.js";
import { getCatHealthImageUrl } from "./vault-cat.js";

// Leave POKKI_GITHUB_URL empty and the GitHub row simply does not render; fill
// it in later and the link appears on its own.
const POKKI_GITHUB_URL = "";
const POKKI_BIO_URL = "https://lnk.bio/popko";
const POKKI_BIO_LABEL = "@pokobpopko · Lnk.Bio";
const POKKI_CREATOR = "สร้างโดย เจ๊ปอกอ (majesty.pop)";

// Pokki's note to whoever installs this, in her own words. Each array entry is
// one block; the newlines inside a block are deliberate line breaks the author
// wrote, kept as-is by `white-space: pre-line` in the stylesheet. Long lines
// still wrap on their own at the menu width.
const POKKI_ABOUT_LINES = [
    "สวัสดีจ้ะ พี่จ๋าทุกคน~\nพ็อกกี้ของเจ๊ปอกอกลับมาแล้ววว 🐾",
    "ภารกิจของหนูคือคอยกอดแชทของพี่จ๋าไว้ให้แน่นที่สุด!\n(แน่นพอ ๆ กับตอนที่หนูกอดเจ๊ปอกอเพื่อขอเงินไปซื้อขนมเลย 🤭)",
    "เพียงเชื่อมต่อหนูกับ Google Drive\nข้อมูลแชทของพี่จ๋าก็จะถูกสำรองเอาไว้แบบ Realtime!\nไม่ต้องกลัวข้อมูลหายอีกต่อไป🐾",
];

// A safe external link: new tab, no referrer, opener severed.
function createPokkiExternalLink(url, label) {
    const link = document.createElement("a");

    link.className = "chat-vault-about-link";
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = label;

    return link;
}

// The body of the "เกี่ยวกับพ็อกกี้" tab.
export function createPokkiAboutSection() {
    const body = document.createElement("div");
    const portrait = document.createElement("img");
    const name = document.createElement("div");
    const version = document.createElement("div");
    const message = document.createElement("div");
    const creator = document.createElement("div");
    const follow = document.createElement("div");

    body.className = "chat-vault-about-body";

    portrait.className = "chat-vault-about-portrait";
    portrait.src = getCatHealthImageUrl("healthy");
    portrait.alt = "";
    portrait.draggable = false;

    name.className = "chat-vault-about-name";
    name.textContent = extensionDisplayName;
    version.className = "chat-vault-about-version";
    version.textContent = `เวอร์ชัน ${extensionVersion} · ผู้ช่วยแมวเก็บแชท`;

    message.className = "chat-vault-about-message";

    for (const line of POKKI_ABOUT_LINES) {
        const lineElement = document.createElement("p");

        lineElement.className = "chat-vault-about-message-line";
        lineElement.textContent = line;
        message.append(lineElement);
    }

    creator.className = "chat-vault-about-creator";
    creator.textContent = POKKI_CREATOR;

    body.append(portrait, name, version, message, creator);

    // Links are pill chips on their own line so they never wrap into the middle
    // of a sentence the way an inline link did.
    follow.className = "chat-vault-about-follow";
    follow.textContent = "ติดตามเจ๊ปอกอได้ที่";
    const bioChip = createPokkiExternalLink(POKKI_BIO_URL, POKKI_BIO_LABEL);
    bioChip.className = "chat-vault-about-chip";
    body.append(follow, bioChip);

    if (POKKI_GITHUB_URL) {
        const gh = createPokkiExternalLink(POKKI_GITHUB_URL, `GitHub · โค้ดของ ${extensionDisplayName}`);
        gh.className = "chat-vault-about-chip";
        body.append(gh);
    }

    return body;
}
