/*
 * Small presentation helpers: numbers clamped, bytes encoded, dates and previews
 * put into words, and content handed to the user as a downloaded file.
 *
 * These were the first things carved out of index.js, chosen because they share
 * one property: none of them knows anything about the vault. They read their
 * arguments and nothing else — no settings, no Drive session, no SillyTavern
 * context — which is what makes them safe to move and, for the pure ones,
 * testable in Node the way the other leaf modules are.
 *
 * The two download helpers do touch the DOM, but only to perform the one
 * browser ritual for saving a file: a temporary <a download> that is clicked
 * and removed. They still depend on nothing of the extension's state.
 */

import { extensionDisplayName } from "./vault-env.js";

export function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
}

export function bytesToBase64(bytes) {
    const values = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = "";

    // Chunked because String.fromCharCode(...everything) puts the whole buffer
    // on the argument stack, and a large archive overflows it.
    for (let offset = 0; offset < values.length; offset += 0x8000) {
        binary += String.fromCharCode(...values.subarray(offset, offset + 0x8000));
    }

    return btoa(binary);
}

export function formatRestoreDate(value) {
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return "ไม่ทราบเวลา";
    }

    return date.toLocaleString("th-TH", {
        day: "2-digit",
        month: "2-digit",
        year: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}

export function formatBackupPreview(parsedBackup) {
    const messages = Array.isArray(parsedBackup?.messages)
        ? parsedBackup.messages
        : [];
    const recentMessages = messages.slice(-3).map((message) => {
        const speaker = message.is_user
            ? (message.name || "ผู้ใช้")
            : (message.name || parsedBackup.header.character_name || "ตัวละคร");
        const text = String(message.mes || "")
            .replace(/<[^>]*>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 140);

        return `${speaker}: ${text || "(ข้อความว่าง)"}`;
    });

    return [
        `${parsedBackup.messageCount} ข้อความ`,
        `ต้นฉบับ: ${parsedBackup.header.character_name || parsedBackup.header.name || "ไม่ระบุ"}`,
        ...(recentMessages.length ? ["", ...recentMessages] : []),
    ].join("\n");
}

// The one supported way to hand the user a file. Object URL revocation is
// delayed because revoking synchronously races the click in some browsers and
// the download silently never starts.
function downloadTextFile(content, fileName, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadBackupContent(content, fileName) {
    downloadTextFile(
        content,
        String(fileName || "chat-vault-backup.jsonl"),
        "application/x-ndjson;charset=utf-8",
    );
}

export function downloadRecoveryKey(recoveryKey) {
    const content = [
        `${extensionDisplayName} recovery key`,
        "เก็บไฟล์นี้ไว้นอกเครื่องที่ใช้ SillyTavern และอย่าเผยแพร่ให้ผู้อื่น",
        "",
        recoveryKey,
        "",
    ].join("\n");

    downloadTextFile(content, "chat-vault-recovery-key.txt", "text/plain;charset=utf-8");
}
