export const VAULT_ARCHIVE_FORMAT = "chat-vault-archive";
export const VAULT_ENCRYPTED_FORMAT = "chat-vault-encrypted";
export const VAULT_ARCHIVE_VERSION = 1;
export const DEFAULT_ARCHIVE_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_PBKDF2_ITERATIONS = 310_000;
const MIN_SECRET_LENGTH = 8;

export class VaultArchiveError extends Error {
    constructor(code, message, cause = null) {
        super(message);
        this.name = "VaultArchiveError";
        this.code = code;

        if (cause) {
            this.cause = cause;
        }
    }
}

function requireWebCrypto() {
    if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) {
        throw new VaultArchiveError(
            "crypto_unavailable",
            "Web Crypto is not available in this browser",
        );
    }

    return globalThis.crypto;
}

function toBase64(bytes) {
    const values = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = "";

    for (let offset = 0; offset < values.length; offset += 0x8000) {
        binary += String.fromCharCode(...values.subarray(offset, offset + 0x8000));
    }

    return btoa(binary);
}

function fromBase64(value) {
    try {
        const binary = atob(String(value || ""));
        const bytes = new Uint8Array(binary.length);

        for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
        }

        return bytes;
    } catch (error) {
        throw new VaultArchiveError("invalid_archive", "Archive contains invalid base64", error);
    }
}

function randomBytes(length) {
    const bytes = new Uint8Array(length);

    requireWebCrypto().getRandomValues(bytes);
    return bytes;
}

async function deriveWrappingKey(secret, salt, iterations) {
    const normalizedSecret = String(secret || "");

    if (normalizedSecret.length < MIN_SECRET_LENGTH) {
        throw new VaultArchiveError(
            "secret_too_short",
            `Passphrase or recovery key must contain at least ${MIN_SECRET_LENGTH} characters`,
        );
    }

    const crypto = requireWebCrypto();
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        "raw",
        encoder.encode(normalizedSecret),
        "PBKDF2",
        false,
        ["deriveKey"],
    );

    return await crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            hash: "SHA-256",
            salt,
            iterations,
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
    );
}

async function createKeySlot(kind, secret, dataKeyBytes, iterations) {
    const crypto = requireWebCrypto();
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const wrappingKey = await deriveWrappingKey(secret, salt, iterations);
    const wrappedKey = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        wrappingKey,
        dataKeyBytes,
    );

    return {
        kind,
        salt: toBase64(salt),
        iv: toBase64(iv),
        wrappedKey: toBase64(wrappedKey),
    };
}

async function unwrapDataKey(slot, secret, iterations) {
    const crypto = requireWebCrypto();
    const wrappingKey = await deriveWrappingKey(
        secret,
        fromBase64(slot.salt),
        iterations,
    );

    return new Uint8Array(await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64(slot.iv) },
        wrappingKey,
        fromBase64(slot.wrappedKey),
    ));
}

export function createRecoveryKey() {
    const bytes = randomBytes(24);
    const encoded = toBase64(bytes)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");

    return encoded.match(/.{1,8}/g).join("-");
}

export function createVaultArchive({ backup, attachments = [] } = {}) {
    if (!backup?.content) {
        throw new VaultArchiveError("backup_missing", "Archive backup content is empty");
    }

    const normalizedAttachments = attachments.map((attachment, index) => ({
        id: String(attachment.id || `attachment-${index + 1}`).slice(0, 100),
        kind: attachment.kind === "file" ? "file" : "media",
        name: String(attachment.name || `attachment-${index + 1}`).slice(0, 180),
        mimeType: String(attachment.mimeType || "application/octet-stream").slice(0, 120),
        size: Math.max(0, Number(attachment.size) || 0),
        originalUrl: String(attachment.originalUrl || "").slice(0, 2048),
        pointers: Array.isArray(attachment.pointers) ? attachment.pointers : [],
        data: String(attachment.data || ""),
    }));
    const backupMetadata = { ...backup };

    delete backupMetadata.content;
    delete backupMetadata.drivePayload;

    return JSON.stringify({
        format: VAULT_ARCHIVE_FORMAT,
        version: VAULT_ARCHIVE_VERSION,
        createdAt: new Date().toISOString(),
        backup: {
            ...backupMetadata,
            content: String(backup.content),
        },
        attachments: normalizedAttachments,
    });
}

export async function encryptVaultArchive(plaintext, passphrase, {
    recoveryKey = "",
    iterations = DEFAULT_PBKDF2_ITERATIONS,
} = {}) {
    const crypto = requireWebCrypto();
    const encoder = new TextEncoder();
    const dataKeyBytes = randomBytes(32);
    const dataKey = await crypto.subtle.importKey(
        "raw",
        dataKeyBytes,
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"],
    );
    const iv = randomBytes(12);
    const normalizedIterations = Math.max(1_000, Number(iterations) || DEFAULT_PBKDF2_ITERATIONS);
    const keySlots = [
        await createKeySlot("passphrase", passphrase, dataKeyBytes, normalizedIterations),
    ];

    if (recoveryKey) {
        keySlots.push(await createKeySlot(
            "recovery",
            recoveryKey,
            dataKeyBytes,
            normalizedIterations,
        ));
    }

    const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        dataKey,
        encoder.encode(String(plaintext || "")),
    );

    return JSON.stringify({
        format: VAULT_ENCRYPTED_FORMAT,
        version: VAULT_ARCHIVE_VERSION,
        algorithm: "AES-256-GCM",
        kdf: "PBKDF2-SHA-256",
        iterations: normalizedIterations,
        iv: toBase64(iv),
        keySlots,
        ciphertext: toBase64(ciphertext),
    });
}

export async function decryptVaultArchive(serialized, secret) {
    let envelope;

    try {
        envelope = JSON.parse(String(serialized || ""));
    } catch (error) {
        throw new VaultArchiveError("invalid_archive", "Encrypted archive is not valid JSON", error);
    }

    if (envelope?.format !== VAULT_ENCRYPTED_FORMAT
        || !Array.isArray(envelope.keySlots)
        || !envelope.keySlots.length) {
        throw new VaultArchiveError("invalid_archive", "Encrypted archive envelope is invalid");
    }

    const crypto = requireWebCrypto();
    const iterations = Math.max(1_000, Number(envelope.iterations) || 0);

    for (const slot of envelope.keySlots) {
        try {
            const dataKeyBytes = await unwrapDataKey(slot, secret, iterations);
            const dataKey = await crypto.subtle.importKey(
                "raw",
                dataKeyBytes,
                { name: "AES-GCM" },
                false,
                ["decrypt"],
            );
            const plaintext = await crypto.subtle.decrypt(
                { name: "AES-GCM", iv: fromBase64(envelope.iv) },
                dataKey,
                fromBase64(envelope.ciphertext),
            );

            return new TextDecoder().decode(plaintext);
        } catch {
            // A passphrase may match either slot. Try all slots before failing.
        }
    }

    throw new VaultArchiveError(
        "invalid_secret",
        "Passphrase or recovery key could not unlock this archive",
    );
}

export async function parseVaultPackage(serialized, { secret = "" } = {}) {
    const value = String(serialized || "").trim();
    let candidate;

    try {
        candidate = JSON.parse(value);
    } catch {
        return {
            encrypted: false,
            archive: null,
            backupContent: value,
            attachments: [],
        };
    }

    if (candidate?.format === VAULT_ENCRYPTED_FORMAT) {
        if (!secret) {
            throw new VaultArchiveError(
                "secret_required",
                "This vault archive requires a passphrase or recovery key",
            );
        }

        const plaintext = await decryptVaultArchive(value, secret);
        const parsed = await parseVaultPackage(plaintext);

        return { ...parsed, encrypted: true };
    }

    if (candidate?.format !== VAULT_ARCHIVE_FORMAT
        || candidate.version !== VAULT_ARCHIVE_VERSION
        || !candidate.backup?.content
        || !Array.isArray(candidate.attachments)) {
        return {
            encrypted: false,
            archive: null,
            backupContent: value,
            attachments: [],
        };
    }

    return {
        encrypted: false,
        archive: candidate,
        backupContent: String(candidate.backup.content),
        attachments: candidate.attachments,
    };
}

function addAttachmentReference(references, attachment, pointer) {
    const url = String(attachment?.url || "").trim();

    if (!url) {
        return;
    }

    const existing = references.get(url) || {
        id: `asset-${references.size + 1}`,
        kind: pointer.collection === "files" ? "file" : "media",
        name: String(attachment.name || attachment.title || "")
            .trim()
            .slice(0, 180),
        mimeType: String(attachment.mimeType || "").slice(0, 120),
        originalUrl: url,
        pointers: [],
    };

    existing.pointers.push(pointer);
    references.set(url, existing);
}

export function collectAttachmentReferences(backupContent) {
    const lines = String(backupContent || "").split(/\r?\n/).filter((line) => line.trim());
    const entries = lines.map((line) => JSON.parse(line));
    const references = new Map();

    for (let messageIndex = 0; messageIndex < entries.length - 1; messageIndex += 1) {
        const message = entries[messageIndex + 1];
        const extra = message?.extra;

        if (!extra || typeof extra !== "object") {
            continue;
        }

        for (const collection of ["media", "files"]) {
            const attachments = Array.isArray(extra[collection]) ? extra[collection] : [];

            for (let attachmentIndex = 0; attachmentIndex < attachments.length; attachmentIndex += 1) {
                addAttachmentReference(references, attachments[attachmentIndex], {
                    messageIndex,
                    collection,
                    attachmentIndex,
                });
            }
        }
    }

    return Array.from(references.values());
}

export async function restoreArchiveAttachments(archive, upload) {
    if (!archive?.backup?.content || !Array.isArray(archive.attachments)) {
        throw new VaultArchiveError("invalid_archive", "Archive attachments are invalid");
    }

    if (typeof upload !== "function") {
        throw new TypeError("restoreArchiveAttachments requires an upload function");
    }

    const entries = String(archive.backup.content)
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));

    for (const attachment of archive.attachments) {
        if (!attachment?.data || !Array.isArray(attachment.pointers)) {
            continue;
        }

        const restoredUrl = await upload(attachment);

        if (!restoredUrl) {
            throw new VaultArchiveError(
                "attachment_restore_failed",
                `Could not restore attachment ${attachment.name || attachment.id}`,
            );
        }

        for (const pointer of attachment.pointers) {
            const message = entries[Number(pointer.messageIndex) + 1];
            const collection = pointer.collection;
            const attachmentIndex = Number(pointer.attachmentIndex);

            if (!["media", "files"].includes(collection)
                || !Array.isArray(message?.extra?.[collection])
                || !message.extra[collection][attachmentIndex]) {
                throw new VaultArchiveError(
                    "invalid_archive",
                    "Archive attachment pointer is invalid",
                );
            }

            message.extra[collection][attachmentIndex].url = restoredUrl;
        }
    }

    return entries.map((entry) => JSON.stringify(entry)).join("\n");
}
