// Import from SillyTavern core
import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import {
    importCharacterChat,
    getRequestHeaders,
    openCharacterChat,
    saveSettingsDebounced,
} from "../../../../script.js";
import { importGroupChat, openGroupChat } from "../../../group-chats.js";
import {
    DEFAULT_DRIVE_AUTO_UPLOAD_EVERY_MESSAGES,
    DriveAutoUploadQueue,
} from "./auto-drive.js";
import { queueBackupForDrive } from "./backup-state.js";
import {
    DEFAULT_HISTORY_LIMIT,
    getAllLatestBackups,
    getBackupHistory,
    getLatestBackup,
    getPendingDriveBackups,
    markLatestBackupDriveFailed,
    markLatestBackupDriveUploaded,
    saveBackupSnapshot,
} from "./vault-storage.js";
import {
    VaultServerError,
    configureVaultServer,
    detectVaultServer,
    disconnectVaultServer,
    getVaultServerAuthUrl,
    requestVaultServerToken,
} from "./vault-server.js";
import {
    DEFAULT_GOOGLE_DRIVE_FOLDER_NAME,
    GoogleDriveError,
    adoptGoogleDriveAccessToken,
    clearGoogleDriveSession,
    connectGoogleDrive,
    downloadGoogleDriveBackup,
    getGoogleDriveAccount,
    isGoogleDriveConnected,
    listChatVaultFolders,
    listGoogleDriveBackups,
    normalizeGoogleDriveFolderName,
    organizeGoogleDriveBackups,
    pinGoogleDriveFolder,
    trashChatVaultFolder,
    prepareGoogleDrive,
    consumeGoogleDriveRedirectAuthorization,
    getGoogleDriveRedirectUri,
    restoreGoogleDriveConnection,
    setGoogleDriveFolderName,
    shouldUseGoogleDriveRedirect,
    startGoogleDriveRedirectAuthorization,
    uploadBackupToGoogleDrive,
} from "./google-drive.js";
import {
    ChatVaultBackupValidationError,
    formatBackupFileSize,
    parseChatVaultBackup,
} from "./restore.js";
import {
    AUTO_SAVE_MODE_DISABLED,
    AUTO_SAVE_MODE_MANUAL,
    AUTO_SAVE_MODE_MESSAGE_COUNT,
    AUTO_SAVE_MODE_TURN_COMPLETE,
    describeSnapshotReason,
    normalizeAutoSaveMode,
    shouldBypassMessageInterval,
    shouldCaptureAutoSaveEvent,
    shouldCaptureImmediately,
} from "./smart-save.js";
import {
    DEFAULT_DRIVE_USAGE_WARNING_GB,
    DRIVE_USAGE_MODE_UNLIMITED,
    DRIVE_USAGE_MODE_WARNING,
    calculateDriveBackupUsageBytes,
    getDriveUsageWarningState,
    normalizeDriveUsageMode,
    normalizeDriveUsageWarningGb,
} from "./storage-policy.js";
import { evaluateVaultHealth } from "./vault-health.js";
import {
    VaultArchiveError,
    collectAttachmentReferences,
    createRecoveryKey,
    createVaultArchive,
    decryptVaultArchive,
    encryptVaultArchive,
    parseVaultPackage,
    restoreArchiveAttachments,
} from "./vault-archive.js";
import {
    extensionDisplayName,
    extensionFolderPath,
    extensionName,
    extensionVersion,
} from "./vault-env.js";
import {
    bytesToBase64,
    clamp,
    downloadBackupContent,
    downloadRecoveryKey,
    formatBackupPreview,
    formatRestoreDate,
} from "./vault-format.js";
import {
    getCatHealthImageUrl,
    placeCatFromSettings,
    preloadCatHealthImages,
    saveCatPosition,
} from "./vault-cat.js";
import { createPokkiAboutSection } from "./vault-about.js";

const GOOGLE_DRIVE_SILENT_RECONNECT_COOLDOWN_MS = 5 * 60 * 1000;
const GOOGLE_DRIVE_PENDING_RETRY_DELAY_MS = 65_000;

// Inline, self-contained icons. The project never fetches external assets, so
// the Google mark ships as SVG rather than a linked image. The G is the
// official four-colour logo and must not be recoloured.
const GOOGLE_G_SVG = '<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true" focusable="false"><path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/><path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/><path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/><path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/></svg>';
const ICON_KEBAB_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>';

// Compatibility shims so the extension loads on older mobile browsers. Chat
// Vault is mobile-first (ADR-001), but Object.hasOwn and Element.replaceChildren
// only exist on iOS Safari 15.4+/14+; on anything older they throw at startup
// and take the whole extension down. These stand-ins work everywhere.
function hasOwn(target, key) {
    return Object.prototype.hasOwnProperty.call(target, key);
}

function replaceElementChildren(element, ...nodes) {
    element.textContent = "";
    if (nodes.length > 0) {
        element.append(...nodes);
    }
}

const defaultSettings = {
    showCat: true,
    catPosition: null,
    autoSaveMode: "turn_complete",
    autoSaveEveryMessages: 5,
    historyLimit: DEFAULT_HISTORY_LIMIT,
    encryptionEnabled: false,
    encryptedRecoveryKey: "",
    encryptionPassphraseHint: "",
    includeAttachmentsInCheckpoints: false,
    attachmentLimitMb: 100,
    storageDestination: "device",
    googleDriveClientId: "",
    googleDriveFolderName: DEFAULT_GOOGLE_DRIVE_FOLDER_NAME,
    googleDrivePreviouslyConnected: false,
    googleDriveAccountHint: "",
    driveUsageMode: DRIVE_USAGE_MODE_UNLIMITED,
    driveUsageWarningGb: DEFAULT_DRIVE_USAGE_WARNING_GB,
};

let autoSaveTimer = null;
let autoSaveWork = Promise.resolve();
let autoSaveEventsRegistered = false;
let driveRetryEventsRegistered = false;
let googleDriveStatusMessage = "";
let googleDriveAccount = null;
let googleDriveFolder = null;
let googleDriveLastFile = null;
let googleDriveFolderBackupCount = null;
let googleDriveUsageBytes = null;
let googleDriveUsageRefreshedAt = 0;
let googleDriveUsageWarningNotified = false;
let googleDriveReconnectPromise = null;
let googleDriveReconnectRetryAfter = 0;
let pendingDriveFlushPromise = null;
let pendingDriveRetryTimer = null;
let refreshCatStorageControls = () => {};
let refreshVaultHealthUi = async () => {};
let refreshVaultSecurityUi = () => {};
let vaultEncryptionPassphrase = "";
let vaultRecoveryKey = "";
let vaultArchiveUnlockSecret = "";
const driveAutoUploadQueue = new DriveAutoUploadQueue(uploadBackupAndTrackState);

async function uploadBackupAndTrackState(backup) {
    let file;

    try {
        file = await uploadBackupToGoogleDrive(backup);
    } catch (error) {
        try {
            await markLatestBackupDriveFailed(
                backup.id,
                backup.snapshotId,
                error instanceof GoogleDriveError ? error.code : "upload_failed",
            );
        } catch (storageError) {
            console.error(`[${extensionName}] Failed to persist Drive upload error:`, storageError);
        }

        throw error;
    }

    try {
        await markLatestBackupDriveUploaded(backup.id, backup.snapshotId);
    } catch (error) {
        console.error(`[${extensionName}] Failed to persist Drive upload success:`, error);
    }

    googleDriveUsageRefreshedAt = 0;
    void refreshGoogleDriveUsage({ force: true });

    return file;
}

/*
 * A folder name that has to outlive a navigation.
 *
 * Both the plugin's authorization and the iOS redirect leave the page entirely,
 * and SillyTavern's only save is debounced — a settings write started just
 * before either one is killed before it lands, silently reverting the folder the
 * user just chose. The iOS path carries the name inside its own authorization
 * state; the plugin path has no such envelope, so it parks the value here and
 * collects it on the way back in.
 */
const PENDING_FOLDER_STORAGE_KEY = "chatVaultPendingFolderName";

function rememberPendingFolderName(folderName) {
    try {
        globalThis.sessionStorage.setItem(PENDING_FOLDER_STORAGE_KEY, String(folderName || ""));
    } catch {
        // Storage can be unavailable or full. Losing this means the previously
        // saved folder name stands, which is the same outcome as before it
        // existed — never a reason to block the connection itself.
    }
}

function takePendingFolderName() {
    try {
        const pending = globalThis.sessionStorage.getItem(PENDING_FOLDER_STORAGE_KEY);

        globalThis.sessionStorage.removeItem(PENDING_FOLDER_STORAGE_KEY);

        return String(pending || "");
    } catch {
        return "";
    }
}

async function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};

    if (Object.keys(extension_settings[extensionName]).length === 0) {
        Object.assign(extension_settings[extensionName], defaultSettings);
    }

    if (!hasOwn(extension_settings[extensionName], "catPosition")) {
        extension_settings[extensionName].catPosition = null;
    }

    if (!hasOwn(extension_settings[extensionName], "showCat")) {
        extension_settings[extensionName].showCat = true;
    }

    extension_settings[extensionName].autoSaveMode = normalizeAutoSaveMode(
        extension_settings[extensionName].autoSaveMode,
    );

    if (!hasOwn(extension_settings[extensionName], "autoSaveEveryMessages")) {
        extension_settings[extensionName].autoSaveEveryMessages = 5;
    }

    extension_settings[extensionName].historyLimit = clamp(
        Number.parseInt(extension_settings[extensionName].historyLimit, 10)
            || DEFAULT_HISTORY_LIMIT,
        1,
        100,
    );

    extension_settings[extensionName].encryptionEnabled = Boolean(
        extension_settings[extensionName].encryptionEnabled,
    );
    extension_settings[extensionName].encryptedRecoveryKey = String(
        extension_settings[extensionName].encryptedRecoveryKey || "",
    );
    extension_settings[extensionName].includeAttachmentsInCheckpoints = Boolean(
        extension_settings[extensionName].includeAttachmentsInCheckpoints,
    );
    extension_settings[extensionName].attachmentLimitMb = clamp(
        Number.parseInt(extension_settings[extensionName].attachmentLimitMb, 10) || 100,
        10,
        250,
    );

    if (!["device", "google_drive"].includes(extension_settings[extensionName].storageDestination)) {
        extension_settings[extensionName].storageDestination = "device";
    }

    if (!hasOwn(extension_settings[extensionName], "googleDriveClientId")) {
        extension_settings[extensionName].googleDriveClientId = "";
    }

    if (!hasOwn(extension_settings[extensionName], "googleDrivePreviouslyConnected")) {
        extension_settings[extensionName].googleDrivePreviouslyConnected = false;
    }

    if (!hasOwn(extension_settings[extensionName], "googleDriveAccountHint")) {
        extension_settings[extensionName].googleDriveAccountHint = "";
    }

    extension_settings[extensionName].driveUsageMode = normalizeDriveUsageMode(
        extension_settings[extensionName].driveUsageMode,
    );
    extension_settings[extensionName].driveUsageWarningGb = normalizeDriveUsageWarningGb(
        extension_settings[extensionName].driveUsageWarningGb,
    );

    // Collected before the folder name is normalised below, so a name that
    // survived a navigation is treated exactly like one that came from settings.
    const pendingFolderName = takePendingFolderName();

    if (pendingFolderName) {
        extension_settings[extensionName].googleDriveFolderName = pendingFolderName;
        saveSettingsDebounced();
    }

    try {
        extension_settings[extensionName].googleDriveFolderName = setGoogleDriveFolderName(
            extension_settings[extensionName].googleDriveFolderName
                || DEFAULT_GOOGLE_DRIVE_FOLDER_NAME,
        );
    } catch {
        extension_settings[extensionName].googleDriveFolderName = setGoogleDriveFolderName(
            DEFAULT_GOOGLE_DRIVE_FOLDER_NAME,
        );
    }

    $("#chat_vault_show_cat").prop("checked", extension_settings[extensionName].showCat);
    $("#chat_vault_google_client_id").val(extension_settings[extensionName].googleDriveClientId);

    const originOutput = document.getElementById("chat_vault_google_authorized_origin");

    if (originOutput) {
        originOutput.textContent = window.location.origin;
    }

    // Only the iOS redirect flow needs this one, but it is shown to everyone:
    // whoever sets up the Client ID is rarely the one who later tries it on a
    // phone, and going back to Google Cloud afterwards is the annoying part.
    const redirectOutput = document.getElementById("chat_vault_google_redirect_uri");

    if (redirectOutput) {
        redirectOutput.textContent = getGoogleDriveRedirectUri();
    }
}

function clearGoogleDriveUiSession() {
    googleDriveAccount = null;
    googleDriveFolder = null;
    googleDriveLastFile = null;
    googleDriveFolderBackupCount = null;
    googleDriveUsageBytes = null;
    googleDriveUsageRefreshedAt = 0;
    googleDriveUsageWarningNotified = false;
    driveAutoUploadQueue.reset();
}

async function refreshGoogleDriveUsage({ force = false } = {}) {
    if (!isGoogleDriveConnected()) {
        googleDriveUsageBytes = null;
        googleDriveUsageRefreshedAt = 0;
        refreshCatStorageControls();
        return null;
    }

    if (
        !force
        && Number.isFinite(googleDriveUsageBytes)
        && Date.now() - googleDriveUsageRefreshedAt < 5 * 60 * 1000
    ) {
        return googleDriveUsageBytes;
    }

    try {
        const files = await listGoogleDriveBackups();
        googleDriveUsageBytes = calculateDriveBackupUsageBytes(files);
        googleDriveUsageRefreshedAt = Date.now();
        const warningState = getDriveUsageWarningState({
            usedBytes: googleDriveUsageBytes,
            mode: extension_settings[extensionName].driveUsageMode,
            warningGb: extension_settings[extensionName].driveUsageWarningGb,
        });

        if (warningState.shouldWarn && !googleDriveUsageWarningNotified) {
            googleDriveUsageWarningNotified = true;
            toastr.warning(
                `สำเนาของ ${extensionDisplayName} ใช้พื้นที่ ${formatBackupFileSize(warningState.usedBytes)} แล้ว · จุดเตือน ${warningState.warningGb} GB`,
                extensionDisplayName,
            );
        } else if (!warningState.shouldWarn) {
            googleDriveUsageWarningNotified = false;
        }

        refreshCatStorageControls();
        return googleDriveUsageBytes;
    } catch (error) {
        console.info(`[${extensionName}] Drive usage refresh unavailable:`, error);
        return null;
    }
}

async function loadGoogleDriveSessionDetails() {
    const [account, organization] = await Promise.all([
        getGoogleDriveAccount(),
        organizeGoogleDriveBackups(),
    ]);
    const { folder, movedCount, totalCount } = organization;
    const settings = extension_settings[extensionName];

    googleDriveAccount = account;
    googleDriveFolder = folder;
    googleDriveLastFile = null;
    googleDriveFolderBackupCount = totalCount;
    settings.googleDrivePreviouslyConnected = true;
    settings.googleDriveAccountHint = account.emailAddress || "";
    saveSettingsDebounced();
    driveAutoUploadQueue.reset();
    googleDriveUsageRefreshedAt = 0;
    void refreshGoogleDriveUsage({ force: true });

    return { account, folder, movedCount, totalCount };
}

/*
 * What the server plugin is, from this file's point of view.
 *
 * `null` means "no plugin on this instance" and is the normal state for an
 * ordinary install. It is filled in once at load by a probe and is not
 * re-checked: a plugin cannot appear or disappear without restarting
 * SillyTavern, which reloads this page anyway.
 */
let vaultServerStatus = null;

/*
 * Installed is not the same as usable.
 *
 * A plugin that is present but has never been given a Client ID and secret can
 * do nothing: /auth/start answers 400 and /token answers 409, permanently.
 * Treating mere presence as "use this path" strands that install with no way to
 * connect at all — the plugin route cannot work, and the browser route has
 * already been stood down in favour of it. So every choice between the two
 * paths asks this, never the bare existence of the status object.
 */
function canUseVaultServer() {
    return Boolean(vaultServerStatus?.configured);
}

/*
 * The plugin's corner of the Extensions settings panel.
 *
 * Setting the plugin up used to mean pasting fetch() calls into the browser
 * console — acceptable for its author, a wall for everyone else, and the reason
 * it stayed unreleased. This panel replaces that: paste the secret, press save,
 * press connect. It renders only when the probe actually found a plugin, so on
 * the vast majority of installs it stays hidden and costs nothing.
 *
 * Null-guarded throughout because it runs before and after the settings HTML
 * exists, and must be harmless in both cases.
 */
function refreshPluginAdminPanel() {
    const section = document.getElementById("chat_vault_plugin_section");

    if (!section) {
        return;
    }

    section.hidden = !vaultServerStatus;

    if (!vaultServerStatus) {
        return;
    }

    const statusLine = document.getElementById("chat_vault_plugin_status");
    const redirectOutput = document.getElementById("chat_vault_plugin_redirect_uri");
    const connectButton = document.getElementById("chat_vault_plugin_connect");

    if (redirectOutput && vaultServerStatus.redirectUri) {
        redirectOutput.textContent = vaultServerStatus.redirectUri;
    }

    if (statusLine) {
        if (!vaultServerStatus.configured) {
            statusLine.textContent = "พบปลั๊กอินแล้ว · ใส่ Client ID ด้านบนให้เรียบร้อย แล้ววาง Client secret ตรงนี้";
        } else if (vaultServerStatus.connected) {
            statusLine.textContent = `เชื่อมแล้ว · ${vaultServerStatus.email || "บัญชี Google"} · เปิดหน้าใหม่ก็เชื่อมเองตลอด`;
        } else {
            statusLine.textContent = "ตั้งค่าแล้ว · เหลือกดเชื่อมบัญชี Google ครั้งเดียว";
        }
    }

    if (connectButton) {
        connectButton.hidden = !vaultServerStatus.configured;
        connectButton.textContent = vaultServerStatus.connected
            ? "เชื่อมใหม่ / เปลี่ยนบัญชี"
            : "เชื่อมบัญชี Google";
    }
}

async function savePluginConfiguration() {
    const secretInput = document.getElementById("chat_vault_plugin_secret");
    const saveButton = document.getElementById("chat_vault_plugin_save");
    const clientId = String(extension_settings[extensionName].googleDriveClientId || "").trim();
    const clientSecret = String(secretInput?.value || "").trim();

    if (!clientId) {
        toastr.warning("ใส่ Google OAuth Client ID ในช่องด้านบนก่อน", extensionDisplayName);
        return;
    }

    if (!clientSecret) {
        toastr.warning("วาง Client secret ก่อนกดบันทึก", extensionDisplayName);
        return;
    }

    if (saveButton) {
        saveButton.disabled = true;
    }

    try {
        const { redirectUri } = await configureVaultServer(clientId, clientSecret);

        vaultServerStatus = {
            ...(vaultServerStatus || {}),
            configured: true,
            ...(redirectUri ? { redirectUri } : {}),
        };

        // The secret has reached the only place it belongs. Keeping it in the
        // field invites shoulder-surfing screenshots and re-saves; the server
        // has it now, so the page forgets it.
        if (secretInput) {
            secretInput.value = "";
        }

        toastr.success("บันทึกลงปลั๊กอินแล้ว · กดเชื่อมบัญชี Google ต่อได้เลย", extensionDisplayName);
    } catch (error) {
        const message = error instanceof VaultServerError && error.code === "client_id_invalid"
            ? "Client ID ด้านบนหน้าตาไม่ถูกต้อง ตรวจอีกครั้ง"
            : "บันทึกไม่สำเร็จ · ตรวจว่าปลั๊กอินยังทำงานอยู่แล้วลองใหม่";

        toastr.error(message, extensionDisplayName);
        console.error(`[${extensionName}] Plugin configuration failed:`, error);
    } finally {
        if (saveButton) {
            saveButton.disabled = false;
        }

        refreshPluginAdminPanel();
        refreshCatStorageControls();
    }
}

/*
 * Reconnect through the plugin.
 *
 * This is the path that finally does what every other website does. There is no
 * popup to be blocked and no gesture to wait for, because nothing is being
 * authorized here — the grant already exists on the server, and this is just
 * collecting a token minted from it. It works identically on a reload, on iOS,
 * and on a machine that has not been touched in a week.
 *
 * Note what is NOT required: `googleDrivePreviouslyConnected`, and the Client ID
 * in extension settings. Those describe the browser-only flow's memory of a past
 * authorization. When the server holds the grant, the server is the record, and
 * a fresh browser profile with empty settings connects just the same.
 */
async function restoreGoogleDriveSessionFromServer() {
    const settings = extension_settings[extensionName];

    if (!canUseVaultServer() || settings.storageDestination !== "google_drive") {
        return false;
    }

    try {
        const { accessToken, expiresAt } = await requestVaultServerToken();

        adoptGoogleDriveAccessToken(accessToken, expiresAt);
        setGoogleDriveFolderName(
            normalizeGoogleDriveFolderName(
                settings.googleDriveFolderName || DEFAULT_GOOGLE_DRIVE_FOLDER_NAME,
            ),
        );

        const { account, folder, movedCount } = await loadGoogleDriveSessionDetails();

        vaultServerStatus = { ...vaultServerStatus, connected: true, email: account.emailAddress };
        googleDriveReconnectRetryAfter = 0;
        googleDriveStatusMessage = movedCount > 0
            ? `เชื่อมอัตโนมัติแล้ว · ย้ายไฟล์เดิม ${movedCount} ไฟล์เข้า “${folder.name}”`
            : `เชื่อมอัตโนมัติแล้ว · โฟลเดอร์ “${folder.name}”`;
        console.log(`[${extensionName}] Connected through the Pocky Vault plugin`);

        return true;
    } catch (error) {
        vaultServerStatus = { ...vaultServerStatus, connected: false };
        clearGoogleDriveSession();
        clearGoogleDriveUiSession();

        // The seven-day case for a consent screen still in Testing. It is an
        // expected part of running that way, so it gets an instruction rather
        // than an error: one tap and it is another week.
        if (error instanceof VaultServerError && error.code === "server_grant_expired") {
            googleDriveStatusMessage = "สิทธิ์ Google หมดอายุแล้ว · แตะเชื่อมบัญชีอีกครั้ง";
        } else if (error instanceof VaultServerError && error.code === "server_not_connected") {
            googleDriveStatusMessage = "แตะ “ต่อบัญชี Google ให้พ็อกกี้” เพื่อเชื่อมครั้งแรก";
        } else {
            googleDriveStatusMessage = "เชื่อมผ่านปลั๊กอินไม่สำเร็จ · แตะเพื่อลองใหม่";
            console.warn(`[${extensionName}] Plugin connection failed:`, error);
        }

        return false;
    } finally {
        refreshCatStorageControls();
        refreshPluginAdminPanel();
    }
}

async function restoreRememberedGoogleDriveSessionOnce() {
    const settings = extension_settings[extensionName];
    const clientId = String(settings.googleDriveClientId || "").trim();

    // The plugin is tried first and unconditionally, because when it is present
    // it is strictly better: silent, gesture-free, and unaffected by the reload
    // that empties this page's memory. Its absence costs one already-completed
    // probe, not a request.
    if (canUseVaultServer()) {
        return await restoreGoogleDriveSessionFromServer();
    }

    if (
        settings.storageDestination !== "google_drive"
        || !settings.googleDrivePreviouslyConnected
        || !clientId
    ) {
        return false;
    }

    // Silent reconnect runs through the popup token client, which on iOS can
    // never return a token — the same WebKit limitation that made the redirect
    // flow necessary in the first place. Attempting it there is not a reconnect
    // that might fail; it is one that cannot succeed, and every attempt costs a
    // stuck status line and ends by clearing the remembered account.
    //
    // The page is not sent to Google on its own. Navigating away from a chat the
    // user did not ask to leave is worse than the state this avoids, so the
    // connect button carries it instead: one tap, and the redirect takes over.
    if (shouldUseGoogleDriveRedirect()) {
        googleDriveStatusMessage = "แตะ “ต่อบัญชี Google ให้พ็อกกี้” เพื่อเชื่อมต่ออีกครั้ง";
        refreshCatStorageControls();

        return false;
    }

    googleDriveStatusMessage = "กำลังเชื่อมต่อบัญชี Google เดิม...";
    refreshCatStorageControls();

    try {
        await restoreGoogleDriveConnection(clientId, settings.googleDriveAccountHint);
        const { account, folder, movedCount } = await loadGoogleDriveSessionDetails();
        const accountName = account.emailAddress || account.displayName || "บัญชี Google";

        googleDriveStatusMessage = movedCount > 0
            ? `เชื่อมบัญชีเดิมแล้ว · ย้ายไฟล์เดิม ${movedCount} ไฟล์เข้า “${folder.name}”`
            : `เชื่อมบัญชีเดิมแล้ว · พร้อมใช้งานโฟลเดอร์ “${folder.name}”`;
        googleDriveReconnectRetryAfter = 0;
        console.log(`[${extensionName}] Restored Google Drive connection for ${accountName}`);
        return true;
    } catch (error) {
        clearGoogleDriveSession();
        clearGoogleDriveUiSession();
        googleDriveReconnectRetryAfter = Date.now()
            + GOOGLE_DRIVE_SILENT_RECONNECT_COOLDOWN_MS;
        console.info(`[${extensionName}] Silent Google Drive reconnect was unavailable:`, error);
        return false;
    } finally {
        refreshCatStorageControls();
    }
}

// Second half of the mobile redirect. Google has sent the browser back with the
// token in the fragment; google-drive.js has already validated it. What is left
// is the bookkeeping the popup path does inline: remember the account, settle the
// folder, and send anything that queued up while we were away.
async function finishGoogleDriveRedirectConnection() {
    const settings = extension_settings[extensionName];
    const result = await consumeGoogleDriveRedirectAuthorization();

    if (result.status === "none") {
        return false;
    }

    if (result.status === "error") {
        clearGoogleDriveSession();
        clearGoogleDriveUiSession();
        showGoogleDriveError(
            new GoogleDriveError(result.code, "Google redirect authorization failed"),
            "เชื่อม Google Drive ไม่สำเร็จ",
        );
        refreshCatStorageControls();

        return true;
    }

    try {
        // The folder the user typed before leaving. It comes back with the
        // authorization rather than from settings, because the settings write
        // that started just before the navigation had no chance to finish. Fall
        // back to the stored value when this round trip carried nothing.
        const carriedFolderName = normalizeGoogleDriveFolderName(
            result.folderName || settings.googleDriveFolderName,
        );

        settings.googleDriveFolderName = carriedFolderName;
        setGoogleDriveFolderName(carriedFolderName);

        const { account, folder, movedCount } = await loadGoogleDriveSessionDetails();

        googleDriveReconnectRetryAfter = 0;
        googleDriveStatusMessage = movedCount > 0
            ? `พร้อมใช้งาน · ย้ายไฟล์เดิม ${movedCount} ไฟล์เข้า “${folder.name}” แล้ว`
            : `พร้อมใช้งาน · โฟลเดอร์ “${folder.name}”`;
        toastr.success(
            `เชื่อม ${account.emailAddress || account.displayName || "บัญชี Google"} สำเร็จแล้ว`,
            extensionDisplayName,
        );
        await flushPendingDriveBackups();
        console.log(`[${extensionName}] Google Drive connected through redirect`);
    } catch (error) {
        clearGoogleDriveSession();
        clearGoogleDriveUiSession();
        showGoogleDriveError(error, "เชื่อม Google Drive ไม่สำเร็จ");
        console.error(`[${extensionName}] Redirect connection follow-up failed:`, error);
    }

    refreshCatStorageControls();

    return true;
}

let gestureReconnectArmed = false;

/*
 * Reconnecting without asking, on a platform that has no silent authorization.
 *
 * Google's token client has no quiet variant. `prompt=none` suppresses the
 * account chooser and the consent screen, but the call still opens a dialog —
 * "only the dialog UX is supported", in Google's words — and a dialog opened
 * without a user gesture is blocked by every browser. Reconnecting during load,
 * which is what this extension did from 1.0 onward, therefore never had a path
 * to success: it opened a window the browser refused, reported the refusal as a
 * failed reconnect, and cleared the remembered account on its way out. That is
 * the whole of the "log in again on every visit" report, and it is why ADR-0003
 * point 6 needs rewriting rather than re-reading.
 *
 * A gesture is the missing ingredient, and the page is about to receive one: the
 * user is here to do something. Riding the first interaction turns the blocked
 * call into an allowed one, and with consent already granted Google answers and
 * closes the window without rendering anything the user has to deal with.
 *
 * Two things this deliberately is not. It is not armed on iOS, where a popup
 * cannot return a token to its opener no matter what permitted it — the connect
 * button runs the redirect there instead. And it never touches the event it
 * rides on: no preventDefault, no await in the listener, nothing that could make
 * the click the user actually meant feel slower or land somewhere else.
 */
function armGestureDriveReconnect() {
    const settings = extension_settings[extensionName];

    if (
        gestureReconnectArmed
        || settings.storageDestination !== "google_drive"
        || !settings.googleDrivePreviouslyConnected
        || !String(settings.googleDriveClientId || "").trim()
        || shouldUseGoogleDriveRedirect()
        // With the plugin present there is nothing for a gesture to unlock: the
        // token arrives from the server without a dialog at all.
        || canUseVaultServer()
    ) {
        return false;
    }

    gestureReconnectArmed = true;

    const attemptReconnect = () => {
        document.removeEventListener("pointerdown", attemptReconnect, true);
        document.removeEventListener("keydown", attemptReconnect, true);

        // Fired, not awaited. A rejection here is an ordinary "could not
        // reconnect", already handled downstream by falling back to the button.
        void restoreRememberedGoogleDriveSession().then((restored) => {
            if (restored) {
                return flushPendingDriveBackups();
            }

            return undefined;
        });
    };

    // Capture phase so the listener is reached before anything downstream can
    // stop the event, and only one shot: a user who is not connected should not
    // be paying for a fresh attempt on every click they make.
    document.addEventListener("pointerdown", attemptReconnect, true);
    document.addEventListener("keydown", attemptReconnect, true);

    return true;
}

async function restoreRememberedGoogleDriveSession() {
    if (isGoogleDriveConnected()) {
        return true;
    }

    if (Date.now() < googleDriveReconnectRetryAfter) {
        return false;
    }

    if (googleDriveReconnectPromise) {
        return await googleDriveReconnectPromise;
    }

    googleDriveReconnectPromise = restoreRememberedGoogleDriveSessionOnce();
    refreshCatStorageControls();

    try {
        return await googleDriveReconnectPromise;
    } finally {
        googleDriveReconnectPromise = null;
        refreshCatStorageControls();
    }
}

function queueBackupForCurrentDrive(backup, settings = extension_settings[extensionName]) {
    return queueBackupForDrive(backup, {
        accountHint: settings.googleDriveAccountHint,
        folderName: settings.googleDriveFolderName || DEFAULT_GOOGLE_DRIVE_FOLDER_NAME,
    });
}

function schedulePendingDriveRetry(delayMs = GOOGLE_DRIVE_PENDING_RETRY_DELAY_MS) {
    if (pendingDriveRetryTimer || isBackupDisabled()) {
        return;
    }

    pendingDriveRetryTimer = globalThis.setTimeout(() => {
        pendingDriveRetryTimer = null;
        // Same reasoning as the retry events: a timer is not a user asking to
        // sign in. It delivers what is queued if a session is open.
        void flushPendingDriveBackups({ allowReconnect: false });
    }, Math.max(1_000, Number(delayMs) || GOOGLE_DRIVE_PENDING_RETRY_DELAY_MS));
}

async function flushPendingDriveBackupsOnce({ allowReconnect = true } = {}) {
    const settings = extension_settings[extensionName];

    if (isBackupDisabled(settings) || settings.storageDestination !== "google_drive") {
        return { uploadedCount: 0, pendingCount: 0 };
    }

    // A flush that nobody asked for must not start an authorization. Background
    // triggers fire far more often than they look like they do — visibilitychange
    // alone lands on every app switch, screen lock and tab change — and each
    // reconnect attempt that fails clears the remembered account, so a phone left
    // switching between apps can walk itself out of a working session.
    if (!isGoogleDriveConnected()) {
        if (!allowReconnect || !await restoreRememberedGoogleDriveSession()) {
            return { uploadedCount: 0, pendingCount: 0 };
        }
    }

    const accountHint = googleDriveAccount?.emailAddress
        || settings.googleDriveAccountHint
        || "";
    const pendingBackups = await getPendingDriveBackups(accountHint);
    let uploadedCount = 0;

    for (const backup of pendingBackups) {
        try {
            const result = await driveAutoUploadQueue.enqueue(backup, 1);

            if (!result.uploaded) {
                schedulePendingDriveRetry();
                break;
            }

            uploadedCount += 1;
        } catch (error) {
            googleDriveStatusMessage = `ยังมีสำเนารอส่งขึ้น Drive ${pendingBackups.length - uploadedCount} รายการ`;
            schedulePendingDriveRetry();
            console.warn(`[${extensionName}] Pending Drive upload will retry:`, error);
            break;
        }
    }

    if (uploadedCount > 0) {
        googleDriveStatusMessage = `ส่งสำเนาที่ค้างขึ้น Drive แล้ว ${uploadedCount} รายการ`;
        await refreshLatestBackupStatus();
    }

    refreshCatStorageControls();
    return { uploadedCount, pendingCount: pendingBackups.length - uploadedCount };
}

async function flushPendingDriveBackups(options = {}) {
    if (pendingDriveFlushPromise) {
        return await pendingDriveFlushPromise;
    }

    pendingDriveFlushPromise = flushPendingDriveBackupsOnce(options);

    try {
        return await pendingDriveFlushPromise;
    } finally {
        pendingDriveFlushPromise = null;
    }
}

function registerDriveRetryEvents() {
    if (driveRetryEventsRegistered) {
        return;
    }

    // Both of these say "a moment that might be a good time to send what is
    // queued", not "the user wants to connect". They send when a session is
    // already open and stay quiet otherwise; reconnecting is the connect
    // button's job, where it is something the user chose.
    globalThis.addEventListener("online", () => {
        void flushPendingDriveBackups({ allowReconnect: false });
    });
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            void flushPendingDriveBackups({ allowReconnect: false });
        }
    });
    driveRetryEventsRegistered = true;
}

function isBackupDisabled(settings = extension_settings[extensionName]) {
    return normalizeAutoSaveMode(settings?.autoSaveMode) === AUTO_SAVE_MODE_DISABLED;
}

async function configureVaultEncryption() {
    // Advanced, at-your-own-risk gate. The user must accept the consequence
    // before a passphrase is ever set, so enabling this can't happen by an
    // accidental tick and "I wasn't told" is off the table.
    const acknowledged = globalThis.confirm(
        "⚠️ โหมดขั้นสูง · เปิดใช้โดยยอมรับความเสี่ยงเอง\n\n"
        + "การเข้ารหัสจะล็อกแชทด้วยรหัสผ่านของคุณเอง ถ้าลืมทั้งรหัสผ่านและ Recovery Key "
        + "จะไม่มีใครกู้ข้อมูลให้ได้เลย — ไม่มีปุ่มรีเซ็ต ไม่มีเซิร์ฟเวอร์สำรอง\n\n"
        + "เข้าใจและยอมรับความเสี่ยงนี้หรือไม่?",
    );

    if (!acknowledged) {
        return false;
    }

    const passphrase = globalThis.prompt(
        `ตั้งรหัสผ่าน ${extensionDisplayName} อย่างน้อย 8 ตัวอักษร\nรหัสนี้จะไม่ถูกบันทึกไว้`,
        "",
    );

    if (passphrase === null) {
        return false;
    }

    if (String(passphrase).length < 8) {
        toastr.warning("รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร", extensionDisplayName);
        return false;
    }

    const confirmation = globalThis.prompt("พิมพ์รหัสผ่านเดิมอีกครั้ง", "");

    if (confirmation !== passphrase) {
        toastr.error("รหัสผ่านทั้งสองครั้งไม่ตรงกัน", extensionDisplayName);
        return false;
    }

    // Optional memory jog shown at unlock time. A hint is not a recovery path —
    // it never reveals the passphrase — so it is stored in plain settings, and
    // we warn the user not to type the real password here.
    const hintInput = globalThis.prompt(
        "ใส่คำใบ้ช่วยจำรหัสผ่าน (ไม่บังคับ · เว้นว่างได้)\n"
        + "⚠️ อย่าใส่ตัวรหัสจริง — คำใบ้นี้ถูกเก็บแบบไม่เข้ารหัส",
        "",
    );
    const passphraseHint = hintInput === null
        ? ""
        : String(hintInput).trim().slice(0, 120);

    const recoveryKey = createRecoveryKey();
    const settings = extension_settings[extensionName];

    settings.encryptedRecoveryKey = await encryptVaultArchive(recoveryKey, passphrase);
    settings.encryptionEnabled = true;
    settings.encryptionPassphraseHint = passphraseHint;
    vaultEncryptionPassphrase = passphrase;
    vaultRecoveryKey = recoveryKey;
    saveSettingsDebounced();
    downloadRecoveryKey(recoveryKey);
    globalThis.alert(
        "เปิดการเข้ารหัสแล้ว และดาวน์โหลด recovery key ให้แล้ว\n"
        + "เก็บไฟล์นั้นไว้คนละที่กับ SillyTavern เพราะหากลืมทั้งรหัสผ่านและ recovery key จะกู้ข้อมูลไม่ได้",
    );
    return true;
}

async function unlockVaultEncryption({ interactive = true } = {}) {
    const settings = extension_settings[extensionName];

    if (!settings.encryptionEnabled) {
        return true;
    }

    if (vaultEncryptionPassphrase) {
        return true;
    }

    if (!interactive) {
        return false;
    }

    const passphraseHint = String(settings.encryptionPassphraseHint || "").trim();
    const passphrase = globalThis.prompt(
        `ปลดล็อก ${extensionDisplayName} เพื่อเข้ารหัสสำเนา\nรหัสจะอยู่ในหน่วยความจำจนกว่าจะปิดหรือรีโหลดหน้า`
        + (passphraseHint ? `\n\nคำใบ้: ${passphraseHint}` : ""),
        "",
    );

    if (passphrase === null) {
        return false;
    }

    try {
        const recoveryKey = settings.encryptedRecoveryKey
            ? await decryptVaultArchive(settings.encryptedRecoveryKey, passphrase)
            : "";

        vaultEncryptionPassphrase = passphrase;
        vaultRecoveryKey = recoveryKey;
        return true;
    } catch (error) {
        toastr.error("รหัสผ่านไม่ถูกต้อง", extensionDisplayName);
        console.info(`[${extensionName}] Vault unlock failed:`, error);
        return false;
    }
}

async function captureBackupAttachments(backup, limitMb) {
    const references = collectAttachmentReferences(backup.content);
    const maxBytes = clamp(Number(limitMb) || 100, 10, 250) * 1024 * 1024;
    const attachments = [];
    let totalBytes = 0;
    let skippedCount = 0;

    for (const reference of references) {
        try {
            const assetUrl = new URL(reference.originalUrl, globalThis.location.href);

            if (assetUrl.protocol !== "data:" && assetUrl.origin !== globalThis.location.origin) {
                skippedCount += 1;
                continue;
            }

            const response = await fetch(assetUrl.href, {
                method: "GET",
                credentials: "same-origin",
                cache: "force-cache",
            });

            if (!response.ok) {
                skippedCount += 1;
                continue;
            }

            const blob = await response.blob();

            if (totalBytes + blob.size > maxBytes) {
                skippedCount += 1;
                continue;
            }

            const pathName = decodeURIComponent(assetUrl.pathname.split("/").pop() || "");
            const name = reference.name || pathName || `${reference.id}.bin`;

            totalBytes += blob.size;
            attachments.push({
                ...reference,
                name,
                mimeType: blob.type || reference.mimeType || "application/octet-stream",
                size: blob.size,
                data: bytesToBase64(await blob.arrayBuffer()),
            });
        } catch (error) {
            skippedCount += 1;
            console.warn(`[${extensionName}] Attachment skipped:`, reference.originalUrl, error);
        }
    }

    return { attachments, skippedCount, totalBytes };
}

async function prepareBackupForDrive(backup, settings, {
    includeAttachments = false,
    interactive = false,
} = {}) {
    const shouldIncludeAttachments = Boolean(
        includeAttachments && settings.includeAttachmentsInCheckpoints,
    );

    if (!settings.encryptionEnabled && !shouldIncludeAttachments) {
        return backup;
    }

    if (settings.encryptionEnabled && !await unlockVaultEncryption({ interactive })) {
        throw new VaultArchiveError(
            "vault_locked",
            "Vault must be unlocked before encrypted backup",
        );
    }

    const capture = shouldIncludeAttachments
        ? await captureBackupAttachments(backup, settings.attachmentLimitMb)
        : { attachments: [], skippedCount: 0, totalBytes: 0 };
    let archiveContent = createVaultArchive({
        backup,
        attachments: capture.attachments,
    });

    if (settings.encryptionEnabled) {
        archiveContent = await encryptVaultArchive(
            archiveContent,
            vaultEncryptionPassphrase,
            { recoveryKey: vaultRecoveryKey },
        );
    }

    return {
        ...backup,
        drivePayload: {
            content: archiveContent,
            fileName: String(backup.fileName || "chat-vault-backup.jsonl")
                .replace(/\.jsonl$/i, ".cvault"),
            mimeType: "application/vnd.chat-vault+json",
            encrypted: Boolean(settings.encryptionEnabled),
            attachmentCount: capture.attachments.length,
            skippedAttachmentCount: capture.skippedCount,
        },
    };
}

async function readVaultBackupPackage(content, { interactive = true } = {}) {
    try {
        const vaultPackage = await parseVaultPackage(content, {
            secret: vaultEncryptionPassphrase || vaultArchiveUnlockSecret,
        });

        return {
            vaultPackage,
            parsedBackup: parseChatVaultBackup(vaultPackage.backupContent),
        };
    } catch (error) {
        if (!(error instanceof VaultArchiveError)
            || !["secret_required", "invalid_secret"].includes(error.code)
            || !interactive) {
            throw error;
        }

        const secret = globalThis.prompt(
            "ไฟล์นี้เข้ารหัสอยู่\nใส่รหัสผ่านหรือ recovery key เพื่อดูและกู้คืน",
            "",
        );

        if (secret === null) {
            throw new VaultArchiveError("unlock_cancelled", "Archive unlock was cancelled");
        }

        const vaultPackage = await parseVaultPackage(content, { secret });

        vaultArchiveUnlockSecret = secret;

        return {
            vaultPackage,
            parsedBackup: parseChatVaultBackup(vaultPackage.backupContent),
        };
    }
}

async function restoreArchiveAssetToSillyTavern(attachment) {
    const safeName = String(attachment.name || `${attachment.id}.bin`)
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120) || `${attachment.id}.bin`;
    const uniqueName = `chat-vault_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeName}`;
    const response = await fetch("/api/files/upload", {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify({
            name: uniqueName,
            data: attachment.data,
        }),
    });

    if (!response.ok) {
        throw new VaultArchiveError(
            "attachment_restore_failed",
            `SillyTavern rejected ${safeName}`,
        );
    }

    const result = await response.json();
    return result.path;
}

async function prepareVaultPackageForRestore(vaultPackage) {
    if (!vaultPackage.archive || !vaultPackage.attachments.length) {
        return parseChatVaultBackup(vaultPackage.backupContent);
    }

    const restoredContent = await restoreArchiveAttachments(
        vaultPackage.archive,
        restoreArchiveAssetToSillyTavern,
    );

    return parseChatVaultBackup(restoredContent);
}

function createCatMagnet() {
    if (document.getElementById("chat_vault_cat_magnet")) {
        return;
    }

    const cat = document.createElement("div");
    const image = document.createElement("img");
    const menu = document.createElement("div");
    const menuTitle = document.createElement("div");
    const accountRow = document.createElement("div");
    const accountMenu = document.createElement("div");
    const tabList = document.createElement("div");
    const backupTabButton = document.createElement("button");
    const restoreTabButton = document.createElement("button");
    const settingsTabButton = document.createElement("button");
    const aboutTabButton = document.createElement("button");
    const backupPanel = document.createElement("section");
    const restorePanel = document.createElement("section");
    const settingsPanel = document.createElement("section");
    const aboutPanel = document.createElement("section");
    const vaultHealthSummary = document.createElement("div");
    const backupButton = document.createElement("button");
    const vaultActions = document.createElement("div");
    const checkpointButton = document.createElement("button");
    const timeMachineButton = document.createElement("button");
    const healthButton = document.createElement("button");
    const rescueButton = document.createElement("button");
    const restoreActions = document.createElement("div");
    const storageSection = document.createElement("div");
    const storageLabel = document.createElement("label");
    const storageSelect = document.createElement("select");
    const driveConnectionStatus = document.createElement("button");
    const accountMenuToggle = document.createElement("button");
    const driveConnectButton = document.createElement("button");
    const driveConnectLabel = document.createElement("span");
    const driveSwitchAccountButton = document.createElement("button");
    const driveDisconnectButton = document.createElement("button");
    const driveSettingsDetails = document.createElement("details");
    const driveSettingsSummary = document.createElement("summary");
    const driveFolderSection = document.createElement("div");
    const driveFolderLabel = document.createElement("label");
    const driveFolderSelect = document.createElement("select");
    const driveFolderInput = document.createElement("input");
    const driveFolderButton = document.createElement("button");
    const driveFolderCleanupButton = document.createElement("button");
    const driveFolderOpenLink = document.createElement("a");
    const driveLastFileOpenLink = document.createElement("a");
    const driveFolderNote = document.createElement("small");
    const driveFolderLooseNote = document.createElement("small");
    const driveFolderWarning = document.createElement("small");
    const driveRestoreButton = document.createElement("button");
    const localRestoreButton = document.createElement("button");
    const localRestoreInput = document.createElement("input");
    const storageNote = document.createElement("small");
    const driveUsageSection = document.createElement("div");
    const driveUsageLabel = document.createElement("label");
    const driveUsageModeSelect = document.createElement("select");
    const driveUsageCustomRow = document.createElement("label");
    const driveUsageInput = document.createElement("input");
    const driveUsageStatus = document.createElement("small");
    const autoSaveSection = document.createElement("div");
    const autoSaveLabel = document.createElement("label");
    const autoSaveSelect = document.createElement("select");
    const customCountRow = document.createElement("div");
    const customCountInput = document.createElement("input");
    const historyLimitRow = document.createElement("div");
    const historyLimitLabel = document.createElement("label");
    const historyLimitSelect = document.createElement("select");
    const latestBackupStatus = document.createElement("div");
    const autoSaveNote = document.createElement("small");
    const securitySection = document.createElement("div");
    const securityDetails = document.createElement("details");
    const securitySummary = document.createElement("summary");
    const securityTitle = document.createElement("strong");
    const encryptionRow = document.createElement("div");
    const encryptionCheckbox = document.createElement("input");
    const encryptionLabel = document.createElement("label");
    const encryptionStatus = document.createElement("small");
    const encryptionActions = document.createElement("div");
    const encryptionUnlockButton = document.createElement("button");
    const recoveryKeyButton = document.createElement("button");
    const attachmentRow = document.createElement("div");
    const attachmentCheckbox = document.createElement("input");
    const attachmentLabel = document.createElement("label");
    const attachmentLimitSelect = document.createElement("select");
    const encryptionRiskNote = document.createElement("small");
    const securityNote = document.createElement("small");
    let driveConnectionAction = "";
    let activeMenuTab = "backup";

    cat.id = "chat_vault_cat_magnet";
    cat.setAttribute("role", "img");
    cat.setAttribute("aria-label", `${extensionDisplayName} cat`);
    cat.title = `${extensionDisplayName} — ลากไปวางตรงไหนก็ได้`;

    preloadCatHealthImages();
    image.dataset.chatVaultHealth = "idle";
    image.src = getCatHealthImageUrl("idle");
    image.alt = "";
    image.draggable = false;
    cat.append(image);

    menu.id = "chat_vault_cat_menu";
    menu.hidden = true;
    menuTitle.className = "chat-vault-cat-menu-title";
    menuTitle.textContent = `🐱 คลังของพ็อกกี้ · v${extensionVersion}`;
    accountMenu.className = "chat-vault-account-menu";
    accountMenu.hidden = true;
    tabList.className = "chat-vault-tabs";
    tabList.setAttribute("role", "tablist");
    tabList.setAttribute("aria-label", `หมวด ${extensionDisplayName}`);
    const configureTabButton = (button, id, label) => {
        button.type = "button";
        button.className = "chat-vault-tab-button";
        button.dataset.tab = id;
        button.setAttribute("role", "tab");
        button.setAttribute("aria-controls", `chat_vault_${id}_panel`);
        button.textContent = label;
    };
    configureTabButton(backupTabButton, "backup", "สำรอง");
    configureTabButton(restoreTabButton, "restore", "กู้คืน");
    configureTabButton(settingsTabButton, "settings", "ตั้งค่า");
    configureTabButton(aboutTabButton, "about", "พ็อกกี้");
    tabList.append(
        backupTabButton,
        restoreTabButton,
        settingsTabButton,
        aboutTabButton,
    );
    const configureTabPanel = (panel, id) => {
        panel.id = `chat_vault_${id}_panel`;
        panel.className = "chat-vault-tab-panel";
        panel.dataset.panel = id;
        panel.setAttribute("role", "tabpanel");
    };
    configureTabPanel(backupPanel, "backup");
    configureTabPanel(restorePanel, "restore");
    configureTabPanel(settingsPanel, "settings");
    configureTabPanel(aboutPanel, "about");
    aboutPanel.append(createPokkiAboutSection());
    vaultHealthSummary.className = "chat-vault-health-summary chat-vault-health-idle";
    vaultHealthSummary.setAttribute("role", "status");
    vaultHealthSummary.setAttribute("aria-live", "polite");
    vaultHealthSummary.textContent = "กำลังตรวจสุขภาพ Vault...";
    backupButton.type = "button";
    backupButton.className = "menu_button chat-vault-cat-menu-button";
    backupButton.textContent = "ฝากพ็อกกี้เก็บตอนนี้";
    vaultActions.className = "chat-vault-quick-actions";
    checkpointButton.type = "button";
    checkpointButton.className = "menu_button chat-vault-checkpoint-button";
    checkpointButton.textContent = "ปักหมุดให้พ็อกกี้คาบไว้";
    timeMachineButton.type = "button";
    timeMachineButton.className = "menu_button chat-vault-time-machine-button";
    timeMachineButton.textContent = "ไทม์แมชชีนพ็อกกี้";
    healthButton.type = "button";
    healthButton.className = "menu_button chat-vault-health-button";
    healthButton.textContent = "ซ้อมกู้กับพ็อกกี้";
    rescueButton.type = "button";
    rescueButton.className = "menu_button chat-vault-rescue-button";
    rescueButton.textContent = "ภารกิจกู้ภัยพ็อกกี้";
    vaultActions.append(checkpointButton, healthButton);
    restoreActions.className = "chat-vault-restore-menu-actions";

    storageSection.className = "chat-vault-storage-section";
    storageLabel.htmlFor = "chat_vault_storage_destination";
    storageLabel.textContent = "ที่เก็บสำเนา";
    storageSelect.id = "chat_vault_storage_destination";
    storageSelect.className = "text_pole chat-vault-storage-select";
    storageSelect.append(
        new Option("ในอุปกรณ์นี้", "device"),
        new Option("Google Drive", "google_drive"),
    );
    accountRow.className = "chat-vault-account-row";
    driveConnectionStatus.type = "button";
    driveConnectionStatus.className = "chat-vault-account-button";
    driveConnectionStatus.setAttribute("aria-live", "polite");
    driveConnectionStatus.setAttribute("aria-expanded", "false");
    driveConnectionStatus.setAttribute("aria-haspopup", "menu");
    driveConnectionStatus.setAttribute("aria-controls", "chat_vault_account_menu");
    accountMenuToggle.type = "button";
    accountMenuToggle.className = "chat-vault-account-menu-toggle";
    accountMenuToggle.innerHTML = ICON_KEBAB_SVG;
    accountMenuToggle.setAttribute("aria-label", "ตัวเลือกบัญชี Google");
    accountMenuToggle.setAttribute("aria-expanded", "false");
    accountMenuToggle.setAttribute("aria-haspopup", "menu");
    accountMenuToggle.setAttribute("aria-controls", "chat_vault_account_menu");
    accountMenu.id = "chat_vault_account_menu";
    // The connect action is now the primary control when disconnected, so it
    // leaves the fold-out menu and sits in the account row with the Google mark.
    driveConnectButton.type = "button";
    driveConnectButton.className = "menu_button chat-vault-drive-connect-button";
    driveConnectLabel.className = "chat-vault-drive-connect-label";
    driveConnectLabel.textContent = "ต่อบัญชี Google ให้พ็อกกี้";
    driveConnectButton.innerHTML = `<span class="chat-vault-drive-connect-g">${GOOGLE_G_SVG}</span>`;
    driveConnectButton.append(driveConnectLabel);
    driveSwitchAccountButton.type = "button";
    driveSwitchAccountButton.className = "menu_button chat-vault-drive-switch-account-button";
    driveSwitchAccountButton.textContent = "สลับบัญชี Google";
    driveDisconnectButton.type = "button";
    driveDisconnectButton.className = "menu_button chat-vault-drive-disconnect-button";
    driveDisconnectButton.textContent = "ตัดการเชื่อมต่อจากอุปกรณ์นี้";
    accountRow.append(
        driveConnectButton,
        driveConnectionStatus,
        accountMenuToggle,
    );
    // The fold-out now holds only the secondary actions; connect moved out.
    accountMenu.append(
        driveSwitchAccountButton,
        driveDisconnectButton,
    );
    driveSettingsDetails.className = "chat-vault-settings-details";
    driveSettingsSummary.textContent = "โฟลเดอร์และพื้นที่ Google Drive";
    driveSettingsDetails.append(driveSettingsSummary);
    driveFolderSection.className = "chat-vault-drive-folder-section";
    driveFolderLabel.htmlFor = "chat_vault_drive_folder_select";
    driveFolderLabel.textContent = "โฟลเดอร์สำรองใน Drive";
    driveFolderSelect.id = "chat_vault_drive_folder_select";
    driveFolderSelect.className = "text_pole chat-vault-drive-folder-select";
    driveFolderCleanupButton.type = "button";
    driveFolderCleanupButton.className = "menu_button chat-vault-drive-folder-cleanup-button";
    driveFolderCleanupButton.hidden = true;
    driveFolderInput.id = "chat_vault_drive_folder_name";
    driveFolderInput.type = "text";
    driveFolderInput.maxLength = 80;
    driveFolderInput.autocomplete = "off";
    driveFolderInput.className = "text_pole chat-vault-drive-folder-input";
    driveFolderInput.placeholder = DEFAULT_GOOGLE_DRIVE_FOLDER_NAME;
    driveFolderButton.type = "button";
    driveFolderButton.className = "menu_button chat-vault-drive-folder-button";
    driveFolderButton.textContent = "ใช้โฟลเดอร์นี้";
    driveFolderOpenLink.className = "menu_button chat-vault-drive-folder-open-link";
    driveFolderOpenLink.target = "_blank";
    driveFolderOpenLink.rel = "noopener noreferrer";
    driveFolderOpenLink.textContent = "เปิดโฟลเดอร์นี้ใน Google Drive";
    driveLastFileOpenLink.className = "menu_button chat-vault-drive-last-file-open-link";
    driveLastFileOpenLink.target = "_blank";
    driveLastFileOpenLink.rel = "noopener noreferrer";
    driveLastFileOpenLink.textContent = "เปิดไฟล์สำรองล่าสุด";
    driveFolderNote.className = "chat-vault-drive-folder-note";
    driveFolderLooseNote.className = "chat-vault-drive-folder-loose-note";
    driveFolderLooseNote.hidden = true;
    driveFolderWarning.className = "chat-vault-drive-folder-warning";
    driveFolderWarning.textContent = "ไฟล์ที่เห็นใน Home/Recent คือไฟล์เดียวกับในโฟลเดอร์ · ลบตรงนั้นจะลบไฟล์ในโฟลเดอร์ด้วย";
    driveFolderSection.append(
        driveFolderLabel,
        driveFolderSelect,
        driveFolderInput,
        driveFolderButton,
        driveFolderCleanupButton,
        driveFolderLooseNote,
        driveFolderOpenLink,
        driveLastFileOpenLink,
        driveFolderNote,
        driveFolderWarning,
    );
    driveRestoreButton.type = "button";
    driveRestoreButton.className = "menu_button chat-vault-drive-restore-button";
    driveRestoreButton.textContent = "กู้คืนจาก Google Drive";
    localRestoreButton.type = "button";
    localRestoreButton.className = "menu_button chat-vault-local-restore-button";
    localRestoreButton.textContent = "กู้คืนจากไฟล์ .jsonl / .cvault";
    localRestoreInput.type = "file";
    localRestoreInput.accept = ".jsonl,.cvault,application/x-ndjson,application/json";
    localRestoreInput.hidden = true;
    storageNote.className = "chat-vault-cat-menu-note";
    driveUsageSection.className = "chat-vault-drive-usage-section";
    driveUsageLabel.htmlFor = "chat_vault_drive_usage_mode";
    driveUsageLabel.textContent = `พื้นที่สำรองของ ${extensionDisplayName}`;
    driveUsageModeSelect.id = "chat_vault_drive_usage_mode";
    driveUsageModeSelect.className = "text_pole chat-vault-drive-usage-mode";
    driveUsageModeSelect.append(
        new Option("ไม่จำกัด", DRIVE_USAGE_MODE_UNLIMITED),
        new Option("แจ้งเตือนเมื่อถึงที่กำหนด", DRIVE_USAGE_MODE_WARNING),
    );
    driveUsageCustomRow.className = "chat-vault-drive-usage-custom";
    driveUsageCustomRow.htmlFor = "chat_vault_drive_usage_warning_gb";
    driveUsageCustomRow.append("แจ้งเตือนที่ ");
    driveUsageInput.id = "chat_vault_drive_usage_warning_gb";
    driveUsageInput.type = "number";
    driveUsageInput.min = "0.1";
    driveUsageInput.max = "1000";
    driveUsageInput.step = "0.1";
    driveUsageInput.inputMode = "decimal";
    driveUsageInput.className = "text_pole chat-vault-drive-usage-input";
    driveUsageCustomRow.append(driveUsageInput, " GB");
    driveUsageStatus.className = "chat-vault-drive-usage-status";
    driveUsageStatus.setAttribute("role", "status");
    driveUsageSection.append(
        driveUsageLabel,
        driveUsageModeSelect,
        driveUsageCustomRow,
        driveUsageStatus,
    );
    driveSettingsDetails.append(driveFolderSection, driveUsageSection);
    storageSection.append(
        storageLabel,
        storageSelect,
        driveSettingsDetails,
        storageNote,
    );
    restoreActions.append(
        timeMachineButton,
        driveRestoreButton,
        localRestoreButton,
        rescueButton,
        localRestoreInput,
    );

    autoSaveSection.className = "chat-vault-autosave-section";
    autoSaveLabel.htmlFor = "chat_vault_autosave_mode";
    autoSaveLabel.textContent = "ความถี่ Auto-save";
    autoSaveSelect.id = "chat_vault_autosave_mode";
    autoSaveSelect.className = "text_pole chat-vault-autosave-select";
    autoSaveSelect.append(
        new Option("ไม่สำรองข้อมูล", AUTO_SAVE_MODE_DISABLED),
        new Option("สำรองด้วยมือเท่านั้น", AUTO_SAVE_MODE_MANUAL),
        new Option("ปลอดภัยสูงสุด — ตอนส่งและตอบเสร็จ", "every_message"),
        new Option("สมดุล — เมื่อคำตอบเสร็จ (แนะนำ)", AUTO_SAVE_MODE_TURN_COMPLETE),
        new Option("เลือกเอง", AUTO_SAVE_MODE_MESSAGE_COUNT),
    );

    customCountRow.className = "chat-vault-custom-count-row";
    customCountRow.append("ทุก ");
    customCountInput.id = "chat_vault_autosave_message_count";
    customCountInput.type = "number";
    customCountInput.min = "1";
    customCountInput.max = "100";
    customCountInput.step = "1";
    customCountInput.inputMode = "numeric";
    customCountInput.className = "text_pole chat-vault-custom-count-input";
    customCountRow.append(customCountInput, " ข้อความ");

    historyLimitRow.className = "chat-vault-history-limit-row";
    historyLimitLabel.htmlFor = "chat_vault_history_limit";
    historyLimitLabel.textContent = "ประวัติย้อนหลัง";
    historyLimitSelect.id = "chat_vault_history_limit";
    historyLimitSelect.className = "text_pole chat-vault-history-limit-select";
    historyLimitSelect.append(
        new Option("10 เวอร์ชัน", "10"),
        new Option("30 เวอร์ชัน", "30"),
        new Option("50 เวอร์ชัน", "50"),
        new Option("100 เวอร์ชัน", "100"),
    );
    historyLimitRow.append(historyLimitLabel, historyLimitSelect);

    latestBackupStatus.id = "chat_vault_latest_backup_status";
    latestBackupStatus.className = "chat-vault-latest-backup-status";
    latestBackupStatus.textContent = "กำลังตรวจสอบสำเนาล่าสุด...";

    autoSaveNote.className = "chat-vault-cat-menu-note";
    autoSaveNote.textContent = "Auto-save พร้อมเก็บในเครื่องและส่งตามที่ตั้งไว้";
    autoSaveSection.append(
        autoSaveLabel,
        autoSaveSelect,
        customCountRow,
        historyLimitRow,
        autoSaveNote,
    );

    securitySection.className = "chat-vault-security-section";
    securityDetails.className = "chat-vault-settings-details";
    securitySummary.textContent = "การเข้ารหัสและไฟล์แนบ";
    securityTitle.textContent = "Encrypted Vault · ขั้นสูง";
    encryptionRow.className = "chat-vault-checkbox-row";
    encryptionCheckbox.id = "chat_vault_encryption_enabled";
    encryptionCheckbox.type = "checkbox";
    encryptionLabel.htmlFor = encryptionCheckbox.id;
    encryptionLabel.textContent = "เข้ารหัสก่อนส่งหรือดาวน์โหลด";
    encryptionRow.append(encryptionCheckbox, encryptionLabel);
    // Always-visible so the risk is clear before anyone ticks the box. Kept in
    // plain, blunt language on purpose — this is a data-loss warning, not a spot
    // for Pokki's voice.
    encryptionRiskNote.className = "chat-vault-security-warning";
    encryptionRiskNote.textContent = "⚠️ โหมดขั้นสูง · ถ้าลืมทั้งรหัสผ่านและ Recovery Key จะกู้แชทที่เข้ารหัสไว้ไม่ได้เลย ไม่มีใครรีเซ็ตให้ได้";
    encryptionStatus.className = "chat-vault-security-status";
    encryptionActions.className = "chat-vault-security-actions";
    encryptionUnlockButton.type = "button";
    encryptionUnlockButton.className = "menu_button";
    recoveryKeyButton.type = "button";
    recoveryKeyButton.className = "menu_button";
    recoveryKeyButton.textContent = "ดาวน์โหลด Recovery Key";
    encryptionActions.append(encryptionUnlockButton, recoveryKeyButton);
    attachmentRow.className = "chat-vault-attachment-row";
    attachmentCheckbox.id = "chat_vault_include_attachments";
    attachmentCheckbox.type = "checkbox";
    attachmentLabel.htmlFor = attachmentCheckbox.id;
    attachmentLabel.textContent = "รวมรูป/ไฟล์แนบในจุดคืนค่าที่ปักหมุด";
    attachmentLimitSelect.className = "text_pole chat-vault-attachment-limit";
    attachmentLimitSelect.append(
        new Option("สูงสุด 25 MB", "25"),
        new Option("สูงสุด 50 MB", "50"),
        new Option("สูงสุด 100 MB", "100"),
        new Option("สูงสุด 250 MB", "250"),
    );
    attachmentRow.append(
        attachmentCheckbox,
        attachmentLabel,
        attachmentLimitSelect,
    );
    securityNote.className = "chat-vault-cat-menu-note";
    securityNote.textContent = "การรวมสื่อทำให้ไฟล์ใหญ่ขึ้นมาก กินเน็ตและหน่วยความจำมากกว่าปกติ · จะรวมให้เฉพาะตอนสำรองด้วยมือและจุดที่ปักหมุด ส่วน Auto-save ปกติเก็บแค่ข้อความ";
    securitySection.append(
        securityTitle,
        encryptionRow,
        encryptionRiskNote,
        encryptionStatus,
        encryptionActions,
        attachmentRow,
        securityNote,
    );
    securityDetails.append(securitySummary, securitySection);
    backupPanel.append(
        vaultHealthSummary,
        latestBackupStatus,
        backupButton,
        vaultActions,
    );
    restorePanel.append(restoreActions);
    settingsPanel.append(
        storageSection,
        autoSaveSection,
        securityDetails,
    );
    menu.append(
        menuTitle,
        accountRow,
        accountMenu,
        tabList,
        backupPanel,
        restorePanel,
        settingsPanel,
        aboutPanel,
    );

    document.body.append(cat);
    document.body.append(menu);
    placeCatFromSettings(cat);
    cat.classList.add("chat-vault-cat-idle");
    updateCatVisibility();

    let activePointerId = null;
    let pointerOffsetX = 0;
    let pointerOffsetY = 0;
    let pointerStartX = 0;
    let pointerStartY = 0;
    let didDrag = false;
    let idleTimer = null;

    const showCatFully = () => {
        clearTimeout(idleTimer);
        idleTimer = null;
        cat.classList.remove("chat-vault-cat-idle");
    };

    const scheduleCatFade = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            cat.classList.add("chat-vault-cat-idle");
            idleTimer = null;
        }, 3000);
    };

    const selectMenuTab = (tabId) => {
        activeMenuTab = ["backup", "restore", "settings", "about"].includes(tabId)
            ? tabId
            : "backup";

        for (const button of [
            backupTabButton,
            restoreTabButton,
            settingsTabButton,
            aboutTabButton,
        ]) {
            button.setAttribute(
                "aria-selected",
                String(button.dataset.tab === activeMenuTab),
            );
        }

        for (const panel of [backupPanel, restorePanel, settingsPanel, aboutPanel]) {
            panel.hidden = panel.dataset.panel !== activeMenuTab;
        }

        accountMenu.hidden = true;
        driveConnectionStatus.setAttribute("aria-expanded", "false");
        accountMenuToggle.setAttribute("aria-expanded", "false");

        if (!menu.hidden) {
            requestAnimationFrame(positionCatMenu);
        }
    };

    const positionCatMenu = () => {
        const margin = 8;
        const catRect = cat.getBoundingClientRect();
        const menuWidth = menu.offsetWidth;
        const menuHeight = menu.offsetHeight;
        let left = catRect.right + margin;

        if (left + menuWidth > window.innerWidth - margin) {
            left = catRect.left - menuWidth - margin;
        }

        const maxLeft = Math.max(margin, window.innerWidth - menuWidth - margin);
        const maxTop = Math.max(margin, window.innerHeight - menuHeight - margin);
        menu.style.left = `${Math.round(clamp(left, margin, maxLeft))}px`;
        menu.style.top = `${Math.round(clamp(catRect.top, margin, maxTop))}px`;
    };

    const openCatMenu = () => {
        selectMenuTab(activeMenuTab);
        updateStorageControls();
        updateAutoSaveControls();
        refreshVaultSecurityUi();
        menu.hidden = false;
        positionCatMenu();
        showCatFully();
        Promise.all([
            refreshLatestBackupStatus(),
            refreshVaultHealthUi(),
            refreshGoogleDriveUsage(),
        ]).finally(() => {
            if (!menu.hidden) {
                requestAnimationFrame(positionCatMenu);
            }
        });
    };

    const closeCatMenu = () => {
        menu.hidden = true;
        accountMenu.hidden = true;
        driveConnectionStatus.setAttribute("aria-expanded", "false");
        accountMenuToggle.setAttribute("aria-expanded", "false");
        scheduleCatFade();
    };

    const toggleCatMenu = () => {
        if (menu.hidden) {
            openCatMenu();
        } else {
            closeCatMenu();
        }
    };

    const updateAutoSaveControls = () => {
        customCountRow.hidden = autoSaveSelect.value !== AUTO_SAVE_MODE_MESSAGE_COUNT;

        if (!menu.hidden) {
            requestAnimationFrame(positionCatMenu);
        }
    };

    const updateSecurityControls = () => {
        const settings = extension_settings[extensionName];
        const encryptionEnabled = Boolean(settings.encryptionEnabled);
        const encryptionUnlocked = Boolean(vaultEncryptionPassphrase);

        encryptionCheckbox.checked = encryptionEnabled;
        attachmentCheckbox.checked = Boolean(settings.includeAttachmentsInCheckpoints);
        attachmentLimitSelect.value = String(settings.attachmentLimitMb);
        attachmentLimitSelect.disabled = !attachmentCheckbox.checked;
        encryptionStatus.textContent = !encryptionEnabled
            ? "ปิดอยู่ · ไฟล์ JSONL บน Drive อ่านได้ตามปกติ"
            : (encryptionUnlocked
                ? "✓ ปลดล็อกแล้ว · สำเนาใหม่จะเข้ารหัสในเบราว์เซอร์"
                : "ล็อกอยู่ · ปลดล็อกหนึ่งครั้งหลังเปิดหรือรีโหลดหน้า");
        encryptionStatus.classList.toggle(
            "chat-vault-security-status-success",
            encryptionEnabled && encryptionUnlocked,
        );
        encryptionUnlockButton.textContent = !encryptionEnabled
            ? "ตั้งค่าการเข้ารหัส"
            : (encryptionUnlocked ? "ปลดล็อกแล้ว" : "ปลดล็อก Encrypted Vault");
        encryptionUnlockButton.disabled = encryptionEnabled && encryptionUnlocked;
        recoveryKeyButton.hidden = !encryptionEnabled;
    };

    const updateStorageControls = () => {
        const usesGoogleDrive = storageSelect.value === "google_drive";
        // The Client ID is the browser flow's own credential. When the plugin is
        // installed it holds the client details on the server instead, so a
        // blank field here is not an unconfigured install — it is the normal
        // state, and telling the user to go find an administrator would be wrong.
        const hasClientId = canUseVaultServer()
            || Boolean(String(extension_settings[extensionName].googleDriveClientId || "").trim());
        const driveConnected = isGoogleDriveConnected();
        const backupDisabled = autoSaveSelect.value === AUTO_SAVE_MODE_DISABLED;
        const autoSaveEnabled = ![
            AUTO_SAVE_MODE_DISABLED,
            AUTO_SAVE_MODE_MANUAL,
        ].includes(autoSaveSelect.value);
        const driveAutoUploadInterval = autoSaveSelect.value === AUTO_SAVE_MODE_MESSAGE_COUNT
            ? clamp(Number.parseInt(customCountInput.value, 10) || 5, 1, 100)
            : DEFAULT_DRIVE_AUTO_UPLOAD_EVERY_MESSAGES;
        const connectedAccount = googleDriveAccount?.emailAddress
            || googleDriveAccount?.displayName
            || "บัญชี Google";
        const selectedFolderName = extension_settings[extensionName].googleDriveFolderName
            || DEFAULT_GOOGLE_DRIVE_FOLDER_NAME;
        const driveUsage = getDriveUsageWarningState({
            usedBytes: googleDriveUsageBytes,
            mode: driveUsageModeSelect.value,
            warningGb: driveUsageInput.value,
        });

        const previouslyConnected = Boolean(
            extension_settings[extensionName].googleDrivePreviouslyConnected,
        );
        const connectionBusy = Boolean(googleDriveReconnectPromise || driveConnectionAction);
        // The kebab (and the fold-out it opens) only matters once there is an
        // account relationship to manage — connected now, or remembered from
        // before. Fresh installs have nothing to switch or disconnect yet.
        const hasAccountRelationship = usesGoogleDrive
            && (driveConnected || previouslyConnected);

        // The bar shows the connected identity or the device-only notice. When
        // Drive is selected but not connected, the connect button represents
        // that state instead, so the bar steps aside.
        driveConnectionStatus.hidden = usesGoogleDrive && !driveConnected;
        driveConnectionStatus.className = "chat-vault-account-button";
        driveConnectionStatus.classList.toggle(
            "chat-vault-account-button-connected",
            usesGoogleDrive && driveConnected,
        );
        if (usesGoogleDrive && driveConnected) {
            const initial = connectedAccount.trim().charAt(0).toUpperCase() || "G";
            const avatar = document.createElement("span");
            avatar.className = "chat-vault-account-avatar";
            avatar.textContent = initial;
            const who = document.createElement("span");
            who.className = "chat-vault-account-who";
            const whoTitle = document.createElement("small");
            whoTitle.textContent = "เชื่อมแล้ว";
            const whoEmail = document.createElement("span");
            whoEmail.className = "chat-vault-account-email";
            whoEmail.textContent = connectedAccount;
            who.append(whoTitle, whoEmail);
            const kebabIcon = document.createElement("span");
            kebabIcon.className = "chat-vault-account-kebab-icon";
            kebabIcon.innerHTML = ICON_KEBAB_SVG;
            replaceElementChildren(driveConnectionStatus, avatar, who, kebabIcon);
            driveConnectionStatus.setAttribute("aria-haspopup", "menu");
        } else {
            // Device-only is the default a fresh install lands on, and every Drive
            // control is hidden in that state. Without naming the next step here,
            // a first-time user sees no way to connect Google at all and concludes
            // the feature is missing. The bar already opens settings on click; this
            // says so.
            replaceElementChildren(
                driveConnectionStatus,
                document.createTextNode("● เก็บในเครื่องนี้ · แตะเพื่อต่อ Google Drive"),
            );
            driveConnectionStatus.title = "แตะเพื่อไปหน้าตั้งค่า แล้วเลือกที่เก็บเป็น Google Drive";
            driveConnectionStatus.removeAttribute("aria-haspopup");
        }

        driveConnectButton.hidden = !usesGoogleDrive || driveConnected;
        driveConnectButton.disabled = connectionBusy;
        // One label as requested; the remembered vs fresh distinction is carried
        // by whether the kebab appears, not by rewording this button.
        driveConnectLabel.textContent = googleDriveReconnectPromise
            ? "กำลังต่อบัญชีเดิมให้พ็อกกี้..."
            : (driveConnectionAction === "connect"
                ? "กำลังเชื่อมต่อ..."
                : "ต่อบัญชี Google ให้พ็อกกี้");

        // The standalone kebab is only needed while the connect button holds the
        // row (remembered but expired). When connected, the bar owns its kebab.
        accountMenuToggle.hidden = !(usesGoogleDrive && !driveConnected && previouslyConnected);
        accountMenuToggle.disabled = connectionBusy;

        driveSwitchAccountButton.disabled = connectionBusy;
        driveSwitchAccountButton.textContent = driveConnectionAction === "switch"
            ? "กำลังเปิดหน้าเลือกบัญชี..."
            : "สลับบัญชี Google";
        driveDisconnectButton.disabled = connectionBusy;
        driveSettingsDetails.hidden = !usesGoogleDrive;
        if (!hasAccountRelationship) {
            accountMenu.hidden = true;
            driveConnectionStatus.setAttribute("aria-expanded", "false");
            accountMenuToggle.setAttribute("aria-expanded", "false");
        }
        driveFolderSection.hidden = !usesGoogleDrive;
        driveFolderButton.disabled = !driveConnected;
        driveFolderOpenLink.hidden = !usesGoogleDrive
            || !driveConnected
            || !googleDriveFolder?.webViewLink;
        driveFolderOpenLink.href = googleDriveFolder?.webViewLink || "#";
        driveLastFileOpenLink.hidden = !usesGoogleDrive
            || !driveConnected
            || !googleDriveLastFile?.webViewLink;
        driveLastFileOpenLink.href = googleDriveLastFile?.webViewLink || "#";
        driveFolderNote.textContent = driveConnected
            ? `สำรองและกู้คืนจากโฟลเดอร์ “${selectedFolderName}”${Number.isFinite(googleDriveFolderBackupCount) ? ` · พบ ${googleDriveFolderBackupCount} ไฟล์` : ""}`
            : "ตั้งชื่อไว้ก่อนได้ แล้วกดเชื่อม Google Drive";
        driveUsageSection.hidden = !usesGoogleDrive;
        driveUsageCustomRow.hidden = driveUsage.mode !== DRIVE_USAGE_MODE_WARNING;
        driveUsageStatus.classList.toggle(
            "chat-vault-drive-usage-status-warning",
            driveUsage.shouldWarn,
        );
        driveUsageStatus.textContent = !driveConnected
            ? `เชื่อม Drive เพื่ออ่านพื้นที่ที่ ${extensionDisplayName} ใช้`
            : (!Number.isFinite(googleDriveUsageBytes)
                ? "กำลังอ่านพื้นที่ที่ใช้..."
                : (driveUsage.shouldWarn
                    ? `ใช้แล้ว ${formatBackupFileSize(driveUsage.usedBytes)} · ถึงระดับแจ้งเตือน ${driveUsage.warningGb} GB`
                    : `ใช้แล้ว ${formatBackupFileSize(driveUsage.usedBytes)} · ${driveUsage.mode === DRIVE_USAGE_MODE_UNLIMITED ? "ไม่จำกัด" : `แจ้งเตือนที่ ${driveUsage.warningGb} GB`}`));
        driveRestoreButton.hidden = !usesGoogleDrive;
        driveRestoreButton.disabled = !driveConnected;
        rescueButton.hidden = !usesGoogleDrive;
        rescueButton.disabled = !driveConnected;
        backupButton.disabled = backupDisabled;
        checkpointButton.disabled = backupDisabled;
        backupButton.textContent = backupDisabled
            ? "ปิดการสำรองข้อมูลอยู่"
            : (usesGoogleDrive
                ? "ฝากพ็อกกี้เก็บขึ้น Drive"
                : "ให้พ็อกกี้ห่อไฟล์ให้");

        if (backupDisabled) {
            storageNote.textContent = "ไม่สร้างสำเนาใหม่ทั้งในเครื่องและบน Drive · การกู้คืนไฟล์เดิมยังใช้ได้";
            autoSaveNote.textContent = "ปิดการสำรองทั้งหมดแล้ว";
        } else if (!usesGoogleDrive) {
            storageNote.textContent = "เก็บสำเนาล่าสุดไว้ในอุปกรณ์นี้";
            autoSaveNote.textContent = "Auto-save เก็บฉบับล่าสุดในอุปกรณ์นี้";
        } else if (googleDriveStatusMessage) {
            storageNote.textContent = googleDriveStatusMessage;
        } else if (!hasClientId) {
            storageNote.textContent = "ผู้ดูแลยังไม่ได้ตั้ง Google OAuth Client ID";
        } else if (extension_settings[extensionName].encryptionEnabled
            && !vaultEncryptionPassphrase) {
            storageNote.textContent = "Drive พร้อม · ปลดล็อก Encrypted Vault เพื่อส่งสำเนาใหม่";
        } else if (driveConnected) {
            storageNote.textContent = "เชื่อมแล้ว · พร้อมส่งสำเนาเข้า Google Drive";
        } else {
            storageNote.textContent = "แตะเชื่อม Google Drive ก่อนส่งสำเนา";
        }

        if (usesGoogleDrive && !backupDisabled) {
            if (!autoSaveEnabled) {
                autoSaveNote.textContent = "Auto-save ปิดอยู่ · ยังส่ง Drive ด้วยปุ่มด้านบนได้";
            } else if (extension_settings[extensionName].encryptionEnabled
                && !vaultEncryptionPassphrase) {
                autoSaveNote.textContent = "ยังเก็บในเครื่องต่อ · ปลดล็อกก่อนส่งสำเนาเข้ารหัสขึ้น Drive";
            } else if (driveConnected) {
                autoSaveNote.textContent = autoSaveSelect.value === "every_message"
                    ? "เก็บตอนส่งและตอนคำตอบเสร็จ · Drive ใช้ฉบับล่าสุด"
                    : (autoSaveSelect.value === AUTO_SAVE_MODE_TURN_COMPLETE
                        ? "เก็บและส่งเมื่อคำตอบเสร็จ · ไม่ส่งระหว่าง thinking"
                        : `เก็บในเครื่องและส่ง Drive อัตโนมัติทุก ${driveAutoUploadInterval} ข้อความ`);
            } else {
                autoSaveNote.textContent = "Auto-save เก็บในเครื่องต่อ\nเชื่อม Drive เพื่อส่งอัตโนมัติ";
            }
        }

        if (!menu.hidden) {
            requestAnimationFrame(positionCatMenu);
        }
    };

    refreshCatStorageControls = updateStorageControls;
    refreshVaultSecurityUi = updateSecurityControls;
    refreshVaultHealthUi = async () => {
        const context = getContext();
        const settings = extension_settings[extensionName];
        let backup = null;
        let history = [];
        let pending = [];

        if (context.chatId && Array.isArray(context.chat)) {
            const backupId = getBackupIdentity(context).id;

            [backup, history, pending] = await Promise.all([
                getLatestBackup(backupId),
                getBackupHistory(backupId),
                getPendingDriveBackups(settings.googleDriveAccountHint),
            ]);
        }

        const health = evaluateVaultHealth({
            backup,
            usesGoogleDrive: settings.storageDestination === "google_drive",
            driveConnected: isGoogleDriveConnected(),
            pendingCount: pending.length,
            historyCount: history.length,
        });
        const stateClasses = ["idle", "healthy", "pending", "attention"];

        for (const state of stateClasses) {
            cat.classList.toggle(`chat-vault-health-${state}`, state === health.state);
            vaultHealthSummary.classList.toggle(
                `chat-vault-health-${state}`,
                state === health.state,
            );
        }

        // Swap the drawing only when the state actually changes. Reassigning the
        // same source on every refresh makes the cat flicker.
        if (image.dataset.chatVaultHealth !== health.state) {
            image.dataset.chatVaultHealth = health.state;
            image.src = getCatHealthImageUrl(health.state);
        }

        if (backup) {
            // Status on top, the kept-versions count on its own dimmer line so
            // the card stops running into three wrapped lines.
            const healthLine = document.createElement("div");
            healthLine.textContent = health.label;
            const versionsLine = document.createElement("div");
            versionsLine.className = "chat-vault-health-detail";
            versionsLine.textContent = `เก็บไว้ ${health.historyCount} เวอร์ชัน`;
            replaceElementChildren(vaultHealthSummary, healthLine, versionsLine);
        } else {
            vaultHealthSummary.textContent = health.label;
        }
        cat.setAttribute(
            "aria-label",
            `${extensionDisplayName}: ${health.label}`,
        );
        cat.title = `${extensionDisplayName} — ${health.label}`;
        return health;
    };

    storageSelect.value = extension_settings[extensionName].storageDestination;
    driveFolderInput.value = extension_settings[extensionName].googleDriveFolderName;
    autoSaveSelect.value = extension_settings[extensionName].autoSaveMode;
    customCountInput.value = String(extension_settings[extensionName].autoSaveEveryMessages);
    historyLimitSelect.value = String(extension_settings[extensionName].historyLimit);
    driveUsageModeSelect.value = extension_settings[extensionName].driveUsageMode;
    driveUsageInput.value = String(extension_settings[extensionName].driveUsageWarningGb);
    encryptionCheckbox.checked = extension_settings[extensionName].encryptionEnabled;
    attachmentCheckbox.checked = extension_settings[extensionName].includeAttachmentsInCheckpoints;
    attachmentLimitSelect.value = String(extension_settings[extensionName].attachmentLimitMb);
    selectMenuTab("backup");
    updateStorageControls();
    updateAutoSaveControls();
    updateSecurityControls();
    void refreshVaultHealthUi();

    storageSelect.addEventListener("change", () => {
        extension_settings[extensionName].storageDestination = storageSelect.value;
        saveSettingsDebounced();
        updateStorageControls();

        console.log(`[${extensionName}] Storage destination saved:`, storageSelect.value);
    });

    for (const button of [
        backupTabButton,
        restoreTabButton,
        settingsTabButton,
        aboutTabButton,
    ]) {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            selectMenuTab(button.dataset.tab);
        });
    }

    for (const details of [driveSettingsDetails, securityDetails]) {
        details.addEventListener("toggle", () => {
            if (!menu.hidden) {
                requestAnimationFrame(positionCatMenu);
            }
        });
    }

    /*
     * The folder list costs two Drive requests, so it is fetched when the user
     * opens the section that shows it rather than on every menu open. Opening
     * that section is also the moment the list is most likely to be stale — it
     * is where someone goes after noticing their backups landed somewhere odd.
     */
    driveSettingsDetails.addEventListener("toggle", () => {
        if (driveSettingsDetails.open) {
            void refreshDriveFolderChoices();
        }
    });

    // Both the connected bar and the standalone kebab open the same fold-out;
    // whichever is visible for the current state acts as the trigger.
    const toggleAccountMenu = () => {
        accountMenu.hidden = !accountMenu.hidden;
        const expanded = String(!accountMenu.hidden);

        driveConnectionStatus.setAttribute("aria-expanded", expanded);
        accountMenuToggle.setAttribute("aria-expanded", expanded);
        requestAnimationFrame(positionCatMenu);
    };

    driveConnectionStatus.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();

        // In device-only mode the bar is a shortcut into settings, not a menu.
        if (storageSelect.value !== "google_drive") {
            selectMenuTab("settings");
            return;
        }

        toggleAccountMenu();
    });

    accountMenuToggle.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleAccountMenu();
    });

    driveDisconnectButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();

        const confirmed = globalThis.confirm(
            "ตัดการเชื่อมต่อ Google Drive จากอุปกรณ์นี้หรือไม่?\nไฟล์บน Drive และสำเนาในเครื่องจะไม่ถูกลบ",
        );

        if (!confirmed) {
            return;
        }

        const settings = extension_settings[extensionName];

        /*
         * When the plugin holds the grant, clearing this page is not a
         * disconnect — the server would hand out a new token on the next load
         * and the user would find themselves reconnected by something they just
         * asked to stop. The server has to be told too, and it is told first:
         * the local clear below happens either way, so a failed request leaves
         * the user disconnected here rather than stuck connected everywhere.
         */
        if (canUseVaultServer()) {
            vaultServerStatus = { ...vaultServerStatus, connected: false, email: "" };
            void disconnectVaultServer().then((ok) => {
                if (!ok) {
                    console.warn(`[${extensionName}] Plugin disconnect did not confirm`);
                }
            });
        }

        settings.googleDrivePreviouslyConnected = false;
        settings.googleDriveAccountHint = "";
        googleDriveReconnectRetryAfter = 0;
        googleDriveReconnectPromise = null;
        googleDriveStatusMessage = "ตัดการเชื่อมต่อแล้ว · ไฟล์เดิมยังอยู่บน Drive";
        clearGoogleDriveSession();
        clearGoogleDriveUiSession();
        refreshPluginAdminPanel();
        accountMenu.hidden = true;
        driveConnectionStatus.setAttribute("aria-expanded", "false");
        accountMenuToggle.setAttribute("aria-expanded", "false");
        saveSettingsDebounced();
        updateStorageControls();
        void refreshVaultHealthUi();
        toastr.success(
            "ตัดการเชื่อมต่อแล้ว · สำเนาและไฟล์บน Drive ยังอยู่ครบ",
            extensionDisplayName,
        );
    });

    driveUsageModeSelect.addEventListener("change", () => {
        const mode = normalizeDriveUsageMode(driveUsageModeSelect.value);

        driveUsageModeSelect.value = mode;
        extension_settings[extensionName].driveUsageMode = mode;
        googleDriveUsageWarningNotified = false;
        saveSettingsDebounced();
        updateStorageControls();
    });

    driveUsageInput.addEventListener("change", () => {
        const warningGb = normalizeDriveUsageWarningGb(driveUsageInput.value);

        driveUsageInput.value = String(warningGb);
        extension_settings[extensionName].driveUsageWarningGb = warningGb;
        googleDriveUsageWarningNotified = false;
        saveSettingsDebounced();
        updateStorageControls();
    });

    const connectGoogleAccount = async (selectAccount) => {
        const settings = extension_settings[extensionName];
        const clientId = settings.googleDriveClientId;
        const wasConnected = isGoogleDriveConnected();
        let authorizationCompleted = false;

        driveConnectionAction = selectAccount ? "switch" : "connect";
        googleDriveStatusMessage = "";
        updateStorageControls();

        try {
            const folderName = normalizeGoogleDriveFolderName(driveFolderInput.value);

            setGoogleDriveFolderName(folderName);

            /*
             * With the plugin installed, authorizing is the server's job: the
             * page goes to it, it runs the authorization-code exchange Google
             * will not let a browser do, and the user comes back connected for
             * good rather than for an hour.
             *
             * This branch comes first because it supersedes both of the ones
             * below — it is the better answer on desktop and on iOS alike.
             */
            if (canUseVaultServer()) {
                rememberPendingFolderName(folderName);
                googleDriveStatusMessage = "กำลังพาไปหน้า Google...";
                updateStorageControls();
                globalThis.location.assign(getVaultServerAuthUrl(
                    globalThis.location.pathname + globalThis.location.search,
                ));

                return;
            }

            // On iOS the popup can never hand the token back, so the whole page
            // goes to Google instead. Nothing after that call runs.
            //
            // The in-memory assignment below is still worth doing for the case
            // where the navigation is blocked, but it cannot be relied on to
            // survive: saveSettingsDebounced() is a timer, and this page is about
            // to be torn down. The folder name therefore travels with the
            // authorization state instead, and is written back on the way in.
            if (shouldUseGoogleDriveRedirect()) {
                settings.googleDriveFolderName = folderName;
                saveSettingsDebounced();
                googleDriveStatusMessage = "กำลังพาไปหน้า Google...";
                updateStorageControls();
                startGoogleDriveRedirectAuthorization(clientId, {
                    loginHint: settings.googleDriveAccountHint,
                    selectAccount,
                    folderName,
                });

                return;
            }

            await connectGoogleDrive(clientId, {
                loginHint: settings.googleDriveAccountHint,
                selectAccount,
            });
            authorizationCompleted = true;
            const { account, folder, movedCount } = await loadGoogleDriveSessionDetails();

            googleDriveReconnectRetryAfter = 0;
            settings.googleDriveFolderName = folderName;
            driveFolderInput.value = folderName;
            saveSettingsDebounced();
            googleDriveStatusMessage = movedCount > 0
                ? `พร้อมใช้งาน · ย้ายไฟล์เดิม ${movedCount} ไฟล์เข้า “${folder.name}” แล้ว`
                : `พร้อมใช้งาน · โฟลเดอร์ “${folder.name}”`;
            toastr.success(
                `${selectAccount ? "สลับเป็น" : "เชื่อม"} ${account.emailAddress || account.displayName || "บัญชี Google"} สำเร็จแล้ว`,
                extensionDisplayName,
            );
            accountMenu.hidden = true;
            driveConnectionStatus.setAttribute("aria-expanded", "false");
            accountMenuToggle.setAttribute("aria-expanded", "false");
            void flushPendingDriveBackups();
            console.log(`[${extensionName}] Google Drive ${selectAccount ? "account switched" : "connected"}`);
        } catch (error) {
            if (wasConnected && !authorizationCompleted) {
                googleDriveStatusMessage = "ไม่ได้เปลี่ยนบัญชี · ยังเชื่อมบัญชีเดิมอยู่";
                toastr.info(googleDriveStatusMessage, extensionDisplayName);
                console.info(`[${extensionName}] Google Drive account switch cancelled:`, error);
            } else {
                clearGoogleDriveSession();
                clearGoogleDriveUiSession();
                showGoogleDriveError(
                    error,
                    selectAccount
                        ? "สลับบัญชี Google ไม่สำเร็จ"
                        : "เชื่อม Google Drive ไม่สำเร็จ",
                );
                console.error(`[${extensionName}] Google Drive connection failed:`, error);
            }
        } finally {
            driveConnectionAction = "";
            updateStorageControls();
        }
    };

    driveConnectButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await connectGoogleAccount(false);
    });

    driveSwitchAccountButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await connectGoogleAccount(true);
    });

    /*
     * Choosing the backup folder used to be a free-text box, which quietly made
     * a typo into a new folder and split someone's backups across both. It also
     * gave no way to answer the question a returning user actually has — "which
     * folder was I using?" — and no way to see the duplicates the old folder
     * race left behind, because they all carry the same name.
     *
     * A list of what exists, with how many backups each holds, answers all three.
     * `drive.file` makes the list exactly right: it can only see folders this
     * extension created, so nothing of the user's own is exposed and nothing of
     * ours is missing.
     */
    const NEW_FOLDER_OPTION_VALUE = "__chat_vault_new_folder__";
    let driveFolderChoices = [];
    let driveFolderLooseCount = 0;

    const isCreatingNewFolder = () => driveFolderSelect.value === NEW_FOLDER_OPTION_VALUE
        || !driveFolderChoices.length;

    const applyFolderSelectionMode = () => {
        const creatingNew = isCreatingNewFolder();

        driveFolderInput.hidden = !creatingNew;
        driveFolderButton.textContent = creatingNew
            ? "สร้างและใช้โฟลเดอร์นี้"
            : "ใช้โฟลเดอร์นี้";
    };

    const refreshDriveFolderChoices = async () => {
        if (!isGoogleDriveConnected()) {
            driveFolderChoices = [];
            replaceElementChildren(driveFolderSelect);
            driveFolderSelect.hidden = true;
            driveFolderCleanupButton.hidden = true;
            applyFolderSelectionMode();

            return;
        }

        let listing;

        try {
            listing = await listChatVaultFolders();
        } catch (error) {
            // The dropdown is a convenience over a box that still works. Losing
            // it must not block the user from typing a folder name.
            driveFolderChoices = [];
            driveFolderSelect.hidden = true;
            driveFolderCleanupButton.hidden = true;
            applyFolderSelectionMode();
            console.warn(`[${extensionName}] Could not list Chat Vault folders:`, error);

            return;
        }

        driveFolderChoices = listing.folders;
        driveFolderLooseCount = listing.looseBackupCount;
        replaceElementChildren(driveFolderSelect);

        const duplicateNames = new Set();
        const seenNames = new Set();

        for (const folder of listing.folders) {
            if (seenNames.has(folder.name)) {
                duplicateNames.add(folder.name);
            }

            seenNames.add(folder.name);
        }

        for (const folder of listing.folders) {
            const option = document.createElement("option");
            // Identical names are exactly the case this list exists to untangle,
            // so when there are any, the creation date is what tells them apart.
            const suffix = duplicateNames.has(folder.name) && folder.createdTime
                ? ` · สร้าง ${formatRestoreDate(folder.createdTime)}`
                : "";

            option.value = folder.id;
            option.textContent = `${folder.name} — ${folder.backupCount} สำเนา${suffix}`;
            driveFolderSelect.append(option);
        }

        const newOption = document.createElement("option");

        newOption.value = NEW_FOLDER_OPTION_VALUE;
        newOption.textContent = "✏️ สร้างโฟลเดอร์ใหม่...";
        driveFolderSelect.append(newOption);

        // Prefer the folder actually in use; otherwise the best match for the
        // saved name, which for duplicates means the one holding the backups.
        const activeName = extension_settings[extensionName].googleDriveFolderName;
        const preferred = listing.folders.find((folder) => folder.id === googleDriveFolder?.id)
            || listing.folders
                .filter((folder) => folder.name === activeName)
                .sort((left, right) => right.backupCount - left.backupCount)[0];

        driveFolderSelect.value = preferred ? preferred.id : NEW_FOLDER_OPTION_VALUE;
        driveFolderSelect.hidden = listing.folders.length === 0;

        // Only ever offered for folders with nothing in them, and never for the
        // one in use. An empty duplicate is debris; a folder with backups is
        // somebody's data and is not this button's business.
        const emptyFolders = listing.folders.filter((folder) => folder.backupCount === 0
            && folder.id !== preferred?.id);

        driveFolderCleanupButton.hidden = emptyFolders.length === 0;
        driveFolderCleanupButton.textContent = `เก็บกวาดโฟลเดอร์ว่าง (${emptyFolders.length})`;
        driveFolderCleanupButton.dataset.chatVaultEmptyIds = emptyFolders
            .map((folder) => folder.id)
            .join(",");

        // Its own element rather than driveFolderNote, which updateStorageControls
        // rewrites on every refresh and would wipe this a moment after it appeared.
        driveFolderLooseNote.hidden = listing.looseBackupCount === 0;
        driveFolderLooseNote.textContent = listing.looseBackupCount > 0
            ? `มีสำเนา ${listing.looseBackupCount} ไฟล์ยังไม่ได้อยู่ในโฟลเดอร์ · เลือกโฟลเดอร์แล้วกด “ใช้โฟลเดอร์นี้” เพื่อย้ายเข้าให้เรียบร้อย`
            : "";

        applyFolderSelectionMode();
    };

    driveFolderSelect.addEventListener("change", () => {
        const chosen = driveFolderChoices.find((folder) => folder.id === driveFolderSelect.value);

        if (chosen) {
            driveFolderInput.value = chosen.name;
        }

        applyFolderSelectionMode();
    });

    driveFolderCleanupButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();

        const ids = String(driveFolderCleanupButton.dataset.chatVaultEmptyIds || "")
            .split(",")
            .filter(Boolean);

        if (!ids.length) {
            return;
        }

        /*
         * Named as what it is. These go to the Drive trash, not to deletion, and
         * the wording says so — a user who changes their mind has thirty days.
         * The second sentence is the honest part: `drive.file` cannot see files
         * the user put in these folders by hand, so "empty" means empty of
         * Chat Vault backups, and only the user knows about the rest.
         */
        const confirmed = globalThis.confirm(
            `ย้ายโฟลเดอร์ว่าง ${ids.length} โฟลเดอร์ไปถังขยะของ Google Drive?\n\n`
            + "โฟลเดอร์เหล่านี้ไม่มีสำเนาแชทอยู่เลย และกู้กลับจากถังขยะได้ภายใน 30 วัน\n"
            + "หากเคยนำไฟล์อื่นไปวางไว้เอง พ็อกกี้จะมองไม่เห็นไฟล์นั้น และมันจะถูกย้ายไปด้วย",
        );

        if (!confirmed) {
            return;
        }

        const originalText = driveFolderCleanupButton.textContent;

        driveFolderCleanupButton.disabled = true;
        driveFolderCleanupButton.textContent = "กำลังเก็บกวาด...";

        let trashedCount = 0;
        let skippedCount = 0;

        for (const id of ids) {
            try {
                await trashChatVaultFolder(id);
                trashedCount += 1;
            } catch (error) {
                // folder_not_empty means a backup landed in it since the list was
                // built. Skipping is the right answer, not an error to shout about.
                skippedCount += 1;
                console.warn(`[${extensionName}] Left folder ${id} alone:`, error);
            }
        }

        driveFolderCleanupButton.disabled = false;
        driveFolderCleanupButton.textContent = originalText;
        toastr.success(
            skippedCount > 0
                ? `เก็บกวาดแล้ว ${trashedCount} โฟลเดอร์ · ข้าม ${skippedCount} โฟลเดอร์ที่มีไฟล์อยู่`
                : `ย้าย ${trashedCount} โฟลเดอร์ว่างไปถังขยะแล้ว`,
            extensionDisplayName,
        );
        await refreshDriveFolderChoices();
        updateStorageControls();
    });

    const applyDriveFolder = async () => {
        if (!isGoogleDriveConnected()) {
            toastr.warning("กรุณาเชื่อม Google Drive ก่อนเลือกโฟลเดอร์", extensionDisplayName);
            return;
        }

        const previousFolderName = extension_settings[extensionName].googleDriveFolderName;
        const previousDriveFolder = googleDriveFolder;
        const originalText = driveFolderButton.textContent;
        const selectedFolder = isCreatingNewFolder()
            ? null
            : driveFolderChoices.find((folder) => folder.id === driveFolderSelect.value);

        /*
         * Choosing a folder does not just point new backups at it — it gathers
         * every existing backup into it, from the other folders and from loose
         * files alike. That is the right behaviour for the case it was written
         * for (one folder, tidy it up) and a trap now that the list makes the
         * other folders visible and clickable: a user opening the small
         * duplicate to see what is inside would sweep the large one into it.
         *
         * So the move is stated before it happens, with the number, whenever
         * there is anything to move. Nothing is destroyed either way — this is
         * reversible by choosing the other folder — but a backup extension
         * should never relocate someone's history without saying so first.
         */
        const incomingCount = driveFolderChoices
            .filter((folder) => folder.id !== selectedFolder?.id)
            .reduce((total, folder) => total + folder.backupCount, 0) + driveFolderLooseCount;

        if (incomingCount > 0 && isGoogleDriveConnected()) {
            const destination = selectedFolder
                ? `“${selectedFolder.name}”`
                : `“${String(driveFolderInput.value || DEFAULT_GOOGLE_DRIVE_FOLDER_NAME).trim()}”`;
            const confirmed = globalThis.confirm(
                `ย้ายสำเนา ${incomingCount} ไฟล์ที่อยู่โฟลเดอร์อื่นเข้ามารวมใน ${destination} หรือไม่?\n\n`
                + "ไฟล์จะถูกย้าย ไม่ได้ถูกลบ และเลือกโฟลเดอร์อื่นภายหลังเพื่อย้ายกลับได้",
            );

            if (!confirmed) {
                return;
            }
        }

        driveFolderButton.disabled = true;
        driveFolderButton.textContent = "กำลังเตรียมโฟลเดอร์...";

        try {
            const chosenFolder = selectedFolder;
            // Picking from the list means that folder, by id. Resolving by name
            // instead would land on whichever duplicate Drive happens to list
            // first, which is the opposite of choosing.
            const folderName = chosenFolder
                ? (await pinGoogleDriveFolder(chosenFolder)).name
                : setGoogleDriveFolderName(driveFolderInput.value);
            const { folder, movedCount, totalCount } = await organizeGoogleDriveBackups();

            extension_settings[extensionName].googleDriveFolderName = folderName;
            googleDriveFolder = folder;
            googleDriveLastFile = null;
            googleDriveFolderBackupCount = totalCount;
            driveFolderInput.value = folderName;
            driveAutoUploadQueue.reset();
            googleDriveUsageBytes = null;
            googleDriveUsageRefreshedAt = 0;
            googleDriveUsageWarningNotified = false;
            googleDriveStatusMessage = movedCount > 0
                ? `ใช้โฟลเดอร์ “${folder.name}” · จัดไฟล์เดิมเข้าแล้ว ${movedCount} ไฟล์`
                : `เปลี่ยนเป็นโฟลเดอร์ “${folder.name}” แล้ว`;
            saveSettingsDebounced();
            toastr.success(`ใช้โฟลเดอร์ “${folder.name}” แล้ว`, extensionDisplayName);
            void refreshGoogleDriveUsage({ force: true });
            void flushPendingDriveBackups();
            // Counts have just changed — files moved into the chosen folder, and
            // whichever folder they came from may now be empty and sweepable.
            void refreshDriveFolderChoices();
        } catch (error) {
            setGoogleDriveFolderName(previousFolderName || DEFAULT_GOOGLE_DRIVE_FOLDER_NAME);
            googleDriveFolder = previousDriveFolder;
            driveFolderInput.value = previousFolderName || DEFAULT_GOOGLE_DRIVE_FOLDER_NAME;
            showGoogleDriveError(error, "เตรียมโฟลเดอร์ Google Drive ไม่สำเร็จ");
            console.error(`[${extensionName}] Google Drive folder update failed:`, error);
        } finally {
            driveFolderButton.disabled = false;
            driveFolderButton.textContent = originalText;
            updateStorageControls();
        }
    };

    driveFolderButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await applyDriveFolder();
    });

    driveFolderInput.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        void applyDriveFolder();
    });

    driveRestoreButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();

        if (!isGoogleDriveConnected()) {
            toastr.warning("กรุณาเชื่อม Google Drive ก่อนกู้คืนแชท", extensionDisplayName);
            return;
        }

        closeCatMenu();
        await openGoogleDriveRestoreDialog();
    });

    localRestoreButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        localRestoreInput.value = "";
        localRestoreInput.click();
    });

    localRestoreInput.addEventListener("change", async () => {
        const file = localRestoreInput.files?.[0];

        if (!file) {
            return;
        }

        const context = getContext();
        const target = getRestoreTarget(context);

        if (!target) {
            toastr.warning("กรุณาเปิดตัวละครหรือกลุ่มที่จะรับแชทก่อน", extensionDisplayName);
            return;
        }

        localRestoreButton.disabled = true;
        localRestoreButton.textContent = "กำลังตรวจและกู้คืน...";

        try {
            const packageResult = await readVaultBackupPackage(await file.text());
            const preparedBackup = await prepareVaultPackageForRestore(
                packageResult.vaultPackage,
            );

            closeCatMenu();
            await restoreBackupAsNewChat(
                target,
                { name: file.name },
                preparedBackup,
            );
            toastr.success(
                `กู้ ${preparedBackup.messageCount} ข้อความเป็นแชทใหม่แล้ว`,
                extensionDisplayName,
            );
        } catch (error) {
            const message = error instanceof VaultArchiveError
                ? "เปิดไฟล์ Vault ไม่สำเร็จ กรุณาตรวจรหัสผ่านหรือ Recovery Key"
                : "กู้คืนจากไฟล์นี้ไม่สำเร็จ";

            toastr.error(message, extensionDisplayName);
            console.error(`[${extensionName}] Local archive restore failed:`, error);
        } finally {
            localRestoreButton.disabled = false;
            localRestoreButton.textContent = "กู้คืนจากไฟล์ .jsonl / .cvault";
            localRestoreInput.value = "";
        }
    });

    autoSaveSelect.addEventListener("change", () => {
        const previousMode = extension_settings[extensionName].autoSaveMode;

        if (
            autoSaveSelect.value === AUTO_SAVE_MODE_DISABLED
            && !globalThis.confirm(
                `ปิดการสำรองข้อมูลทั้งหมดหรือไม่?\n${extensionDisplayName} จะไม่สร้างสำเนาใหม่จนกว่าจะเปิดกลับ แต่ไฟล์เดิมจะไม่ถูกลบ`,
            )
        ) {
            autoSaveSelect.value = previousMode;
            return;
        }

        extension_settings[extensionName].autoSaveMode = autoSaveSelect.value;
        if (autoSaveSelect.value === AUTO_SAVE_MODE_DISABLED) {
            driveAutoUploadQueue.reset();
            clearTimeout(pendingDriveRetryTimer);
            pendingDriveRetryTimer = null;
        } else {
            void flushPendingDriveBackups();
        }
        saveSettingsDebounced();
        updateAutoSaveControls();
        updateStorageControls();

        console.log(`[${extensionName}] Auto-save mode saved:`, autoSaveSelect.value);
    });

    customCountInput.addEventListener("change", () => {
        const value = clamp(Number.parseInt(customCountInput.value, 10) || 5, 1, 100);
        customCountInput.value = String(value);
        extension_settings[extensionName].autoSaveEveryMessages = value;
        saveSettingsDebounced();
        updateStorageControls();

        console.log(`[${extensionName}] Auto-save message count saved:`, value);
    });

    historyLimitSelect.addEventListener("change", () => {
        const value = clamp(
            Number.parseInt(historyLimitSelect.value, 10) || DEFAULT_HISTORY_LIMIT,
            1,
            100,
        );

        historyLimitSelect.value = String(value);
        extension_settings[extensionName].historyLimit = value;
        saveSettingsDebounced();
        console.log(`[${extensionName}] Backup history limit saved:`, value);
    });

    encryptionCheckbox.addEventListener("change", async () => {
        encryptionCheckbox.disabled = true;

        try {
            const settings = extension_settings[extensionName];

            if (encryptionCheckbox.checked) {
                if (!settings.encryptedRecoveryKey) {
                    const configured = await configureVaultEncryption();

                    if (!configured) {
                        encryptionCheckbox.checked = false;
                    }
                } else {
                    settings.encryptionEnabled = true;
                    saveSettingsDebounced();
                    await unlockVaultEncryption({ interactive: true });
                }
            } else {
                const confirmed = globalThis.confirm(
                    "ปิดการเข้ารหัสสำหรับสำเนาใหม่หรือไม่?\nไฟล์ที่เข้ารหัสไว้แล้วจะยังต้องใช้รหัสเดิมหรือ recovery key",
                );

                if (!confirmed) {
                    encryptionCheckbox.checked = true;
                } else {
                    settings.encryptionEnabled = false;
                    vaultEncryptionPassphrase = "";
                    vaultRecoveryKey = "";
                    saveSettingsDebounced();
                }
            }
        } catch (error) {
            encryptionCheckbox.checked = false;
            toastr.error("ตั้งค่าการเข้ารหัสไม่สำเร็จ", extensionDisplayName);
            console.error(`[${extensionName}] Encryption setup failed:`, error);
        } finally {
            encryptionCheckbox.disabled = false;
            updateSecurityControls();
            updateStorageControls();
        }
    });

    encryptionUnlockButton.addEventListener("click", async () => {
        encryptionUnlockButton.disabled = true;

        try {
            if (!extension_settings[extensionName].encryptionEnabled) {
                await configureVaultEncryption();
            } else {
                await unlockVaultEncryption({ interactive: true });
            }
        } catch (error) {
            toastr.error("ปลดล็อก Encrypted Vault ไม่สำเร็จ", extensionDisplayName);
            console.error(`[${extensionName}] Encryption unlock failed:`, error);
        } finally {
            updateSecurityControls();
            updateStorageControls();
        }
    });

    recoveryKeyButton.addEventListener("click", async () => {
        if (!vaultRecoveryKey && !await unlockVaultEncryption({ interactive: true })) {
            return;
        }

        if (vaultRecoveryKey) {
            downloadRecoveryKey(vaultRecoveryKey);
            toastr.success("ดาวน์โหลด Recovery Key แล้ว", extensionDisplayName);
        }

        updateSecurityControls();
    });

    attachmentCheckbox.addEventListener("change", () => {
        extension_settings[extensionName].includeAttachmentsInCheckpoints = Boolean(
            attachmentCheckbox.checked,
        );
        saveSettingsDebounced();
        updateSecurityControls();
    });

    attachmentLimitSelect.addEventListener("change", () => {
        const value = clamp(
            Number.parseInt(attachmentLimitSelect.value, 10) || 100,
            10,
            250,
        );

        attachmentLimitSelect.value = String(value);
        extension_settings[extensionName].attachmentLimitMb = value;
        saveSettingsDebounced();
    });

    checkpointButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        checkpointButton.disabled = true;

        try {
            const checkpoint = await createNamedCheckpoint();

            if (checkpoint) {
                closeCatMenu();
            }
        } catch (error) {
            toastr.error("สร้างจุดคืนค่าไม่สำเร็จ", extensionDisplayName);
            console.error(`[${extensionName}] Named checkpoint failed:`, error);
        } finally {
            checkpointButton.disabled = false;
        }
    });

    timeMachineButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeCatMenu();
        await openTimeMachineDialog();
    });

    healthButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeCatMenu();
        await openVaultHealthDialog();
    });

    rescueButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeCatMenu();
        await openRescueModeDialog();
    });

    backupButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();

        if (storageSelect.value === "google_drive") {
            const originalText = backupButton.textContent;

            backupButton.disabled = true;
            backupButton.textContent = "กำลังส่งไป Google Drive...";

            try {
                const uploaded = await onGoogleDriveBackupClick();

                if (uploaded) {
                    closeCatMenu();
                }
            } finally {
                backupButton.disabled = false;
                backupButton.textContent = originalText;
                updateStorageControls();
            }
        } else {
            await onDownloadBackupClick();
            closeCatMenu();
        }
    });

    cat.addEventListener("pointerdown", (event) => {
        if (event.pointerType === "mouse" && event.button !== 0) {
            return;
        }

        const rect = cat.getBoundingClientRect();
        activePointerId = event.pointerId;
        pointerOffsetX = event.clientX - rect.left;
        pointerOffsetY = event.clientY - rect.top;
        pointerStartX = event.clientX;
        pointerStartY = event.clientY;
        didDrag = false;
        showCatFully();
        cat.classList.add("chat-vault-cat-dragging");
        if (typeof cat.setPointerCapture === "function") {
            cat.setPointerCapture(event.pointerId);
        }
        event.preventDefault();
    });

    cat.addEventListener("pointermove", (event) => {
        if (event.pointerId !== activePointerId) {
            return;
        }

        const maxLeft = Math.max(0, window.innerWidth - cat.offsetWidth);
        const maxTop = Math.max(0, window.innerHeight - cat.offsetHeight);
        const left = clamp(event.clientX - pointerOffsetX, 0, maxLeft);
        const top = clamp(event.clientY - pointerOffsetY, 0, maxTop);

        if (!didDrag && Math.hypot(
            event.clientX - pointerStartX,
            event.clientY - pointerStartY,
        ) >= 6) {
            didDrag = true;
            closeCatMenu();
        }

        cat.style.left = `${Math.round(left)}px`;
        cat.style.top = `${Math.round(top)}px`;
        showCatFully();
        event.preventDefault();
    });

    const finishDragging = (event) => {
        if (event.pointerId !== activePointerId) {
            return;
        }

        const shouldToggleMenu = event.type === "pointerup" && !didDrag;
        activePointerId = null;
        cat.classList.remove("chat-vault-cat-dragging");

        if (didDrag) {
            saveCatPosition(cat);
        }

        if (shouldToggleMenu) {
            toggleCatMenu();
        } else {
            scheduleCatFade();
        }

        if (typeof cat.hasPointerCapture === "function"
            && cat.hasPointerCapture(event.pointerId)) {
            cat.releasePointerCapture(event.pointerId);
        }
    };

    cat.addEventListener("pointerup", finishDragging);
    cat.addEventListener("pointercancel", finishDragging);
    cat.addEventListener("dragstart", (event) => event.preventDefault());
    document.addEventListener("pointerdown", (event) => {
        if (!menu.hidden && !menu.contains(event.target) && !cat.contains(event.target)) {
            closeCatMenu();
        }
    });
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !menu.hidden) {
            closeCatMenu();
        }
    });
    window.addEventListener("resize", () => {
        if (activePointerId === null) {
            placeCatFromSettings(cat);

            if (!menu.hidden) {
                positionCatMenu();
            }
        }
    });

    console.log(`[${extensionName}] Cat magnet loaded`);
}

function onShowCatChange(event) {
    const value = Boolean($(event.target).prop("checked"));
    extension_settings[extensionName].showCat = value;
    saveSettingsDebounced();
    updateCatVisibility();

    console.log(`[${extensionName}] Cat visibility saved:`, value);
}

function onGoogleDriveClientIdChange(event) {
    const value = String($(event.target).val() || "").trim();

    if (value === extension_settings[extensionName].googleDriveClientId) {
        return;
    }

    extension_settings[extensionName].googleDriveClientId = value;
    extension_settings[extensionName].googleDrivePreviouslyConnected = false;
    extension_settings[extensionName].googleDriveAccountHint = "";
    googleDriveReconnectRetryAfter = 0;
    clearGoogleDriveSession();
    clearGoogleDriveUiSession();
    googleDriveStatusMessage = "";
    saveSettingsDebounced();

    console.log(`[${extensionName}] Google OAuth Client ID setting updated`);
}

function updateCatVisibility() {
    const cat = document.getElementById("chat_vault_cat_magnet");
    const menu = document.getElementById("chat_vault_cat_menu");

    if (!cat) {
        return;
    }

    cat.hidden = !Boolean(extension_settings[extensionName].showCat);

    if (cat.hidden && menu) {
        menu.hidden = true;
    }
}

function getBackupIdentity(context) {
    const entityType = context.groupId ? "group" : "character";
    const characterAvatar = context.characters?.[context.characterId]?.avatar;
    const entityId = context.groupId || characterAvatar || context.name2 || "unknown";

    return {
        id: `${entityType}:${entityId}:${context.chatId}`,
        entityType,
        entityId: String(entityId),
    };
}

function renderLatestBackupStatus(backup, message = "") {
    const status = document.getElementById("chat_vault_latest_backup_status");

    if (!status) {
        return;
    }

    if (!backup) {
        status.textContent = message || "พ็อกกี้ยังไม่มีสำเนาแชทนี้เลย";
        void refreshVaultHealthUi();
        return;
    }

    const savedAt = new Date(backup.savedAt);
    const formattedTime = Number.isNaN(savedAt.getTime())
        ? "ไม่ทราบเวลา"
        : savedAt.toLocaleString("th-TH", {
            day: "2-digit",
            month: "2-digit",
            year: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
    const driveState = backup.driveUpload?.status === "uploaded"
        ? " · ส่งขึ้น Drive แล้ว"
        : (backup.driveUpload?.status === "failed"
            ? " · ส่ง Drive ไม่สำเร็จ กำลังรอส่งซ้ำ"
            : (backup.driveUpload?.status === "pending" ? " · รอส่งขึ้น Drive" : ""));

    // Two lines: when it happened on top, what was saved + its Drive state below.
    // The detail line is secondary information, so it reads dimmer.
    const primaryLine = document.createElement("div");
    primaryLine.textContent = `พ็อกกี้เซฟล่าสุด ${formattedTime}`;
    const detailLine = document.createElement("div");
    detailLine.className = "chat-vault-latest-backup-detail";
    detailLine.textContent = `${backup.messageCount} ข้อความ${driveState}`;
    replaceElementChildren(status, primaryLine, detailLine);
    void refreshVaultHealthUi();
}

async function refreshLatestBackupStatus() {
    const context = getContext();

    if (!context.chatId || !Array.isArray(context.chat)) {
        renderLatestBackupStatus(null, "เปิดแชทเพื่อดูสถานะสำรองล่าสุด");
        return;
    }

    const expectedBackupId = getBackupIdentity(context).id;

    try {
        const backup = await getLatestBackup(expectedBackupId);
        const currentContext = getContext();
        const currentBackupId = currentContext.chatId
            ? getBackupIdentity(currentContext).id
            : null;

        if (currentBackupId === expectedBackupId) {
            renderLatestBackupStatus(backup);
        }
    } catch (error) {
        renderLatestBackupStatus(null, "อ่านสถานะสำรองล่าสุดไม่ได้");
        console.error(`[${extensionName}] Latest backup status failed:`, error);
    }
}

function createAutoSaveBackup(context, {
    triggerReason = "",
    checkpointName = "",
    isCheckpoint = false,
} = {}) {
    const savedAt = new Date().toISOString();
    const snapshotId = globalThis.crypto?.randomUUID?.()
        || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const identity = getBackupIdentity(context);
    const chatHeader = {
        user_name: context.name1 || "unused",
        character_name: context.name2 || "unused",
        chat_metadata: context.chatMetadata || {},
    };
    const content = [chatHeader, ...context.chat]
        .map((entry) => JSON.stringify(entry))
        .join("\n");
    const safeChatId = String(context.chatId)
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
        .slice(0, 80) || "chat";

    return {
        ...identity,
        chatId: String(context.chatId),
        characterName: context.name2 || "",
        savedAt,
        snapshotId,
        messageCount: context.chat.length,
        fileName: `chat-vault_${safeChatId}.jsonl`,
        content,
        triggerReason: String(triggerReason || ""),
        checkpointName: String(checkpointName || ""),
        isCheckpoint: Boolean(isCheckpoint || checkpointName),
    };
}

function getRestoreTarget(context) {
    const hasGroup = context.groupId !== null
        && context.groupId !== undefined
        && context.groupId !== "";

    if (hasGroup) {
        return {
            type: "group",
            id: context.groupId,
            name: context.name2 || "กลุ่มปัจจุบัน",
        };
    }

    const character = context.characters?.[context.characterId];

    if (!character?.avatar) {
        return null;
    }

    return {
        type: "character",
        id: character.avatar,
        name: context.name2 || character.name || "ตัวละครปัจจุบัน",
        avatar: character.avatar,
    };
}

async function createNamedCheckpoint() {
    if (isBackupDisabled()) {
        toastr.warning("เปิดการสำรองข้อมูลก่อนสร้างจุดคืนค่า", extensionDisplayName);
        return null;
    }

    const context = getContext();

    if (!context.chatId || !Array.isArray(context.chat)) {
        toastr.warning("กรุณาเปิดแชทก่อนตั้งจุดคืนค่า", extensionDisplayName);
        return null;
    }

    const requestedName = globalThis.prompt(
        "ตั้งชื่อหมุดนี้ให้พ็อกกี้คาบไว้",
        `จุดสำคัญ ${new Date().toLocaleDateString("th-TH")}`,
    );

    if (requestedName === null) {
        return null;
    }

    const checkpointName = String(requestedName || "")
        .replace(/[\u0000-\u001F\u007F]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);

    if (!checkpointName) {
        toastr.warning("กรุณาตั้งชื่อจุดคืนค่า", extensionDisplayName);
        return null;
    }

    const settings = extension_settings[extensionName];
    let backup = createAutoSaveBackup(context, {
        triggerReason: "named_checkpoint",
        checkpointName,
        isCheckpoint: true,
    });
    let drivePrepared = false;

    if (settings.storageDestination === "google_drive") {
        try {
            backup = await prepareBackupForDrive(backup, settings, {
                includeAttachments: true,
                interactive: true,
            });
            backup = queueBackupForCurrentDrive(backup, settings);
            drivePrepared = true;
        } catch (error) {
            googleDriveStatusMessage = error instanceof VaultArchiveError
                && error.code === "vault_locked"
                ? "ปักหมุดในเครื่องแล้ว · ปลดล็อก Encrypted Vault เพื่อส่งขึ้น Drive"
                : "ปักหมุดในเครื่องแล้ว · สร้าง Archive สำหรับ Drive ไม่สำเร็จ";
            console.warn(`[${extensionName}] Checkpoint Drive package skipped:`, error);
        }
    }

    backup = await saveBackupSnapshot(backup, {
        historyLimit: settings.historyLimit,
        triggerReason: "named_checkpoint",
        checkpointName,
        isCheckpoint: true,
    });
    renderLatestBackupStatus(backup);

    if (drivePrepared) {
        void autoUploadBackupToGoogleDrive(backup, settings);
    }

    toastr.success(`ปักหมุด “${checkpointName}” แล้ว`, extensionDisplayName);
    return backup;
}

async function openTimeMachineDialog() {
    const context = getContext();
    const target = getRestoreTarget(context);

    if (!target || !context.chatId || !Array.isArray(context.chat)) {
        toastr.warning("กรุณาเปิดแชทก่อนใช้ Time Machine", extensionDisplayName);
        return;
    }

    document.getElementById("chat_vault_time_machine_overlay")?.remove();

    const backupId = getBackupIdentity(context).id;
    const overlay = document.createElement("div");
    const panel = document.createElement("section");
    const header = document.createElement("div");
    const title = document.createElement("h3");
    const closeButton = document.createElement("button");
    const targetNote = document.createElement("p");
    const list = document.createElement("div");
    const preview = document.createElement("pre");
    const actions = document.createElement("div");
    const checkpointButton = document.createElement("button");
    const downloadButton = document.createElement("button");
    const restoreButton = document.createElement("button");
    let selectedBackup = null;
    let selectedParsedBackup = null;

    overlay.id = "chat_vault_time_machine_overlay";
    overlay.className = "chat-vault-restore-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "chat_vault_time_machine_title");
    panel.className = "chat-vault-restore-panel chat-vault-time-machine-panel";
    header.className = "chat-vault-restore-header";
    title.id = "chat_vault_time_machine_title";
    title.textContent = "Time Machine";
    closeButton.type = "button";
    closeButton.className = "menu_button chat-vault-restore-close";
    closeButton.textContent = "×";
    closeButton.setAttribute("aria-label", "ปิด");
    header.append(title, closeButton);
    targetNote.className = "chat-vault-restore-target";
    targetNote.textContent = `ประวัติของ: ${target.name}`;
    list.className = "chat-vault-restore-list chat-vault-history-list";
    list.textContent = "กำลังเปิดประวัติ...";
    preview.className = "chat-vault-restore-preview chat-vault-history-preview";
    preview.textContent = "เลือกจุดเวลาเพื่อดูตัวอย่าง";
    actions.className = "chat-vault-restore-actions chat-vault-time-machine-actions";
    checkpointButton.type = "button";
    checkpointButton.className = "menu_button";
    checkpointButton.textContent = "ปักหมุดตอนนี้";
    downloadButton.type = "button";
    downloadButton.className = "menu_button";
    downloadButton.textContent = "ดาวน์โหลดเวอร์ชันนี้";
    downloadButton.disabled = true;
    restoreButton.type = "button";
    restoreButton.className = "menu_button chat-vault-restore-confirm";
    restoreButton.textContent = "กู้เป็นแชทใหม่";
    restoreButton.disabled = true;
    actions.append(checkpointButton, downloadButton, restoreButton);
    panel.append(header, targetNote, list, preview, actions);
    overlay.append(panel);
    document.body.append(overlay);

    const closeDialog = () => {
        document.removeEventListener("keydown", onKeyDown);
        overlay.remove();
    };
    const onKeyDown = (event) => {
        if (event.key === "Escape") {
            closeDialog();
        }
    };

    closeButton.addEventListener("click", closeDialog);
    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
            closeDialog();
        }
    });
    document.addEventListener("keydown", onKeyDown);

    checkpointButton.addEventListener("click", async () => {
        checkpointButton.disabled = true;

        try {
            const checkpoint = await createNamedCheckpoint();

            if (checkpoint) {
                closeDialog();
                await openTimeMachineDialog();
            }
        } finally {
            checkpointButton.disabled = false;
        }
    });
    downloadButton.addEventListener("click", () => {
        if (selectedBackup) {
            downloadBackupContent(selectedBackup.content, selectedBackup.fileName);
        }
    });
    restoreButton.addEventListener("click", async () => {
        if (!selectedBackup || !selectedParsedBackup) {
            return;
        }

        restoreButton.disabled = true;
        checkpointButton.disabled = true;
        downloadButton.disabled = true;
        restoreButton.textContent = "กำลังกู้คืน...";

        try {
            await restoreBackupAsNewChat(
                target,
                { name: selectedBackup.fileName },
                selectedParsedBackup,
            );
            closeDialog();
            toastr.success(
                `กู้ ${selectedParsedBackup.messageCount} ข้อความเป็นแชทใหม่แล้ว`,
                extensionDisplayName,
            );
        } catch (error) {
            toastr.error("กู้จุดเวลานี้เป็นแชทใหม่ไม่สำเร็จ", extensionDisplayName);
            console.error(`[${extensionName}] Time Machine restore failed:`, error);
            restoreButton.disabled = false;
            checkpointButton.disabled = false;
            downloadButton.disabled = false;
            restoreButton.textContent = "กู้เป็นแชทใหม่";
        }
    });

    try {
        const history = await getBackupHistory(backupId);

        replaceElementChildren(list);

        if (!history.length) {
            list.textContent = "ยังไม่มีประวัติสำหรับแชทนี้";
            return;
        }

        for (const backup of history) {
            const item = document.createElement("button");
            const itemName = document.createElement("span");
            const itemMeta = document.createElement("small");
            const reason = backup.checkpointName
                ? `★ ${backup.checkpointName}`
                : describeSnapshotReason(backup.triggerReason);

            item.type = "button";
            item.className = "menu_button chat-vault-restore-file";
            itemName.className = "chat-vault-restore-file-name";
            itemName.textContent = reason;
            itemMeta.textContent = `${formatRestoreDate(backup.savedAt)} · ${backup.messageCount} ข้อความ`;
            item.append(itemName, itemMeta);
            item.addEventListener("click", () => {
                try {
                    selectedParsedBackup = parseChatVaultBackup(backup.content);
                    selectedBackup = backup;
                    downloadButton.disabled = false;
                    restoreButton.disabled = false;
                    preview.textContent = formatBackupPreview(selectedParsedBackup);

                    for (const button of list.querySelectorAll("button")) {
                        button.classList.toggle(
                            "chat-vault-restore-file-selected",
                            button === item,
                        );
                    }
                } catch (error) {
                    selectedParsedBackup = null;
                    selectedBackup = null;
                    downloadButton.disabled = true;
                    restoreButton.disabled = true;
                    preview.textContent = "snapshot นี้อ่านไม่ได้ จึงไม่อนุญาตให้กู้คืน";
                    console.error(`[${extensionName}] Time Machine preview failed:`, error);
                }
            });
            list.append(item);
        }
    } catch (error) {
        list.textContent = "เปิดประวัติ Time Machine ไม่สำเร็จ";
        console.error(`[${extensionName}] Time Machine history failed:`, error);
    }
}

async function openVaultHealthDialog() {
    document.getElementById("chat_vault_health_overlay")?.remove();

    const overlay = document.createElement("div");
    const panel = document.createElement("section");
    const header = document.createElement("div");
    const title = document.createElement("h3");
    const closeButton = document.createElement("button");
    const summary = document.createElement("div");
    const results = document.createElement("div");
    const actions = document.createElement("div");
    const runButton = document.createElement("button");
    const doneButton = document.createElement("button");

    overlay.id = "chat_vault_health_overlay";
    overlay.className = "chat-vault-restore-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    panel.className = "chat-vault-restore-panel chat-vault-health-panel";
    header.className = "chat-vault-restore-header";
    title.textContent = `สุขภาพ ${extensionDisplayName}`;
    closeButton.type = "button";
    closeButton.className = "menu_button chat-vault-restore-close";
    closeButton.textContent = "×";
    closeButton.setAttribute("aria-label", "ปิด");
    header.append(title, closeButton);
    summary.className = "chat-vault-restore-target";
    summary.textContent = "กำลังอ่านสถานะ...";
    results.className = "chat-vault-health-results";
    actions.className = "chat-vault-restore-actions";
    runButton.type = "button";
    runButton.className = "menu_button";
    runButton.textContent = "ทดสอบกู้คืน";
    doneButton.type = "button";
    doneButton.className = "menu_button";
    doneButton.textContent = "เสร็จแล้ว";
    actions.append(runButton, doneButton);
    panel.append(header, summary, results, actions);
    overlay.append(panel);
    document.body.append(overlay);

    const closeDialog = () => {
        document.removeEventListener("keydown", onKeyDown);
        overlay.remove();
    };
    const onKeyDown = (event) => {
        if (event.key === "Escape") {
            closeDialog();
        }
    };
    const appendResult = (label, value, state = "neutral") => {
        const row = document.createElement("div");
        const labelElement = document.createElement("strong");
        const valueElement = document.createElement("span");

        row.className = `chat-vault-health-result chat-vault-health-result-${state}`;
        labelElement.textContent = label;
        valueElement.textContent = value;
        row.append(labelElement, valueElement);
        results.append(row);
        return row;
    };

    closeButton.addEventListener("click", closeDialog);
    doneButton.addEventListener("click", closeDialog);
    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
            closeDialog();
        }
    });
    document.addEventListener("keydown", onKeyDown);

    const renderOverview = async () => {
        const context = getContext();
        const settings = extension_settings[extensionName];
        const backupId = context.chatId && Array.isArray(context.chat)
            ? getBackupIdentity(context).id
            : "";
        const [allBackups, backup, history, pending] = await Promise.all([
            getAllLatestBackups(),
            backupId ? getLatestBackup(backupId) : Promise.resolve(null),
            backupId ? getBackupHistory(backupId) : Promise.resolve([]),
            getPendingDriveBackups(settings.googleDriveAccountHint),
        ]);
        const health = evaluateVaultHealth({
            backup,
            usesGoogleDrive: settings.storageDestination === "google_drive",
            driveConnected: isGoogleDriveConnected(),
            pendingCount: pending.length,
            historyCount: history.length,
        });

        summary.textContent = health.label;
        replaceElementChildren(results);
        appendResult("แชทที่มีสำเนา", `${allBackups.length} แชท`);
        appendResult("ประวัติแชทนี้", `${history.length} เวอร์ชัน`);
        appendResult(
            "งานรอส่ง",
            pending.length ? `${pending.length} รายการ` : "ไม่มี",
            pending.length ? "warning" : "success",
        );
        appendResult(
            "Google Drive",
            settings.storageDestination !== "google_drive"
                ? "ไม่ได้เลือกเป็นปลายทาง"
                : (isGoogleDriveConnected()
                    ? `เชื่อมแล้ว · ${googleDriveAccount?.emailAddress || "บัญชี Google"}`
                    : "ยังไม่เชื่อม"),
            settings.storageDestination === "google_drive" && !isGoogleDriveConnected()
                ? "warning"
                : "success",
        );

        if (backup) {
            appendResult(
                "สำเนาล่าสุด",
                `${formatRestoreDate(backup.savedAt)} · ${backup.messageCount} ข้อความ`,
            );
        }

        return { backup, settings };
    };

    runButton.addEventListener("click", async () => {
        runButton.disabled = true;
        doneButton.disabled = true;
        runButton.textContent = "กำลังตรวจ...";

        try {
            const { backup, settings } = await renderOverview();

            if (!backup) {
                appendResult("ทดสอบไฟล์ในเครื่อง", "ยังไม่มี snapshot ให้ตรวจ", "warning");
                return;
            }

            try {
                const parsed = parseChatVaultBackup(backup.content);

                appendResult(
                    "ทดสอบไฟล์ในเครื่อง",
                    `ผ่าน · อ่านได้ ${parsed.messageCount} ข้อความ`,
                    "success",
                );
            } catch (error) {
                appendResult("ทดสอบไฟล์ในเครื่อง", "ไม่ผ่าน · snapshot อ่านไม่ได้", "error");
                throw error;
            }

            if (settings.storageDestination !== "google_drive") {
                return;
            }

            if (!isGoogleDriveConnected() && !await restoreRememberedGoogleDriveSession()) {
                appendResult("ทดสอบไฟล์บน Drive", "รอเชื่อม Google Drive", "warning");
                return;
            }

            const files = await listGoogleDriveBackups();
            const matchingFile = files.find((file) => (
                file.appProperties?.chatVaultSnapshotId === backup.snapshotId
                || (!file.appProperties?.chatVaultCheckpoint
                    && file.name === backup.fileName)
            ));

            if (!matchingFile) {
                appendResult("ทดสอบไฟล์บน Drive", "ยังไม่พบ snapshot เวอร์ชันนี้", "warning");
                return;
            }

            const driveContent = await downloadGoogleDriveBackup(matchingFile.id);
            const packageResult = await readVaultBackupPackage(driveContent);
            const parsedDriveBackup = packageResult.parsedBackup;

            appendResult(
                "ทดสอบไฟล์บน Drive",
                `ผ่าน checksum และอ่านได้ ${parsedDriveBackup.messageCount} ข้อความ${packageResult.vaultPackage.encrypted ? " · เข้ารหัสแล้ว" : ""}`,
                "success",
            );
            toastr.success("ทดสอบเส้นทางกู้คืนผ่านแล้ว", extensionDisplayName);
        } catch (error) {
            appendResult("ผลตรวจ", "พบปัญหา กรุณาดูรายการด้านบน", "error");
            console.error(`[${extensionName}] Vault health drill failed:`, error);
        } finally {
            runButton.disabled = false;
            doneButton.disabled = false;
            runButton.textContent = "ทดสอบอีกครั้ง";
            void refreshVaultHealthUi();
        }
    });

    try {
        await renderOverview();
    } catch (error) {
        summary.textContent = "อ่านสถานะ Vault ไม่สำเร็จ";
        console.error(`[${extensionName}] Vault health overview failed:`, error);
    }
}

async function importCharacterBackupForRescue(target, driveFile, parsedBackup) {
    const context = getContext();
    const fileName = String(driveFile.name || "chat-vault-rescued.jsonl")
        .replace(/[^a-zA-Z0-9._\-ก-๙ ]/g, "_")
        .replace(/\.jsonl$/i, "")
        .slice(0, 120) + ".jsonl";
    const importFile = new File([parsedBackup.content], fileName, {
        type: "application/x-ndjson;charset=utf-8",
    });
    const formData = new FormData();

    formData.set("avatar", importFile);
    formData.set("file_type", "jsonl");
    formData.set("user_name", context.name1 || parsedBackup.header.user_name || "User");
    formData.set("avatar_url", target.avatar);
    formData.set("character_name", target.name);

    const importedFileNames = await importCharacterChat(formData, { refresh: false });

    if (!importedFileNames.length) {
        throw new Error("rescue_import_failed");
    }

    return importedFileNames[0];
}

async function openRescueModeDialog() {
    if (!isGoogleDriveConnected() && !await restoreRememberedGoogleDriveSession()) {
        toastr.warning("กรุณาเชื่อม Google Drive ก่อนใช้ Rescue Mode", extensionDisplayName);
        return;
    }

    document.getElementById("chat_vault_rescue_overlay")?.remove();

    const overlay = document.createElement("div");
    const panel = document.createElement("section");
    const header = document.createElement("div");
    const title = document.createElement("h3");
    const closeButton = document.createElement("button");
    const note = document.createElement("p");
    const toolbar = document.createElement("div");
    const filterSelect = document.createElement("select");
    const selectAllButton = document.createElement("button");
    const list = document.createElement("div");
    const progress = document.createElement("div");
    const actions = document.createElement("div");
    const cancelButton = document.createElement("button");
    const rescueButton = document.createElement("button");
    let files = [];
    let rescueComplete = false;
    const selectedFileIds = new Set();

    overlay.id = "chat_vault_rescue_overlay";
    overlay.className = "chat-vault-restore-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    panel.className = "chat-vault-restore-panel chat-vault-rescue-panel";
    header.className = "chat-vault-restore-header";
    title.textContent = "Rescue Mode";
    closeButton.type = "button";
    closeButton.className = "menu_button chat-vault-restore-close";
    closeButton.textContent = "×";
    closeButton.setAttribute("aria-label", "ปิด");
    header.append(title, closeButton);
    note.className = "chat-vault-restore-target";
    note.textContent = "เลือกไฟล์ที่ต้องการกู้ ระบบจะจับคู่ชื่อตัวละครและสร้างเป็นแชทใหม่โดยไม่เขียนทับของเดิม";
    toolbar.className = "chat-vault-rescue-toolbar";
    filterSelect.className = "text_pole";
    filterSelect.append(
        new Option("สำเนาหลัก", "primary"),
        new Option("ไฟล์ conflict", "conflict"),
        new Option("จุดคืนค่าที่ปักหมุด", "checkpoint"),
        new Option("ทั้งหมด", "all"),
    );
    selectAllButton.type = "button";
    selectAllButton.className = "menu_button";
    selectAllButton.textContent = "เลือกทั้งหมดที่เห็น";
    toolbar.append(filterSelect, selectAllButton);
    list.className = "chat-vault-restore-list chat-vault-rescue-list";
    list.textContent = "กำลังค้นหาไฟล์สำรอง...";
    progress.className = "chat-vault-restore-preview chat-vault-rescue-progress";
    progress.textContent = "ยังไม่ได้เลือกไฟล์";
    actions.className = "chat-vault-restore-actions";
    cancelButton.type = "button";
    cancelButton.className = "menu_button";
    cancelButton.textContent = "ยกเลิก";
    rescueButton.type = "button";
    rescueButton.className = "menu_button chat-vault-restore-confirm";
    rescueButton.textContent = "กู้ไฟล์ที่เลือก";
    rescueButton.disabled = true;
    actions.append(cancelButton, rescueButton);
    panel.append(header, note, toolbar, list, progress, actions);
    overlay.append(panel);
    document.body.append(overlay);

    const closeDialog = () => {
        document.removeEventListener("keydown", onKeyDown);
        overlay.remove();
    };
    const onKeyDown = (event) => {
        if (event.key === "Escape") {
            closeDialog();
        }
    };
    const getFileType = (file) => {
        if (file.appProperties?.chatVaultConflict === "true") {
            return "conflict";
        }

        if (file.appProperties?.chatVaultCheckpoint === "true") {
            return "checkpoint";
        }

        return "primary";
    };
    const updateSelectionStatus = () => {
        rescueButton.disabled = selectedFileIds.size === 0;
        progress.textContent = selectedFileIds.size
            ? `เลือกแล้ว ${selectedFileIds.size} ไฟล์ · จะสร้างเป็นแชทใหม่ทั้งหมด`
            : "ยังไม่ได้เลือกไฟล์";
    };
    const renderFiles = () => {
        const filter = filterSelect.value;
        const visibleFiles = files.filter((file) => (
            filter === "all" || getFileType(file) === filter
        ));

        replaceElementChildren(list);

        if (!visibleFiles.length) {
            list.textContent = "ไม่พบไฟล์ประเภทนี้";
            return;
        }

        for (const file of visibleFiles) {
            const item = document.createElement("div");
            const checkbox = document.createElement("input");
            const checkboxLabel = document.createElement("label");
            const text = document.createElement("span");
            const name = document.createElement("strong");
            const meta = document.createElement("small");
            const previewButton = document.createElement("button");
            const type = getFileType(file);
            const typeLabel = type === "conflict"
                ? "Conflict"
                : (type === "checkpoint" ? "★ จุดคืนค่า" : "สำเนาหลัก");
            const characterName = file.appProperties?.chatVaultCharacterName || "";

            item.className = "chat-vault-rescue-file";
            checkbox.type = "checkbox";
            checkbox.id = `chat_vault_rescue_${String(file.id).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
            checkbox.checked = selectedFileIds.has(file.id);
            checkboxLabel.htmlFor = checkbox.id;
            checkboxLabel.className = "chat-vault-rescue-file-label";
            name.textContent = file.name || "ไฟล์ไม่มีชื่อ";
            meta.textContent = [
                typeLabel,
                characterName,
                formatRestoreDate(file.modifiedTime || file.createdTime),
                formatBackupFileSize(file.size),
            ].filter(Boolean).join(" · ");
            text.append(name, meta);
            checkboxLabel.append(text);
            previewButton.type = "button";
            previewButton.className = "menu_button chat-vault-rescue-preview-button";
            previewButton.textContent = type === "conflict" ? "เปรียบเทียบ" : "ดูตัวอย่าง";
            item.append(checkbox, checkboxLabel, previewButton);
            checkbox.addEventListener("change", () => {
                if (checkbox.checked) {
                    selectedFileIds.add(file.id);
                } else {
                    selectedFileIds.delete(file.id);
                }

                updateSelectionStatus();
            });
            previewButton.addEventListener("click", async () => {
                previewButton.disabled = true;
                progress.textContent = `กำลังอ่าน ${file.name || "ไฟล์สำรอง"}...`;

                try {
                    const content = await downloadGoogleDriveBackup(file.id);
                    const packageResult = await readVaultBackupPackage(content);
                    const parsed = packageResult.parsedBackup;
                    const sections = [
                        `${typeLabel}: ${file.name || "ไฟล์สำรอง"}`,
                        formatBackupPreview(parsed),
                        packageResult.vaultPackage.encrypted ? "Encrypted Vault: ใช่" : "Encrypted Vault: ไม่",
                        `สื่อใน Archive: ${packageResult.vaultPackage.attachments.length} ไฟล์`,
                    ];

                    if (type === "conflict") {
                        const primaryKey = file.appProperties?.chatVaultPrimaryBackupKey;
                        const primaryFile = files.find((candidate) => (
                            candidate.appProperties?.chatVaultBackupKey === primaryKey
                            && candidate.appProperties?.chatVaultConflict !== "true"
                        ));

                        if (primaryFile) {
                            const primaryContent = await downloadGoogleDriveBackup(primaryFile.id);
                            const primaryPackage = await readVaultBackupPackage(primaryContent);
                            const primaryParsed = primaryPackage.parsedBackup;

                            sections.push(
                                "",
                                `สำเนาหลัก: ${primaryFile.name || "ไฟล์สำรองหลัก"}`,
                                formatBackupPreview(primaryParsed),
                            );
                        } else {
                            sections.push("", "ไม่พบสำเนาหลักสำหรับเปรียบเทียบ");
                        }
                    }

                    progress.textContent = sections.join("\n");
                } catch (error) {
                    progress.textContent = "อ่านตัวอย่างไม่สำเร็จหรือ checksum ไม่ตรง";
                    console.error(`[${extensionName}] Rescue preview failed:`, error);
                } finally {
                    previewButton.disabled = false;
                }
            });
            list.append(item);
        }
    };

    closeButton.addEventListener("click", closeDialog);
    cancelButton.addEventListener("click", closeDialog);
    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
            closeDialog();
        }
    });
    document.addEventListener("keydown", onKeyDown);
    filterSelect.addEventListener("change", renderFiles);
    selectAllButton.addEventListener("click", () => {
        const filter = filterSelect.value;
        const visibleFiles = files.filter((file) => (
            filter === "all" || getFileType(file) === filter
        ));
        const allSelected = visibleFiles.every((file) => selectedFileIds.has(file.id));

        for (const file of visibleFiles) {
            if (allSelected) {
                selectedFileIds.delete(file.id);
            } else {
                selectedFileIds.add(file.id);
            }
        }

        selectAllButton.textContent = allSelected
            ? "เลือกทั้งหมดที่เห็น"
            : "ยกเลิกทั้งหมดที่เห็น";
        renderFiles();
        updateSelectionStatus();
    });

    rescueButton.addEventListener("click", async () => {
        if (rescueComplete) {
            closeDialog();
            return;
        }

        const selectedFiles = files.filter((file) => selectedFileIds.has(file.id));
        const context = getContext();
        const characters = Array.isArray(context.characters) ? context.characters : [];
        let restoredCount = 0;
        let skippedCount = 0;
        let failedCount = 0;

        rescueButton.disabled = true;
        cancelButton.disabled = true;
        closeButton.disabled = true;
        filterSelect.disabled = true;
        selectAllButton.disabled = true;

        for (let index = 0; index < selectedFiles.length; index += 1) {
            const file = selectedFiles[index];

            progress.textContent = `กำลังกู้ ${index + 1}/${selectedFiles.length} · ${file.name || "ไฟล์สำรอง"}`;

            try {
                const content = await downloadGoogleDriveBackup(file.id);
                const packageResult = await readVaultBackupPackage(content);
                const parsedBackup = packageResult.parsedBackup;
                const expectedName = String(
                    file.appProperties?.chatVaultCharacterName
                    || parsedBackup.header.character_name
                    || parsedBackup.header.name
                    || "",
                ).trim();
                const character = characters.find((candidate) => (
                    String(candidate?.name || "").trim().toLocaleLowerCase()
                    === expectedName.toLocaleLowerCase()
                ));

                if (!character?.avatar) {
                    skippedCount += 1;
                    continue;
                }

                const preparedBackup = await prepareVaultPackageForRestore(
                    packageResult.vaultPackage,
                );

                await importCharacterBackupForRescue(
                    { name: character.name, avatar: character.avatar },
                    file,
                    preparedBackup,
                );
                restoredCount += 1;
            } catch (error) {
                failedCount += 1;
                console.error(`[${extensionName}] Rescue import failed for ${file.id}:`, error);
            }
        }

        progress.textContent = [
            `กู้สำเร็จ ${restoredCount}`,
            `ข้ามเพราะไม่พบตัวละคร ${skippedCount}`,
            `ไม่สำเร็จ ${failedCount}`,
        ].join(" · ");
        rescueButton.textContent = "เสร็จแล้ว";
        rescueButton.disabled = false;
        rescueComplete = true;
        cancelButton.disabled = false;
        cancelButton.textContent = "ปิด";
        closeButton.disabled = false;
        toastr[failedCount ? "warning" : "success"](
            `Rescue สำเร็จ ${restoredCount} แชท`,
            extensionDisplayName,
        );
    });

    try {
        files = await listGoogleDriveBackups();
        renderFiles();
        updateSelectionStatus();
    } catch (error) {
        list.textContent = "โหลดรายการสำรองจาก Google Drive ไม่สำเร็จ";
        showGoogleDriveError(error, "เปิด Rescue Mode ไม่สำเร็จ");
        console.error(`[${extensionName}] Rescue list failed:`, error);
    }
}

async function saveCurrentChatBeforeRestore() {
    if (isBackupDisabled()) {
        return;
    }

    const context = getContext();

    if (!context.chatId || !Array.isArray(context.chat)) {
        return;
    }

    const settings = extension_settings[extensionName];
    let backup = createAutoSaveBackup(context, { triggerReason: "before_restore" });

    if (settings.storageDestination === "google_drive") {
        try {
            backup = await prepareBackupForDrive(backup, settings);
            backup = queueBackupForCurrentDrive(backup, settings);
        } catch (error) {
            console.info(`[${extensionName}] Pre-restore snapshot kept locally:`, error);
        }
    }

    backup = await saveBackupSnapshot(backup, {
        historyLimit: settings.historyLimit,
        triggerReason: "before_restore",
    });
    renderBackupStatusIfCurrent(backup);
    console.log(`[${extensionName}] Current chat saved locally before restore`);
}

async function restoreBackupAsNewChat(target, driveFile, parsedBackup) {
    const context = getContext();
    const currentTarget = getRestoreTarget(context);

    if (!currentTarget
        || currentTarget.type !== target.type
        || String(currentTarget.id) !== String(target.id)) {
        throw new Error("restore_target_changed");
    }

    await saveCurrentChatBeforeRestore();

    const fileName = String(driveFile.name || "chat-vault-restored.jsonl")
        .replace(/[^a-zA-Z0-9._\-ก-๙ ]/g, "_")
        .replace(/\.jsonl$/i, "")
        .slice(0, 120) + ".jsonl";
    const importFile = new File([parsedBackup.content], fileName, {
        type: "application/x-ndjson;charset=utf-8",
    });
    const formData = new FormData();

    formData.set("avatar", importFile);
    formData.set("file_type", "jsonl");
    formData.set("user_name", context.name1 || "User");

    if (target.type === "group") {
        const importedChatIds = await importGroupChat(formData, { refresh: false });

        if (!importedChatIds.length) {
            throw new Error("restore_import_failed");
        }

        await openGroupChat(target.id, importedChatIds[0]);
        return importedChatIds[0];
    }

    formData.set("avatar_url", target.avatar);
    formData.set("character_name", target.name);

    const importedFileNames = await importCharacterChat(formData, { refresh: false });

    if (!importedFileNames.length) {
        throw new Error("restore_import_failed");
    }

    const importedChatName = importedFileNames[0].replace(/\.jsonl$/i, "");

    await openCharacterChat(importedChatName);
    return importedChatName;
}

async function openGoogleDriveRestoreDialog() {
    const context = getContext();
    const target = getRestoreTarget(context);

    if (!target) {
        toastr.warning("กรุณาเปิดตัวละครหรือกลุ่มที่ต้องการกู้คืนแชทก่อน", extensionDisplayName);
        return;
    }

    document.getElementById("chat_vault_restore_overlay")?.remove();

    const overlay = document.createElement("div");
    const panel = document.createElement("section");
    const header = document.createElement("div");
    const title = document.createElement("h3");
    const closeButton = document.createElement("button");
    const targetNote = document.createElement("p");
    const list = document.createElement("div");
    const preview = document.createElement("div");
    const actions = document.createElement("div");
    const cancelButton = document.createElement("button");
    const restoreButton = document.createElement("button");
    let selectedDriveFile = null;
    let selectedParsedBackup = null;
    let selectedVaultPackage = null;
    let selectionVersion = 0;

    overlay.id = "chat_vault_restore_overlay";
    overlay.className = "chat-vault-restore-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "chat_vault_restore_title");

    panel.className = "chat-vault-restore-panel";
    header.className = "chat-vault-restore-header";
    title.id = "chat_vault_restore_title";
    title.textContent = "กู้คืนแชทจาก Google Drive";
    closeButton.type = "button";
    closeButton.className = "menu_button chat-vault-restore-close";
    closeButton.textContent = "×";
    closeButton.setAttribute("aria-label", "ปิด");
    header.append(title, closeButton);

    targetNote.className = "chat-vault-restore-target";
    targetNote.textContent = `จะสร้างเป็นแชทใหม่ของ: ${target.name}`;
    list.className = "chat-vault-restore-list";
    list.textContent = "กำลังค้นหาไฟล์สำรอง...";
    preview.className = "chat-vault-restore-preview";
    preview.textContent = "เลือกไฟล์เพื่อดูจำนวนข้อความก่อนกู้คืน";

    actions.className = "chat-vault-restore-actions";
    cancelButton.type = "button";
    cancelButton.className = "menu_button";
    cancelButton.textContent = "ยกเลิก";
    restoreButton.type = "button";
    restoreButton.className = "menu_button chat-vault-restore-confirm";
    restoreButton.textContent = "สร้างเป็นแชทใหม่";
    restoreButton.disabled = true;
    actions.append(cancelButton, restoreButton);

    panel.append(header, targetNote, list, preview, actions);
    overlay.append(panel);
    document.body.append(overlay);

    const closeDialog = () => {
        document.removeEventListener("keydown", onKeyDown);
        overlay.remove();
    };
    const onKeyDown = (event) => {
        if (event.key === "Escape") {
            closeDialog();
        }
    };

    closeButton.addEventListener("click", closeDialog);
    cancelButton.addEventListener("click", closeDialog);
    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
            closeDialog();
        }
    });
    document.addEventListener("keydown", onKeyDown);

    restoreButton.addEventListener("click", async () => {
        if (!selectedDriveFile || !selectedParsedBackup || !selectedVaultPackage) {
            return;
        }

        restoreButton.disabled = true;
        cancelButton.disabled = true;
        restoreButton.textContent = "กำลังสร้างแชทใหม่...";

        try {
            const preparedBackup = await prepareVaultPackageForRestore(selectedVaultPackage);

            await restoreBackupAsNewChat(
                target,
                selectedDriveFile,
                preparedBackup,
            );
            closeDialog();
            toastr.success(
                `กู้คืน ${preparedBackup.messageCount} ข้อความเป็นแชทใหม่แล้ว`,
                extensionDisplayName,
            );
        } catch (error) {
            const message = error?.message === "restore_target_changed"
                ? "ตัวละครหรือกลุ่มเปลี่ยนไประหว่างกู้คืน กรุณาเริ่มใหม่"
                : "สร้างแชทใหม่จากไฟล์สำรองไม่สำเร็จ";

            toastr.error(message, extensionDisplayName);
            console.error(`[${extensionName}] Chat restore failed:`, error);
            restoreButton.disabled = false;
            cancelButton.disabled = false;
            restoreButton.textContent = "สร้างเป็นแชทใหม่";
        }
    });

    try {
        const files = await listGoogleDriveBackups();

        replaceElementChildren(list);

        if (!files.length) {
            list.textContent = "ยังไม่พบไฟล์สำรองในโฟลเดอร์ที่เลือก";
            return;
        }

        for (const file of files) {
            const fileButton = document.createElement("button");
            const fileName = document.createElement("span");
            const fileMeta = document.createElement("small");

            fileButton.type = "button";
            fileButton.className = "menu_button chat-vault-restore-file";
            fileName.className = "chat-vault-restore-file-name";
            fileName.textContent = file.name || "ไฟล์สำรองไม่มีชื่อ";
            fileMeta.textContent = `${formatRestoreDate(file.modifiedTime || file.createdTime)} · ${formatBackupFileSize(file.size)}`;
            fileButton.append(fileName, fileMeta);

            fileButton.addEventListener("click", async () => {
                const currentSelection = ++selectionVersion;

                selectedDriveFile = null;
                selectedParsedBackup = null;
                selectedVaultPackage = null;
                restoreButton.disabled = true;
                preview.textContent = `กำลังอ่าน ${file.name || "ไฟล์สำรอง"}...`;

                for (const button of list.querySelectorAll("button")) {
                    button.classList.toggle("chat-vault-restore-file-selected", button === fileButton);
                }

                try {
                    const content = await downloadGoogleDriveBackup(file.id);
                    const packageResult = await readVaultBackupPackage(content);
                    const parsedBackup = packageResult.parsedBackup;

                    if (currentSelection !== selectionVersion || !overlay.isConnected) {
                        return;
                    }

                    selectedDriveFile = file;
                    selectedParsedBackup = parsedBackup;
                    selectedVaultPackage = packageResult.vaultPackage;
                    restoreButton.disabled = false;
                    preview.textContent = [
                        `${parsedBackup.messageCount} ข้อความ`,
                        `ต้นฉบับ: ${parsedBackup.header.character_name || parsedBackup.header.name || "ไม่ระบุ"}`,
                        packageResult.vaultPackage.encrypted ? "เข้ารหัสแล้ว" : "ไม่ได้เข้ารหัส",
                        packageResult.vaultPackage.attachments.length
                            ? `มีสื่อ ${packageResult.vaultPackage.attachments.length} ไฟล์`
                            : "ไม่มีสื่อที่ฝังใน Archive",
                        "ไฟล์นี้จะถูกสร้างเป็นแชทใหม่ ไม่เขียนทับแชทปัจจุบัน",
                    ].join(" · ");
                } catch (error) {
                    if (currentSelection !== selectionVersion || !overlay.isConnected) {
                        return;
                    }

                    const message = error instanceof ChatVaultBackupValidationError
                        ? "ไฟล์นี้ไม่ใช่แชทสำรอง JSONL ที่ถูกต้อง"
                        : (error instanceof GoogleDriveError
                            && error.code === "backup_checksum_mismatch"
                            ? "Checksum ไม่ตรง ไฟล์อาจเสียหายหรือถูกแก้ไข จึงไม่อนุญาตให้กู้คืน"
                            : "ดาวน์โหลดไฟล์สำรองจาก Google Drive ไม่สำเร็จ");

                    preview.textContent = message;
                    console.error(`[${extensionName}] Backup preview failed:`, error);
                }
            });

            list.append(fileButton);
        }
    } catch (error) {
        list.textContent = "โหลดรายการไฟล์สำรองไม่สำเร็จ";
        showGoogleDriveError(error, "โหลดรายการสำรองจาก Google Drive ไม่สำเร็จ");
        console.error(`[${extensionName}] Google Drive backup list failed:`, error);
    }
}

function showGoogleDriveError(error, fallbackMessage) {
    const messages = {
        client_id_missing: "ผู้ดูแลยังไม่ได้ตั้ง Google OAuth Client ID",
        client_id_invalid: "รูปแบบ Google OAuth Client ID ไม่ถูกต้อง",
        identity_load_failed: "โหลดระบบเชื่อมบัญชี Google ไม่ได้ กรุณาตรวจอินเทอร์เน็ต",
        identity_unavailable: "เบราว์เซอร์นี้ยังเปิดระบบเชื่อมบัญชี Google ไม่ได้",
        popup_failed_to_open: "เบราว์เซอร์ปิดกั้นหน้าต่าง Google กรุณาอนุญาตป๊อปอัปแล้วลองใหม่",
        // Google reports popup_closed both when the user really closes the window
        // and when it closes itself because this page's origin is not on the
        // Client ID's allow-list — by far the more common cause, and invisible
        // unless we name it. The origin is printed verbatim so it can be compared
        // character by character with Google Cloud.
        popup_closed: "หน้าต่าง Google ถูกปิดก่อนเชื่อมต่อสำเร็จ"
            + `\n\nถ้าไม่ได้ปิดเอง มักเป็นเพราะ Google Cloud ยังไม่รู้จักที่อยู่นี้ — เปิด Credentials → OAuth Client ID ของคุณ แล้วตรวจว่า Authorized JavaScript origins มี ${window.location.origin} ตรงทุกตัวอักษร (ห้ามมี / ปิดท้าย) และรอสักครู่หลังบันทึก`,
        authorization_start_failed: "เปิดหน้าต่างเชื่อมบัญชี Google ไม่ได้ กรุณาลองใหม่",
        authorization_timeout: `Google ไม่ได้ส่งผลกลับมายัง ${extensionDisplayName} กรุณาลองเชื่อมใหม่`,
        authorization_required: "สิทธิ์ Google Drive หมดอายุ กรุณากดเชื่อมใหม่",
        access_denied: "ไม่ได้รับอนุญาตให้เข้าถึง Google Drive",
        access_token_missing: "Google ไม่ได้ส่งสิทธิ์กลับมา กรุณาเชื่อมใหม่",
        // Redirect flow (mobile). These are refusals on our side, not Google's:
        // the reply did not prove it came from the request we sent.
        redirect_state_mismatch: "การเชื่อมต่อไม่ตรงกับที่เริ่มไว้ ระบบจึงไม่รับสิทธิ์นี้ · กรุณากดเชื่อมใหม่จากในแอป",
        redirect_state_invalid: "ข้อมูลการเชื่อมต่อเสียหาย กรุณากดเชื่อมใหม่",
        redirect_token_foreign: "สิทธิ์ที่ได้กลับมาไม่ใช่ของแอปนี้ ระบบจึงปฏิเสธเพื่อความปลอดภัย",
        redirect_token_scope: "สิทธิ์ที่ได้กลับมาไม่ครอบคลุม Google Drive กรุณาเชื่อมใหม่",
        redirect_token_unverified: "ตรวจสอบสิทธิ์กับ Google ไม่สำเร็จ กรุณาลองใหม่",
        network_error: "ติดต่อ Google Drive ไม่ได้ กรุณาตรวจอินเทอร์เน็ต",
        drive_request_failed: "Google Drive ปฏิเสธคำขอ กรุณาตรวจว่าเปิด Drive API แล้ว",
        drive_temporarily_unavailable: "Google Drive ยังไม่พร้อมหรือมีคำขอมากเกินไป ระบบจะลองส่งซ้ำอัตโนมัติ",
        drive_file_not_found: "ไฟล์สำรองเดิมถูกลบและยังสร้างใหม่ไม่ได้ กรุณาลองอีกครั้ง",
        drive_file_trashed: "ไฟล์สำรองเดิมอยู่ในถังขยะและยังสร้างใหม่ไม่ได้ กรุณาลองอีกครั้ง",
        folder_create_failed: "สร้างโฟลเดอร์สำรองใน Google Drive ไม่สำเร็จ",
        folder_name_missing: "กรุณาตั้งชื่อโฟลเดอร์ Google Drive",
        backup_missing: "ไม่พบข้อมูลแชทสำหรับส่งสำเนา",
        backup_identity_missing: "ไม่พบรหัสแชทสำหรับอัปเดตไฟล์ใน Google Drive",
        backup_file_missing: "ไม่พบไฟล์สำรองที่เลือกใน Google Drive",
        backup_upload_failed: "Google Drive ไม่ได้ส่งข้อมูลไฟล์สำรองกลับมา",
        backup_location_unavailable: "Google Drive ไม่ได้ส่งตำแหน่งไฟล์สำรองกลับมา",
        backup_folder_mismatch: "Google Drive ยังวางไฟล์ไม่ตรงโฟลเดอร์ที่เลือก กรุณาลองใหม่",
        backup_checksum_mismatch: "Checksum ของไฟล์สำรองไม่ตรง ระบบหยุดเพื่อป้องกันการกู้คืนไฟล์เสีย",
    };
    const message = error instanceof GoogleDriveError
        ? messages[error.code] || error.message || fallbackMessage
        : fallbackMessage;

    googleDriveStatusMessage = message;
    toastr.error(message, extensionDisplayName);
}

async function onGoogleDriveBackupClick() {
    if (isBackupDisabled()) {
        toastr.warning("เปิดการสำรองข้อมูลก่อนส่งสำเนาไป Google Drive", extensionDisplayName);
        return false;
    }

    const context = getContext();

    if (!context.chatId || !Array.isArray(context.chat)) {
        toastr.warning("กรุณาเปิดแชทก่อนส่งสำเนา", extensionDisplayName);
        return false;
    }

    if (
        !isGoogleDriveConnected()
        && !await restoreRememberedGoogleDriveSession()
    ) {
        toastr.warning("กรุณากดเชื่อม Google Drive ก่อนส่งสำเนา", extensionDisplayName);
        return false;
    }

    const settings = extension_settings[extensionName];
    let backup = createAutoSaveBackup(context, {
        triggerReason: "manual",
    });

    try {
        backup = await prepareBackupForDrive(backup, settings, {
            includeAttachments: true,
            interactive: true,
        });
        backup = queueBackupForCurrentDrive(backup, settings);
    } catch (error) {
        await saveBackupSnapshot(backup, {
            historyLimit: settings.historyLimit,
            triggerReason: "manual",
        });
        googleDriveStatusMessage = error instanceof VaultArchiveError
            && error.code === "vault_locked"
            ? "สำรองในเครื่องแล้ว · ยังไม่ได้ส่งเพราะ Encrypted Vault ล็อกอยู่"
            : "สำรองในเครื่องแล้ว · สร้าง Archive สำหรับ Drive ไม่สำเร็จ";
        toastr.warning(googleDriveStatusMessage, extensionDisplayName);
        console.warn(`[${extensionName}] Manual Drive package skipped:`, error);
        return false;
    }

    try {
        backup = await saveBackupSnapshot(backup, {
            historyLimit: settings.historyLimit,
            triggerReason: "manual",
        });
        renderLatestBackupStatus(backup);
    } catch (error) {
        console.warn(`[${extensionName}] Local snapshot failed before Drive upload:`, error);
    }

    try {
        const result = await driveAutoUploadQueue.enqueue(backup, 1);

        if (!result.uploaded) {
            googleDriveStatusMessage = "สำรองในเครื่องแล้ว · กรุณาลองส่ง Drive ใหม่อีกสักครู่";
            schedulePendingDriveRetry();
            toastr.warning(googleDriveStatusMessage, extensionDisplayName);
            return false;
        }

        const uploadedFile = result.file || {};
        const uploadedBackup = result.backup || backup;
        const folderName = extension_settings[extensionName].googleDriveFolderName
            || DEFAULT_GOOGLE_DRIVE_FOLDER_NAME;

        googleDriveLastFile = uploadedFile;
        googleDriveFolderBackupCount = uploadedFile.folderBackupCount;
        if (uploadedFile.conflictPreserved) {
            googleDriveStatusMessage = "พบไฟล์หลักที่ใหม่กว่า · เก็บ snapshot นี้เป็นไฟล์ conflict แยกไว้โดยไม่เขียนทับ";
            toastr.warning(googleDriveStatusMessage, extensionDisplayName);
        } else {
            googleDriveStatusMessage = uploadedFile.organizedMovedCount > 0
                ? `Google ยืนยันตำแหน่งแล้ว · เก็บไฟล์ที่หลุดกลับ ${uploadedFile.organizedMovedCount} ไฟล์ · “${folderName}”`
                : `Google ยืนยันตำแหน่งแล้ว · โฟลเดอร์ “${folderName}” · ${uploadedBackup.messageCount} ข้อความ`;
            toastr.success(
                `อัปเดต ${uploadedFile.name || backup.fileName} ในโฟลเดอร์ “${folderName}” แล้ว`,
                extensionDisplayName,
            );
        }
        console.log(`[${extensionName}] Backup uploaded to Google Drive:`, uploadedFile.id);
        await refreshLatestBackupStatus();
        return true;
    } catch (error) {
        schedulePendingDriveRetry();
        showGoogleDriveError(error, "ส่งสำเนาไป Google Drive ไม่สำเร็จ");
        console.error(`[${extensionName}] Google Drive upload failed:`, error);
        return false;
    }
}

function getDriveAutoUploadInterval(settings) {
    if (settings.autoSaveMode === "message_count") {
        return clamp(Number(settings.autoSaveEveryMessages) || 5, 1, 100);
    }

    return DEFAULT_DRIVE_AUTO_UPLOAD_EVERY_MESSAGES;
}

async function autoUploadBackupToGoogleDrive(backup, settings) {
    if (isBackupDisabled() || settings.storageDestination !== "google_drive") {
        return;
    }

    // This runs off a chat event, not off a click. Whatever activation the
    // message send carried is long gone by the time the snapshot is built, so an
    // authorization started here is a popup the browser blocks — and a blocked
    // attempt is not free: it clears the remembered account and starts the
    // reconnect cooldown, which would then swallow the user's own next click.
    // The snapshot is already safe locally; it waits as a pending backup and
    // goes up once a real reconnect happens.
    if (!isGoogleDriveConnected()) {
        googleDriveStatusMessage = "สำรองในเครื่องแล้ว · เชื่อม Drive ใหม่เพื่อส่งอัตโนมัติ";
        refreshCatStorageControls();
        return;
    }

    try {
        const result = await driveAutoUploadQueue.enqueue(
            backup,
            getDriveAutoUploadInterval(settings),
        );

        if (!result.uploaded) {
            schedulePendingDriveRetry();
            return;
        }

        const uploadedBackup = result.backup;
        const uploadedFile = result.file || {};
        const uploadedAt = new Date().toLocaleTimeString("th-TH", {
            hour: "2-digit",
            minute: "2-digit",
        });
        const folderName = settings.googleDriveFolderName
            || extension_settings[extensionName].googleDriveFolderName
            || DEFAULT_GOOGLE_DRIVE_FOLDER_NAME;

        googleDriveLastFile = uploadedFile;
        googleDriveFolderBackupCount = uploadedFile.folderBackupCount;
        googleDriveStatusMessage = uploadedFile.conflictPreserved
            ? `พบไฟล์ใหม่กว่าบนอุปกรณ์อื่น ${uploadedAt} · เก็บ snapshot นี้เป็นไฟล์ conflict แยกไว้`
            : (uploadedFile.organizedMovedCount > 0
                ? `Google ยืนยันแล้ว ${uploadedAt} · เก็บไฟล์ที่หลุดกลับ ${uploadedFile.organizedMovedCount} ไฟล์ · “${folderName}”`
                : `Google ยืนยันตำแหน่งแล้ว ${uploadedAt} · โฟลเดอร์ “${folderName}” · ${uploadedBackup.messageCount} ข้อความ`);
        refreshCatStorageControls();
        console.log(
            `[${extensionName}] Auto-save uploaded to Google Drive:`,
            result.file?.id,
            uploadedBackup.messageCount,
        );
        await refreshLatestBackupStatus();
    } catch (error) {
        schedulePendingDriveRetry();
        showGoogleDriveError(error, "ส่ง Auto-save ไป Google Drive ไม่สำเร็จ");
        refreshCatStorageControls();
        console.error(`[${extensionName}] Google Drive auto-upload failed:`, error);
    }
}

function readAutoSaveSettings() {
    const settings = extension_settings[extensionName];

    return {
        autoSaveMode: settings.autoSaveMode,
        autoSaveEveryMessages: settings.autoSaveEveryMessages,
        historyLimit: settings.historyLimit,
        storageDestination: settings.storageDestination,
        googleDriveFolderName: settings.googleDriveFolderName,
        googleDriveAccountHint: settings.googleDriveAccountHint,
        encryptionEnabled: settings.encryptionEnabled,
        includeAttachmentsInCheckpoints: settings.includeAttachmentsInCheckpoints,
        attachmentLimitMb: settings.attachmentLimitMb,
    };
}

function renderBackupStatusIfCurrent(backup) {
    const context = getContext();

    if (!context.chatId || !Array.isArray(context.chat)) {
        return;
    }

    if (getBackupIdentity(context).id === backup.id) {
        renderLatestBackupStatus(backup);
    }
}

async function processAutoSave(
    reason,
    expectedChatId,
    preparedBackup = null,
    preparedSettings = null,
) {
    const settings = preparedSettings || readAutoSaveSettings();

    if (!shouldCaptureAutoSaveEvent(settings.autoSaveMode, reason)) {
        return;
    }

    let backup = preparedBackup;
    const capturesExistingMessageMutation = shouldBypassMessageInterval(reason);

    if (!backup) {
        const context = getContext();

        if (!context.chatId || !Array.isArray(context.chat)) {
            return;
        }

        if (String(context.chatId) !== String(expectedChatId)) {
            console.warn(`[${extensionName}] Auto-save skipped: chat changed before snapshot`);
            return;
        }

        backup = createAutoSaveBackup(context, { triggerReason: reason });
    }

    if (settings.autoSaveMode === "message_count") {
        const requiredMessages = clamp(
            Number(settings.autoSaveEveryMessages) || 5,
            1,
            100,
        );

        if (requiredMessages > 1 && !capturesExistingMessageMutation) {
            const previousBackup = await getLatestBackup(backup.id);
            const messagesSinceLastBackup = previousBackup
                ? backup.messageCount - previousBackup.messageCount
                : backup.messageCount;

            if (previousBackup
                && messagesSinceLastBackup >= 0
                && messagesSinceLastBackup < requiredMessages) {
                console.log(
                    `[${extensionName}] Auto-save waiting:`,
                    `${messagesSinceLastBackup}/${requiredMessages}`,
                );
                return;
            }
        }
    }

    let drivePrepared = false;

    if (settings.storageDestination === "google_drive") {
        try {
            backup = await prepareBackupForDrive(backup, settings);
            backup = queueBackupForCurrentDrive(backup, settings);
            drivePrepared = true;
        } catch (error) {
            googleDriveStatusMessage = error instanceof VaultArchiveError
                && error.code === "vault_locked"
                ? "สำรองในเครื่องแล้ว · ปลดล็อก Encrypted Vault เพื่อส่งอัตโนมัติ"
                : "สำรองในเครื่องแล้ว · เตรียม Archive สำหรับ Drive ไม่สำเร็จ";
            refreshCatStorageControls();
            console.warn(`[${extensionName}] Auto-save Drive package skipped:`, error);
        }
    }

    backup = await saveBackupSnapshot(backup, {
        historyLimit: settings.historyLimit,
        triggerReason: reason,
    });
    renderBackupStatusIfCurrent(backup);
    console.log(
        `[${extensionName}] Auto-save snapshot stored:`,
        reason,
        backup.messageCount,
    );

    // Cloud uploads have their own ordered queue. Do not make a slow mobile
    // connection delay the next local snapshot.
    if (drivePrepared) {
        void autoUploadBackupToGoogleDrive(backup, settings);
    }
}

function enqueueAutoSave(reason, expectedChatId, backup = null, settings = null) {
    autoSaveWork = autoSaveWork
        .then(() => processAutoSave(reason, expectedChatId, backup, settings))
        .catch((error) => {
            toastr.error("บันทึกสำเนาอัตโนมัติไม่สำเร็จ", extensionDisplayName);
            console.error(`[${extensionName}] Auto-save failed:`, error);
        });
}

function scheduleAutoSave(reason) {
    const settings = readAutoSaveSettings();

    if (!shouldCaptureAutoSaveEvent(settings.autoSaveMode, reason)) {
        return;
    }

    const context = getContext();
    const expectedChatId = context.chatId;

    if (!expectedChatId || !Array.isArray(context.chat)) {
        return;
    }

    const savesEveryEvent = shouldCaptureImmediately(
        settings.autoSaveMode,
        settings.autoSaveEveryMessages,
        reason,
    );

    if (savesEveryEvent) {
        // Capture now instead of debouncing. This preserves a message even if
        // the app changes or removes it before a later message arrives.
        enqueueAutoSave(
            reason,
            String(expectedChatId),
            createAutoSaveBackup(context, { triggerReason: reason }),
            settings,
        );
        return;
    }

    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
        enqueueAutoSave(reason, String(expectedChatId));
    }, 750);
}

function registerAutoSaveEvents() {
    if (autoSaveEventsRegistered) {
        return;
    }

    const context = getContext();
    const eventSource = context.eventSource;
    const eventTypes = context.eventTypes;
    const registeredEventValues = new Set();
    const register = (eventName, reason, waitForMutation = false) => {
        const eventValue = eventTypes[eventName];

        if (!eventValue || registeredEventValues.has(eventValue)) {
            return;
        }

        registeredEventValues.add(eventValue);
        eventSource.on(eventValue, () => {
            if (waitForMutation) {
                globalThis.setTimeout(() => scheduleAutoSave(reason), 0);
            } else {
                scheduleAutoSave(reason);
            }
        });
    };

    register("MESSAGE_SENT", "message_sent");
    register("MESSAGE_RECEIVED", "message_received");
    register("MESSAGE_EDITED", "message_edited", true);
    register("MESSAGE_UPDATED", "message_updated", true);
    register("MESSAGE_SWIPED", "message_swiped", true);
    register("MESSAGE_DELETED", "message_deleted", true);
    register("MESSAGES_DELETED", "messages_deleted", true);
    register("MESSAGE_FILE_EMBEDDED", "message_file_embedded", true);
    autoSaveEventsRegistered = true;

    console.log(
        `[${extensionName}] Auto-save events registered:`,
        registeredEventValues.size,
    );
}

async function onDownloadBackupClick() {
    if (isBackupDisabled()) {
        toastr.warning("เปิดการสำรองข้อมูลก่อนดาวน์โหลดสำเนาใหม่", extensionDisplayName);
        return;
    }

    const context = getContext();

    if (!context.chatId || !Array.isArray(context.chat)) {
        toastr.warning("กรุณาเปิดแชทก่อนดาวน์โหลดสำเนา", extensionDisplayName);
        console.log(`[${extensionName}] Backup skipped: no active chat selected`);
        return;
    }

    try {
        const settings = extension_settings[extensionName];
        let backup = createAutoSaveBackup(context, { triggerReason: "manual" });

        await saveBackupSnapshot(backup, {
            historyLimit: settings.historyLimit,
            triggerReason: "manual",
        });
        renderLatestBackupStatus(backup);
        backup = await prepareBackupForDrive(backup, settings, {
            includeAttachments: true,
            interactive: true,
        });

        const payload = backup.drivePayload || backup;
        const extension = String(payload.fileName).toLocaleLowerCase().endsWith(".cvault")
            ? ".cvault"
            : ".jsonl";
        const safeSavedAt = backup.savedAt.replace(/[:.]/g, "-");
        const fileName = String(payload.fileName)
            .replace(/\.(?:jsonl|cvault)$/i, "")
            + `_${safeSavedAt}${extension}`;

        downloadBackupContent(payload.content, fileName);

        toastr.success(
            `ดาวน์โหลดสำเนา ${context.chat.length} ข้อความ${payload.attachmentCount ? ` · สื่อ ${payload.attachmentCount} ไฟล์` : ""} แล้ว`,
            extensionDisplayName,
        );
        console.log(`[${extensionName}] Backup downloaded:`, fileName);
    } catch (error) {
        const message = error instanceof VaultArchiveError && error.code === "vault_locked"
            ? "ยกเลิกการดาวน์โหลด เพราะ Encrypted Vault ยังล็อกอยู่"
            : "ไม่สามารถดาวน์โหลดสำเนาแชทได้";

        toastr.error(message, extensionDisplayName);
        console.error(`[${extensionName}] Backup download failed:`, error);
    }
}

// Extension initialization
jQuery(async () => {
    console.log(`[${extensionName}] Loading...`);

    try {
        // ?v= on every file we fetch by path. Browsers cache these aggressively, so
        // after an update the old settings panel and the old artwork keep being
        // served until the user clears their cache by hand. Tying the query to the
        // version makes each release a different URL, which fetches fresh once and
        // then caches normally.
        const settingsHtml = await $.get(`${extensionFolderPath}/example.html?v=${extensionVersion}`);
        $("#extensions_settings2").append(settingsHtml);

        $("#chat_vault_show_cat").on("input", onShowCatChange);
        $("#chat_vault_google_client_id").on("change", onGoogleDriveClientIdChange);

        // The plugin panel's two buttons. Bound here where the HTML now exists;
        // the panel itself stays hidden until the probe below finds a plugin.
        document.getElementById("chat_vault_plugin_save")
            ?.addEventListener("click", (event) => {
                event.preventDefault();
                void savePluginConfiguration();
            });
        document.getElementById("chat_vault_plugin_connect")
            ?.addEventListener("click", (event) => {
                event.preventDefault();
                globalThis.location.assign(getVaultServerAuthUrl(
                    globalThis.location.pathname + globalThis.location.search,
                ));
            });

        await loadSettings();
        createCatMagnet();
        registerAutoSaveEvents();
        registerDriveRetryEvents();

        /*
         * Which of the two authorization paths this session uses is decided
         * here, and it is decided by the instance rather than by the user: the
         * plugin is either installed on this SillyTavern or it is not. The probe
         * is a local request that answers at once or 404s, so asking costs an
         * ordinary install nothing.
         */
        detectVaultServer()
            .then(async (status) => {
                vaultServerStatus = status;
                refreshPluginAdminPanel();

                if (canUseVaultServer()) {
                    console.log(`[${extensionName}] Pocky Vault plugin detected`);
                    refreshCatStorageControls();

                    if (await restoreRememberedGoogleDriveSession()) {
                        await flushPendingDriveBackups();
                    }

                    return;
                }

                // Installed but never given its Google credentials. Said out
                // loud, because from the menu this is indistinguishable from
                // having no plugin at all, and whoever put the file there is
                // owed an explanation of why it appears to do nothing.
                if (status) {
                    console.warn(
                        `[${extensionName}] Pocky Vault plugin is installed but not configured;`
                        + " falling back to browser authorization."
                        + " POST clientId and clientSecret to /api/plugins/pocky-vault/config to enable it.",
                    );
                }

                // Browser-only path — which needs Google's script loaded, and
                // cannot reconnect until the user supplies a gesture for it to
                // work with.
                await prepareGoogleDrive();

                // Coming back from the mobile redirect the token is already in the
                // URL, so settle that before anything tries to reconnect — a silent
                // reconnect would otherwise race it and fail for no reason.
                const redirected = await finishGoogleDriveRedirectConnection();

                if (redirected) {
                    return;
                }

                armGestureDriveReconnect();
            })
            .catch((error) => {
                console.warn(`[${extensionName}] Google Drive startup failed:`, error);
            });

        console.log(`[${extensionName}] Loaded successfully`);
    } catch (error) {
        console.error(`[${extensionName}] Failed to load:`, error);
    }
});
