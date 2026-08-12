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
