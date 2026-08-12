# UI Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix five defects found during live testing of the OAuth migration: three CSS bugs, a look-and-feel that reads as unstyled default, and a From dropdown that shows SMS numbers when WhatsApp is selected.

**Architecture:** Two independent tasks. Task A is functional — `get-phone-numbers` becomes channel-aware, backed by Twilio's Channel Senders API, and the send path's `whatsapp:` prefixing becomes idempotent. Task B is visual — adopt the sibling project `twilio-lookup-api-ui`'s design token system and fix the three layout bugs structurally.

**Tech Stack:** Twilio Serverless Functions + Assets, vanilla JS, hand-written CSS. `twilio@5.10.6`. No build step, no framework, no test suite.

---

## Read This First

**The OAuth migration is complete, deployed to the `oauthtest` environment, and verified.** Do not undo any of it. In particular: credentials arrive in POST bodies, never query strings; `authenticate()` is deadline-bounded; campaign ownership is enforced by `ownerKey` with a 404 for non-owners.

**Two facts established by live probing against a real account — do not re-litigate them:**

1. `client.messaging.v2.channelsSenders.list({ channel })` works with OAuth credentials and **requires** the `channel` parameter (omitting it throws `Required parameter "params['channel']" missing.`). It returns `senderId` already prefixed (`whatsapp:+6500000000`, `rcs:your_agent_id`), plus `status` and `profile.name`.
2. Observed statuses on the test account: WhatsApp senders return `ONLINE` / `OFFLINE`; RCS agents return `DRAFT`. Only `ONLINE` is usable.

**Decided by the user, against the recommendation:** the dropdown lists **only usable senders**. The stated risk was that an empty dropdown is indistinguishable from a fetch failure — so an explicit empty state is required (see Task A Step 4). That is implementing the decision properly, not hedging against it.

**There is no test suite and none is being added.** Verification is `node --check`, grep assertions, throwaway `node` probes, and a redeploy to `oauthtest`.

## File Structure

| File | Action | Responsibility after this change |
|---|---|---|
| `functions/get-phone-numbers.js` | Modify | Channel-aware sender list: `incomingPhoneNumbers` for sms/mms, Channel Senders API for whatsapp/rcs |
| `functions/send-messages.js` | Modify | One-line idempotency guard on the `whatsapp:` prefix |
| `functions/resume-execution.js` | Modify | The same guard — both files or neither, to avoid divergence |
| `assets/app.js` | Modify | Reload senders on channel change; per-channel help text and empty state |
| `assets/styles.css` | Modify | Adopt the sibling project's token system; fix the three layout bugs |
| `assets/index.html` | Modify | Move the template filter onto its own row |

---

### Task A: Channel-aware sender list

**Files:**
- Modify: `functions/get-phone-numbers.js`
- Modify: `functions/send-messages.js` (one guard)
- Modify: `functions/resume-execution.js` (the same guard)
- Modify: `assets/app.js`

- [ ] **Step 1: Make `get-phone-numbers` channel-aware**

Replace the body of the second `try` block. Keep the credential block and the two-stage try/catch exactly as they are.

```js
    const channel = String(event.channel || 'sms').toLowerCase();

    // sms/mms send from a Twilio phone number; whatsapp/rcs send from a
    // registered channel sender, which is a different resource entirely. Asking
    // incomingPhoneNumbers for a WhatsApp sender returns numbers that cannot
    // send on WhatsApp — the defect this fixes.
    let senders;
    let totalRegistered;

    if (channel === 'whatsapp' || channel === 'rcs') {
      // `channel` is required by this endpoint; omitting it throws.
      const registered = await client.messaging.v2.channelsSenders.list({
        channel,
        limit: 100,
      });
      totalRegistered = registered.length;

      senders = registered
        .filter((s) => String(s.status || '').toUpperCase() === 'ONLINE')
        .map((s) => ({
          // senderId already carries the channel prefix (whatsapp:+65…), which
          // is exactly what `from` needs. Do not strip it — the send path's
          // prefixing is idempotent (Step 2).
          value: s.senderId,
          label: s.profile && s.profile.name
            ? `${s.senderId.replace(/^[a-z]+:/, '')} · ${s.profile.name}`
            : s.senderId.replace(/^[a-z]+:/, ''),
          status: s.status,
        }));
    } else {
      const numbers = await client.incomingPhoneNumbers.list({ limit: 100 });
      const smsCapable = numbers.filter((n) => {
        const c = n.capabilities || {};
        return c.sms === true || c.sms === 'true';
      });
      totalRegistered = smsCapable.length;
      senders = smsCapable.map((n) => ({
        value: n.phoneNumber,
        label: n.friendlyName && n.friendlyName !== n.phoneNumber
          ? `${n.phoneNumber} · ${n.friendlyName}`
          : n.phoneNumber,
        status: 'ONLINE',
      }));
    }

    response.setStatusCode(200);
    response.setBody({
      success: true,
      channel,
      senders,
      // The frontend needs both counts to tell "none registered" apart from
      // "some registered but none usable" — two different things to say.
      usableCount: senders.length,
      totalRegistered,
      // Kept so nothing that still reads `phoneNumbers` breaks silently.
      phoneNumbers: senders.map((s) => ({ phoneNumber: s.value })),
    });
    return callback(null, response);
```

- [ ] **Step 2: Make the `whatsapp:` prefix idempotent, in BOTH send files**

`get-phone-numbers` now returns `whatsapp:+6500000000` as the value, so blind prefixing would produce `whatsapp:whatsapp:+65…`.

In **both** `functions/send-messages.js` and `functions/resume-execution.js`, find:

```js
        if (channel === 'whatsapp') {
          messageParams.from = `whatsapp:${messageParams.from}`;
          messageParams.to = `whatsapp:${messageParams.to}`;
        }
```

Replace with:

```js
        if (channel === 'whatsapp') {
          // Idempotent: the From value may already carry the prefix, because
          // the Channel Senders API returns senderId as `whatsapp:+65…`.
          const wa = (v) => (String(v).startsWith('whatsapp:') ? String(v) : `whatsapp:${v}`);
          messageParams.from = wa(messageParams.from);
          messageParams.to = wa(messageParams.to);
        }
```

Apply to both files. Applying it to one only would recreate exactly the kind of divergence that caused the `contentVariables` bug.

- [ ] **Step 3: Reload senders when the channel changes**

In `assets/app.js`, `loadPhoneNumbers` currently takes no argument and runs once at login. Make it channel-aware:

```js
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
```

- [ ] **Step 4: Render the options, with an explicit empty state**

Add alongside it. The empty state is required: the user chose to list only usable senders, and a blank dropdown would otherwise be indistinguishable from a failed fetch.

```js
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
```

- [ ] **Step 5: Call it on channel change**

In `handleChannelChange`, after the existing channel read, reload the senders. Find the line that reads the channel and add immediately after it:

```js
    // The sender list is channel-specific — a WhatsApp sender is not a phone number.
    loadPhoneNumbers(channel);
```

Leave the content-template logic in that function untouched, including its fail-soft branch.

- [ ] **Step 6: Verify**

```bash
node --check functions/get-phone-numbers.js && echo "fn OK"
node --check functions/send-messages.js && echo "send OK"
node --check functions/resume-execution.js && echo "resume OK"
node --check assets/app.js && echo "app OK"
grep -c "startsWith('whatsapp:')" functions/send-messages.js functions/resume-execution.js
grep -c "channelsSenders" functions/get-phone-numbers.js
```

Expected: four `OK` lines, `1` for each send file (the guard, in both — not one), and `1` for `channelsSenders`.

Then probe the real endpoint for every channel, with credentials from `.env.oauthtest` (gitignored; never echo it):

```bash
set -a; . ./.env.oauthtest; set +a
for ch in sms whatsapp rcs; do
  echo "--- $ch ---"
  curl -s -X POST https://<service>-<n>-oauthtest.twil.io/get-phone-numbers \
    -H 'Content-Type: application/json' \
    --data "$(jq -nc --arg a "$APP_A_SID" --arg c "$APP_A_CLIENT_ID" --arg s "$APP_A_SECRET" --arg ch "$ch" \
      '{accountSid:$a,clientId:$c,clientSecret:$s,channel:$ch}')" \
  | jq -c '{channel, usableCount, totalRegistered, first: (.senders[0].label // null)}'
done
```

Expected shape: `sms` returns 13 usable; `whatsapp` returns 3 usable of 4 registered; `rcs` returns 0 usable of 2 registered. The RCS case is the one that proves the empty state is reachable.

- [ ] **Step 7: Commit**

```bash
git add functions/get-phone-numbers.js functions/send-messages.js functions/resume-execution.js assets/app.js
git commit -m "feat: list senders per channel instead of always showing SMS numbers"
```

---

### Task B: Adopt the sibling project's design system

**Files:**
- Modify: `assets/styles.css`
- Modify: `assets/index.html`

The reference is `/Users/hng/Documents/GitHub/twilio-lookup-api-ui/assets/styles.css`. Read its `:root` block and its button/input/card rules before starting. Match its language; do not invent a new one.

- [ ] **Step 1: Replace the token block**

Replace the existing `:root` in `assets/styles.css` with the sibling's system, keeping the old variable names as aliases so no existing rule breaks:

```css
:root {
    /* Adopted from twilio-lookup-api-ui so the two apps read as one family. */
    --twilio-red: #F22F46;
    --twilio-red-hover: #D91F36;
    --twilio-navy: #121C2D;
    --twilio-navy-light: #1F2D3D;

    --bg: #F4F4F6;
    --surface: #FFFFFF;
    --surface-hover: #F9FAFB;
    --border: #E1E3EA;
    --border-strong: #CACDD8;

    --text: #121C2D;
    --text-secondary: #606B85;
    --text-muted: #8891AA;

    --accent: #0263E0;
    --accent-hover: #014FB6;
    --accent-light: #E8F1FC;

    --success: #14B053;
    --success-light: #E3F9ED;
    --danger: #D91F36;
    --danger-light: #FEE2E6;
    --warning: #E46216;

    --shadow-sm: 0 1px 3px rgba(18, 28, 45, 0.08);
    --shadow-md: 0 4px 12px rgba(18, 28, 45, 0.08), 0 1px 3px rgba(18, 28, 45, 0.05);
    --shadow-lg: 0 8px 24px rgba(18, 28, 45, 0.1), 0 2px 6px rgba(18, 28, 45, 0.06);

    --radius: 8px;
    --radius-lg: 12px;

    --font: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --mono: "Fira Code", "JetBrains Mono", ui-monospace, monospace;

    /* Aliases: existing rules reference these names. Kept so this change is a
       re-skin rather than a rewrite of every selector. */
    --twilio-white: var(--surface);
    --twilio-dark-blue: var(--twilio-navy);
    --twilio-blue: var(--accent);
    --twilio-light-blue: var(--accent-light);
    --twilio-gray-50: var(--surface-hover);
    --twilio-gray-100: #F1F2F5;
    --twilio-gray-200: var(--border);
    --twilio-gray-300: var(--border-strong);
    --twilio-gray-400: var(--text-muted);
    --twilio-gray-500: var(--text-muted);
    --twilio-gray-600: var(--text-secondary);
    --twilio-gray-700: var(--text-secondary);
    --twilio-gray-800: var(--text);
    --twilio-gray-900: var(--text);
    --twilio-success: var(--success);
    --twilio-error: var(--danger);
    --twilio-warning: var(--warning);
}
```

- [ ] **Step 2: Fix issue 1 — the dropdown chevron sits on the field edge**

The cause is `padding: 10px 12px` on selects: the native arrow renders inside a 12px gutter and looks flush. Replace the native arrow with an inline SVG chevron and give it room. Append:

```css
/* One rule for every select in the app, so they cannot drift apart. */
select,
.form-group select,
.phone-select,
.content-select,
.filter-select {
    appearance: none;
    -webkit-appearance: none;
    /* Right padding must clear the chevron: 16px inset + 12px glyph + 12px gap. */
    padding: 10px 40px 10px 12px;
    background-color: var(--surface);
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8' fill='none'%3E%3Cpath d='M1 1.5L6 6.5L11 1.5' stroke='%23606B85' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 14px center;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    font-family: var(--font);
    font-size: 14px;
    line-height: 1.4;
    cursor: pointer;
    transition: border-color 0.15s, box-shadow 0.15s;
}

select:hover { border-color: var(--border-strong); }

select:focus-visible,
select:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-light);
}

select:disabled {
    background-color: var(--surface-hover);
    color: var(--text-muted);
    cursor: not-allowed;
}
```

- [ ] **Step 3: Fix issue 2 — the template filter row overflows the card**

The row is `display: flex` and the select inside it inherits `width: 100%`; flex items default to `min-width: auto`, so it cannot shrink and pushes past the card. Give it its own row and let it shrink:

```css
.template-filter-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0 0 10px;
    /* Without min-width:0 a flex item refuses to shrink below its content. */
    min-width: 0;
}

.template-filter-row .filter-label {
    margin: 0;
    flex: 0 0 auto;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-secondary);
    white-space: nowrap;
}

.template-filter-row .filter-select,
.template-filter-row select {
    flex: 1 1 auto;
    min-width: 0;
    width: auto;
}
```

- [ ] **Step 4: Fix issue 3 — the campaign card's top border is clipped**

`.campaigns-list` is a scroll container (`max-height: 600px; overflow-y: auto`) with no padding, so a child's 2px border sits exactly on the clip edge and the top edge is lost. Give the container inset room and stop the hover transform from pushing a card under the edge:

```css
.campaigns-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-height: 600px;
    overflow-y: auto;
    /* Inset so a child's border and focus ring are never on the clip boundary. */
    padding: 3px;
    margin: -3px;
    scroll-padding-block: 3px;
}

.campaign-item {
    background: var(--surface);
    border: 1px solid var(--border);
    border-left: 3px solid var(--border-strong);
    border-radius: var(--radius);
    padding: 16px;
    cursor: pointer;
    transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
}

.campaign-item:hover {
    border-color: var(--border-strong);
    border-left-color: var(--accent);
    background: var(--surface-hover);
    box-shadow: var(--shadow-sm);
    /* No translate: a transform inside a scroll container is what clipped the
       top edge in the first place. */
}

.campaign-item.active {
    border-color: var(--accent);
    border-left-color: var(--accent);
    background: var(--accent-light);
    box-shadow: var(--shadow-sm);
}
```

Note the left-edge accent replaces the old full 2px blue box. It reads as a status marker rather than a selection outline, and it cannot be clipped by the scroll container.

- [ ] **Step 5: Fix issue 4 — buttons**

Give the buttons a real hierarchy. Append:

```css
.btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 10px 18px;
    border: 1px solid transparent;
    border-radius: var(--radius);
    font-family: var(--font);
    font-size: 14px;
    font-weight: 600;
    line-height: 1.2;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, box-shadow 0.15s, color 0.15s;
}

.btn:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--accent-light);
}

.btn:disabled { opacity: 0.55; cursor: not-allowed; }

.btn-primary {
    background: var(--twilio-red);
    border-color: var(--twilio-red);
    color: #fff;
    box-shadow: var(--shadow-sm);
}
.btn-primary:hover:not(:disabled) {
    background: var(--twilio-red-hover);
    border-color: var(--twilio-red-hover);
    box-shadow: var(--shadow-md);
}
.btn-primary:active:not(:disabled) { box-shadow: none; }

.btn-secondary {
    background: var(--surface);
    border-color: var(--border-strong);
    color: var(--text);
}
.btn-secondary:hover:not(:disabled) {
    background: var(--surface-hover);
    border-color: var(--text-muted);
}

.btn-danger {
    background: var(--danger);
    border-color: var(--danger);
    color: #fff;
}
.btn-danger:hover:not(:disabled) { background: #C01B30; border-color: #C01B30; }
```

- [ ] **Step 6: Fix issue 4 — surfaces, type and inputs**

```css
body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    font-size: 14px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
}

.card {
    background: var(--surface);
    padding: 24px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    margin-bottom: 24px;
}

h1, h2, h3 {
    color: var(--text);
    letter-spacing: -0.01em;
    line-height: 1.25;
}
h2 { font-size: 18px; font-weight: 650; }

label,
.form-group > label {
    display: block;
    margin-bottom: 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
}

input[type="text"],
input[type="password"],
input[type="tel"],
textarea {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
    font-family: var(--font);
    font-size: 14px;
    transition: border-color 0.15s, box-shadow 0.15s;
}

input:focus, textarea:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-light);
}

input::placeholder, textarea::placeholder { color: var(--text-muted); }

.field-help,
.form-group small {
    display: block;
    margin-top: 6px;
    font-size: 12px;
    color: var(--text-secondary);
}

.field-help--problem { color: var(--danger); }

/* Message SIDs are data, not prose — set them in the mono face so they can be
   compared column-wise. */
.results-table td:first-child,
.message-sid { font-family: var(--mono); font-size: 12px; }

@media (prefers-reduced-motion: reduce) {
    * { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
}
```

- [ ] **Step 7: Load the two typefaces**

In `assets/index.html`, inside `<head>` before the stylesheet link:

```html
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet">
```

- [ ] **Step 8: Give the From field a help element**

Task A's `setSenderHelp` writes to `#from-number-help`. Add it under the From controls in `assets/index.html`, replacing the existing static help text for that field:

```html
                                    <small id="from-number-help" class="field-help">Select a sender for the chosen channel</small>
```

- [ ] **Step 9: Verify**

```bash
node --check assets/app.js && echo "app OK"
grep -c "appearance: none" assets/styles.css
grep -c "min-width: 0" assets/styles.css
grep -n "from-number-help" assets/index.html assets/app.js
grep -c "Inter" assets/index.html
```

Expected: `app OK`; at least `1` for `appearance: none`; at least `2` for `min-width: 0`; `from-number-help` present in both files; `1` for the font link.

Confirm no CSS variable is referenced but undefined:

```bash
comm -23 \
  <(grep -oE 'var\(--[a-z0-9-]+' assets/styles.css | sed 's/var(//' | sort -u) \
  <(grep -oE '^\s*--[a-z0-9-]+' assets/styles.css | tr -d ' ' | sed 's/:$//' | sort -u)
```

Expected: no output. Any name printed is referenced but never defined.

- [ ] **Step 10: Commit**

```bash
git add assets/styles.css assets/index.html
git commit -m "style: adopt the lookup-api-ui design system and fix three layout bugs"
```

---

### Task C: Redeploy and re-verify

- [ ] **Step 1: Redeploy to the same throwaway environment**

```bash
twilio serverless:deploy --environment=oauthtest
```

Do **not** deploy to the default environment — `dev` is a live deployment and must stay untouched.

- [ ] **Step 2: Re-run the OAuth regression checks**

The visual work touched `app.js` and the send path, so confirm the migration still holds. Credentials come from `.env.oauthtest`; never echo it.

Re-check, at minimum: `/verify` rejects a bad secret with HTTP 200 `valid:false`; the private asset returns 403; a non-owner gets an identical 404 from `check-status` and `resume-execution`.

- [ ] **Step 3: Report what needs eyes**

Screenshots cannot be taken from here. Report to the user exactly what to look at: the four chevrons, the filter row inside its card, the campaign card's top border, the button hierarchy, and the From dropdown after switching to WhatsApp (expect 3 senders) and to RCS (expect the explicit empty state, not a blank dropdown).

---

---

### Task D: Correct the MMS and Messenger sender sources

Task A made the sender list channel-aware but left two channels wrong. Both were reported by the user after testing.

**Established by live probing — do not re-derive:**

- `incomingPhoneNumbers` on the test account: 24 total, **13 sms-capable, 8 mms-capable, 5 sms-but-not-mms**. Filtering MMS on `capabilities.sms` therefore offers 5 numbers that cannot send media.
- The Channel Senders API **rejects** messenger: `client.messaging.v2.channelsSenders.list({ channel: 'messenger' })` fails with `400 / 63105 Channel does not support this action`. It is not a source for Messenger senders.
- `client.messaging.v1.services.list()` works with OAuth and returns 5 Messaging Services. Facebook Pages attach to a Messaging Service, and `send-messages.js` already consumes `messagingServiceSid` for the messenger channel — so Messaging Services are the correct dropdown source.

**Files:**
- Modify: `functions/get-phone-numbers.js`
- Modify: `functions/send-messages.js`
- Modify: `functions/resume-execution.js`
- Modify: `assets/app.js` (one label)

- [ ] **Step 1: Split the capability filter and add a Messenger branch**

In `functions/get-phone-numbers.js`, replace the `else` branch from Task A with three branches:

```js
    } else if (channel === 'messenger') {
      // Facebook Pages are not exposed by the Channel Senders API (it answers
      // 63105 "Channel does not support this action"). Pages attach to a
      // Messaging Service, and the send path already consumes
      // messagingServiceSid for this channel, so list the services.
      const services = await client.messaging.v1.services.list({ limit: 50 });
      totalRegistered = services.length;
      senders = services.map((s) => ({
        value: s.sid,
        label: `${s.friendlyName} · ${s.sid.slice(0, 10)}…`,
        status: 'ONLINE',
      }));
    } else {
      const numbers = await client.incomingPhoneNumbers.list({ limit: 100 });

      // MMS carries media, and a number that can send SMS cannot necessarily
      // send MMS — on the test account 5 of 13 sms-capable numbers are not
      // mms-capable. Filtering both on `sms` offers senders that will fail.
      const needsMms = channel === 'mms';
      const capable = numbers.filter((n) => {
        const c = n.capabilities || {};
        const flag = needsMms ? c.mms : c.sms;
        return flag === true || flag === 'true';
      });

      totalRegistered = capable.length;
      senders = capable.map((n) => ({
        value: n.phoneNumber,
        label: n.friendlyName && n.friendlyName !== n.phoneNumber
          ? `${n.phoneNumber} · ${n.friendlyName}`
          : n.phoneNumber,
        status: 'ONLINE',
      }));
    }
```

- [ ] **Step 2: Make the messenger send path coherent, in BOTH send files**

The current branch sets `messagingServiceSid` *and* leaves `from` as-is, so both can be sent at once, and the `messenger:` channel prefix is never applied. In **both** `functions/send-messages.js` and `functions/resume-execution.js`, find:

```js
          } else if (channel === 'messenger') {
            messageParams.messagingServiceSid = message.messagingServiceSid || context.MESSAGING_SERVICE_SID;
```

Replace with:

```js
          } else if (channel === 'messenger') {
            // Two valid shapes, and only one may be used at a time: a Messaging
            // Service that owns the Page, or a Page ID in From. The sender
            // dropdown supplies an MG SID, so detect that and drop From.
            const fromValue = String(messageParams.from || '');
            const mg = (v) => /^MG[0-9a-f]{32}$/i.test(v);

            if (mg(fromValue)) {
              messageParams.messagingServiceSid = fromValue;
              delete messageParams.from;
            } else {
              const svc = message.messagingServiceSid || context.MESSAGING_SERVICE_SID;
              if (svc) messageParams.messagingServiceSid = svc;
              // Idempotent, like the whatsapp prefix: a caller may already have
              // supplied `messenger:<id>`.
              const ms = (v) => (String(v).startsWith('messenger:') ? String(v) : `messenger:${v}`);
              if (fromValue) messageParams.from = ms(fromValue);
              messageParams.to = ms(messageParams.to);
            }
```

Both files. One without the other reproduces the divergence that caused the `contentVariables` bug.

Note the `if (svc)` guard: the previous code assigned `undefined` when neither a per-message value nor the environment variable was set, which sends an empty parameter.

- [ ] **Step 3: Correct the Messenger label**

In `assets/app.js`, `CHANNEL_SENDER_NOUN` says `messenger: 'Facebook Page'`, but the dropdown now lists Messaging Services. Change it to:

```js
    messenger: 'Messaging Service',
```

- [ ] **Step 4: Verify**

```bash
node --check functions/get-phone-numbers.js && echo "fn OK"
node --check functions/send-messages.js && echo "send OK"
node --check functions/resume-execution.js && echo "resume OK"
node --check assets/app.js && echo "app OK"
grep -c "needsMms" functions/get-phone-numbers.js
grep -c "messaging.v1.services.list" functions/get-phone-numbers.js
grep -c "MG\[0-9a-f\]{32}" functions/send-messages.js functions/resume-execution.js
```

Expected: four `OK` lines, `2` for `needsMms` (it appears on both its declaration and its use inside the filter — `grep -c` counts lines), `1` for the services call, and `1` for the MG pattern in **each** send file.

Then probe the deployed endpoint per channel (credentials from the gitignored `.env.oauthtest`; never echo it). Expected after redeploy: `sms` 13, `mms` **8** (not 13), `whatsapp` 3 of 4, `rcs` 0 of 2, `messenger` 5 Messaging Services.

- [ ] **Step 5: Commit**

```bash
git add functions/get-phone-numbers.js functions/send-messages.js functions/resume-execution.js assets/app.js
git commit -m "fix: use MMS-capable numbers for MMS and Messaging Services for Messenger"
```

---

---

### Task E: One source of truth for campaign counters

Reported by the user from a screenshot: a campaign showed **`Failed: 0`** while two of its messages displayed a red `UNDELIVERED` badge with error 63049, and the progress bar read **166.7% complete**.

**Three defects, one root cause: the counters are incremented at send time and by the webhook, but only *some* are recomputed from the message statuses afterwards.**

1. **`undelivered` is never counted as a failure.** The string appears in exactly one place in the codebase — `assets/app.js:1174`, which picks the badge colour. `check-status.js` recomputes `delivered` and `read` from the statuses map but not `failed`; `webhook.js` never increments `failed` for any status. So a message Meta rejected is reported as a success.
2. **Progress can exceed 100%.** `assets/app.js:1011` computes `((campaign.sent + campaign.failed) / campaign.totalMessages * 100)` with no ceiling. A campaign whose chunk was sent twice reports `sent: 5` against `totalMessages: 3` → 166.7%.
3. **`webhook.js`'s de-duplication guard is inverted and its increments are dead code.** It assigns the merged status object first, then tests `!campaignData.statuses[messageSid].delivered` — which the assignment has already set to `true`. The guard is always false, so the increment never runs. Masked today only because `check-status` recomputes `delivered` separately.

**The fix is structural, not three patches:** `check-status.js` becomes the single place that derives counters from the statuses map. `webhook.js` stops maintaining counters and only records per-message status. That removes the double-counting class of bug rather than correcting one instance of it.

**Terminal failure is defined as `failed` or `undelivered`** — matching what `app.js:1174` already uses for the badge, so the badge and the counter can no longer disagree.

**Not in scope:** `totalMessages` stays the number of recipients (3), even when more message records exist. A campaign has 3 recipients; the table legitimately lists 5 rows because 5 messages were created. Renaming or inflating `totalMessages` would misreport the campaign. Step 3 surfaces the discrepancy explicitly instead.

**Files:**
- Modify: `functions/check-status.js`
- Modify: `functions/webhook.js`
- Modify: `assets/app.js`

- [ ] **Step 1: Derive every counter in `check-status.js`**

Replace the "Calculate delivered and read counts" block with a single derivation. Note `sent` is deliberately *not* derived from the map — it means "messages Twilio accepted", which is what send time recorded.

```js
    // Single source of truth for the derived counters. The webhook records
    // per-message status; this is the only place that counts them, so a badge
    // and a counter cannot disagree.
    //
    // Terminal failure is `failed` or `undelivered`. `undelivered` matters: Meta
    // rejecting a WhatsApp template (error 63049) lands here, and reporting that
    // as a success is worse than reporting nothing.
    const TERMINAL_FAILURE = new Set(['failed', 'undelivered']);

    let delivered = 0;
    let read = 0;
    let failed = 0;
    for (const statusInfo of Object.values(statusUpdates)) {
      const status = String(statusInfo.status || '').toLowerCase();
      if (statusInfo.delivered || status === 'delivered' || status === 'read') {
        delivered++;
      }
      if (statusInfo.read || status === 'read') {
        read++;
      }
      if (TERMINAL_FAILURE.has(status)) {
        failed++;
      }
    }

    campaignData.delivered = delivered;
    campaignData.read = read;
    campaignData.failed = failed;
    // Anything accepted by Twilio that has not yet reached a terminal state.
    // Clamped at zero: a chunk sent twice inflates `sent` past the recipient
    // count, and a negative "pending" is noise rather than information.
    campaignData.pending = Math.max(0, (campaignData.sent || 0) - delivered - failed);
```

- [ ] **Step 2: Stop `webhook.js` maintaining counters**

The webhook's two increments are dead code (the guard is inverted) and duplicate what Step 1 now derives. Delete them. Find the block that increments `campaignData.delivered` and `campaignData.read` — the two `if` statements after the status assignment — and remove both, leaving a comment:

```js
            // Counters are derived in check-status.js from this statuses map, not
            // maintained here. Two writers meant two chances to double-count, and
            // the guard on the increments this replaced was inverted anyway: it
            // tested the object it had just overwritten, so it never fired.
```

Keep everything else: the per-message status assignment, the `delivered`/`read` flags on the individual status entry, and the Sync update.

- [ ] **Step 3: Cap progress and surface a duplicate send**

In `assets/app.js`, replace the percentage calculation at roughly line 1011:

```js
        // Progress is how far through the recipient list we are, not a ratio of
        // send attempts — a resent chunk would otherwise push this past 100%.
        const processed = Number.isFinite(campaign.startIndex)
            ? campaign.startIndex
            : (campaign.sent || 0);
        const percent = campaign.totalMessages > 0
            ? Math.min(100, (processed / campaign.totalMessages) * 100).toFixed(1)
            : '0.0';
```

Then, where the campaign card renders its counters, add a note when more messages exist than recipients. This is the one case where the numbers legitimately look wrong, so say why rather than hide it:

```js
        const duplicateNote = (campaign.sent || 0) > campaign.totalMessages
            ? `<p class="campaign-warning">${campaign.sent} messages sent for ${campaign.totalMessages} recipients — this campaign was sent more than once.</p>`
            : '';
```

Insert `${duplicateNote}` into the campaign card markup after the counters line. Add the style to `assets/styles.css`:

```css
.campaign-warning {
    margin: 8px 0 0;
    font-size: 12px;
    color: var(--warning);
}
```

- [ ] **Step 4: Verify**

```bash
node --check functions/check-status.js && echo "status OK"
node --check functions/webhook.js && echo "webhook OK"
node --check assets/app.js && echo "app OK"
grep -c "TERMINAL_FAILURE" functions/check-status.js
grep -c "campaignData.delivered = (campaignData.delivered || 0) + 1" functions/webhook.js
grep -c "Math.min(100" assets/app.js
```

Expected: three `OK` lines, `2` for `TERMINAL_FAILURE` (declaration plus use), `0` for the removed webhook increment, and `1` for the progress cap.

- [ ] **Step 5: Prove it against the real campaign that exposed the bug**

Campaign `wa-resume-test` on the `oauthtest` deployment has exactly the pathological shape: 3 recipients, 5 messages, 2 of them `undelivered` with error 63049. After redeploy, `check-status` for it must report **`failed: 2`**, `delivered: 3`, `read: 3`, `pending: 0` — and the progress must read `100.0%`, not 166.7%.

Ask the coordinator to redeploy, then confirm with the campaignId in `/tmp/wa_cid.txt`. Report the actual counters.

- [ ] **Step 6: Commit**

```bash
git add functions/check-status.js functions/webhook.js assets/app.js assets/styles.css
git commit -m "fix: count undelivered as failed and stop progress exceeding 100%"
```

---

---

### Task F: Derive the Account SID from the token; sign in with two fields

The design spec asserted the Account SID could not be reliably derived from the access token, citing the sibling project's comment to that effect. **That was wrong, and the spec must be corrected.** The sibling project scans for a bare `AC`-shaped claim, which genuinely is not present — but it never looked for the Twilio Resource Name form.

**Established by decoding a real token on 2026-08-12:**

```
act.sub          = trn:us1:iam:account:AC41b8…533     <- the account
urn:tw:iam_ctx   = trn:us1:iam:account:AC41b8…533     <- same value
sub              = trn:us1:iam:oauthapp:OQdd2247…     <- the OAuth app
```

`authStrategy.getAuthString()` returns the string `"Bearer <jwt>"`; the JWT's payload carries `act.sub`, and the SID extracted from it matched the typed Account SID exactly.

**The user chose `act.sub`** as the source — it is a standard RFC 8693 actor claim rather than Twilio's private `urn:tw:` namespace, so it is the more defensible of the two.

Sign-in becomes **OAuth Client ID + Client Secret only**.

**Consequences to handle deliberately:**

- The Account SID is still required for five v2010 calls that embed it in the URL path (`messages.create`, `incomingPhoneNumbers.list`, `messages(sid).fetch`). Nothing about that changes — it is now *derived* rather than *typed*.
- `setCredentialProvider()` blanks `accountSid`, and the SID is only knowable once a token exists. So derivation must happen in `authenticate()`, after the token fetch — not in `createOAuthClient()`, which has no token yet.
- **A failure to derive breaks every send.** It must throw a clear, distinct error, not fall through to an empty SID producing `/Accounts//Messages.json`.
- The SID-mismatch error class disappears: there is no typed value left to mismatch. Twilio error 70051 still means a missing scope and must keep its message.
- `/verify` should now **return** the derived `accountSid`. This reverses an earlier decision, and correctly: the field was dropped from the response because the caller had just typed it, so echoing it said nothing. Now the caller does not know it, so returning it is the only way the UI can show which account is in use.
- `ownerKey` stays `oauth:<clientId>`. Campaign ownership is unaffected.

**Files:**
- Modify: `assets/twilio-oauth.private.js`
- Modify: `functions/verify.js`
- Modify: `functions/send-messages.js`, `functions/resume-execution.js` (display field only)
- Modify: `assets/index.html`, `assets/app.js`
- Modify: `README.md`, `docs/superpowers/specs/2026-08-07-oauth-login-design.md`

- [ ] **Step 1: `credsFrom` stops requiring an Account SID**

In `assets/twilio-oauth.private.js`, reduce the required set to two fields. Keep the same "name the missing field" behaviour.

```js
function credsFrom(event) {
  const clientId = String(event.clientId || '').trim();
  const clientSecret = String(event.clientSecret || '').trim();

  const missing = [];
  if (!clientId) missing.push('OAuth Client ID');
  if (!clientSecret) missing.push('OAuth Client Secret');
  if (missing.length) {
    throw httpError(400, `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required.`);
  }

  // No accountSid: it is derived from the access token in `authenticate`.
  return { clientId, clientSecret };
}
```

- [ ] **Step 2: Add the extractor**

```js
/**
 * Pulls the Account SID out of an access token's `act.sub` claim.
 *
 * `getAuthString()` returns "Bearer <jwt>". The JWT payload carries the acting
 * account as a Twilio Resource Name:
 *
 *   act.sub = "trn:us1:iam:account:AC0123…"
 *
 * `act` is the RFC 8693 actor claim, preferred over Twilio's private
 * `urn:tw:iam_ctx` (which holds the same value) because it is a standard claim.
 * `urn:tw:iam_ctx` is read only as a fallback.
 *
 * Returns null if no SID can be found — callers must treat that as fatal rather
 * than proceeding with an empty SID, which would build /Accounts//Messages.json.
 */
function accountSidFromAuthString(authString) {
  try {
    const jwt = String(authString || '').split(' ').pop();
    const segment = jwt.split('.')[1];
    if (!segment) return null;
    const payload = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    const candidates = [payload && payload.act && payload.act.sub, payload && payload['urn:tw:iam_ctx']];
    for (const candidate of candidates) {
      const match = String(candidate || '').match(/AC[0-9a-f]{32}/i);
      if (match) return match[0];
    }
  } catch {
    // Malformed token: fall through to null and let the caller fail loudly.
  }
  return null;
}
```

- [ ] **Step 3: `createOAuthClient` no longer sets the SID; `authenticate` does**

Remove the `client.setAccountSid(creds.accountSid)` line and its comment from `createOAuthClient` — there is no token at that point, so the SID is unknowable. Replace the comment with:

```js
  // accountSid is deliberately NOT set here: it comes from the access token, which
  // does not exist until `authenticate` fetches one. Anything using this client
  // directly must set it, or v2010 URIs come out as /Accounts//Messages.json.
```

Then in `authenticate`, derive and set it. Keep the existing deadline handling exactly as it is:

```js
async function authenticate(creds, timeoutMs = TOKEN_DEADLINE_MS) {
  const { client, authStrategy } = createOAuthClient(creds);
  let authString;
  try {
    authString = await withDeadline(
      authStrategy.getAuthString(),
      timeoutMs,
      "Twilio's token endpoint did not respond in time. Try again."
    );
  } catch (err) {
    if (err.name === 'DeadlineError') {
      throw httpError(504, err.message);
    }
    throw httpError(401, tokenErrorMessage(err));
  }

  const accountSid = accountSidFromAuthString(authString);
  if (!accountSid) {
    // Fail loudly. An unset accountSid silently produces /Accounts//Messages.json,
    // which fails later with a far less obvious message.
    throw httpError(
      502,
      'Signed in, but could not read the Account SID from the access token. This is unexpected — the token may have changed shape.'
    );
  }
  client.setAccountSid(accountSid);

  return client;
}
```

Export `accountSidFromAuthString` so `verify.js` can reuse it on the token it already fetches.

- [ ] **Step 4: `verify.js` derives instead of validating**

Two changes. First, step 1's token fetch already has the raw token — decode it there rather than exchanging a second time:

```js
    const token = JSON.parse(text);
    accountSid = oauth.accountSidFromAuthString(token.access_token);
    if (!accountSid) {
      response.setBody({
        valid: false,
        error: 'Signed in, but could not read the Account SID from the access token.',
      });
      return callback(null, response);
    }
```

Second, the phone-number probe now proves scope only, not account ownership — there is no typed SID to disagree with. Build the client and set the derived SID explicitly:

```js
    const { client } = oauth.createOAuthClient(creds);
    client.setAccountSid(accountSid);
    await oauth.withDeadline(
      client.incomingPhoneNumbers.list({ limit: 1 }),
      PROBE_TIMEOUT_MS,
      'Timed out reading phone numbers. Try again.'
    );
```

Simplify `describeAccountError`: **delete** the two messages about credentials not belonging to the Account SID — that case can no longer arise. **Keep** the 70051 branch, reworded to name only the scope, and keep the DeadlineError and transient-token branches.

Finally, return the derived SID so the UI can show which account is in use:

```js
  response.setBody({ valid: true, accountSid });
```

- [ ] **Step 5: The two send Functions use the client's SID for display**

In both `functions/send-messages.js` and `functions/resume-execution.js`, the campaign document stores `accountSid` for display. `creds.accountSid` no longer exists. Change it to read from the authenticated client:

```js
          accountSid: client.accountSid, // display only; never an authorization key
```

In `send-messages.js` that is inside the `documents.create` payload. Check `resume-execution.js` for the same field and update it if present.

- [ ] **Step 6: Drop the field from the form**

In `assets/index.html`, remove the entire Account SID form group — the label, the `#account-sid` input, and its help text. Leave `#client-id` and `#client-secret` untouched.

Update the help paragraph under the form to stop mentioning the Account SID, and say the account is detected automatically.

- [ ] **Step 7: `app.js` — two fields, and show the detected account**

- `handleLogin`: build `candidate` from `#client-id` and `#client-secret` only. Do **not** read `#account-sid`; it no longer exists and `getElementById` would return null.
- On success, `/verify` returns `accountSid`. Store it alongside the credentials so the UI can display it, but **never** send it as an authorization input:

```js
        saveCreds({ ...candidate, accountSid: data.accountSid });
```

- `loadCreds`: validate on `clientId` and `clientSecret` only. A stored blob from before this change contains all three and stays valid — do not reject it.
- `postToFunction` spreads `creds`, which now includes `accountSid`. That is harmless: the Functions ignore it and derive their own. Add a brief comment saying so, so nobody later mistakes it for an input.
- Display the account somewhere unobtrusive in the header, e.g. `Account ${creds.accountSid}` next to the sign-out button, only when present.

- [ ] **Step 8: Correct the spec and the README**

In `docs/superpowers/specs/2026-08-07-oauth-login-design.md`, the section "The Account SID is still required" now states something disproven. Rewrite it: the SID is still required *by the API*, but it is derived from `act.sub`, not typed. Record the observed claim shape and note explicitly that the earlier reasoning — that the claim was unreliable — was based on looking for a bare `AC` value rather than the TRN form.

In `README.md`: sign-in is two fields; remove the Account SID row from the instructions; and remove the two "do not belong to that Account SID" troubleshooting bullets, since that error can no longer occur. Keep the 70051 scope bullet.

- [ ] **Step 9: Verify**

```bash
for f in assets/app.js assets/twilio-oauth.private.js functions/verify.js functions/send-messages.js functions/resume-execution.js; do
  node --check "$f" || echo "SYNTAX FAIL: $f"
done
grep -c "accountSidFromAuthString" assets/twilio-oauth.private.js
grep -n "account-sid" assets/index.html assets/app.js || echo "field fully removed: OK"
grep -n "setAccountSid" assets/twilio-oauth.private.js functions/verify.js
grep -rn "creds.accountSid" functions/ || echo "no Function reads creds.accountSid: OK"
```

Expected: no syntax failures; `3` for the extractor (declaration, use in `authenticate`, export); no `account-sid` anywhere; `setAccountSid` present in `authenticate` and in `verify.js` but **not** in `createOAuthClient`; and no Function reading `creds.accountSid`.

- [ ] **Step 10: Prove it end to end**

Probe with real credentials from the gitignored `.env.oauthtest` (never echo it), against the **local** code first via a stubbed handler, then ask the coordinator to redeploy and confirm:

1. `POST /verify` with only `clientId` + `clientSecret` returns `{"valid":true,"accountSid":"AC…"}`, and that SID equals `$APP_A_SID`.
2. `POST /verify` with a missing `clientSecret` returns HTTP 400 naming that field — and does **not** mention an Account SID.
3. `POST /get-phone-numbers` with two fields returns the 13 SMS senders, proving the derived SID reached the v2010 URL path.
4. A 1-message SMS send with two fields succeeds, proving `messages.create` got a real SID rather than an empty one.
5. Campaign ownership still holds: a second OAuth app gets an identical 404 from `check-status`.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: derive the Account SID from the token and sign in with two fields"
```

---

---

### Task G: Offer a Messaging Service as the From on every channel

Requested by the user. A Messaging Service can send on any channel, picking a sender from its pool — that is the recommended production shape (sticky sender, geo-match, pool failover). Today it is offered for Messenger only.

**The trap this task exists to avoid.** The channel prefix helpers glue their prefix onto whatever sits in `from`:

```js
const wa = (v) => (String(v).startsWith('whatsapp:') ? String(v) : `whatsapp:${v}`);
messageParams.from = wa(messageParams.from);
```

Task D put the `MG…` detection *inside* the messenger branch, so it protects only that channel. Offer a service for WhatsApp with the code as it stands and you get `from: "whatsapp:MG7f6b5fdd…"`, which fails on every message. So **sender resolution must be hoisted above all channel prefixing**, and `from` must only ever be prefixed when it holds a concrete sender.

A second rule falls out of the same restructure: **the recipient always takes the channel prefix; the sender only does when it is not a service.** Those two were tangled together in one branch before.

**Files:**
- Modify: `functions/get-phone-numbers.js`
- Modify: `functions/send-messages.js`, `functions/resume-execution.js`
- Modify: `assets/app.js`

- [ ] **Step 1: Return Messaging Services for every channel**

In `functions/get-phone-numbers.js`, tag each sender with a `kind` so the frontend can group them, and fetch the services concurrently with the channel-specific list — this adds a second API call inside a 10-second budget, so do not serialise them.

Restructure the branch so it computes `direct` senders, then appends services:

```js
    const channel = String(event.channel || 'sms').toLowerCase();

    // A Messaging Service can send on any channel, so it is offered everywhere.
    // Fetched concurrently with the channel-specific list: this is a second network
    // call inside a 10s Function budget, and serialising them wastes headroom.
    const servicesPromise = client.messaging.v1.services.list({ limit: 50 });

    let directPromise;
    if (channel === 'whatsapp' || channel === 'rcs') {
      directPromise = client.messaging.v2.channelsSenders
        .list({ channel, limit: 100 })
        .then((registered) => ({
          total: registered.length,
          senders: registered
            .filter((s) => String(s.status || '').toUpperCase() === 'ONLINE')
            .map((s) => ({
              value: s.senderId,
              label: s.profile && s.profile.name
                ? `${s.senderId.replace(/^[a-z]+:/, '')} · ${s.profile.name}`
                : s.senderId.replace(/^[a-z]+:/, ''),
              status: s.status,
              kind: 'direct',
            })),
        }));
    } else if (channel === 'messenger') {
      // Facebook Pages are not exposed by any list API, so a Messaging Service that
      // owns the Page is the only selectable sender here.
      directPromise = Promise.resolve({ total: 0, senders: [] });
    } else {
      const needsMms = channel === 'mms';
      directPromise = client.incomingPhoneNumbers.list({ limit: 100 }).then((numbers) => {
        const capable = numbers.filter((n) => {
          const c = n.capabilities || {};
          const flag = needsMms ? c.mms : c.sms;
          return flag === true || flag === 'true';
        });
        return {
          total: capable.length,
          senders: capable.map((n) => ({
            value: n.phoneNumber,
            label: n.friendlyName && n.friendlyName !== n.phoneNumber
              ? `${n.phoneNumber} · ${n.friendlyName}`
              : n.phoneNumber,
            status: 'ONLINE',
            kind: 'direct',
          })),
        };
      });
    }

    const [direct, services] = await Promise.all([directPromise, servicesPromise]);

    const serviceSenders = services.map((s) => ({
      value: s.sid,
      label: `${s.friendlyName} · ${s.sid.slice(0, 10)}…`,
      status: 'ONLINE',
      kind: 'service',
    }));

    response.setStatusCode(200);
    response.setBody({
      success: true,
      channel,
      senders: [...direct.senders, ...serviceSenders],
      directCount: direct.senders.length,
      serviceCount: serviceSenders.length,
      usableCount: direct.senders.length + serviceSenders.length,
      totalRegistered: direct.total,
      phoneNumbers: direct.senders.map((s) => ({ phoneNumber: s.value })),
    });
    return callback(null, response);
```

- [ ] **Step 2: Hoist sender resolution above channel prefixing, in BOTH send files**

In `functions/send-messages.js` and `functions/resume-execution.js`, replace the whole `// Add channel-specific parameters` block with:

```js
          // Resolve the sender BEFORE any channel prefixing. A Messaging Service is
          // chosen by SID and must travel as messagingServiceSid — never as From, and
          // never with a channel prefix glued to it. This was inside the messenger
          // branch until a service became selectable on every channel; left there,
          // picking one for WhatsApp produced from: "whatsapp:MG7f6b…".
          const MESSAGING_SERVICE_SID = /^MG[0-9a-f]{32}$/i;
          const usingService = MESSAGING_SERVICE_SID.test(String(messageParams.from || ''));
          if (usingService) {
            messageParams.messagingServiceSid = String(messageParams.from);
            delete messageParams.from;
          }

          // The recipient always takes the channel prefix. From only takes it when a
          // concrete sender was chosen — a service SID must stay bare.
          if (channel === 'whatsapp') {
            const wa = (v) => (String(v).startsWith('whatsapp:') ? String(v) : `whatsapp:${v}`);
            messageParams.to = wa(messageParams.to);
            if (messageParams.from) messageParams.from = wa(messageParams.from);
          } else if (channel === 'messenger') {
            const ms = (v) => (String(v).startsWith('messenger:') ? String(v) : `messenger:${v}`);
            messageParams.to = ms(messageParams.to);
            if (messageParams.from) messageParams.from = ms(messageParams.from);
            if (!usingService) {
              const svc = message.messagingServiceSid || context.MESSAGING_SERVICE_SID;
              if (svc) messageParams.messagingServiceSid = svc;
            }
          } else if (channel === 'mms' || channel === 'rcs') {
            if (message.mediaUrl) {
              messageParams.mediaUrl = Array.isArray(message.mediaUrl) ? message.mediaUrl : [message.mediaUrl];
            }
          }
```

Two notes on what changed and why:

- **`mms` and `rcs` are merged.** Their bodies are now identical. The old `rcs` branch also re-assigned `messageParams.contentSid`, which the general content-template block above already set — along with `contentVariables`, which that duplicate omitted. Dropping the duplicate is safe and removes a line that looked like it handled templates while handling them worse.
- `context.MESSAGING_SERVICE_SID` remains the messenger fallback for a typed Page ID, guarded by `if (svc)` so an unset variable is not sent as `undefined`.

- [ ] **Step 3: Group the dropdown**

In `assets/app.js`, `renderSenderOptions` currently appends a flat list. Split it into two `<optgroup>`s so a service is not mistaken for a phone number:

```js
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
```

Update the help text to name both counts, and the empty state to fire only when *both* are empty:

```js
    const parts = [];
    if (data.directCount) parts.push(`${data.directCount} ${noun}${data.directCount === 1 ? '' : 's'}`);
    if (data.serviceCount) parts.push(`${data.serviceCount} Messaging Service${data.serviceCount === 1 ? '' : 's'}`);
    const hidden = (data.totalRegistered || 0) - (data.directCount || 0);
    setSenderHelp(
        parts.join(' · ') + (hidden > 0 ? ` · ${hidden} not online` : ''),
        false
    );
```

The existing `if (!senders.length)` empty state already covers "both empty", since `senders` is the concatenation — keep it, but make its message mention that no Messaging Services exist either.

- [ ] **Step 4: Verify**

```bash
for f in functions/get-phone-numbers.js functions/send-messages.js functions/resume-execution.js assets/app.js; do
  node --check "$f" || echo "SYNTAX FAIL: $f"
done
grep -c "MESSAGING_SERVICE_SID = /" functions/send-messages.js functions/resume-execution.js
grep -c "usingService" functions/send-messages.js functions/resume-execution.js
grep -c "optgroup" assets/app.js
grep -c "Promise.all(\[directPromise, servicesPromise\])" functions/get-phone-numbers.js
```

Expected: no syntax failures; `1` for the regex and `3` for `usingService` in **each** send file; at least `1` for `optgroup`; `1` for the concurrent fetch.

- [ ] **Step 5: Prove the trap is closed**

This is the point of the task. With a probe against the real handlers of **both** send files, for each of `sms`, `mms`, `whatsapp`, `rcs`, `messenger`, capture the `messageParams` passed to `messages.create` when `from` is a Messaging Service SID, and confirm for every channel:

- `messagingServiceSid` equals the SID
- `from` is **absent** from the params
- **no `whatsapp:MG…` or `messenger:MG…` value appears anywhere**
- `to` still carries the channel prefix for whatsapp and messenger, and does not for sms/mms/rcs

Then repeat with a concrete sender (`+6500000000` for whatsapp, `+1…` for sms) and confirm `from` is present and prefixed correctly, with no `messagingServiceSid` set except on messenger's env fallback.

Report the actual params for every combination.

- [ ] **Step 6: Commit**

```bash
git add functions/get-phone-numbers.js functions/send-messages.js functions/resume-execution.js assets/app.js
git commit -m "feat: offer a Messaging Service as the From on every channel"
```

---

---

### Task H: Port the top bar and sign-in card from the sibling project

Requested by the user: the top bar's icon, colour and Sign Out button, and the sign-in page, should match `twilio-lookup-api-ui`. The current top bar renders a **phone emoji** via `.top-nav .logo::before { content: "📱" }` — replace it with the real Twilio logo image that project uses. Also delete the sentence *"The account is detected automatically from your credentials."* from the sign-in page.

**Reference files** (read them; do not invent an alternative):
- `/Users/hng/Documents/GitHub/twilio-lookup-api-ui/assets/index.html` — the `<nav class="topbar">` block at lines 50-60, and the `.login-card` block at lines 18-46
- `/Users/hng/Documents/GitHub/twilio-lookup-api-ui/assets/styles.css` — `.topbar*` rules, and `.login-view` / `.login-card*` at lines 593-670
- `/Users/hng/Documents/GitHub/twilio-lookup-api-ui/assets/twilio_logo.png` — 200×200 PNG, displayed at 30px in the bar and 36px on the card

**Files:**
- Create: `assets/twilio_logo.png` (copied from the reference project)
- Modify: `assets/index.html`, `assets/styles.css`

- [ ] **Step 1: Copy the logo asset**

```bash
cp /Users/hng/Documents/GitHub/twilio-lookup-api-ui/assets/twilio_logo.png assets/twilio_logo.png
```

It deploys as a **public** asset at `/twilio_logo.png` — correct, it is a logo. Reference it as `twilio_logo.png` (relative), matching how `styles.css` is referenced in this project.

- [ ] **Step 2: Add the missing token**

`:root` in `assets/styles.css` has no `--header-height`; the ported `.topbar` needs it. Add it alongside the other tokens:

```css
    --header-height: 56px;
```

- [ ] **Step 3: Replace the top bar markup**

In `assets/index.html`, replace the whole `<nav class="top-nav">…</nav>` block with the sibling project's shape. **The two IDs must survive verbatim** — `app.js` reads `logout-btn` and `account-indicator`, and renaming either silently breaks sign-out or the account display:

```html
            <nav class="topbar">
                <div class="topbar__logo">
                    <img src="twilio_logo.png" alt="Twilio" width="30" height="30">
                    <span>Twilio</span>
                </div>
                <div class="topbar__sep"></div>
                <span class="topbar__title">Messaging — Bulk Sender</span>
                <div class="topbar__spacer"></div>
                <span class="topbar__account" id="account-indicator"></span>
                <button type="button" class="topbar__signout" id="logout-btn">Sign out</button>
            </nav>
```

Note the button loses `class="btn btn-secondary"` and gains `topbar__signout` — that is the point of the request. Its label becomes "Sign out" (sentence case), matching the sibling project.

- [ ] **Step 4: Port the top bar CSS and delete the emoji**

Delete the `.top-nav`, `.top-nav .nav-content`, `.top-nav .logo`, **`.top-nav .logo::before`** (the phone emoji) and `.top-nav .nav-actions` rules. Replace with the sibling project's rules, adapted to this project's token names:

```css
.topbar {
    position: sticky;
    top: 0;
    z-index: 100;
    height: var(--header-height);
    background: var(--twilio-navy);
    display: flex;
    align-items: center;
    padding: 0 24px;
    gap: 16px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.topbar__logo {
    display: flex;
    align-items: center;
    gap: 10px;
}

.topbar__logo img {
    width: 30px;
    height: 30px;
    display: block;
}

.topbar__logo span {
    color: #FFFFFF;
    font-weight: 600;
    font-size: 15px;
    letter-spacing: -0.01em;
}

.topbar__sep {
    width: 1px;
    height: 24px;
    background: rgba(255, 255, 255, 0.15);
}

.topbar__title {
    color: rgba(255, 255, 255, 0.85);
    font-size: 14px;
    font-weight: 400;
}

.topbar__spacer {
    flex: 1;
}

.topbar__account {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.65);
    font-family: var(--mono);
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.topbar__signout {
    background: none;
    border: 1px solid rgba(255, 255, 255, 0.25);
    color: rgba(255, 255, 255, 0.8);
    font-size: 12px;
    font-family: var(--font);
    font-weight: 500;
    padding: 5px 12px;
    border-radius: var(--radius);
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
}

.topbar__signout:hover {
    background: rgba(255, 255, 255, 0.1);
    border-color: rgba(255, 255, 255, 0.4);
}

.topbar__signout:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.25);
}
```

**Check the cascade.** The generic `.btn` rules added earlier are broad; confirm no leftover rule still targets the sign-out button now that it no longer carries `.btn`. Also confirm `.top-nav` is fully gone — a stale rule with `content: "📱"` left in the file would reappear if any markup still used that class.

- [ ] **Step 5: Rebuild the sign-in screen as a login card**

Replace the `.login-container` / `.login-header` / `.login-form` markup inside `#login-screen` with the sibling project's card shape. **Keep every ID**: `login-form`, `client-id`, `client-secret`, `login-btn`, `login-error`. Keep it a real `<form>` with a `type="submit"` button — `app.js` binds the form's `submit` event, unlike the sibling project which binds a button click.

```html
        <div id="login-screen" class="screen active">
            <div class="login-view">
                <div class="login-card">
                    <div class="login-card__logo">
                        <img src="twilio_logo.png" alt="Twilio" width="36" height="36">
                        <span>Twilio</span>
                    </div>
                    <h1 class="login-card__title">Messaging — Bulk Sender</h1>
                    <p class="login-card__subtitle">
                        Sign in with a Twilio OAuth app. Your credentials are stored only in this browser.
                    </p>

                    <form id="login-form">
                        <div class="form-group">
                            <label for="client-id">Client ID</label>
                            <input type="text" id="client-id" required spellcheck="false"
                                   autocomplete="username"
                                   placeholder="Your OAuth app's Client ID">
                        </div>
                        <div class="form-group">
                            <label for="client-secret">Client Secret</label>
                            <input type="password" id="client-secret" required spellcheck="false"
                                   autocomplete="current-password"
                                   placeholder="••••••••••••••••••••••••••••••••">
                        </div>
                        <button type="submit" id="login-btn" class="btn btn-primary login-card__submit">Sign in</button>
                    </form>

                    <p class="login-card__error" id="login-error"></p>
                    <p class="login-card__hint">
                        Create an OAuth app in the Twilio Console under
                        <strong>Settings &rsaquo; Account settings &rsaquo; OAuth applications</strong>,
                        granting the <strong>Messaging</strong>, <strong>Phone Numbers</strong> and
                        <strong>Content</strong> scopes.
                    </p>
                </div>
            </div>
        </div>
```

The sentence *"The account is detected automatically from your credentials."* is deliberately **not** carried over — the user asked for it gone.

- [ ] **Step 6: Port the login card CSS**

```css
.login-view {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg);
    padding: 24px;
}

.login-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md);
    padding: 32px;
    width: 100%;
    max-width: 420px;
}

.login-card__logo {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 20px;
}

.login-card__logo img { display: block; }

.login-card__logo span {
    font-weight: 700;
    font-size: 16px;
    color: var(--twilio-navy);
    letter-spacing: -0.01em;
}

.login-card__title {
    margin: 0 0 6px;
    font-size: 19px;
    font-weight: 700;
    color: var(--twilio-navy);
    letter-spacing: -0.02em;
}

.login-card__subtitle {
    margin: 0 0 24px;
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.5;
}

.login-card__submit {
    width: 100%;
    padding: 11px;
    font-size: 14px;
    margin-top: 20px;
}

.login-card__error {
    margin: 12px 0 0;
    font-size: 13px;
    color: var(--danger);
    font-weight: 500;
    display: none;
}

.login-card__error.show { display: block; }

.login-card__hint {
    margin: 20px 0 0;
    padding-top: 16px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.5;
}

.login-card__hint strong {
    font-weight: 600;
    color: var(--text);
}
```

**Two cascade hazards to resolve, not assume away:**

1. `#login-error` is toggled by `app.js` with `classList.add('show')` / `remove('show')`. The old `.login-error` rule may also target it. Confirm exactly one rule governs its visibility, and that `.login-card__error.show` wins — otherwise a failed sign-in shows nothing.
2. `.screen` / `.screen.active` control which view is visible. `.login-view` is a flex centering container *inside* `#login-screen`. Read the `.screen` rules and confirm `display` does not conflict — if `.screen.active` sets `display: block`, the inner `.login-view` flex still works, but verify rather than assume.

Delete the now-unused `.login-container`, `.login-header` and `.login-help` rules, and any `.login-form` rule that no longer applies.

- [ ] **Step 7: Verify**

```bash
test -f assets/twilio_logo.png && echo "logo present: OK"
grep -c "📱" assets/styles.css assets/index.html
grep -n "top-nav" assets/index.html assets/styles.css || echo "top-nav fully removed: OK"
grep -n "detected automatically" assets/index.html || echo "sentence removed: OK"
grep -c "header-height" assets/styles.css
for id in login-form client-id client-secret login-btn login-error logout-btn account-indicator; do
  printf '%-20s ' "$id"; grep -c "id=\"$id\"" assets/index.html
done
comm -23 <(grep -oE 'var\(--[a-z0-9-]+' assets/styles.css | sed 's/var(//' | sort -u) \
         <(grep -oE '^\s*--[a-z0-9-]+' assets/styles.css | tr -d ' ' | sed 's/:$//' | sort -u)
```

Expected: logo present; `0` emoji in both files; no `top-nav` anywhere; sentence gone; `--header-height` referenced at least twice (definition + use); every ID exactly `1`; and no output from the variable audit.

- [ ] **Step 8: Commit**

```bash
git add assets/twilio_logo.png assets/index.html assets/styles.css
git commit -m "style: port the top bar and sign-in card from twilio-lookup-api-ui"
```

---

---

### Task I: Stop the 5-second refresh resetting scroll, and export the delivery table to CSV

Two user requests.

**1. Scrolling back through campaigns keeps jumping to the top.** Root cause: `startStatusAutoRefresh` runs a `setInterval` every 5 seconds calling both `checkCampaignStatus()` and `loadCampaigns()`. Each rebuilds its panel with a wholesale `innerHTML` assignment (`assets/app.js:1126` for the campaign list, `displayMessageDetails` for the delivery table), which destroys the scroll container and resets `scrollTop` to 0. **Both panels are affected**, not just the campaign list — the delivery table's own `overflow-y: auto` container is rebuilt on the same tick.

**2. Export the Message Delivery Status table to CSV.**

For the CSV, match the sibling project's helpers rather than inventing new ones — `toCsv` and `downloadCsv` in `/Users/hng/Documents/GitHub/twilio-lookup-api-ui/assets/app.js:589-615`. They use RFC-style escaping (`"` doubled, fields quoted when they contain `"`/`,`/CR/LF), CRLF line endings, and a UTF-8 BOM so Excel reads it correctly.

**Files:**
- Modify: `assets/app.js`, `assets/index.html`, `assets/styles.css`

- [ ] **Step 1: Two small helpers for preserving scroll**

Add near the top of `assets/app.js`:

```js
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
```

- [ ] **Step 2: Apply both to the campaign list**

In `displayCampaigns`, before building `html`, compute a signature over everything the markup depends on — including `currentCampaignId`, because the active highlight changes without the campaign data changing:

```js
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
```

Then wrap the existing write at the end of the function:

```js
    withPreservedScroll(campaignsContent, '.campaigns-list', () => {
        campaignsContent.innerHTML = html;
    });
```

- [ ] **Step 3: Give the delivery table's scroll container a class, and apply the same treatment**

The table's scrollable wrapper is currently an inline-styled `div` with no class, so it cannot be selected. In `displayMessageDetails`, change:

```html
        <div style="overflow-x: auto; max-height: 600px; overflow-y: auto;">
```

to:

```html
        <div class="message-status-scroll">
```

and add the rule to `assets/styles.css`:

```css
.message-status-scroll {
    overflow-x: auto;
    overflow-y: auto;
    max-height: 600px;
}
```

Then in `displayMessageDetails`, add a signature check over the statuses and counters, and wrap its write:

```js
    const signature = JSON.stringify([
        campaign.campaignId, campaign.sent, campaign.failed, campaign.delivered,
        campaign.read, campaign.totalMessages,
        statusEntries.map(([sid, s]) => [sid, s.status, s.delivered, s.read, s.errorCode, s.dateUpdated]),
    ]);
    if (renderUnchanged('details', signature, Boolean(messageDetailsContent.querySelector('.message-status-scroll')))) {
        return;
    }
```

and at the end:

```js
    withPreservedScroll(messageDetailsContent, '.message-status-scroll', () => {
        messageDetailsContent.innerHTML = html;
    });
```

**Careful:** the signature check must sit *after* `statusEntries` is built and sorted, and the early `return` for "no messages yet" must stay before it — otherwise an empty campaign caches a signature for markup it never wrote.

- [ ] **Step 4: Remember which campaign is displayed**

The export needs the data currently on screen. Add a module-level holder and set it in `displayMessageDetails`:

```js
// The campaign currently rendered in the delivery panel, so Export CSV can use it.
let displayedCampaign = null;
```

Set `displayedCampaign = campaign;` at the top of `displayMessageDetails`, **before** the signature early-return — the export must work even on a tick that skipped redrawing.

- [ ] **Step 5: CSV helpers, matching the sibling project**

```js
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
```

- [ ] **Step 6: The export itself**

Columns mirror the on-screen table exactly, in the same order, so the file matches what the user is looking at:

```js
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
        'Message SID': sid,
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
```

- [ ] **Step 7: Wire up the button**

In `assets/index.html`, the Message Delivery Status header has a Close button. Add an Export CSV button before it:

```html
                                    <div style="display: flex; gap: 8px; align-items: center;">
                                        <button id="export-csv-btn" class="btn btn-secondary" style="padding: 5px 15px; font-size: 14px;">Export CSV</button>
                                        <button id="close-message-details-btn" class="btn btn-secondary" style="padding: 5px 15px; font-size: 14px;">Close</button>
                                    </div>
```

Match the existing Close button's markup and inline sizing rather than introducing a new style. In `setupEventListeners`, alongside the existing close handler:

```js
    const exportCsvBtn = document.getElementById('export-csv-btn');
    if (exportCsvBtn) {
        exportCsvBtn.addEventListener('click', exportMessageStatusCsv);
    }
```

- [ ] **Step 8: Verify**

```bash
node --check assets/app.js && echo "app OK"
grep -c "withPreservedScroll" assets/app.js
grep -c "renderUnchanged" assets/app.js
grep -c "message-status-scroll" assets/app.js assets/styles.css
grep -n 'style="overflow-x: auto; max-height: 600px' assets/app.js || echo "inline scroll style replaced: OK"
grep -c "export-csv-btn" assets/index.html assets/app.js
comm -23 <(grep -oE 'var\(--[a-z0-9-]+' assets/styles.css | sed 's/var(//' | sort -u) \
         <(grep -oE '^\s*--[a-z0-9-]+' assets/styles.css | tr -d ' ' | sed 's/:$//' | sort -u)
```

Expected: `app OK`; `3` for `withPreservedScroll` (declaration + two uses); `3` for `renderUnchanged`; `3` in `app.js` for `message-status-scroll` (the markup plus the two `querySelector` calls) and `1` in `styles.css`; the inline style gone; `1` in each file for the button; empty variable audit.

- [ ] **Step 9: Prove the behaviour**

`node` cannot exercise scroll, so prove what is provable and state the rest plainly for the user to confirm:

1. **Signature skipping works.** Extract `renderUnchanged` and drive it directly: same key + same signature + present → `true` on the second call; a changed signature → `false`; `stillPresent = false` → `false` even when the signature matches (so a cleared panel always redraws). Report actual results.
2. **The CSV is correct.** Extract `toCsv` and run it over rows containing a comma, a double quote, a newline and an empty value. Confirm the output quotes exactly the fields that need it, doubles the inner quote, and uses CRLF. Report the raw output with escapes visible.
3. **The filename sanitiser** turns a campaign name with spaces and slashes into a safe filename. Report input and output.
4. State clearly that the scroll-preservation itself needs the user's eyes: scroll down the campaign list, wait through two 5-second ticks, and confirm the position holds.

- [ ] **Step 10: Commit**

```bash
git add assets/app.js assets/index.html assets/styles.css
git commit -m "fix: keep scroll position through the 5s refresh, and export delivery status to CSV"
```

---

## Done When

- [ ] Selecting WhatsApp lists WhatsApp senders, not SMS numbers
- [ ] Selecting RCS shows an explicit empty state naming how many are registered but not online
- [ ] No `whatsapp:whatsapp:` prefix is possible from either send Function
- [ ] Every select has a chevron clear of the field edge
- [ ] The template filter row sits inside its card at narrow widths
- [ ] The campaign card's top edge is not clipped
- [ ] Buttons have a visible primary/secondary/danger hierarchy with hover, active and focus states
- [ ] No CSS variable is referenced but undefined
- [ ] The OAuth migration's security properties still hold after redeploy
