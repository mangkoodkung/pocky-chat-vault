export class ChatVaultBackupValidationError extends Error {
    constructor(code, message, lineNumber = null) {
        super(message);
        this.name = "ChatVaultBackupValidationError";
        this.code = code;
        this.lineNumber = lineNumber;
    }
}

const MAX_BACKUP_CHARACTERS = 64 * 1024 * 1024;
const MAX_BACKUP_MESSAGES = 200_000;
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function containsUnsafeObjectKey(value) {
    const pending = [value];

    while (pending.length > 0) {
        const current = pending.pop();

        if (!current || typeof current !== "object") {
            continue;
        }

        for (const key of Object.keys(current)) {
            if (UNSAFE_OBJECT_KEYS.has(key)) {
                return true;
            }

            const child = current[key];

            if (child && typeof child === "object") {
                pending.push(child);
            }
        }
    }

    return false;
}

export function parseChatVaultBackup(content) {
    const value = String(content || "").trim();

    if (!value) {
        throw new ChatVaultBackupValidationError(
            "empty_backup",
            "Backup file is empty",
        );
    }

    if (value.length > MAX_BACKUP_CHARACTERS) {
        throw new ChatVaultBackupValidationError(
            "backup_too_large",
            "Backup file is too large to restore safely in the browser",
        );
    }

    const lines = value.split(/\r?\n/).filter((line) => line.trim());

    if (lines.length - 1 > MAX_BACKUP_MESSAGES) {
        throw new ChatVaultBackupValidationError(
            "too_many_messages",
            "Backup contains too many messages",
        );
    }

    const entries = lines.map((line, index) => {
        try {
            return JSON.parse(line);
        } catch (error) {
            throw new ChatVaultBackupValidationError(
                "invalid_jsonl",
                `Invalid JSON on line ${index + 1}`,
                index + 1,
            );
        }
    });
    const header = entries[0];

    if (containsUnsafeObjectKey(entries)) {
        throw new ChatVaultBackupValidationError(
            "unsafe_property",
            "Backup contains unsafe object properties",
        );
    }

    if (!header || typeof header !== "object" || Array.isArray(header)) {
        throw new ChatVaultBackupValidationError(
            "invalid_header",
            "Backup header is invalid",
            1,
        );
    }

    if (header.user_name === undefined
        && header.name === undefined
        && header.chat_metadata === undefined) {
        throw new ChatVaultBackupValidationError(
            "invalid_header",
            "Backup is not a SillyTavern JSONL chat",
            1,
        );
    }

    for (let index = 1; index < entries.length; index += 1) {
        const message = entries[index];

        if (!message || typeof message !== "object" || Array.isArray(message)) {
            throw new ChatVaultBackupValidationError(
                "invalid_message",
                `Invalid chat message on line ${index + 1}`,
                index + 1,
            );
        }

        if (!Object.prototype.hasOwnProperty.call(message, "mes")) {
            throw new ChatVaultBackupValidationError(
                "invalid_message",
                `Chat message on line ${index + 1} has no message content`,
                index + 1,
            );
        }
    }

    return {
        content: lines.join("\n"),
        header,
        messages: entries.slice(1),
        messageCount: Math.max(0, entries.length - 1),
    };
}

export function formatBackupFileSize(size) {
    const bytes = Math.max(0, Number(size) || 0);

    if (bytes < 1024) {
        return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }

    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
