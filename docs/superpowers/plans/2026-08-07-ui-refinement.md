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
