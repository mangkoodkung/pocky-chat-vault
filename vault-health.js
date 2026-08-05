export const VAULT_HEALTH_IDLE = "idle";
export const VAULT_HEALTH_HEALTHY = "healthy";
export const VAULT_HEALTH_PENDING = "pending";
export const VAULT_HEALTH_ATTENTION = "attention";

export function evaluateVaultHealth({
    backup = null,
    usesGoogleDrive = false,
    driveConnected = false,
    pendingCount = 0,
    historyCount = 0,
} = {}) {
    if (!backup) {
        return {
            state: VAULT_HEALTH_IDLE,
            label: "พ็อกกี้ยังไม่มีสำเนาแชทนี้เลย",
            historyCount: 0,
            pendingCount: Math.max(0, Number(pendingCount) || 0),
        };
    }

    const driveStatus = String(backup.driveUpload?.status || "");
    const normalizedPendingCount = Math.max(0, Number(pendingCount) || 0);
    const normalizedHistoryCount = Math.max(0, Number(historyCount) || 0);

    if (usesGoogleDrive && driveStatus === "failed") {
        return {
            state: VAULT_HEALTH_ATTENTION,
            label: "Drive ส่งไม่สำเร็จ · ระบบจะลองใหม่",
            historyCount: normalizedHistoryCount,
            pendingCount: Math.max(1, normalizedPendingCount),
        };
    }

    if (usesGoogleDrive && (
        !driveConnected
        || driveStatus !== "uploaded"
        || normalizedPendingCount > 0
    )) {
        return {
            state: VAULT_HEALTH_PENDING,
            label: driveConnected
                ? `พ็อกกี้รอส่งขึ้น Drive ${Math.max(1, normalizedPendingCount)} รายการ`
                : "พ็อกกี้เก็บไว้ในเครื่องแล้ว · ยังไม่ได้ต่อ Drive",
            historyCount: normalizedHistoryCount,
            pendingCount: normalizedPendingCount,
        };
    }

    return {
        state: VAULT_HEALTH_HEALTHY,
        label: usesGoogleDrive ? "พ็อกกี้เซฟขึ้น Drive แล้ว" : "พ็อกกี้เซฟในเครื่องแล้ว",
        historyCount: normalizedHistoryCount,
        pendingCount: normalizedPendingCount,
    };
}
