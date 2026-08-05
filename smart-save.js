export const AUTO_SAVE_MODE_MANUAL = "manual";
export const AUTO_SAVE_MODE_DISABLED = "disabled";
export const AUTO_SAVE_MODE_MAXIMUM_SAFETY = "every_message";
export const AUTO_SAVE_MODE_TURN_COMPLETE = "turn_complete";
export const AUTO_SAVE_MODE_MESSAGE_COUNT = "message_count";

export const AUTO_SAVE_MODES = new Set([
    AUTO_SAVE_MODE_DISABLED,
    AUTO_SAVE_MODE_MANUAL,
    AUTO_SAVE_MODE_MAXIMUM_SAFETY,
    AUTO_SAVE_MODE_TURN_COMPLETE,
    AUTO_SAVE_MODE_MESSAGE_COUNT,
]);

export const CHAT_MUTATION_REASONS = new Set([
    "message_edited",
    "message_updated",
    "message_swiped",
    "message_deleted",
    "messages_deleted",
    "message_file_embedded",
]);

export function normalizeAutoSaveMode(value) {
    return AUTO_SAVE_MODES.has(value) ? value : AUTO_SAVE_MODE_MANUAL;
}

export function shouldCaptureAutoSaveEvent(mode, reason) {
    const normalizedMode = normalizeAutoSaveMode(mode);

    if ([AUTO_SAVE_MODE_DISABLED, AUTO_SAVE_MODE_MANUAL].includes(normalizedMode)) {
        return false;
    }

    if (
        normalizedMode === AUTO_SAVE_MODE_TURN_COMPLETE
        && reason === "message_sent"
    ) {
        return false;
    }

    return true;
}

export function shouldCaptureImmediately(mode, messageInterval, reason) {
    const normalizedMode = normalizeAutoSaveMode(mode);

    return normalizedMode === AUTO_SAVE_MODE_MAXIMUM_SAFETY
        || normalizedMode === AUTO_SAVE_MODE_TURN_COMPLETE
        || (normalizedMode === AUTO_SAVE_MODE_MESSAGE_COUNT
            && Number(messageInterval) === 1)
        || CHAT_MUTATION_REASONS.has(reason);
}

export function shouldBypassMessageInterval(reason) {
    return CHAT_MUTATION_REASONS.has(reason);
}

export function describeSnapshotReason(reason) {
    const labels = {
        manual: "สำรองด้วยมือ",
        named_checkpoint: "จุดคืนค่าที่ตั้งชื่อ",
        before_restore: "ก่อนกู้คืน",
        message_sent: "หลังส่งข้อความ",
        message_received: "หลังคำตอบเสร็จ",
        message_edited: "หลังแก้ไขข้อความ",
        message_updated: "หลังข้อความเปลี่ยน",
        message_swiped: "หลังปัดคำตอบ",
        message_deleted: "หลังลบข้อความ",
        messages_deleted: "หลังลบหลายข้อความ",
        message_file_embedded: "หลังแนบไฟล์",
    };

    return labels[String(reason || "")] || "Auto-save";
}
