// Configuration - Update with your Twilio Functions URL
const FUNCTIONS_BASE_URL = window.location.origin.replace(/\/$/, '');

// State
const CREDS_KEY = 'twilio_messaging_oauth';

/** { accountSid, clientId, clientSecret }, or null when signed out. */
let creds = null;
let currentCampaignId = null;
let resumeInterval = null;
let statusRefreshInterval = null;
// Content templates loaded for the current channel (full objects from the API)
let loadedTemplates = [];

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
});

function initializeApp() {
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
        if (parsed && parsed.accountSid && parsed.clientId && parsed.clientSecret) {
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
}

async function handleLogin(e) {
    e.preventDefault();
    const errorDiv = document.getElementById('login-error');
    const loginBtn = document.getElementById('login-btn');
    errorDiv.classList.remove('show');
    errorDiv.textContent = '';

    const candidate = {
        accountSid: document.getElementById('account-sid').value.trim(),
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

        saveCreds(candidate);
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
}

function showAppScreen() {
    document.getElementById('login-screen').classList.remove('active');
    document.getElementById('app-screen').classList.add('active');
    // Load phone numbers when app screen is shown
    loadPhoneNumbers();
    // Load content templates for current channel
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
        const response = await postToFunction('get-phone-numbers', { channel: ch });
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
    mms: 'SMS-capable number',
    whatsapp: 'WhatsApp sender',
    rcs: 'RCS agent',
    messenger: 'Facebook Page',
};

function setSenderHelp(text, isProblem) {
    const help = document.getElementById('from-number-help');
    if (!help) return;
    help.textContent = text;
    help.classList.toggle('field-help--problem', Boolean(isProblem));
}

function renderSenderOptions(data) {
    const select = document.getElementById('from-number-select');
    const noun = CHANNEL_SENDER_NOUN[data.channel] || 'sender';
    const senders = Array.isArray(data.senders) ? data.senders : [];

    select.innerHTML = '';

    if (!senders.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.disabled = true;
        // Distinguish "none exist" from "some exist but none usable" — the
        // second is a fixable configuration problem and should say so.
        opt.textContent = data.totalRegistered
            ? `No usable ${noun}s — ${data.totalRegistered} registered but not online`
            : `No ${noun}s registered on this account`;
        select.appendChild(opt);
        setSenderHelp(opt.textContent, true);
        return;
    }

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = `Select a ${noun}…`;
    select.appendChild(placeholder);

    for (const sender of senders) {
        const opt = document.createElement('option');
        opt.value = sender.value;
        opt.textContent = sender.label;
        select.appendChild(opt);
    }

    const hidden = data.totalRegistered - senders.length;
    setSenderHelp(
        hidden > 0
            ? `${senders.length} ${noun}${senders.length === 1 ? '' : 's'} available · ${hidden} not online`
            : `${senders.length} ${noun}${senders.length === 1 ? '' : 's'} available`,
        false
    );
}

async function handleChannelChange() {
    if (!creds) return;

    const channel = document.getElementById('channel').value;
    // The sender list is channel-specific — a WhatsApp sender is not a phone number.
    loadPhoneNumbers(channel);
    const contentTemplateGroup = document.getElementById('content-template-group');
    const contentTemplateSelect = document.getElementById('content-template');
    const contentTemplateHelp = document.getElementById('content-template-help');
    const filterRow = document.getElementById('template-filter-row');

    // Reset previous template state
    loadedTemplates = [];
    clearTemplateDetails();
    filterRow.style.display = 'none';

    // Show/hide content template based on channel support
    const supportsContentTemplates = ['whatsapp', 'rcs'].includes(channel);

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
                contentTemplateHelp.textContent = 'Select a content template';
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

    if (templateSelected) {
        messageBody.removeAttribute('required');
        messageBodyHelp.textContent = 'Optional when using a content template';
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

    const sid = document.getElementById('content-template').value;
    if (!sid) return;

    const template = loadedTemplates.find(t => t.sid === sid);
    if (!template) return;

    renderTemplatePreview(template);
    renderTemplateVariableInputs(template);
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


async function handleSendMessages(e) {
    e.preventDefault();
    
    const sendBtn = document.getElementById('send-btn');
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending...';

    const channel = document.getElementById('channel').value;
    const fromInput = document.getElementById('from-number');
    const fromSelect = document.getElementById('from-number-select');
    const from = fromSelect.value || fromInput.value.trim();
    const body = document.getElementById('message-body').value.trim();
    const recipientsText = document.getElementById('recipients').value.trim();
    const campaignName = document.getElementById('campaign-name').value.trim();
    const contentSid = document.getElementById('content-template').value;
    const contentVariables = contentSid ? getSelectedContentVariables() : null;

    // Validate from field
    if (!from) {
        alert('Please select a phone number or enter a Sender ID');
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Messages';
        return;
    }

    // A template with no body and no content template selected is invalid
    if (!contentSid && !body) {
        alert('Please enter a message body or select a content template');
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Messages';
        return;
    }

    // Parse recipients
    const recipients = recipientsText
        .split(/[\n,]+/)
        .map(r => r.trim())
        .filter(r => r.length > 0);

    if (recipients.length === 0) {
        alert('Please enter at least one recipient');
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Messages';
        return;
    }

    // Format messages array
    const messages = recipients.map(to => {
        const message = {
            to: channel === 'whatsapp' && !to.startsWith('whatsapp:')
                ? `whatsapp:${to}`
                : to,
            from: channel === 'whatsapp' && !from.startsWith('whatsapp:')
                ? `whatsapp:${from}`
                : from
        };

        if (contentSid) {
            message.contentSid = contentSid;
            if (contentVariables) {
                message.contentVariables = contentVariables;
            }
        }

        if (body) {
            message.body = body;
        }

        return message;
    });

    // Generate campaign ID
    currentCampaignId = `campaign_${Date.now()}`;

    try {
        await sendMessagesBatch(messages, channel, from, campaignName);
    } catch (error) {
        alert('Error: ' + error.message);
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Messages';
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
    
    document.getElementById('send-btn').disabled = false;
    document.getElementById('send-btn').textContent = 'Send Messages';
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


async function resumeCampaign() {
    const channel = document.getElementById('channel').value;
    const fromInput = document.getElementById('from-number');
    const fromSelect = document.getElementById('from-number-select');
    const from = fromSelect.value || fromInput.value.trim();
    const body = document.getElementById('message-body').value.trim();
    const contentTemplateSid = document.getElementById('content-template').value;
    const contentVariables = contentTemplateSid ? getSelectedContentVariables() : null;
    const recipientsText = document.getElementById('recipients').value.trim();

    const recipients = recipientsText
        .split(/[\n,]+/)
        .map(r => r.trim())
        .filter(r => r.length > 0);

    const messages = recipients.map(to => {
        const message = {
            to: channel === 'whatsapp' && !to.startsWith('whatsapp:') 
                ? `whatsapp:${to}` 
                : to,
            from: channel === 'whatsapp' && !from.startsWith('whatsapp:')
                ? `whatsapp:${from}`
                : from
        };

        // Add content template if selected
        if (contentTemplateSid) {
            message.contentSid = contentTemplateSid;
            if (contentVariables) {
                message.contentVariables = contentVariables;
            }
        }

        // Add body if provided
        if (body) {
            message.body = body;
        }

        return message;
    });

    try {
        await sendMessagesBatch(messages, channel, from);
    } catch (error) {
        alert('Error resuming: ' + error.message);
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

// Make resumeCampaign functions available globally
window.resumeCampaign = resumeCampaign;
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

    let html = '<div class="campaigns-list">';
    campaigns.forEach(campaign => {
        const isActive = campaign.campaignId === currentCampaignId;
        const progress = campaign.totalMessages > 0 
            ? ((campaign.sent + campaign.failed) / campaign.totalMessages * 100).toFixed(1) 
            : 0;
        
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
                        <span class="stat-value">${campaign.totalMessages}</span>
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
    campaignsContent.innerHTML = html;
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

    let html = `
        <div style="margin-bottom: 15px; padding: 12px; background: var(--twilio-gray-50); border-radius: 6px;">
            <div style="display: flex; gap: 20px; flex-wrap: wrap;">
                <div><strong>Total Messages:</strong> ${campaign.totalMessages || 0}</div>
                <div><strong>Sent:</strong> <span style="color: var(--twilio-success);">${campaign.sent || 0}</span></div>
                <div><strong>Failed:</strong> <span style="color: var(--twilio-error);">${campaign.failed || 0}</span></div>
                <div><strong>Delivered:</strong> <span style="color: var(--twilio-success);">${campaign.delivered || 0}</span></div>
                <div><strong>Read:</strong> ${campaign.read || 0}</div>
            </div>
        </div>
        <div style="overflow-x: auto; max-height: 600px; overflow-y: auto;">
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
                <td style="font-family: monospace; font-size: 11px; word-break: break-all;">${sid}</td>
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

    messageDetailsContent.innerHTML = html;
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

