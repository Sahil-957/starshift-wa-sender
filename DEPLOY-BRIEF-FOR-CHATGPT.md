# Context brief + request — deploying "Starshift WA Sender" on a GCP VM

Paste this whole file to ChatGPT as your first message.

---

## What I want from you (ChatGPT)

I have a Google Cloud Compute Engine VM. I want to move this project off my Windows PC
(where it currently runs behind an ngrok free tunnel) and onto that VM, running 24/7.

Give me a **step-by-step deployment guide** I can follow command by command, covering:

1. VM sizing + firewall rules + reserving a static external IP
2. Installing Node.js 22 and copying the project to the VM
3. Migrating existing state files (see "Persistent state" below) without re-linking WhatsApp
4. Running the backend as a **systemd service** that survives reboot and crashes
5. Putting it behind **HTTPS on a real domain** (Caddy or nginx + certbot — recommend one)
6. The exact Chrome-extension file edits the new domain forces, and what breaks for
   existing customers when the URL changes
7. Backups of the state directory, and log rotation
8. A verification checklist at the end

Ask me anything you need before writing the guide. Things I may not have decided yet:
VM OS image, machine type, whether I own a domain name, and whether I have a
DNS provider. **Assume Ubuntu 22.04/24.04 unless I say otherwise.**

Please prefer plain, boring, reliable setups over Docker/Kubernetes. Single VM, single
process. Explain *why* for each step briefly so I can debug it later.

---

## The project, so you understand it

**Name:** Starshift WA Sender. A commercial WhatsApp bulk-messaging product sold to
Indian customers on 1/3/6/12-month rental plans.

It has **two halves**, and this matters a lot:

### Half 1 — Chrome extension (Manifest V3) — NOT deployed to the server

Lives in `extension/`. It is client-side software that **each customer installs in their
own Chrome** ("Load unpacked" today). It is distributed as a folder/zip, not hosted. It:

- reads an Excel contact list (SheetJS bundled locally at `extension/lib/xlsx.full.min.js`)
- composes personalized messages (`{{name}}`, `{{custom1}}`, `{{custom2}}`)
- runs campaigns from a background service worker (`extension/background/background.js`)
  using `chrome.alarms` for the time-gap between sends and for scheduled campaigns
- a content script (`extension/content/content.js`) drives the real
  `web.whatsapp.com` DOM to send messages
- calls the backend for login / licence checks on every use
- parts: `popup/` (login), `dashboard/` (main UI), `admin/` (admin panel), `common/`

**So "deploying the extension on the server" is not a thing.** Only the backend is
deployed. The extension just needs to be re-pointed at the new backend URL and
re-distributed to customers.

### Half 2 — Node/Express backend — THIS is what goes on the VM

Lives in `backend/`. Entry point `backend/server.js`, started with `npm start`
(`node server.js`). Listens on **port 5001** (`PORT` in `.env`). Node 22 locally.

**Dependencies** (`backend/package.json`):
`express` 4, `cors`, `dotenv`, `jsonwebtoken`, `@whiskeysockets/baileys` ^7.0.0-rc14,
`qrcode`, `pino`.

**What it does:**

| Area | Detail |
|---|---|
| Auth | `/api/auth/*` — mobile+password login, JWT issued, password reset via one-time code |
| Licensing | Admin adds customers with a plan; extension re-validates the licence on every action; a running campaign stops the instant the account goes inactive |
| Admin | `/api/admin/*` — add/renew/deactivate/delete customers, generate activation links |
| Activation | Public page `GET /activate` — the customer opens the link the seller sent and is signed straight in, via Chrome's `externally_connectable` messaging to the extension ID |
| Public pages | `GET /privacy`, `GET /terms` — HTML in `backend/public/` with `{{PLACEHOLDER}}`s filled from `.env` at request time; `GET /api/public-config`; `GET /api/health` |
| **Server-side WhatsApp** | `/api/wa/*` — **the important/heavy part, see below** |

### The server-side WhatsApp sockets (the real deployment constraint)

`backend/utils/waSessions.js` + `backend/utils/waBot.js` keep **one live Baileys
WhatsApp socket per customer account**, running headlessly on the server — no browser.
This lets campaigns send text, media and captions without WhatsApp Web being open on
the customer's PC. It also runs an auto-reply chatbot with STOP/START unsubscribe
handling (`/api/wa/bot/sync`).

Consequences for deployment:

- **Long-lived outbound WebSocket connections to WhatsApp.** The process must stay up
  continuously. Any restart drops every customer's socket; `waSessions.restoreAll()` is
  called at the bottom of `server.js` to reconnect from saved credentials on boot.
- Each account **links its WhatsApp once by scanning a QR code** shown in the dashboard.
  Credentials are then persisted and reused. Moving servers **must** carry those files
  over or every customer has to re-scan.
- `/api/wa/send` takes the attachment **inline as a base64 data URL**, so that one route
  is mounted with `express.json({ limit: "70mb" })` while the rest of the app uses the
  default limit. **Any reverse proxy in front needs a matching large body limit**
  (e.g. nginx `client_max_body_size 80m;`) or big attachments will 413.
- Outbound-only; WhatsApp needs no inbound ports.

### Persistent state — plain JSON files, no database

Everything lives under `backend/data/`:

```
backend/data/users.json              all customers, licences, password hashes
backend/data/wa-sessions/<mobile>/   Baileys auth state per account:
                                       creds.json, app-state-sync-*.json,
                                       device-list-*.json, contacts.json
backend/data/bots/<mobile>.json      chatbot rules + unsubscriber list
```

There is **no Postgres/MySQL/Redis**. Writes are synchronous `fs.writeFileSync`.
This directory is the entire product's data — losing it loses all customers and all
WhatsApp links. It must be on persistent disk and backed up.
I currently have 2 live accounts linked (`917028080364`, `917588258599`).

### Configuration — `backend/.env` (see `backend/.env.example`)

```
PORT=5001
JWT_SECRET=<long random string>
ADMIN_MOBILE=917028080364          # the only account that sees the Admin Panel
ADMIN_PASSWORD=<...>
PUBLIC_BASE_URL=http://localhost:5001   # <-- activation links are built from this
EXTENSION_ID=                      # Chrome extension ID; activation page needs it
SMS_PROVIDER=                      # blank = reset codes only printed to console
SUPPORT_MOBILE=917028080364
BUSINESS_NAME= / SUPPORT_EMAIL= / JURISDICTION= / POLICY_EFFECTIVE_DATE=
```

`PUBLIC_BASE_URL` **must become the new public HTTPS URL** or every activation link
I generate will point at a dead address.

### Current (to-be-replaced) hosting setup

Backend runs as a hidden `node server.js` on my Windows PC, exposed via a reserved free
ngrok domain `https://civic-facsimile-dimly.ngrok-free.dev`. `scripts/keep-running.ps1`
is a 30-second watchdog loop restarting whichever of the two died; launched at logon by
`scripts/autostart.vbs`. **All of this gets replaced by systemd + a real domain on the VM.**

### The domain change ripples into the extension — 3 files

The ngrok hostname is hardcoded in the extension. After deploying, these must all change
to the new domain, and the extension must be **repackaged and redistributed to every
customer**:

1. `extension/common/config.js` → `const API_BASE = "https://<new-domain>/api";`
2. `extension/manifest.json` → `host_permissions` entry (replace the ngrok URL)
3. `extension/manifest.json` → `externally_connectable.matches` (replace the ngrok URL)

Then in `.env`: `PUBLIC_BASE_URL=https://<new-domain>`.

Notes:
- Chrome requires **HTTPS** for `externally_connectable` matches — a bare IP or plain
  HTTP will not work. A real domain with a valid certificate is mandatory, not optional.
- Reloading the extension unpacked from a different folder changes its **extension ID**,
  which breaks `EXTENSION_ID` and the one-click activation page. Please tell me how to
  pin a stable extension ID (a `key` field in the manifest) so this survives.
- Existing activation links embed the old ngrok host and will stop working, so I
  probably need to regenerate them for existing customers — confirm.

### Other things worth knowing

- `app.use(cors())` is wide open — tell me if I should tighten it once on a real domain.
- `backend/data/` currently sits inside the repo. Advise whether to move it out
  (e.g. `/var/lib/starshift/`) and point the app at it.
- `scripts/` holds one-off generators (icons, Excel template) — not needed at runtime.
- The repo also carries marketing assets (PPTX/PDF decks, ~40 MB of demo `videos/`).
  These should **not** be copied to the VM.
- This project is **not currently a git repository**, so plan the file transfer with
  `gcloud compute scp` or by initializing git first — your call, suggest the cleaner one.
- Compliance context: this automates the normal WhatsApp Web UI, not the official
  Business API. Aggressive volume can get numbers banned, so a sane time-gap between
  sends is a product requirement, not a performance knob.
