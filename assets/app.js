// Configuration - Update with your Twilio Functions URL
const FUNCTIONS_BASE_URL = window.location.origin.replace(/\/$/, '');

// State
const CREDS_KEY = 'twilio_messaging_oauth';

/**
 * { clientId, clientSecret, accountSid }, or null when signed out.
 * accountSid is derived server-side by /verify from the access token — it is
 * stored here for display only, never sent as an authorization input.
 */
let creds = null;
let currentCampaignId = null;
let resumeInterval = null;
let statusRefreshInterval = null;
// Content templates loaded for the current channel (full objects from the API)
let loadedTemplates = [];

/**
 * The uploaded CSV, or null in manual mode.
 *
 * `raw` holds the parsed rows verbatim so the file can be re-interpreted when
 * the template changes — which column feeds which variable is a property of the
 * template, not the file, so switching templates must re-map rather than send
 * the previous mapping against new variables.
 */
let csvUpload = null;  // { fileName, raw, ...interpretCsv() result }

// The Recipients placeholder as authored in index.html, captured before the CSV
// state overwrites it so manual mode can be restored verbatim.
let recipientsPlaceholder = null;

// The campaign currently rendered in the delivery panel, so Export CSV can use it.
let displayedCampaign = null;

/**
 * A real Twilio message SID: two-letter prefix plus 32 hex. Sends Twilio
 * rejected outright never got one, so send-messages.js records them under a
 * synthetic "failed-<n>" key; this tells the two apart for display. Mirrors the
 * same constant in functions/check-status.js.
 */
const MESSAGE_SID = /^[A-Z]{2}[0-9a-f]{32}$/i;

// The 5s poll rebuilds whole panels with innerHTML, which destroys the scroll
// container and snaps the user back to the top. Two defences: skip the write
// entirely when nothing changed, and restore scrollTop when it did.
const renderSignatures = {};

/** True when this panel's data is unchanged since the last render. */
function renderUnchanged(key, signature, stillPresent) {
    if (renderSignatures[key] === signature && stillPresent) return true;
    renderSignatures[key] = signature;
    return false;
}

/** Runs `write`, keeping the scroll position of `selector` inside `container`. */
function withPreservedScroll(container, selector, write) {
    const before = container.querySelector(selector);
    const top = before ? before.scrollTop : 0;
    write();
    if (top) {
        const after = container.querySelector(selector);
        if (after) after.scrollTop = top;
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
});

function initializeApp() {
    // Restore the send-mode toggle before anything below can read it.
    // showAppScreen() triggers a sender fetch keyed on the mode, so if this
    // ran after that fetch started, a saved "bulk" mode could lose a race
    // against a "classic" fetch fired with the toggle still at its default.
    const sendModeSelect = document.getElementById('send-mode');
    if (sendModeSelect) {
        sendModeSelect.value = sessionStorage.getItem(MODE_KEY) || 'classic';
    }

    // Restore the session if this tab already holds credentials. They are not
    // re-verified here, so a rotated secret surfaces on the first action rather
    // than at page load.
    creds = loadCreds();
    if (creds) {
        showAppScreen();
    } else {
        showLoginScreen();
    }

    // Setup event listeners
    setupEventListeners();

    // Setup phone number select handler
    setupPhoneNumberHandlers();

    // Sync everything else that depends on the mode (hidden groups, the
    // Messenger option, help text) now that the toggle reflects it.
    applySendMode();
}

function setupPhoneNumberHandlers() {
    const phoneSelect = document.getElementById('from-number-select');
    const phoneInput = document.getElementById('from-number');
    
    if (phoneSelect && phoneInput) {
        phoneSelect.addEventListener('change', (e) => {
            if (e.target.value) {
                phoneInput.value = e.target.value;
            }
        });

        phoneInput.addEventListener('input', () => {
            if (phoneInput.value) {
                phoneSelect.value = '';
            }
        });
    }
}

// --- Send mode ---------------------------------------------------------
// The chosen API mode, kept beside the credentials in sessionStorage so a
// reload does not silently switch which API a campaign is sent through.
const MODE_KEY = 'twilio_messaging_ui_mode';

function getSendMode() {
    const select = document.getElementById('send-mode');
    if (select && select.value) return select.value;
    return sessionStorage.getItem(MODE_KEY) || 'classic';
}

function isBulkMode() {
    return getSendMode() === 'bulk';
}

/**
 * Applies everything that differs between the two modes.
 *
 * Messenger is hidden rather than disabled because the Bulk API has no
 * Messenger channel at all, and the send note is inverted: in bulk mode the
 * campaign runs on Twilio, so the tab does not have to stay open. That note is
 * the most visible difference between the modes and must not go stale.
 */
function applySendMode() {
    const bulk = isBulkMode();
    sessionStorage.setItem(MODE_KEY, getSendMode());

    document.querySelectorAll('.bulk-only').forEach((el) => {
        el.hidden = !bulk;
    });

    const channelSelect = document.getElementById('channel');
    const messengerOption = channelSelect
        ? channelSelect.querySelector('option[value="messenger"]')
        : null;
    if (messengerOption) {
        messengerOption.hidden = bulk;
        messengerOption.disabled = bulk;
        if (bulk && channelSelect.value === 'messenger') {
            channelSelect.value = 'sms';
            channelSelect.dispatchEvent(new Event('change'));
        }
    }

    const modeHelp = document.getElementById('send-mode-help');
    if (modeHelp) {
        modeHelp.textContent = bulk
            ? 'One request for up to 10,000 recipients, processed on Twilio.'
            : 'One message per recipient, driven from this tab.';
    }

    const sendNote = document.getElementById('send-note');
    // Shared with setSendingState() below so the idle wording can never drift
    // between the two call sites.
    if (sendNote) {
        sendNote.textContent = sendNoteIdleText();
    }

    updateFallbackAvailability();

    // Senders differ by mode: bulk cannot use a Messaging Service, so the list
    // must be refetched rather than filtered client-side. loadPhoneNumbers takes
    // the channel explicitly (assets/app.js:473).
    if (channelSelect && channelSelect.value) {
        loadPhoneNumbers(channelSelect.value);
    }
}

/** Fallback is WhatsApp-only; see the payload module for why RCS cannot use it. */
function updateFallbackAvailability() {
    const group = document.getElementById('fallback-group');
    const checkbox = document.getElementById('fallback-to-sms');
    if (!group || !checkbox) return;

    const channel = document.getElementById('channel');
    const available = isBulkMode() && channel && channel.value === 'whatsapp';

    group.hidden = !available;
    if (!available) checkbox.checked = false;
}

// --- Credentials -----------------------------------------------------------
// sessionStorage rather than localStorage: an OAuth Client Secret should not
// outlive the tab or persist to disk. It is still readable by JavaScript on
// this origin — see docs/superpowers/specs/2026-08-07-oauth-login-design.md
// § Security properties.

function loadCreds() {
    try {
        const raw = sessionStorage.getItem(CREDS_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        // Validated on clientId/clientSecret only. A blob stored before this
        // change also carries accountSid (then typed, now derived) and stays
        // valid — it is not rejected for having an extra field.
        if (parsed && parsed.clientId && parsed.clientSecret) {
            return parsed;
        }
    } catch (error) {
        console.warn('Discarding unreadable stored credentials:', error);
    }
    sessionStorage.removeItem(CREDS_KEY);
    return null;
}

function saveCreds(next) {
    creds = next;
    sessionStorage.setItem(CREDS_KEY, JSON.stringify(next));
}

function clearCreds() {
    creds = null;
    sessionStorage.removeItem(CREDS_KEY);
}

/**
 * Calls a Function with the credentials in the JSON body. Never a query string:
 * a Client Secret there would be recorded in request logs and browser history.
 *
 * `creds` includes `accountSid` (stored for display — see the `creds` comment
 * above). Spreading it here is harmless: the Functions derive their own SID
 * from the token and ignore any accountSid in the body. Not an input.
 */
async function postToFunction(path, body = {}) {
    return fetch(`${FUNCTIONS_BASE_URL}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...creds, ...body })
    });
}

function setupEventListeners() {
    // Login form
    document.getElementById('login-form').addEventListener('submit', handleLogin);

    // Logout
    document.getElementById('logout-btn').addEventListener('click', handleLogout);

    // Message form
    document.getElementById('message-form').addEventListener('submit', handleSendMessages);

    // Channel change handler to load content templates
    document.getElementById('channel').addEventListener('change', handleChannelChange);

    // Send-mode toggle: restore whatever was last chosen, then react to changes.
    const sendModeSelect = document.getElementById('send-mode');
    if (sendModeSelect) {
        sendModeSelect.value = sessionStorage.getItem(MODE_KEY) || 'classic';
        sendModeSelect.addEventListener('change', applySendMode);
    }

    // Re-render the template list when the status filter changes
    document.getElementById('template-status-filter').addEventListener('change', renderTemplateOptions);

    // Show preview + variable inputs when a template is selected
    document.getElementById('content-template').addEventListener('change', handleTemplateSelect);

    // Refresh campaigns button
    const refreshCampaignsBtn = document.getElementById('refresh-campaigns-btn');
    if (refreshCampaignsBtn) {
        refreshCampaignsBtn.addEventListener('click', loadCampaigns);
    }

    // Close message details button
    const closeMessageDetailsBtn = document.getElementById('close-message-details-btn');
    if (closeMessageDetailsBtn) {
        closeMessageDetailsBtn.addEventListener('click', () => {
            document.getElementById('message-details-section').style.display = 'none';
        });
    }

    // Export the delivery status table to CSV
    const exportCsvBtn = document.getElementById('export-csv-btn');
    if (exportCsvBtn) {
        exportCsvBtn.addEventListener('click', exportMessageStatusCsv);
    }

    // CSV recipient upload
    document.getElementById('csv-file').addEventListener('change', handleCsvFile);
    document.getElementById('csv-sample-btn').addEventListener('click', downloadSampleCsv);
    document.getElementById('csv-clear-btn').addEventListener('click', clearCsvUpload);
}

/** Read the chosen file, interpret it against the current template, and report. */
async function handleCsvFile(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    try {
        const raw = parseCsv(await file.text());
        csvUpload = { fileName: file.name, raw, ...interpretCsv(raw, selectedTemplate()) };
    } catch (error) {
        console.error('Error reading CSV:', error);
        csvUpload = { fileName: file.name, raw: [], rows: [], total: 0, skipped: [], warnings: [],
            error: `Could not read that file: ${error.message}` };
    }

    // Reset the input so re-picking the same filename fires `change` again.
    event.target.value = '';
    renderCsvState();
}

/** Re-map an already-loaded file after the template or channel changed. */
function reinterpretCsv() {
    if (!csvUpload) return;
    csvUpload = { fileName: csvUpload.fileName, raw: csvUpload.raw,
        ...interpretCsv(csvUpload.raw, selectedTemplate()) };
    renderCsvState();
}

function clearCsvUpload() {
    csvUpload = null;
    renderCsvState();
}

/** The currently selected template object, or null. */
function selectedTemplate() {
    const sid = document.getElementById('content-template').value;
    return sid ? loadedTemplates.find(t => t.sid === sid) || null : null;
}

/** True when a CSV is loaded and usable, so it should drive the send. */
function csvIsActive() {
    return Boolean(csvUpload && !csvUpload.error && csvUpload.rows.length);
}

/**
 * Paint the summary panel and mark the inputs the CSV has superseded. The
 * textarea keeps its `required` attribute only in manual mode, or the browser
 * would block submit on an empty field the user was told to ignore.
 */
function renderCsvState() {
    const summary = document.getElementById('csv-summary');
    const clearBtn = document.getElementById('csv-clear-btn');
    const recipients = document.getElementById('recipients');
    const recipientsHelp = document.getElementById('recipients-help');
    const variables = document.getElementById('template-variables');

    const active = csvIsActive();

    clearBtn.hidden = !csvUpload;
    recipients.disabled = active;
    recipients.classList.toggle('csv-overridden', active);
    if (active) recipients.removeAttribute('required');
    else recipients.setAttribute('required', 'required');

    // A dimmed empty box reads as broken rather than superseded, so say what is
    // standing in for it. Stashed on first use so the original is restorable.
    if (recipientsPlaceholder === null) recipientsPlaceholder = recipients.placeholder;
    recipients.placeholder = active
        ? `Using ${csvUpload.fileName} — ${csvUpload.rows.length} recipient${csvUpload.rows.length === 1 ? '' : 's'}`
        : recipientsPlaceholder;

    recipientsHelp.textContent = active
        ? `Taken from ${csvUpload.fileName} — clear the CSV to type recipients instead.`
        : 'Enter numbers in E.164 format (+6512345678), one per line or comma-separated';

    // Variable inputs only matter in variables mode; a Body-mode CSV leaves them alone.
    const overrideVars = active && csvUpload.mode === 'variables';
    if (variables) {
        variables.classList.toggle('csv-overridden', overrideVars);
        variables.querySelectorAll('.template-variable-input')
            .forEach(input => { input.disabled = overrideVars; });
    }

    if (!csvUpload) {
        summary.hidden = true;
        summary.innerHTML = '';
        updateMessageBodyRequirement();
        return;
    }

    summary.hidden = false;
    summary.className = 'csv-summary'
        + (csvUpload.error ? ' csv-summary--error'
            : (csvUpload.skipped.length || csvUpload.warnings.length) ? ' csv-summary--warn' : '');

    const parts = [`<span class="csv-summary__file">${escapeHtml(csvUpload.fileName)}</span>`];

    if (csvUpload.error) {
        parts.push(` — ${escapeHtml(csvUpload.error)}`);
    } else {
        const n = csvUpload.rows.length;
        parts.push(` <span class="csv-summary__count">— ${n} of ${csvUpload.total} row${csvUpload.total === 1 ? '' : 's'} loaded`
            + `, sending ${csvUpload.mode === 'variables' ? 'template variables' : 'a message body'} per recipient.</span>`);

        if (csvUpload.mode === 'variables' && csvUpload.columns.length) {
            parts.push(`<div class="csv-summary__map">${csvUpload.columns
                .map(c => escapeHtml(`{{${c.key}}}`)).join('  ·  ')}</div>`);
        }

        if (csvUpload.skipped.length) {
            const shown = csvUpload.skipped.slice(0, 10);
            const rest = csvUpload.skipped.length - shown.length;
            parts.push(`<ul class="csv-summary__list">${shown
                .map(s => `<li>Line ${s.line} skipped — ${escapeHtml(s.reason)}</li>`).join('')
                }${rest > 0 ? `<li>and ${rest} more</li>` : ''}</ul>`);
        }

        if (csvUpload.warnings.length) {
            parts.push(`<ul class="csv-summary__list">${csvUpload.warnings
                .map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`);
        }
    }

    summary.innerHTML = parts.join('');
    updateMessageBodyRequirement();
}

/**
 * A blank CSV the user fills in. Columns come from the selected template's own
 * variables, so the header always matches what the send expects, and the two
 * example rows are seeded from the template's sample values where it has them.
 */
function downloadSampleCsv() {
    const template = selectedTemplate();
    // Valid E.164, matching the Recipients placeholder: leading +, country code,
    // no spaces or punctuation. The previous examples were malformed — +1 with
    // nine digits, and one with a leading zero after the + — so copying the
    // shape from the sample produced numbers Twilio would reject.
    const numbers = ['+6512345678', '+6598765432'];
    let rows;

    if (template) {
        const vars = extractVariables(template);
        if (!vars.length) {
            rows = numbers.map(Number_ => ({ Number: Number_ }));
        } else {
            const samples = template.variables || {};
            // Row 1 shows the template's own sample values so the expected kind
            // of content is obvious; row 2 is left as visible fill-in slots. Two
            // rows that differ are the point — they demonstrate that these vary
            // per recipient, which two identical rows would not.
            rows = numbers.map((num, i) => {
                const row = { Number: num };
                vars.forEach(({ key }) => {
                    const sample = samples[key] != null ? String(samples[key]) : '';
                    row[`{{${key}}}`] = i === 0 && sample ? sample : `<your {{${key}}} here>`;
                });
                return row;
            });
        }
    } else {
        rows = numbers.map((num, i) => ({ Number: num, Body: `Your message for recipient ${i + 1}` }));
    }

    const label = template
        ? (template.friendlyName || 'template').replace(/[^a-z0-9._-]+/gi, '-').slice(0, 40)
        : 'message-body';
    downloadCsv(toCsv(rows), `sample-recipients-${label}.csv`);
}

async function handleLogin(e) {
    e.preventDefault();
    const errorDiv = document.getElementById('login-error');
    const loginBtn = document.getElementById('login-btn');
    errorDiv.classList.remove('show');
    errorDiv.textContent = '';

    const candidate = {
        clientId: document.getElementById('client-id').value.trim(),
        clientSecret: document.getElementById('client-secret').value.trim()
    };

    loginBtn.disabled = true;
    loginBtn.textContent = 'Signing in…';

    try {
        const response = await fetch(`${FUNCTIONS_BASE_URL}/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(candidate)
        });

        // /verify answers HTTP 200 with valid:false for a credential rejection, so
        // "rejected" is told apart from "transport failed" by `valid`, not by status.
        //
        // Parse defensively though: a platform-level failure returns an HTML error
        // page, and calling .json() on that throws a SyntaxError whose message
        // ("Unexpected token '<'…") is useless on a login screen. Substitute
        // something a user can act on.
        let data;
        try {
            data = await response.json();
        } catch {
            throw new Error(
                `Sign-in failed unexpectedly (HTTP ${response.status}). Try again.`
            );
        }

        if (!data.valid) {
            throw new Error(data.error || 'Verification failed.');
        }

        // /verify derives the Account SID from the access token and returns it.
        // Store it alongside the credentials for display, but it is never sent
        // as an authorization input — see the `creds` comment above.
        saveCreds({ ...candidate, accountSid: data.accountSid });
        // Blank the form now rather than waiting for sign-out, so the Client Secret
        // does not sit in a DOM input for the life of the tab.
        document.getElementById('login-form').reset();
        showAppScreen();
    } catch (error) {
        errorDiv.textContent = error.message;
        errorDiv.classList.add('show');
    } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = 'Sign In';
    }
}

function handleLogout() {
    clearCreds();
    currentCampaignId = null;
    if (resumeInterval) {
        clearInterval(resumeInterval);
        resumeInterval = null;
    }
    if (statusRefreshInterval) {
        clearInterval(statusRefreshInterval);
        statusRefreshInterval = null;
    }
    showLoginScreen();
}

function showLoginScreen() {
    document.getElementById('app-screen').classList.remove('active');
    document.getElementById('login-screen').classList.add('active');
    // Clear the form so the Client Secret is not left sitting in a DOM node.
    document.getElementById('login-form').reset();
    const indicator = document.getElementById('account-indicator');
    if (indicator) indicator.textContent = '';
}

function showAppScreen() {
    document.getElementById('login-screen').classList.remove('active');
    document.getElementById('app-screen').classList.add('active');
    // Show which account is signed in, only when known (derived by /verify).
    const indicator = document.getElementById('account-indicator');
    if (indicator) {
        indicator.textContent = creds && creds.accountSid ? `Account ${creds.accountSid}` : '';
    }
    // handleChannelChange() loads the senders for the current channel, so there is
    // no separate loadPhoneNumbers() call here. Calling both would fire two
    // identical requests, each paying its own OAuth token exchange.
    handleChannelChange();
    // Load campaigns list
    loadCampaigns();
    // Start auto-refresh for current campaign if exists
    startStatusAutoRefresh();
}

async function loadPhoneNumbers(channel) {
    if (!creds) return;

    const select = document.getElementById('from-number-select');
    const ch = channel || document.getElementById('channel').value || 'sms';

    select.innerHTML = '<option value="">Loading senders…</option>';

    try {
        const response = await postToFunction('get-phone-numbers', {
            channel: ch,
            mode: getSendMode(),
        });
        const data = await response.json();

        if (!response.ok || !data.success) {
            throw new Error(data.error || 'Could not load senders.');
        }

        renderSenderOptions(data);
    } catch (error) {
        console.error('Error loading senders:', error);
        select.innerHTML = '<option value="">Could not load senders</option>';
        setSenderHelp(`Could not load senders — ${error.message}`, true);
    }
}

const CHANNEL_SENDER_NOUN = {
    sms: 'SMS-capable number',
    mms: 'MMS-capable number',
    whatsapp: 'WhatsApp sender',
    rcs: 'RCS agent',
    messenger: 'Messaging Service',
};

// "an SMS", "an MMS", "an RCS" — the article follows how the acronym is spoken,
// which can't be derived from its first letter.
const CHANNEL_SENDER_ARTICLE = {
    sms: 'an',
    mms: 'an',
    rcs: 'an',
    whatsapp: 'a',
    messenger: 'a',
};

// Channels whose senders can carry a Content template. Messenger is absent
// because its templates are governed by Facebook, not the Content API.
const CONTENT_TEMPLATE_CHANNELS = ['sms', 'mms', 'whatsapp', 'rcs'];

// Per-channel help under the template picker. SMS and MMS each get their own
// line because their lists are deliberately narrower than the account's full
// template set, which otherwise reads as a loading failure.
const CHANNEL_TEMPLATE_HELP = {
    sms: 'Only templates with a text type are listed — SMS cannot carry media, cards or buttons.',
    mms: 'Only templates with a media type are listed — a text-only template has no media for MMS to send.',
};

/**
 * Idle copy differs by mode. applySendMode() writes this same text into the
 * DOM whenever the mode changes; setSendingState() below recomputes it from
 * the mode rather than caching the DOM text the way it used to, because a
 * cached value would go stale the first time a campaign is sent in one mode,
 * the mode is switched, and a second campaign is sent in the other — the
 * cache would still hold the first mode's wording.
 */
function sendNoteIdleText() {
    return isBulkMode()
        ? 'Sending continues on Twilio once submitted — you can close this tab.'
        : 'Keep this tab open while sending — the campaign is driven from your browser, not from Twilio.';
}

const SEND_NOTE_ACTIVE = 'Sending — keep this tab open. Closing it stops the campaign, '
    + 'though progress is saved and you can resume from Campaigns.';

// Bulk has no chunk loop and no client-driven checkpoint to lose, so the
// in-flight note only needs to cover the brief window of the single request.
const SEND_NOTE_ACTIVE_BULK = 'Submitting to Twilio…';

/**
 * Single owner of the Send button's state, and of the advisory beneath it.
 *
 * The chunk loop lives in sendMessagesBatch() in this file, not on the server:
 * each round trip sends what fits in one 9-second Function invocation and the
 * browser initiates the next. Credentials live only in sessionStorage, so
 * nothing server-side could continue the campaign on its own. Closing the tab
 * therefore halts sending — hence the promotion to a warning while in flight.
 *
 * In bulk mode there is no such risk — Twilio owns the campaign once
 * submitted — so the active note is the short "submitting" message instead.
 */
function setSendingState(sending) {
    const btn = document.getElementById('send-btn');
    if (btn) {
        btn.disabled = sending;
        btn.textContent = sending ? 'Sending...' : 'Send Messages';
    }

    const note = document.getElementById('send-note');
    if (!note) return;
    note.textContent = sending
        ? (isBulkMode() ? SEND_NOTE_ACTIVE_BULK : SEND_NOTE_ACTIVE)
        : sendNoteIdleText();
    note.classList.toggle('send-note--active', sending);
}

function setSenderHelp(text, isProblem) {
    const help = document.getElementById('from-number-help');
    if (!help) return;
    help.textContent = text;
    help.classList.toggle('field-help--problem', Boolean(isProblem));
}

function renderSenderOptions(data) {
    const select = document.getElementById('from-number-select');
    const noun = CHANNEL_SENDER_NOUN[data.channel] || 'sender';
    const article = CHANNEL_SENDER_ARTICLE[data.channel] || 'a';
    const senders = Array.isArray(data.senders) ? data.senders : [];

    select.innerHTML = '';

    if (!senders.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.disabled = true;
        // Distinguish "none exist" from "some exist but none usable" — the
        // second is a fixable configuration problem and should say so. Now that
        // Messaging Services are offered on every channel, "none" also means no
        // services exist on the account.
        opt.textContent = data.totalRegistered
            ? `No usable ${noun}s — ${data.totalRegistered} registered but not online`
            : `No ${noun}s or Messaging Services registered on this account`;
        select.appendChild(opt);
        setSenderHelp(opt.textContent, true);
        return;
    }

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = `Select ${article} ${noun}…`;
    select.appendChild(placeholder);

    const direct = senders.filter((s) => s.kind !== 'service');
    const services = senders.filter((s) => s.kind === 'service');

    const addGroup = (labelText, items) => {
        if (!items.length) return;
        const group = document.createElement('optgroup');
        group.label = labelText;
        for (const sender of items) {
            const opt = document.createElement('option');
            opt.value = sender.value;
            opt.textContent = sender.label;
            group.appendChild(opt);
        }
        select.appendChild(group);
    };

    addGroup(`${noun.replace(/^./, (c) => c.toUpperCase())}s`, direct);
    addGroup('Messaging Services', services);

    const parts = [];
    if (data.directCount) parts.push(`${data.directCount} ${noun}${data.directCount === 1 ? '' : 's'}`);
    if (data.serviceCount) parts.push(`${data.serviceCount} Messaging Service${data.serviceCount === 1 ? '' : 's'}`);
    const hidden = (data.totalRegistered || 0) - (data.directCount || 0);
    setSenderHelp(
        parts.join(' · ') + (hidden > 0 ? ` · ${hidden} not online` : ''),
        false
    );
}

async function handleChannelChange() {
    if (!creds) return;

    const channel = document.getElementById('channel').value;
    // The sender list is channel-specific — a WhatsApp sender is not a phone number.
    loadPhoneNumbers(channel);
    // The fallback checkbox is WhatsApp-only in bulk mode; re-evaluate on every
    // channel switch so it does not stay visible (or checked) for a channel it
    // no longer applies to.
    updateFallbackAvailability();
    const contentTemplateGroup = document.getElementById('content-template-group');
    const contentTemplateSelect = document.getElementById('content-template');
    const contentTemplateHelp = document.getElementById('content-template-help');
    const filterRow = document.getElementById('template-filter-row');

    // Reset previous template state
    loadedTemplates = [];
    clearTemplateDetails();
    filterRow.style.display = 'none';

    // Show/hide content template based on channel support
    const supportsContentTemplates = CONTENT_TEMPLATE_CHANNELS.includes(channel);

    if (!supportsContentTemplates) {
        contentTemplateGroup.style.display = 'none';
        contentTemplateHelp.style.display = 'none';
        contentTemplateSelect.value = '';
        updateMessageBodyRequirement();
        return;
    }

    contentTemplateGroup.style.display = 'block';
    contentTemplateHelp.style.display = 'block';
    contentTemplateSelect.innerHTML = '<option value="">Loading templates…</option>';

    // Load content templates for this channel
    try {
        const response = await postToFunction('get-content-templates', { channel });
        const data = await response.json();

        if (response.ok && data.success !== false) {
            loadedTemplates = Array.isArray(data.templates) ? data.templates : [];

            if (loadedTemplates.length > 0) {
                populateStatusFilter(loadedTemplates);
                filterRow.style.display = 'flex';
            }
            renderTemplateOptions();

            // Show error/help message
            if (data.error) {
                console.warn('Content templates warning:', data.error);
                contentTemplateHelp.textContent = `Warning: ${data.error}`;
                contentTemplateHelp.style.color = '#ff9800';
            } else {
                contentTemplateHelp.textContent =
                    CHANNEL_TEMPLATE_HELP[channel] || 'Select a content template';
                contentTemplateHelp.style.color = '';
            }
        } else {
            const errorMsg = data.error || data.message || 'Failed to load templates';
            console.error('Error loading content templates:', errorMsg);
            contentTemplateSelect.innerHTML = '<option value="">None (Use custom message)</option>';
            const option = document.createElement('option');
            option.value = '';
            option.disabled = true;
            option.textContent = `Error: ${errorMsg}`;
            contentTemplateSelect.appendChild(option);
            contentTemplateHelp.textContent = `Error: ${errorMsg}`;
            contentTemplateHelp.style.color = '#d32f2f';
        }
    } catch (error) {
        console.error('Error loading content templates:', error);
        contentTemplateSelect.innerHTML = '<option value="">None (Use custom message)</option>';
        const errorOption = document.createElement('option');
        errorOption.value = '';
        errorOption.disabled = true;
        errorOption.textContent = `Error: ${error.message}`;
        contentTemplateSelect.appendChild(errorOption);
        contentTemplateHelp.textContent = `Error loading templates: ${error.message}`;
        contentTemplateHelp.style.color = '#d32f2f';
    }

    updateMessageBodyRequirement();
    // The channel switch may have changed the template selection out from under
    // a loaded CSV, so re-map it against whatever is selected now.
    reinterpretCsv();
}

// Populate the status filter dropdown with the distinct statuses present in the
// loaded templates (plus a leading "All" option). Default selection is "All".
function populateStatusFilter(templates) {
    const filter = document.getElementById('template-status-filter');
    const statuses = [...new Set(templates.map(t => (t.status || 'unknown')))].sort();

    filter.innerHTML = '<option value="all">All</option>';
    statuses.forEach(status => {
        const count = templates.filter(t => (t.status || 'unknown') === status).length;
        const option = document.createElement('option');
        option.value = status;
        option.textContent = `${status} (${count})`;
        filter.appendChild(option);
    });
    filter.value = 'all';
}

// Rebuild the template <select> from loadedTemplates, applying the status filter.
function renderTemplateOptions() {
    const contentTemplateSelect = document.getElementById('content-template');
    const statusFilter = document.getElementById('template-status-filter').value || 'all';

    // Reset selection + any preview/variable UI
    contentTemplateSelect.innerHTML = '<option value="">None (Use custom message)</option>';
    clearTemplateDetails();

    const visible = statusFilter === 'all'
        ? loadedTemplates
        : loadedTemplates.filter(t => (t.status || 'unknown') === statusFilter);

    if (visible.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.disabled = true;
        option.textContent = loadedTemplates.length === 0
            ? 'No templates available'
            : 'No templates match this filter';
        contentTemplateSelect.appendChild(option);
        updateMessageBodyRequirement();
        return;
    }

    visible.forEach(template => {
        const option = document.createElement('option');
        option.value = template.sid;
        const statusText = template.status ? ` [${template.status}]` : '';
        option.textContent = `${template.friendlyName} (${template.language})${statusText}`;
        option.dataset.templateSid = template.sid;
        contentTemplateSelect.appendChild(option);
    });

    updateMessageBodyRequirement();
}

// Toggle the Message Body required attribute + help text depending on whether a
// content template is currently selected.
function updateMessageBodyRequirement() {
    const messageBody = document.getElementById('message-body');
    const messageBodyHelp = document.getElementById('message-body-help');
    const templateSelected = !!document.getElementById('content-template').value;
    // A Body-mode CSV carries the text per recipient, so the single field is
    // then only a fallback for rows whose own cell is blank.
    const csvSuppliesBody = csvIsActive() && csvUpload.mode === 'body';

    if (templateSelected) {
        messageBody.removeAttribute('required');
        messageBodyHelp.textContent = 'Optional when using a content template';
    } else if (csvSuppliesBody) {
        messageBody.removeAttribute('required');
        messageBodyHelp.textContent = 'Taken per recipient from the CSV; used as a fallback for blank cells';
    } else {
        messageBody.setAttribute('required', 'required');
        messageBodyHelp.textContent = 'Required if no content template is selected';
    }
}

// Hide + empty the preview and variable-input containers.
function clearTemplateDetails() {
    const preview = document.getElementById('template-preview');
    const variables = document.getElementById('template-variables');
    const fields = document.getElementById('template-variables-fields');
    if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }
    if (variables) { variables.style.display = 'none'; }
    if (fields) { fields.innerHTML = ''; }
}

// Called when the user picks a template: render a preview of its content and,
// if it has {{n}} placeholders, generate an input field per variable.
function handleTemplateSelect() {
    updateMessageBodyRequirement();
    clearTemplateDetails();

    const template = selectedTemplate();
    if (template) {
        renderTemplatePreview(template);
        renderTemplateVariableInputs(template);
    }

    // Which column feeds which variable depends on the template, so an already
    // loaded CSV is re-mapped here rather than sent against the old mapping.
    // This runs after the variable inputs are rebuilt, because renderCsvState
    // disables them and the rebuild would otherwise discard that.
    reinterpretCsv();
}

// Build a readable preview from a template's `types` object.
function renderTemplatePreview(template) {
    const preview = document.getElementById('template-preview');
    const types = template.types || {};
    const parts = [];

    Object.keys(types).forEach(typeKey => {
        const content = types[typeKey] || {};
        const label = typeKey.replace('twilio/', '');
        let text = '';

        if (content.title) text += `${content.title}\n`;
        if (content.body) text += content.body;
        if (content.media && Array.isArray(content.media) && content.media.length) {
            text += `${text ? '\n' : ''}📎 Media: ${content.media.join(', ')}`;
        }

        // Buttons / actions (quick-reply, call-to-action, list-picker)
        if (Array.isArray(content.actions) && content.actions.length) {
            const buttons = content.actions.map(a => `[ ${a.title || a.id || 'button'} ]`).join(' ');
            text += `${text ? '\n' : ''}${buttons}`;
        }

        parts.push({ label, text: text || '(no text content)' });
    });

    if (parts.length === 0) {
        preview.style.display = 'none';
        return;
    }

    const html = parts.map(p => `
        <div class="preview-block">
            <span class="preview-type">${escapeHtml(p.label)}</span>
            <div class="preview-body">${escapeHtml(p.text)}</div>
        </div>
    `).join('');

    preview.innerHTML = `<div class="preview-heading">Preview</div>${html}`;
    preview.style.display = 'block';
}

// Detect {{n}} placeholders across all content types and render an input per
// unique variable, seeded with the template's sample value when available.
function renderTemplateVariableInputs(template) {
    const container = document.getElementById('template-variables');
    const fields = document.getElementById('template-variables-fields');

    const vars = extractVariables(template);
    if (vars.length === 0) {
        container.style.display = 'none';
        return;
    }

    const samples = template.variables || {};
    fields.innerHTML = vars.map(({ key, kind }) => {
        const sample = samples[key] != null ? String(samples[key]) : '';
        const safeKey = escapeHtml(key);

        let inputType = 'text';
        let hint = '';
        let tag = '';
        let placeholder;

        if (kind === 'mediaUrl') {
            inputType = 'url';
            tag = '<span class="var-tag">media URL</span>';
            hint = 'Enter a full, publicly reachable URL (https://…) to the media file.';
            placeholder = sample || 'https://example.com/image.jpg';
        } else if (kind === 'mediaPart') {
            tag = '<span class="var-tag">media</span>';
            hint = 'This value is inserted into a media URL — enter only the URL fragment.';
            placeholder = sample ? `e.g. ${sample}` : `Value for {{${key}}}`;
        } else {
            placeholder = sample ? `e.g. ${sample}` : `Enter value for {{${key}}}`;
        }

        return `
            <div class="variable-field">
                <label for="tpl-var-${safeKey}">Variable {{${safeKey}}}${tag}</label>
                <input type="${inputType}" id="tpl-var-${safeKey}" class="template-variable-input"
                       data-var-key="${safeKey}"
                       placeholder="${escapeHtml(placeholder)}"
                       value="${escapeHtml(sample)}">
                ${hint ? `<small class="variable-hint">${escapeHtml(hint)}</small>` : ''}
            </div>
        `;
    }).join('');

    container.style.display = 'block';
}

// Detect every {{n}} placeholder in a template and classify each by context:
//   'mediaUrl'  – the placeholder is the entire value of a media entry, so the
//                 user must supply a full, publicly reachable URL.
//   'mediaPart' – the placeholder is embedded inside a larger media URL string.
//   'text'      – anything else (body copy, titles, button labels, …).
// Returns [{ key, kind }] sorted numerically then lexically.
function extractVariables(template) {
    const types = template.types || {};
    const placeholder = /\{\{\s*([\w.-]+)\s*\}\}/g;

    // 1. All placeholder keys anywhere in the template.
    const all = new Set();
    const scan = (value) => {
        if (typeof value === 'string') {
            for (const match of value.matchAll(placeholder)) {
                all.add(match[1]);
            }
        } else if (Array.isArray(value)) {
            value.forEach(scan);
        } else if (value && typeof value === 'object') {
            Object.values(value).forEach(scan);
        }
    };
    scan(types);

    // 2. Classify placeholders that live in media URL fields.
    const mediaStrings = [];
    collectMediaStrings(types, mediaStrings);

    const fullUrlKeys = new Set();  // media entry is exactly "{{n}}"
    const partUrlKeys = new Set();  // placeholder embedded in a larger URL
    const standalone = /^\s*\{\{\s*[\w.-]+\s*\}\}\s*$/;
    mediaStrings.forEach(str => {
        const matches = [...str.matchAll(placeholder)];
        if (matches.length === 0) return;
        const isStandalone = standalone.test(str);
        matches.forEach(m => (isStandalone ? fullUrlKeys : partUrlKeys).add(m[1]));
    });

    return [...all]
        .sort((a, b) => {
            const na = Number(a), nb = Number(b);
            if (!isNaN(na) && !isNaN(nb)) return na - nb;
            return String(a).localeCompare(String(b));
        })
        .map(key => {
            let kind = 'text';
            if (fullUrlKeys.has(key)) kind = 'mediaUrl';
            else if (partUrlKeys.has(key)) kind = 'mediaPart';
            return { key, kind };
        });
}

// Walk a template's `types` and collect all strings found under any `media`
// key (media entries can be a single string or an array of strings, and can
// live nested inside cards / carousel cards).
function collectMediaStrings(obj, acc) {
    if (!obj || typeof obj !== 'object') return;
    for (const [key, value] of Object.entries(obj)) {
        if (key === 'media') {
            const push = (x) => {
                if (typeof x === 'string') acc.push(x);
                else if (Array.isArray(x)) x.forEach(push);
            };
            push(value);
        } else if (Array.isArray(value)) {
            value.forEach(item => collectMediaStrings(item, acc));
        } else if (value && typeof value === 'object') {
            collectMediaStrings(value, acc);
        }
    }
}

// Read the current variable input values into a { key: value } map, or return
// null if no template variables are present.
function getSelectedContentVariables() {
    const inputs = document.querySelectorAll('.template-variable-input');
    if (inputs.length === 0) return null;

    const vars = {};
    inputs.forEach(input => {
        vars[input.dataset.varKey] = input.value;
    });
    return vars;
}

// Minimal HTML escaping for user/template-supplied strings injected into markup.
function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}


/**
 * Build one entry of the `messages` array the Functions consume.
 *
 * `row` is { to, body?, contentVariables? } — a bare { to } for a typed
 * recipient, or a CSV row carrying its own text or variables. Row values take
 * precedence; the form values fall through for anything the row omits.
 *
 * Only WhatsApp is prefixed here. The other channels' prefixing happens
 * server-side in send-messages.js, which also resolves a Messaging Service
 * sender, so duplicating either rule here would risk them drifting apart.
 */
function buildMessage(row, { channel, from, contentSid, body, contentVariables }) {
    const wa = (value) => (value.startsWith('whatsapp:') ? value : `whatsapp:${value}`);
    const message = {
        to: channel === 'whatsapp' ? wa(row.to) : row.to,
        from: channel === 'whatsapp' ? wa(from) : from
    };

    if (contentSid) {
        message.contentSid = contentSid;
        const vars = row.contentVariables || contentVariables;
        if (vars) message.contentVariables = vars;
    }

    const text = row.body || body;
    if (text) message.body = text;

    return message;
}

async function handleSendMessages(e) {
    e.preventDefault();
    
    setSendingState(true);

    const channel = document.getElementById('channel').value;
    const fromInput = document.getElementById('from-number');
    const fromSelect = document.getElementById('from-number-select');
    const from = fromSelect.value || fromInput.value.trim();
    const body = document.getElementById('message-body').value.trim();
    const recipientsText = document.getElementById('recipients').value.trim();
    const campaignName = document.getElementById('campaign-name').value.trim();
    const contentSid = document.getElementById('content-template').value;
    const contentVariables = contentSid ? getSelectedContentVariables() : null;

    const usingCsv = csvIsActive();

    // Validate from field
    if (!from) {
        alert('Please select a phone number or enter a Sender ID');
        setSendingState(false);
        return;
    }

    // A loaded-but-unusable CSV is reported before the generic checks below: it
    // is the actual blocker, and its message says what is wrong with the file.
    if (csvUpload && !usingCsv) {
        alert(csvUpload.error || 'The uploaded CSV has no usable rows. Fix it and re-upload, or clear it to type recipients instead.');
        setSendingState(false);
        return;
    }

    // Every message needs something to say: a template, a literal body, or —
    // with a CSV loaded — a per-row body from the file.
    if (!contentSid && !body && !usingCsv) {
        alert('Please enter a message body or select a content template');
        setSendingState(false);
        return;
    }

    // Parse recipients — from the CSV when one is loaded, else the textarea.
    const recipients = usingCsv
        ? csvUpload.rows
        : recipientsText.split(/[\n,]+/).map(r => r.trim()).filter(r => r.length > 0)
            .map(to => ({ to }));

    if (recipients.length === 0) {
        alert('Please enter at least one recipient');
        setSendingState(false);
        return;
    }

    // Format messages array. Per-recipient values from the CSV win over the
    // single form values, which then act as the fallback for whatever a row
    // does not carry.
    const messages = recipients.map(row => buildMessage(row, {
        channel, from, contentSid, body, contentVariables
    }));

    // Generate campaign ID
    currentCampaignId = `campaign_${Date.now()}`;

    try {
        if (isBulkMode()) {
            await sendBulkCampaign(messages, channel, from, campaignName);
        } else {
            await sendMessagesBatch(messages, channel, from, campaignName);
        }
    } catch (error) {
        alert('Error: ' + error.message);
        setSendingState(false);
    }
}

async function sendMessagesBatch(messages, channel, from, campaignName) {
    let resumeFrom = 0;
    let isComplete = false;

    while (!isComplete) {
        try {
            const response = await postToFunction('send-messages', {
                messages,
                campaignId: currentCampaignId,
                channel,
                from,
                resumeFrom,
                campaignName: campaignName || null
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to send messages');
            }

            resumeFrom = data.resumeFrom;
            isComplete = data.isComplete;

            // Update UI - fetch full campaign status to get delivery/read info
            await checkCampaignStatus();

            if (!isComplete) {
                // Wait a bit before resuming (to avoid hitting rate limits)
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        } catch (error) {
            console.error('Error sending messages:', error);
            
            // Show error but allow manual resume
            showResumeOption();
            throw error;
        }
    }

    // Final status check
    await checkCampaignStatus();
    
    // Reload campaigns list
    await loadCampaigns();
    
    // Start auto-refresh
    startStatusAutoRefresh();
    
    setSendingState(false);
}

/**
 * Submits a bulk campaign in a single request.
 *
 * No loop, and deliberately so: one operation covers 10,000 recipients and
 * Twilio processes it server-side, which is the whole reason this mode exists.
 * The `messages` array the classic path builds is reused as-is — each entry
 * already carries `to`, and optionally `body` and `variables`.
 */
async function sendBulkCampaign(messages, channel, from, campaignName) {
    const sendAtInput = document.getElementById('send-at');
    const fallbackInput = document.getElementById('fallback-to-sms');

    // datetime-local yields a value with no timezone ("2026-09-10T09:30"), which
    // the API would read as UTC. Converting through Date attaches the browser's
    // offset, so the user gets the time they actually picked.
    const sendAt = sendAtInput && sendAtInput.value
        ? new Date(sendAtInput.value).toISOString()
        : null;

    const first = messages[0] || {};

    const response = await postToFunction('send-bulk', {
        channel,
        from,
        body: document.getElementById('message-body').value || '',
        contentSid: first.contentSid || null,
        mediaUrl: first.mediaUrl || null,
        recipients: messages.map((message) => ({
            to: message.to,
            ...(message.body ? { body: message.body } : {}),
            ...(message.contentVariables
                ? { variables: typeof message.contentVariables === 'string'
                    ? JSON.parse(message.contentVariables)
                    : message.contentVariables }
                : {}),
        })),
        campaignName: campaignName || null,
        sendAt,
        fallbackToSms: Boolean(fallbackInput && fallbackInput.checked),
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || 'Failed to submit the bulk campaign');
    }

    currentCampaignId = data.campaignId;

    if (data.warning) alert(data.warning);
    if (data.partial) alert(data.error);

    if (currentCampaignId) {
        await checkBulkCampaignStatus();
        await loadCampaigns();
        startStatusAutoRefresh();
    }

    setSendingState(false);
    return data;
}

async function checkCampaignStatus() {
    if (!currentCampaignId || !creds) return;

    try {
        const response = await postToFunction('check-status', {
            campaignId: currentCampaignId
        });

        const data = await response.json();

        if (response.ok && data.campaign) {
            // Update message details if section is visible
            const messageDetailsSection = document.getElementById('message-details-section');
            if (messageDetailsSection && messageDetailsSection.style.display !== 'none') {
                displayMessageDetails(data.campaign);
            }
        }
    } catch (error) {
        console.error('Error checking status:', error);
    }
}


async function resumeCampaignById(campaignId, event) {
    if (!creds) {
        alert('Please sign in to resume campaigns');
        return;
    }

    // Show loading state
    const resumeBtn = event?.target;
    if (resumeBtn) {
        resumeBtn.disabled = true;
        resumeBtn.textContent = 'Resuming...';
    }

    try {
        // Fetch campaign details including messages
        const response = await postToFunction('check-status', { campaignId });
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Failed to fetch campaign details');
        }

        const campaign = data.campaign;
        
        // Check if campaign has resume data
        if (!campaign.messages || !campaign.channel || !campaign.from) {
            throw new Error('Campaign data is missing. Cannot resume this campaign.');
        }

        // Set current campaign ID
        currentCampaignId = campaignId;

        // Continue resuming until complete
        let isComplete = false;
        while (!isComplete) {
            const resumeResponse = await postToFunction('resume-execution', {
                campaignId: campaignId,
                messages: campaign.messages,
                channel: campaign.channel,
                from: campaign.from
            });

            const resumeData = await resumeResponse.json();

            if (!resumeResponse.ok) {
                throw new Error(resumeData.error || 'Failed to resume campaign');
            }

            isComplete = resumeData.isComplete;

            // Update UI
            await checkCampaignStatus();

            if (!isComplete) {
                // Wait a bit before resuming (to avoid hitting rate limits)
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        // Campaign completed
        await checkCampaignStatus();
        await loadCampaigns();
        startStatusAutoRefresh();

    } catch (error) {
        console.error('Error resuming campaign:', error);
        alert('Error resuming campaign: ' + error.message);
    } finally {
        // Restore button state
        if (resumeBtn) {
            resumeBtn.disabled = false;
            resumeBtn.textContent = 'Resume';
        }
    }
}

function showResumeOption() {
    // Show alert and refresh campaigns list to show resume option
    alert('Execution was interrupted. You can resume the campaign from the campaigns list.');
    loadCampaigns();
}

// resumeCampaignById is reached from an onclick in the campaign list markup.
window.resumeCampaignById = resumeCampaignById;

// Campaign listing functions
async function loadCampaigns() {
    if (!creds) return;

    const campaignsContent = document.getElementById('campaigns-content');
    if (!campaignsContent) return;

    try {
        const response = await postToFunction('list-campaigns');
        const data = await response.json();

        if (response.ok && data.campaigns) {
            displayCampaigns(data.campaigns);
        } else {
            campaignsContent.innerHTML = '<p style="color: #666; text-align: center; padding: 20px;">No campaigns found</p>';
        }
    } catch (error) {
        console.error('Error loading campaigns:', error);
        campaignsContent.innerHTML = '<p style="color: #d32f2f; text-align: center; padding: 20px;">Error loading campaigns</p>';
    }
}

function displayCampaigns(campaigns) {
    const campaignsContent = document.getElementById('campaigns-content');
    if (!campaignsContent) return;

    if (campaigns.length === 0) {
        campaignsContent.innerHTML = '<p style="color: #666; text-align: center; padding: 20px;">No campaigns found</p>';
        return;
    }

    const signature = JSON.stringify([
        currentCampaignId,
        campaigns.map((c) => [
            c.campaignId, c.campaignName, c.totalMessages, c.sent, c.failed,
            c.delivered, c.read, c.startIndex, c.isComplete, c.lastUpdated,
        ]),
    ]);
    // Nothing to redraw: leave the DOM alone so the user's scroll survives.
    if (renderUnchanged('campaigns', signature, Boolean(campaignsContent.querySelector('.campaigns-list')))) {
        return;
    }

    let html = '<div class="campaigns-list">';
    campaigns.forEach(campaign => {
        const isActive = campaign.campaignId === currentCampaignId;
        // Progress is how far through the recipient list we are, not a ratio of
        // send attempts — a resent chunk would otherwise push this past 100%.
        const processed = Number.isFinite(campaign.startIndex)
            ? campaign.startIndex
            : (campaign.sent || 0);
        const progress = campaign.totalMessages > 0
            ? Math.min(100, (processed / campaign.totalMessages) * 100).toFixed(1)
            : 0;
        // Total is the campaign's message count. That normally equals the number of
        // recipients, but a resent chunk creates more messages than recipients, and
        // the delivery table lists every one — so show the larger of the two. The
        // progress bar above deliberately keeps dividing by totalMessages, or a
        // finished campaign with a resend would read 60% instead of 100%.
        const messageCount = Math.max(campaign.totalMessages || 0, campaign.sent || 0);
        
        const createdDate = campaign.createdAt 
            ? new Date(campaign.createdAt).toLocaleString() 
            : 'Unknown';
        const lastUpdated = campaign.lastUpdated 
            ? new Date(campaign.lastUpdated).toLocaleString() 
            : 'Unknown';

        const canResume = !campaign.isComplete && campaign.startIndex < campaign.totalMessages;
        
        // Use campaign name if available, otherwise fall back to formatted timestamp
        const displayName = campaign.campaignName || 
            (campaign.createdAt ? new Date(campaign.createdAt).toLocaleString() : 
            campaign.campaignId.replace('campaign_', ''));
        
        html += `
            <div class="campaign-item ${isActive ? 'active' : ''}" onclick="viewCampaign('${campaign.campaignId}')">
                <div class="campaign-header">
                    <div class="campaign-id">${displayName}</div>
                    <div style="display: flex; gap: 8px; align-items: center;">
                        <div class="campaign-status-badge ${campaign.isComplete ? 'complete' : 'in-progress'}">
                            ${campaign.isComplete ? 'Complete' : 'In Progress'}
                        </div>
                        ${canResume ? `
                            <button class="btn-resume-campaign" onclick="event.stopPropagation(); resumeCampaignById('${campaign.campaignId}', event);" title="Resume sending messages">
                                Resume
                            </button>
                        ` : ''}
                    </div>
                </div>
                <div class="campaign-stats">
                    <div class="stat-item">
                        <span class="stat-label">Total:</span>
                        <span class="stat-value">${messageCount}</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">Sent:</span>
                        <span class="stat-value success">${campaign.sent}</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">Failed:</span>
                        <span class="stat-value failed">${campaign.failed}</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">Delivered:</span>
                        <span class="stat-value success">${campaign.delivered}</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">Read:</span>
                        <span class="stat-value">${campaign.read}</span>
                    </div>
                </div>
                <div class="campaign-progress">
                    <div class="progress-bar" style="width: 100%; height: 6px; background: #e0e0e0; border-radius: 3px; margin-top: 10px;">
                        <div class="progress-fill" style="width: ${progress}%; height: 100%; background: #4caf50; border-radius: 3px;"></div>
                    </div>
                    <div style="font-size: 12px; color: #666; margin-top: 5px;">
                        ${progress}% complete
                    </div>
                </div>
                <div class="campaign-meta" style="font-size: 11px; color: #999; margin-top: 8px;">
                    Created: ${createdDate} | Updated: ${lastUpdated}
                </div>
            </div>
        `;
    });
    html += '</div>';
    withPreservedScroll(campaignsContent, '.campaigns-list', () => {
        campaignsContent.innerHTML = html;
    });
}

async function viewCampaign(campaignId) {
    currentCampaignId = campaignId;
    
    // Show message details section
    const messageDetailsSection = document.getElementById('message-details-section');
    if (messageDetailsSection) {
        messageDetailsSection.style.display = 'block';
        document.getElementById('message-details-content').innerHTML = '<p style="color: #666; text-align: center; padding: 20px;">Loading message details...</p>';
    }
    
    // Fetch and display detailed campaign status
    await fetchAndDisplayCampaignDetails(campaignId);
    await loadCampaigns(); // Refresh list to highlight active campaign
    startStatusAutoRefresh();
}

async function fetchAndDisplayCampaignDetails(campaignId) {
    if (!creds) return;

    try {
        const response = await postToFunction('check-status', { campaignId });

        const data = await response.json();

        if (response.ok && data.campaign) {
            displayMessageDetails(data.campaign);
        } else {
            document.getElementById('message-details-content').innerHTML = 
                '<p style="color: #d32f2f; text-align: center; padding: 20px;">Error loading message details</p>';
        }
    } catch (error) {
        console.error('Error fetching campaign details:', error);
        document.getElementById('message-details-content').innerHTML = 
            '<p style="color: #d32f2f; text-align: center; padding: 20px;">Error loading message details</p>';
    }
}

function displayMessageDetails(campaign) {
    const messageDetailsContent = document.getElementById('message-details-content');
    if (!messageDetailsContent) return;

    // Set before any early return: the export must work even on a poll tick
    // that correctly skips redrawing because nothing changed.
    displayedCampaign = campaign;

    const statuses = campaign.statuses || {};
    const statusEntries = Object.entries(statuses);

    if (statusEntries.length === 0) {
        messageDetailsContent.innerHTML = '<p style="color: #666; text-align: center; padding: 20px;">No messages sent yet. Messages will appear here once they are successfully sent.</p>';
        return;
    }

    // Sort by sentAt date (most recent first)
    statusEntries.sort((a, b) => {
        const dateA = a[1].sentAt || a[1].dateSent || '';
        const dateB = b[1].sentAt || b[1].dateSent || '';
        if (!dateA && !dateB) return 0;
        if (!dateA) return 1;
        if (!dateB) return -1;
        return new Date(dateB) - new Date(dateA);
    });

    const signature = JSON.stringify([
        campaign.campaignId, campaign.sent, campaign.failed, campaign.delivered,
        campaign.read, campaign.totalMessages,
        statusEntries.map(([sid, s]) => [sid, s.status, s.delivered, s.read, s.errorCode, s.dateUpdated]),
    ]);
    if (renderUnchanged('details', signature, Boolean(messageDetailsContent.querySelector('.message-status-scroll')))) {
        return;
    }

    let html = `
        <div style="margin-bottom: 15px; padding: 12px; background: var(--twilio-gray-50); border-radius: 6px;">
            <div style="display: flex; gap: 20px; flex-wrap: wrap;">
                <div><strong>Total Messages:</strong> ${Math.max(campaign.totalMessages || 0, campaign.sent || 0)}</div>
                <div><strong>Sent:</strong> <span style="color: var(--twilio-success);">${campaign.sent || 0}</span></div>
                <div><strong>Failed:</strong> <span style="color: var(--twilio-error);">${campaign.failed || 0}</span></div>
                <div><strong>Delivered:</strong> <span style="color: var(--twilio-success);">${campaign.delivered || 0}</span></div>
                <div><strong>Read:</strong> ${campaign.read || 0}</div>
            </div>
        </div>
        <div class="message-status-scroll">
            <table class="message-status-table">
                <thead>
                    <tr>
                        <th>Message SID</th>
                        <th>To</th>
                        <th>Status</th>
                        <th>Delivered</th>
                        <th>Read</th>
                        <th>Error Code</th>
                        <th>Error Message</th>
                        <th>Sent At</th>
                        <th>Updated At</th>
                        <th>Webhook Received</th>
                    </tr>
                </thead>
                <tbody>
    `;

    statusEntries.forEach(([sid, statusInfo]) => {
        const status = statusInfo.status || 'unknown';
        const statusClass = status === 'delivered' || status === 'read' ? 'success' : 
                           status === 'failed' || status === 'undelivered' ? 'failed' : 'pending';
        
        const delivered = statusInfo.delivered || status === 'delivered' || status === 'read' ? 'Yes' : 'No';
        const read = statusInfo.read || status === 'read' ? 'Yes' : 'No';
        
        const sentAt = statusInfo.sentAt || statusInfo.dateSent || null;
        const updatedAt = statusInfo.dateUpdated || statusInfo.webhookReceivedAt || null;
        const webhookReceived = statusInfo.webhookReceivedAt || null;
        
        const errorCode = statusInfo.errorCode || '-';
        const errorMessage = (statusInfo.errorMessage || '-').replace(/"/g, '&quot;');
        const to = statusInfo.to || '-';
        // Rejected sends are keyed "failed-<n>" because Twilio never issued a
        // SID. Showing that internal key in a column headed "Message SID" would
        // read as a real identifier, so say what actually happened instead.
        const sidLabel = MESSAGE_SID.test(sid) ? sid : 'not accepted';

        const formatDate = (dateValue) => {
            if (!dateValue) return 'N/A';
            try {
                return new Date(dateValue).toLocaleString();
            } catch (e) {
                return dateValue;
            }
        };

        html += `
            <tr>
                <td style="font-family: monospace; font-size: 11px; word-break: break-all;">${sidLabel}</td>
                <td>${to}</td>
                <td><span class="status-badge ${statusClass}">${status}</span></td>
                <td>${delivered}</td>
                <td>${read}</td>
                <td>${errorCode}</td>
                <td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${errorMessage}">${errorMessage}</td>
                <td>${formatDate(sentAt)}</td>
                <td>${formatDate(updatedAt)}</td>
                <td>${formatDate(webhookReceived)}</td>
            </tr>
        `;
    });

    html += `
                </tbody>
            </table>
        </div>
    `;

    withPreservedScroll(messageDetailsContent, '.message-status-scroll', () => {
        messageDetailsContent.innerHTML = html;
    });
}

/**
 * The inverse of toCsv(): parse CSV text into an array of row-arrays.
 *
 * Written against what spreadsheets actually emit rather than the happy path —
 * `text.split(',')` breaks on the first quoted field containing a comma, which
 * a message body very often does. Handles quoted fields spanning commas and
 * newlines, "" as an escaped quote, CRLF or LF, and a leading BOM (downloadCsv
 * writes one, so our own sample has to survive a round trip). Wholly blank
 * lines are dropped; a row of empty cells is not, since that is real if ragged
 * data the caller should get to reject.
 */
function parseCsv(text) {
    const src = String(text).replace(/^﻿/, '');
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;

    const endField = () => { row.push(field); field = ''; };
    const endRow = () => {
        endField();
        // A trailing newline yields one final [''] which is not a real row.
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
    };

    for (let i = 0; i < src.length; i++) {
        const ch = src[i];

        if (quoted) {
            if (ch === '"') {
                if (src[i + 1] === '"') { field += '"'; i++; }  // escaped quote
                else quoted = false;                            // closing quote
            } else {
                field += ch;
            }
            continue;
        }

        if (ch === '"' && field === '') { quoted = true; }
        else if (ch === ',') { endField(); }
        else if (ch === '\r') { if (src[i + 1] === '\n') i++; endRow(); }
        else if (ch === '\n') { endRow(); }
        else { field += ch; }
    }

    if (field !== '' || row.length) endRow();
    return rows;
}

// Header aliases. Hand-edited and re-exported CSVs will not match one exact
// spelling, and rejecting "To" or "Phone" for not being "Number" would be a
// pointless obstacle.
const CSV_NUMBER_HEADERS = ['number', 'to', 'phone', 'phone number', 'recipient', 'msisdn'];
const CSV_BODY_HEADERS = ['body', 'message', 'text'];

/**
 * Map a parsed CSV onto the send shape, given the currently selected template.
 *
 * Returns { mode, rows, columns, total, skipped, warnings, error }. `error` is
 * set for problems with the file as a whole (no header, no number column) —
 * those are fatal because nothing can be salvaged. Problems with individual
 * rows land in `skipped` and the rest still send.
 *
 * Mode follows the template selection rather than the file: Twilio ignores Body
 * when ContentSid is set, so a Body column alongside a template is a warning,
 * not an instruction.
 */
function interpretCsv(raw, template) {
    const result = { mode: null, rows: [], columns: [], total: 0, skipped: [], warnings: [], error: null };

    if (!raw.length) {
        result.error = 'That file is empty.';
        return result;
    }

    const header = raw[0].map(h => String(h || '').trim());
    const body = raw.slice(1);
    result.total = body.length;

    const numberIndex = header.findIndex(h => CSV_NUMBER_HEADERS.includes(h.toLowerCase()));
    if (numberIndex === -1) {
        result.error = `No recipient column found. Name the first column ${CSV_NUMBER_HEADERS.map(h => `"${h}"`).join(', ')} (any case).`;
        return result;
    }

    const bodyIndex = header.findIndex(h => CSV_BODY_HEADERS.includes(h.toLowerCase()));

    // Variable columns: "{{1}}", "{{ 1 }}", or a bare token naming one of the
    // template's own variables, so "1" and "name" work as written.
    const templateKeys = template ? extractVariables(template).map(v => v.key) : [];
    const variableColumns = [];
    header.forEach((h, index) => {
        const braced = h.match(/^\{\{\s*([\w.-]+)\s*\}\}$/);
        if (braced) variableColumns.push({ key: braced[1], index });
        else if (templateKeys.includes(h)) variableColumns.push({ key: h, index });
    });

    result.mode = template ? 'variables' : 'body';
    result.columns = result.mode === 'variables' ? variableColumns : [];

    if (result.mode === 'variables') {
        if (!variableColumns.length) {
            result.error = templateKeys.length
                ? `No variable columns found. This template needs ${templateKeys.map(k => `{{${k}}}`).join(', ')} — download the sample for the exact header.`
                : 'The selected template takes no variables, so a CSV only needs a recipient column.';
            if (templateKeys.length) return result;
            result.error = null;
        }
        if (bodyIndex !== -1) {
            result.warnings.push('A Body column is present but ignored: Twilio sends the template, not a literal body, when a template is selected.');
        }
        const missing = templateKeys.filter(k => !variableColumns.some(c => c.key === k));
        if (missing.length) {
            result.warnings.push(`No column for ${missing.map(k => `{{${k}}}`).join(', ')} — ${missing.length === 1 ? 'it' : 'they'} will send empty.`);
        }
        const unknown = variableColumns.filter(c => templateKeys.length && !templateKeys.includes(c.key));
        if (unknown.length) {
            result.warnings.push(`Ignoring ${unknown.map(c => `{{${c.key}}}`).join(', ')} — not used by this template.`);
        }
    }

    const fallbackBody = document.getElementById('message-body').value.trim();
    if (result.mode === 'body' && bodyIndex === -1 && !fallbackBody) {
        result.error = `No message text found. Add a ${CSV_BODY_HEADERS.map(h => `"${h}"`).join(' / ')} column, type a message body above, or pick a content template.`;
        return result;
    }

    let blankCells = 0;
    let fellBack = 0;
    const seen = new Set();
    let duplicates = 0;
    let notE164 = 0;

    body.forEach((cells, i) => {
        const line = i + 2;  // 1-based, and the header occupies line 1

        if (cells.length !== header.length) {
            result.skipped.push({ line, reason: `${cells.length} column${cells.length === 1 ? '' : 's'}, expected ${header.length}` });
            return;
        }

        const to = String(cells[numberIndex] || '').trim();
        if (!to) {
            result.skipped.push({ line, reason: 'no recipient number' });
            return;
        }

        // Flagged, not skipped. Twilio wants E.164, but a Messaging Service with
        // a configured geography can accept national formats, so refusing them
        // outright would reject numbers that would in fact deliver. A channel
        // prefix is stripped first — a CSV may legitimately carry "whatsapp:+65…".
        if (!/^\+[1-9]\d{6,14}$/.test(to.replace(/^[a-z]+:/i, ''))) notE164++;

        const message = { to };

        if (result.mode === 'variables') {
            const vars = {};
            result.columns
                .filter(c => !templateKeys.length || templateKeys.includes(c.key))
                .forEach(c => {
                    const value = String(cells[c.index] ?? '').trim();
                    // Blank stays blank. The variable inputs above still hold
                    // seeded sample values, and quietly substituting one for
                    // missing data would send the wrong thing to a real person.
                    if (!value) blankCells++;
                    vars[c.key] = value;
                });
            if (Object.keys(vars).length) message.contentVariables = vars;
        } else {
            // A blank cell falls back to the single message body above, so a
            // partially-filled column is usable rather than fatal. Only a row
            // with neither is skipped. Unlike variables, this substitution is
            // announced below, and the fallback is text the user typed for this
            // campaign rather than a template's leftover sample value.
            const cell = bodyIndex === -1 ? '' : String(cells[bodyIndex] ?? '').trim();
            const text = cell || fallbackBody;
            if (!text) {
                result.skipped.push({ line, reason: 'no message text' });
                return;
            }
            if (!cell) fellBack++;
            message.body = text;
        }

        if (seen.has(to)) duplicates++;
        seen.add(to);

        result.rows.push(message);
    });

    if (blankCells) {
        result.warnings.push(`${blankCells} variable cell${blankCells === 1 ? '' : 's'} left blank — ${blankCells === 1 ? 'it' : 'they'} will render as empty text.`);
    }
    if (notE164) {
        result.warnings.push(`${notE164} number${notE164 === 1 ? '' : 's'} ${notE164 === 1 ? 'is' : 'are'} not in E.164 format (a leading + and country code, e.g. +6512345678) and may be rejected.`);
    }
    if (fellBack) {
        result.warnings.push(`${fellBack} row${fellBack === 1 ? '' : 's'} had no message text and will use the message body typed above.`);
    }
    if (duplicates) {
        result.warnings.push(`${duplicates} repeated number${duplicates === 1 ? '' : 's'} — sending more than once to the same recipient.`);
    }
    if (!result.rows.length && !result.error) {
        result.error = 'No usable rows in that file.';
    }

    return result;
}

/** RFC-style CSV: quote fields containing a quote, comma, CR or LF; double quotes. */
function toCsv(rows) {
    if (!rows.length) return '';
    const headers = Array.from(rows.reduce((keys, row) => {
        Object.keys(row).forEach((k) => keys.add(k));
        return keys;
    }, new Set()));
    const escape = (val) => {
        const s = val == null ? '' : String(val);
        return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [
        headers.map(escape).join(','),
        ...rows.map((row) => headers.map((h) => escape(row[h] ?? '')).join(',')),
    ].join('\r\n');
}

function downloadCsv(text, filename) {
    // BOM so Excel reads it as UTF-8 rather than mangling non-ASCII.
    const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

function exportMessageStatusCsv() {
    const campaign = displayedCampaign;
    const statuses = (campaign && campaign.statuses) || {};
    const entries = Object.entries(statuses);

    if (!entries.length) {
        alert('No messages to export yet.');
        return;
    }

    // Same order as the table: most recently sent first.
    entries.sort((a, b) => {
        const dateA = a[1].sentAt || a[1].dateSent || '';
        const dateB = b[1].sentAt || b[1].dateSent || '';
        if (!dateA && !dateB) return 0;
        if (!dateA) return 1;
        if (!dateB) return -1;
        return new Date(dateB) - new Date(dateA);
    });

    const rows = entries.map(([sid, s]) => ({
        'Message SID': MESSAGE_SID.test(sid) ? sid : 'not accepted',
        'To': s.to || '',
        'Status': s.status || '',
        'Delivered': s.delivered ? 'Yes' : 'No',
        'Read': s.read ? 'Yes' : 'No',
        'Error Code': s.errorCode == null ? '' : s.errorCode,
        'Error Message': s.errorMessage || '',
        'Sent At': s.sentAt || s.dateSent || '',
        'Updated At': s.dateUpdated || '',
        'Webhook Received': s.webhookReceivedAt || '',
    }));

    const label = (campaign.campaignName || campaign.campaignId || 'campaign')
        .replace(/[^a-z0-9._-]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv(toCsv(rows), `${label}-messages-${stamp}.csv`);
}

function startStatusAutoRefresh() {
    // Clear existing interval
    if (statusRefreshInterval) {
        clearInterval(statusRefreshInterval);
        statusRefreshInterval = null;
    }

    // Only start refresh if we have an active campaign
    if (currentCampaignId && creds) {
        // Refresh every 5 seconds
        statusRefreshInterval = setInterval(async () => {
            await checkCampaignStatus();
            await loadCampaigns(); // Also refresh the campaigns list
        }, 5000);
    }
}

// Make viewCampaign available globally
window.viewCampaign = viewCampaign;

