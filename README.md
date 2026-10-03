# Starshift WA Sender

Chrome extension to send WhatsApp messages in bulk to individual numbers and
groups, with Excel import, message personalization, file attachments, a
time-gap between sends, and scheduling for a future date/time. Includes a
small backend that handles licensing, one-click activation links and password
resets, so the extension can be rented out to customers on monthly plans.

**Important:** this automates the normal web.whatsapp.com UI (no official
WhatsApp Business API). Only message people who've agreed to receive your
messages, keep sending volumes and pace reasonable, and follow WhatsApp's
Terms of Service — aggressive bulk sending can get a number banned.

## Project layout

```
extension/     Chrome extension (Manifest V3)
  popup/       Login popup: password login, activation code, password reset
  dashboard/   Main app: upload contacts, compose, attach, schedule
  background/  Service worker: campaign queue, alarms, time-gap timing
  content/     Injected into web.whatsapp.com to drive the UI
  lib/         SheetJS (xlsx) bundled locally for Excel parsing
  assets/      Downloadable sample Excel template
backend/       Node/Express licence server (login, activation links, resets)
  public/      The page a customer's activation link opens
templates/     Source copy of the sample Excel template
scripts/       One-off generators (icons, template) - not needed at runtime
```

## 1. Run the backend (licence server)

```
cd backend
npm install
copy .env.example .env      (PowerShell: Copy-Item .env.example .env)
npm start
```

Runs on `http://localhost:5001`. Password-reset codes are printed to this
console by default (see `backend/utils/sms.js`) so you can test without an SMS
account. To send them for real, set `SMS_PROVIDER` in `.env` and fill in the
provider code in `utils/sms.js` (Twilio/MSG91/2Factor/etc).

`.env` settings that matter once you rent the extension out:

| Setting           | What it does                                                        |
|-------------------|---------------------------------------------------------------------|
| `PUBLIC_BASE_URL` | The public address of this backend. Activation links are built from it — `localhost` only works on your own PC. |
| `EXTENSION_ID`    | The extension's ID from `chrome://extensions`. Lets the activation page sign the customer in with one click. |
| `ADMIN_MOBILE` / `ADMIN_PASSWORD` | Your own login; only this account sees the Admin Panel. |

Hosting it publicly also means editing two places in the extension:
`API_BASE` in `extension/common/config.js`, and `host_permissions` plus
`externally_connectable.matches` in `extension/manifest.json` (replace
`http://localhost/*` with your domain).

## 2. Load the extension in Chrome

1. Go to `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked" and select the `extension/` folder
4. Pin the extension, click its icon, and log in with your mobile number + password

## 3. Renting it out (Admin Panel)

Log in with your `ADMIN_MOBILE`, open the popup and click **Admin Panel**.

**Add a customer** — name, mobile with country code, and a plan of 1 / 3 / 6 /
12 months. You get back two things:

- an **activation link** — send this to the customer. They install Starshift WA Sender,
  open the link, and they are signed in. Nothing to type. The link keeps
  working while their plan runs, so a reinstall or a second PC needs no new
  one. **Activation link** on their row shows it again, or makes a new one
  (which kills the old).
- a **password** — their backup way in, shown only once.

**Deactivate**, **Renew**, **Reset password** and **Delete** all take effect on
the customer's next action: the extension re-checks the licence with the server
on every use, and a running campaign stops the moment the account goes
inactive or the plan ends.

**If a customer forgets their password** they can fix it themselves: popup →
**Forgot password?** → a one-time code goes to their mobile → they set a new
one. That needs `SMS_PROVIDER` configured; without it, use **Reset password**
in the Admin Panel instead.

## 4. Prepare your contact list

Click **Download sample template** in the dashboard, or use
`templates/bulk_contacts_template.xlsx` directly. Columns:

| Column         | Meaning                                                                 |
|----------------|--------------------------------------------------------------------------|
| Sr No          | Optional, for your own reference                                       |
| Name           | Used in the message as `{{name}}`                                      |
| Mobile Number  | Number **without** country code, e.g. `8873520027` (blank for groups)  |
| Country Code   | e.g. `91` for India                                                     |
| Group Name     | Fill only to send to a WhatsApp Group by name (leave Mobile blank)     |
| Custom1        | Extra field for personalization -> `{{custom1}}`                       |
| Custom2        | Extra field for personalization -> `{{custom2}}`                       |

Each row is **either** an individual contact (Mobile Number filled) **or**
a group (Group Name filled) — not both.

## 5. Create a campaign

In the dashboard:
1. Upload the Excel file — a preview table shows what was parsed.
2. Write your message, using `{{name}}`, `{{custom1}}`, `{{custom2}}` as placeholders.
3. Optionally attach an image/video/document with a caption.
4. Set the time gap between messages (seconds) — keep this reasonable (15s+)
   to reduce the chance of WhatsApp flagging the number.
5. Choose **Send Now** or **Schedule for later** (pick date & time).
6. Name the campaign and click **Save & Start / Schedule Campaign**.

Progress (sent / failed / pending) shows live in the Campaigns list. Chrome
must stay open for scheduled/queued sends to go out — the extension resumes
in-progress campaigns automatically if Chrome restarts.

## Notes & limitations

- WhatsApp Web's DOM changes periodically; if sends start failing, the
  selectors in `extension/content/content.js` (`SELECTORS` object) are the
  first place to check/update.
- The very first time, you must have already scanned the WhatsApp Web QR
  code in this Chrome profile (normal WhatsApp Web login) — the extension
  automates an already-logged-in session, it does not replace WhatsApp's
  own device linking.
- The login here is for **Starshift WA Sender access** (licensing/account), separate
  from linking your WhatsApp account to WhatsApp Web.
- An activation link is a credential: anyone who has it can use that
  customer's plan. Treat it like a password, and generate a new one from the
  Admin Panel if it leaks.
