/*
 * Pocky Chat Vault — SillyTavern server plugin
 *
 * Why this exists
 * ---------------
 * The browser extension asks Google for a Drive token directly. That works, but
 * Google will not issue a refresh token to a client that runs in a page: a page
 * cannot keep a secret, so the longest credential it can hold is a one-hour
 * access token that dies with the tab. Google's own documentation is explicit
 * that for the client-side flow, "when the token expires, the application
 * repeats the process" — which is the "log in again every visit" the extension
 * has had since 1.0. It is not a bug in the extension; it is the flow's ceiling.
 *
 * Node can keep a secret. This plugin therefore does the half of OAuth the
 * browser is not allowed to do: it holds the client secret, performs the
 * authorization-code exchange, keeps the refresh token on disk, and hands the
 * page a fresh access token whenever it asks. Connect once, stay connected.
 *
 * What this does NOT change
 * -------------------------
 * ADR-001 forbids a Chat Vault server standing between the user and Google.
 * This is not that server. It is the user's own SillyTavern process — the one
 * already holding every chat this extension exists to back up — and it is
 * reached over the same loopback the chats travel on. No third party is added,
 * and no chat content passes through this file: it moves tokens, nothing else.
 * Uploads still go from the browser straight to Google.
 *
 * What it costs, stated plainly
 * -----------------------------
 * The refresh token and the client secret sit in a plaintext file on this
 * machine, and every endpoint below is reachable by anyone who can reach this
 * SillyTavern instance. That is the same trust boundary as SillyTavern itself,
 * which already serves every chat to whoever can open it — but it is a real
 * change from the extension's browser-only posture, where nothing durable
 * existed to steal. Do not run this on an instance you would not trust with
 * your chats, and keep SillyTavern off the open internet without auth.
 *
 * Scope stays `drive.file`: files this extension created, not the whole Drive.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
/*
 * The address is read from Drive, not from the userinfo endpoint. Userinfo needs
 * the `email` or `openid` scope, and asking for either to fill in a label would
 * widen the grant past `drive.file` — a change the development guide lists as
 * requiring its own ADR, and rightly: the narrow scope is a promise made to the
 * user, not an implementation detail. Drive's own `about` endpoint answers the
 * same question inside the scope we already hold, and is what the extension has
 * always used for this.
 */
const GOOGLE_DRIVE_ABOUT_ENDPOINT = "https://www.googleapis.com/drive/v3/about";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

// Refresh a little before the hour is up. A token that expires mid-upload costs
// a failed backup and a retry; a token fetched sixty seconds early costs
// nothing.
const TOKEN_REFRESH_MARGIN_MS = 120_000;

export const info = {
    id: "pocky-vault",
    name: "Pocky Chat Vault",
    description: "Holds the Google refresh token so Chat Vault stays connected across reloads.",
};

/*
 * Storage lives under SillyTavern's data directory rather than beside this file,
 * because a plugin folder is something a user replaces wholesale when updating.
 * Credentials that vanish on update would send them back to the setup they did
 * this to avoid.
 */
function resolveStorePath() {
    const dataDir = path.join(process.cwd(), "data", "_pocky-vault");

    fs.mkdirSync(dataDir, { recursive: true });

    return path.join(dataDir, "auth.json");
}

let storePath = "";

function readStore() {
    let raw;

    try {
        raw = fs.readFileSync(storePath, "utf8");
    } catch {
        // Not written yet. A fresh install, not a problem.
        return {};
    }

    try {
        return JSON.parse(raw);
    } catch (error) {
        /*
         * The file exists but will not parse — a half-finished write after a
         * crash, most likely. Returning {} is the only way to keep serving, but
         * the next write would then flatten whatever was left, and what is in
         * there is a refresh token that cannot be reissued without the user
         * authorizing again. So it is set aside first, under a name that says
         * what it is, and the caller gets a clean slate.
         */
        const salvagePath = `${storePath}.corrupt`;

        try {
            fs.renameSync(storePath, salvagePath);
            console.warn(`[${info.id}] credentials file was unreadable; kept a copy at ${salvagePath}`);
        } catch {
            console.warn(`[${info.id}] credentials file is unreadable and could not be set aside:`, error.message);
        }

        return {};
    }
}

function writeStore(store) {
    // 0600: this file holds a client secret and a refresh token. Other accounts
    // on the machine have no business reading it. (No-op on Windows, which is
    // why the warning above is worded the way it is.)
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2), { mode: 0o600 });
}

function patchStore(changes) {
    const store = { ...readStore(), ...changes };

    writeStore(store);

    return store;
}

// The exact value that has to be registered in Google Cloud. Derived from the
// request so it matches however the user actually reaches SillyTavern, rather
// than a guess baked in at install time.
function resolveRedirectUri(req) {
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const protocol = forwardedProto || req.protocol || "http";
    const host = req.headers["x-forwarded-host"] || req.headers.host;

    return `${protocol}://${host}/api/plugins/${info.id}/auth/callback`;
}

function readCredentials() {
    const store = readStore();

    return {
        clientId: String(store.clientId || ""),
        clientSecret: String(store.clientSecret || ""),
    };
}

async function postForm(url, params) {
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params).toString(),
    });
    const text = await response.text();
    let payload = {};

    try {
        payload = JSON.parse(text);
    } catch {
        payload = { raw: text };
    }

    if (!response.ok) {
        const error = new Error(payload.error_description || payload.error || "Google rejected the request");

        error.code = payload.error || "token_request_failed";
        error.status = response.status;
        throw error;
    }

    return payload;
}

/*
 * The one function the rest of this file exists to support. Returns a usable
 * access token, refreshing it first if the cached one is spent.
 *
 * A refresh that fails with invalid_grant is terminal, not transient: Google is
 * saying the grant is gone — revoked in the account's security settings, or
 * expired because the OAuth consent screen is still in Testing, where grants
 * die after seven days. Clearing the token here is what lets the UI say
 * "reconnect" instead of retrying a credential that will never work again.
 */
async function getAccessToken() {
    const store = readStore();

    if (!store.refreshToken) {
        const error = new Error("Not connected to Google");

        error.code = "not_connected";
        throw error;
    }

    if (store.accessToken && Number(store.accessTokenExpiresAt || 0) > Date.now() + TOKEN_REFRESH_MARGIN_MS) {
        return {
            accessToken: store.accessToken,
            expiresAt: store.accessTokenExpiresAt,
        };
    }

    const { clientId, clientSecret } = readCredentials();

    try {
        const payload = await postForm(GOOGLE_TOKEN_ENDPOINT, {
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: store.refreshToken,
            grant_type: "refresh_token",
        });
        const expiresAt = Date.now() + (Math.max(0, Number(payload.expires_in) || 3600) * 1000);

        patchStore({
            accessToken: payload.access_token,
            accessTokenExpiresAt: expiresAt,
        });

        return { accessToken: payload.access_token, expiresAt };
    } catch (error) {
        if (error.code === "invalid_grant") {
            patchStore({
                refreshToken: "",
                accessToken: "",
                accessTokenExpiresAt: 0,
                email: "",
            });
        }

        throw error;
    }
}

// Best effort by design: the address is a label in the UI, so failing to read it
// must never fail the connection that just succeeded.
async function fetchAccountEmail(accessToken) {
    try {
        const url = `${GOOGLE_DRIVE_ABOUT_ENDPOINT}?fields=user(displayName,emailAddress)`;
        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!response.ok) {
            return "";
        }

        const payload = await response.json();

        return String(payload?.user?.emailAddress || payload?.user?.displayName || "").trim();
    } catch {
        return "";
    }
}

/*
 * SillyTavern mounts plugin routers itself, and whether a JSON body parser has
 * already run on the way here is not something this file gets to assume. Reading
 * the stream directly when `req.body` is absent costs a few lines and removes a
 * dependency on somebody else's middleware order.
 */
async function readJsonBody(req) {
    if (req.body && typeof req.body === "object") {
        return req.body;
    }

    const raw = await new Promise((resolve) => {
        let buffer = "";

        req.setEncoding("utf8");
        req.on("data", (chunk) => {
            buffer += chunk;

            // A config post is a few hundred bytes. Anything larger is not ours.
            if (buffer.length > 64_000) {
                buffer = "";
                req.destroy();
            }
        });
        req.on("end", () => resolve(buffer));
        req.on("error", () => resolve(""));
    });

    try {
        return JSON.parse(raw || "{}");
    } catch {
        return {};
    }
}

/*
 * Authorizations in flight, keyed by their state value.
 *
 * A single slot would have been simpler and wrong: one SillyTavern serves every
 * device in the house, so a phone and a desktop can be sent to Google within
 * seconds of each other. With one slot the second departure overwrites the
 * first, and the first person comes back to "this authorization did not match" —
 * a security message for something that was never an attack.
 *
 * Entries are memory-only and expire, so an abandoned round trip cleans itself
 * up instead of accumulating.
 */
const PENDING_STATE_TTL_MS = 10 * 60 * 1000;
const pendingStates = new Map();

function rememberPendingState(entry) {
    const now = Date.now();

    for (const [value, pending] of pendingStates) {
        if (now - pending.createdAt > PENDING_STATE_TTL_MS) {
            pendingStates.delete(value);
        }
    }

    pendingStates.set(entry.value, entry);
}

function takePendingState(value) {
    const entry = pendingStates.get(String(value || ""));

    if (!entry) {
        return null;
    }

    pendingStates.delete(entry.value);

    if (Date.now() - entry.createdAt > PENDING_STATE_TTL_MS) {
        return null;
    }

    return entry;
}

export async function init(router) {
    storePath = resolveStorePath();
    console.log(`[${info.id}] credentials file: ${storePath}`);

    /*
     * Everything below is reachable by anyone who can reach SillyTavern. That is
     * stated in the header and is a deliberate choice, not an oversight: adding
     * a second authentication scheme here would be security theatre while the
     * chats themselves are served with none.
     */

    // What the extension probes on load to decide which authorization path to
    // take. Its absence is the answer for a browser-only install, so it must
    // stay cheap and must never throw.
    router.get("/status", async (req, res) => {
        const store = readStore();
        const hasCredentials = Boolean(store.clientId && store.clientSecret);

        res.json({
            plugin: info.id,
            version: 1,
            configured: hasCredentials,
            connected: Boolean(store.refreshToken),
            email: String(store.email || ""),
            redirectUri: resolveRedirectUri(req),
        });
    });

    // The client secret arrives here rather than living in extension settings,
    // which are synced into the page and readable by anything running in it.
    router.post("/config", async (req, res) => {
        const body = await readJsonBody(req);
        const clientId = String(body.clientId || "").trim();
        const clientSecret = String(body.clientSecret || "").trim();

        if (!clientId.endsWith(".apps.googleusercontent.com")) {
            res.status(400).json({ error: "client_id_invalid" });
            return;
        }

        if (!clientSecret) {
            res.status(400).json({ error: "client_secret_missing" });
            return;
        }

        const previous = readStore();

        patchStore({
            clientId,
            clientSecret,
            // Changing the application invalidates any grant issued to the old
            // one. Keeping the old refresh token would only produce a confusing
            // invalid_grant on the next call.
            ...(previous.clientId && previous.clientId !== clientId
                ? { refreshToken: "", accessToken: "", accessTokenExpiresAt: 0, email: "" }
                : {}),
        });

        res.json({ ok: true, redirectUri: resolveRedirectUri(req) });
    });

    /*
     * Start of the authorization-code flow — the part the browser cannot do.
     *
     * access_type=offline is what asks for a refresh token at all, and
     * prompt=consent is what makes Google send one every time rather than only
     * on a user's very first consent. Without the second, reconnecting after a
     * revoke silently yields no refresh token and the whole point is lost.
     */
    router.get("/auth/start", async (req, res) => {
        const { clientId } = readCredentials();

        if (!clientId) {
            res.status(400).send("Pocky Vault: set the Client ID and secret first.");
            return;
        }

        const redirectUri = resolveRedirectUri(req);

        const pending = {
            value: randomUUID(),
            redirectUri,
            returnTo: String(req.query.returnTo || "/"),
            createdAt: Date.now(),
        };

        rememberPendingState(pending);

        const params = new URLSearchParams({
            client_id: clientId,
            redirect_uri: redirectUri,
            response_type: "code",
            scope: DRIVE_SCOPE,
            access_type: "offline",
            prompt: "consent",
            include_granted_scopes: "true",
            state: pending.value,
        });

        res.redirect(`${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`);
    });

    router.get("/auth/callback", async (req, res) => {
        // Consumed by its own state value, so two devices authorizing at once
        // each get their own answer instead of cancelling one another.
        const state = takePendingState(req.query.state);

        // An authorization nobody here started is one somebody else started.
        if (!state) {
            res.status(400).send("Pocky Vault: this authorization did not match the one that was started.");
            return;
        }

        if (req.query.error) {
            res.status(400).send(`Pocky Vault: Google returned ${req.query.error}`);
            return;
        }

        const code = String(req.query.code || "");

        if (!code) {
            res.status(400).send("Pocky Vault: Google returned no authorization code.");
            return;
        }

        try {
            const { clientId, clientSecret } = readCredentials();
            const payload = await postForm(GOOGLE_TOKEN_ENDPOINT, {
                client_id: clientId,
                client_secret: clientSecret,
                code,
                grant_type: "authorization_code",
                redirect_uri: state.redirectUri,
            });

            if (!payload.refresh_token) {
                res.status(400).send(
                    "Pocky Vault: Google did not return a refresh token. Remove this app at "
                    + "myaccount.google.com/permissions and connect again.",
                );
                return;
            }

            const expiresAt = Date.now() + (Math.max(0, Number(payload.expires_in) || 3600) * 1000);
            const email = await fetchAccountEmail(payload.access_token);

            patchStore({
                refreshToken: payload.refresh_token,
                accessToken: payload.access_token,
                accessTokenExpiresAt: expiresAt,
                email,
            });

            console.log(`[${info.id}] connected${email ? ` as ${email}` : ""}`);
            res.redirect(state.returnTo || "/");
        } catch (error) {
            console.error(`[${info.id}] token exchange failed:`, error);
            res.status(500).send(`Pocky Vault: token exchange failed — ${error.message}`);
        }
    });

    // The endpoint the page actually lives on. POST because it has a side
    // effect: it may spend a refresh to mint a new token.
    router.post("/token", async (req, res) => {
        try {
            const { accessToken, expiresAt } = await getAccessToken();
            let email = String(readStore().email || "");

            // Backfill for connections made before the address was read from the
            // right endpoint, so an existing grant does not have to be redone
            // just to put a label on a card. Costs one call, once.
            if (!email) {
                email = await fetchAccountEmail(accessToken);

                if (email) {
                    patchStore({ email });
                }
            }

            res.json({ accessToken, expiresAt, email });
        } catch (error) {
            /*
             * 409 means one thing to the caller: the user has to authorize again,
             * and retrying will not help. Both codes that reach it say exactly
             * that — never connected, or connected and the grant is now gone.
             *
             * invalid_grant is the ordinary weekly event for anyone whose OAuth
             * consent screen is still in Testing, where Google expires the grant
             * after seven days. That is a supported way to run this, so the case
             * gets a clean "reconnect" rather than being dressed up as a server
             * fault. 502 is kept for what it should mean: Google was reachable
             * but something else went wrong.
             */
            const needsReauthorization = error.code === "not_connected"
                || error.code === "invalid_grant";

            res.status(needsReauthorization ? 409 : 502).json({
                error: error.code || "token_unavailable",
                message: error.message,
                reconnectRequired: needsReauthorization,
            });
        }
    });

    /*
     * Disconnect tells Google to drop the grant as well as forgetting it here.
     * A local delete alone would leave the application listed in the account's
     * permissions with nothing on this side able to use or remove it.
     *
     * Backups already on Drive are untouched, matching what Disconnect has
     * always meant in this project.
     */
    router.post("/disconnect", async (req, res) => {
        const store = readStore();

        if (store.refreshToken) {
            try {
                await postForm(GOOGLE_REVOKE_ENDPOINT, { token: store.refreshToken });
            } catch (error) {
                console.warn(`[${info.id}] revoke failed, clearing locally anyway:`, error.message);
            }
        }

        patchStore({
            refreshToken: "",
            accessToken: "",
            accessTokenExpiresAt: 0,
            email: "",
        });

        res.json({ ok: true });
    });

    console.log(`[${info.id}] ready at /api/plugins/${info.id}`);
}

export async function exit() {
    pendingState = null;
}
