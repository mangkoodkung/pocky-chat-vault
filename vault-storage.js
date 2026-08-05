import {
    isPendingDriveBackupForAccount,
    markBackupDriveFailed,
    markBackupDriveUploaded,
} from "./backup-state.js";

const DATABASE_NAME = "sillytavern-chat-vault";
const DATABASE_VERSION = 2;
const BACKUP_STORE_NAME = "latest-backups";
const HISTORY_STORE_NAME = "backup-history";
export const DEFAULT_HISTORY_LIMIT = 30;
export const MAX_HISTORY_LIMIT = 100;

let databasePromise = null;

function normalizeHistoryLimit(value) {
    const parsed = Number.parseInt(value, 10);

    if (!Number.isFinite(parsed)) {
        return DEFAULT_HISTORY_LIMIT;
    }

    return Math.min(Math.max(parsed, 1), MAX_HISTORY_LIMIT);
}

function createHistoryKey(backup) {
    const backupId = String(backup?.id || "").trim();
    const snapshotId = String(backup?.snapshotId || "").trim();

    if (!backupId || !snapshotId) {
        throw new TypeError("Chat Vault history requires backup and snapshot IDs");
    }

    return `${backupId}\u0000${snapshotId}`;
}

function createHistoryRecord(backup, {
    triggerReason = "",
    checkpointName = "",
    isCheckpoint = false,
} = {}) {
    const normalizedCheckpointName = String(checkpointName || "")
        .replace(/[\u0000-\u001F\u007F]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);

    return {
        ...backup,
        historyKey: createHistoryKey(backup),
        triggerReason: String(triggerReason || backup?.triggerReason || "").slice(0, 64),
        checkpointName: normalizedCheckpointName,
        isCheckpoint: Boolean(isCheckpoint || normalizedCheckpointName),
    };
}

function openDatabase() {
    if (databasePromise) {
        return databasePromise;
    }

    const openingDatabase = new Promise((resolve, reject) => {
        if (!("indexedDB" in window)) {
            reject(new Error("IndexedDB is not available in this browser"));
            return;
        }

        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

        request.onupgradeneeded = () => {
            const database = request.result;

            if (!database.objectStoreNames.contains(BACKUP_STORE_NAME)) {
                database.createObjectStore(BACKUP_STORE_NAME, { keyPath: "id" });
            }

            if (!database.objectStoreNames.contains(HISTORY_STORE_NAME)) {
                database.createObjectStore(HISTORY_STORE_NAME, { keyPath: "historyKey" });
            }
        };

        request.onsuccess = () => {
            const database = request.result;

            database.onversionchange = () => {
                database.close();
                databasePromise = null;
            };
            resolve(database);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("Chat Vault database is blocked"));
    });

    databasePromise = openingDatabase;
    openingDatabase.catch(() => {
        if (databasePromise === openingDatabase) {
            databasePromise = null;
        }
    });

    return databasePromise;
}

function sortNewestFirst(backups) {
    return backups.sort((left, right) => {
        const savedAtOrder = String(right.savedAt || "")
            .localeCompare(String(left.savedAt || ""));

        return savedAtOrder || String(right.snapshotId || "")
            .localeCompare(String(left.snapshotId || ""));
    });
}

export async function getLatestBackup(id) {
    const database = await openDatabase();

    return await new Promise((resolve, reject) => {
        const transaction = database.transaction(BACKUP_STORE_NAME, "readonly");
        const request = transaction.objectStore(BACKUP_STORE_NAME).get(id);

        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
    });
}

export async function getAllLatestBackups() {
    const database = await openDatabase();

    return await new Promise((resolve, reject) => {
        const transaction = database.transaction(BACKUP_STORE_NAME, "readonly");
        const request = transaction.objectStore(BACKUP_STORE_NAME).getAll();

        request.onsuccess = () => resolve(sortNewestFirst(request.result || []));
        request.onerror = () => reject(request.error);
    });
}

export async function getBackupHistory(id) {
    const database = await openDatabase();

    return await new Promise((resolve, reject) => {
        const transaction = database.transaction(HISTORY_STORE_NAME, "readonly");
        const request = transaction.objectStore(HISTORY_STORE_NAME).getAll();

        request.onsuccess = () => {
            const records = Array.isArray(request.result) ? request.result : [];

            resolve(sortNewestFirst(records.filter(
                (backup) => String(backup.id || "") === String(id || ""),
            )));
        };
        request.onerror = () => reject(request.error);
    });
}

export async function saveLatestBackup(backup) {
    const database = await openDatabase();

    await new Promise((resolve, reject) => {
        const transaction = database.transaction(BACKUP_STORE_NAME, "readwrite");

        transaction.objectStore(BACKUP_STORE_NAME).put(backup);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });
}

export async function saveBackupSnapshot(backup, options = {}) {
    const database = await openDatabase();
    const historyLimit = normalizeHistoryLimit(options.historyLimit);
    const historyRecord = createHistoryRecord(backup, options);
    const compactHistoryRecord = { ...historyRecord };

    delete compactHistoryRecord.drivePayload;

    await new Promise((resolve, reject) => {
        const transaction = database.transaction(
            [BACKUP_STORE_NAME, HISTORY_STORE_NAME],
            "readwrite",
        );
        const latestStore = transaction.objectStore(BACKUP_STORE_NAME);
        const historyStore = transaction.objectStore(HISTORY_STORE_NAME);

        latestStore.put(historyRecord);
        historyStore.put(compactHistoryRecord);

        const historyRequest = historyStore.getAll();

        historyRequest.onsuccess = () => {
            const automaticSnapshots = sortNewestFirst(
                (historyRequest.result || []).filter((record) => (
                    String(record.id || "") === String(historyRecord.id || "")
                    && !record.isCheckpoint
                )),
            );

            for (const expired of automaticSnapshots.slice(historyLimit)) {
                historyStore.delete(expired.historyKey);
            }
        };
        historyRequest.onerror = () => transaction.abort();
        transaction.oncomplete = () => resolve(historyRecord);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || historyRequest.error);
    });

    return historyRecord;
}

async function updateLatestBackup(id, update) {
    const database = await openDatabase();

    return await new Promise((resolve, reject) => {
        const transaction = database.transaction(
            [BACKUP_STORE_NAME, HISTORY_STORE_NAME],
            "readwrite",
        );
        const latestStore = transaction.objectStore(BACKUP_STORE_NAME);
        const historyStore = transaction.objectStore(HISTORY_STORE_NAME);
        const request = latestStore.get(id);
        let updatedBackup = null;

        request.onsuccess = () => {
            const currentBackup = request.result;

            if (!currentBackup) {
                return;
            }

            updatedBackup = update(currentBackup);

            if (updatedBackup === currentBackup) {
                return;
            }

            latestStore.put(updatedBackup);

            const historyKey = currentBackup.historyKey
                || (currentBackup.snapshotId ? createHistoryKey(currentBackup) : "");

            if (!historyKey) {
                return;
            }

            const historyRequest = historyStore.get(historyKey);

            historyRequest.onsuccess = () => {
                if (historyRequest.result) {
                    historyStore.put({
                        ...historyRequest.result,
                        driveUpload: updatedBackup.driveUpload,
                    });
                }
            };
            historyRequest.onerror = () => transaction.abort();
        };
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => resolve(updatedBackup);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });
}

export async function markLatestBackupDriveUploaded(id, snapshotId, options = {}) {
    return await updateLatestBackup(
        id,
        (backup) => {
            const updatedBackup = markBackupDriveUploaded(backup, snapshotId, options);

            if (updatedBackup === backup) {
                return backup;
            }

            const compactBackup = { ...updatedBackup };

            delete compactBackup.drivePayload;
            return compactBackup;
        },
    );
}

export async function markLatestBackupDriveFailed(
    id,
    snapshotId,
    errorCode,
    options = {},
) {
    return await updateLatestBackup(
        id,
        (backup) => markBackupDriveFailed(backup, snapshotId, errorCode, options),
    );
}

export async function getPendingDriveBackups(accountHint = "") {
    const database = await openDatabase();

    return await new Promise((resolve, reject) => {
        const transaction = database.transaction(BACKUP_STORE_NAME, "readonly");
        const request = transaction.objectStore(BACKUP_STORE_NAME).getAll();

        request.onsuccess = () => {
            const backups = Array.isArray(request.result) ? request.result : [];

            resolve(backups
                .filter((backup) => isPendingDriveBackupForAccount(backup, accountHint))
                .sort((left, right) => String(left.savedAt || "")
                    .localeCompare(String(right.savedAt || ""))));
        };
        request.onerror = () => reject(request.error);
    });
}
