# Tombstone Inquiry Middleware (Payload CMS)

Middleware between a WordPress tombstone-inquiry form and the documents/emails
your team acts on. It:

1. Receives WordPress form submissions on a secured webhook endpoint.
2. Stores them in an **Inquiries** collection (the "CPT" equivalent).
3. Keeps a **daily-synced mirror of the DK Vörubók catalog** (with prices) in Postgres.
4. Generates an **Excel quote** from a master template — each item is priced
   from the DK catalog and the template's formulas total the job.
5. Sends **two emails**: a designer brief (customer choices + reference images) and
   a salesperson quote (the `.xlsx` attached).

Built on Payload CMS 3.85 (Next.js) + Postgres + ExcelJS + Nodemailer.

---

## Pipeline

```
WordPress form ──POST JSON + HMAC──▶ /api/webhooks/wordpress-inquiry
                                           │  (verify signature, store, 201)
                                           ▼
                                   Inquiries collection
                                           │  afterChange (create) → queue job
                                           ▼
                                 processInquiry job:
                                   • download reference images (SSRF-guarded) → Media
                                   • live DK price fetch for the inquiry's items → catalog-items
                                   • generate Excel quote (DK prices next to each code)
                                   • email designer brief + salesperson quote
                                   • log each email in the Sent emails collection
                                   • status → emailed

Admin clicks Accept ──POST /api/inquiries/:id/accept──▶ live DK price fetch
                                   → regenerate .xlsx with real prices → status accepted

Nightly (03:00): syncCatalog job ──GET /Product/page──▶ dkPlus ──▶ exact mirror in catalog-items
```

## Accepting an inquiry (admin)

Inquiries have an **Accept** button (list-view column and edit-view sidebar),
wired to `POST /api/inquiries/:id/accept` (admin auth required). Accepting:

1. fetches **live prices from the DK API** for exactly the inquiry's items
   (`GET /Product/{itemcode}`, main product + add-ons) and upserts them into
   `catalog-items` — so it never waits for the nightly sync
2. regenerates the Excel quote so it carries the real prices
3. marks the inquiry `accepted`, recording `acceptedAt` and `acceptedBy`

Allowed from statuses quoted / emailed / failed; re-accepting an accepted
inquiry returns 409. Errors (DK unreachable, bad key) surface as an admin
toast and mark the inquiry `failed` with the message in `processingError` —
fix and click Accept again to retry.

Still open from the v0.5 acceptance criteria: creating the DK **sales order**
on accept (plug it into `src/lib/acceptInquiry.ts` after the price refresh).

---

## Local development

```bash
corepack enable        # Node ≥ 25 ships without corepack: use `npx pnpm@10 …` instead
pnpm install

# Postgres (matches DATABASE_URL below)
docker run -d --name payload-mw-pg \
  -e POSTGRES_USER=payload -e POSTGRES_PASSWORD=payload -e POSTGRES_DB=payload_middleware \
  -p 5432:5432 postgres:16-alpine

cp .env.example .env   # then fill in the values (see below)
pnpm dev               # admin at http://localhost:3000/admin
```

In dev, the Postgres schema is auto-synced (Drizzle push). The admin will ask you
to create the first user.

### Environment variables

See `.env.example`. Key ones:

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `PAYLOAD_SECRET` | Payload signing secret |
| `SERVER_URL` | Public URL (makes Media URLs absolute for email images) |
| `WEBHOOK_SECRET` | Shared secret for the WordPress HMAC signature |
| `WP_ALLOWED_IMAGE_HOST` | Only host reference images may be downloaded from (SSRF guard) |
| `DK_API_KEY` | dkPlus API token (GUID). `DK_API_BASE` defaults to the prod API |
| `SMTP_*`, `MAIL_FROM` | SMTP; if unset, dev uses jsonTransport (captures, doesn't send) |
| `DESIGNER_EMAIL`, `SALES_EMAIL` | Recipients of the two emails |
| `DISABLE_AUTORUN` | Set `true` on serverless / when using a separate job worker |

---

## The master Excel template (client's real file, Icelandic)

`src/templates/master-quote-template.xlsx` is the client's real order template
(sheets **Pantanir** = the order form, **Vörulisti** = the template's own code →
price lists, `Sheet1` = internal notes). All labels stay Icelandic; the generator
only writes values into input and price cells.

The quote is **only the Pantanir sheet**, and prices come **only from the DK
catalog**: Vörulisti and Sheet1 are dropped, together with every named range,
VLOOKUP and drop-down list that pointed at Vörulisti. The saved
template is the client's *filled* example (Selma, Guðrún, Blómarammi 82 000, …),
so all input and price cells are cleared first — nothing from the example leaks
into a quote.

The cell map lives in **`src/lib/excel.ts` → `TEMPLATE_MAP`** — re-align it if the
client ever reshuffles the template. What the generator writes:

- **Customer block**: Nafn (D9), Kt (D11), Heimili (D12), Sími (D13), Netfang
  (D14), Dagsetning (K11, auto = generation date), Afhending (K12),
  Kirkjugarður (J15).
- **Inscription (Áletrun)**: deceased name (C19), a generated `f.<born> d.<died>`
  line (C20), then extra lines from C22 (template counts characters itself).
- **Stone + selects**: Steinn code (H29), Glitir stone colour (I29), Letur (D29),
  price-per-character (H30), Litur (D31), Sölumaður (E57), Athugasemdir (C34-36).
- **Typed add-ons** into their sections: Kross H31, Lukt/vasi H32-33, Fugl
  H34-36, Mynd H37, Rammi H38, Annað H40-49 (overflow lands in free Annað rows).
- **Manual price cells** when provided: Blómarammi K39, Uppsetning K50,
  Afsláttur K52 (written negative).
- **DK prices** (VAT-inclusive `UnitPrice1WithTax`) are written as plain values
  into column K next to each code — stone K29, add-ons K31-K49 — matching
  itemCode case-insensitively. Codes DK doesn't know, or that have no price in
  DK, are **left blank** for the salesperson.
- The template's remaining formulas stay, so the total follows manual edits:
  letter count (D30), Áletrun price K30 = D30 × H30, total K54 = SUM(K29:L52).

The generator sets `fullCalcOnLoad`, so Excel/Numbers/LibreOffice recompute those
formulas when the file is opened, and it also stores their computed results, so
previews that don't recalculate (Quick Look, mail apps) show the same numbers.

---

## WordPress integration

The endpoint owns the JSON contract (see `src/endpoints/intake.ts`). Add the
snippet in **`docs/wordpress-snippet.php`** to your custom form's submit handler:
it builds that JSON, signs the raw body with `hash_hmac('sha256', $body, WEBHOOK_SECRET)`
in the `X-Signature` header, and POSTs to `/api/webhooks/wordpress-inquiry`.

Reference images are sent as **URLs** (into the WP media library); the job downloads
them server-side (allowlisted to `WP_ALLOWED_IMAGE_HOST`).

---

## Email log

Every email the job sends (or fails to send) is recorded in the **Sent emails**
collection (`email-logs`, admin group *Inquiries*): type (designer brief / sales
quote), client name, recipient, subject, HTML body, linked inquiry, and — for the
sales quote — the attached `.xlsx` from Media. Records are created server-side
only; admins can read them but not create/edit/delete, so the log is a
trustworthy audit trail.

## dkPlus catalog sync

`src/lib/dkClient.ts` calls the dkPlus REST API (`Authorization: bearer <DK_API_KEY>`);
its header lists the API behaviour verified against the live account.
`syncCatalog` (src/jobs → `src/lib/catalogSync.ts`) pulls the **whole** catalog
(~2k products, a few seconds), writes only rows whose DK data changed and
**deletes rows DK doesn't have** — so `catalog-items` is an exact mirror (no
placeholders). Scheduled daily at 03:00 on the `nightly` queue; run it on demand
with `scripts/sync-catalog.mts`.

Things worth knowing about the DK data (Sep 2026):

- ItemCodes are lowercase in DK (`h101`), uppercase in the template (`H101`);
  codes are stored lowercase and always compared through `normalizeItemCode`.
- Only ~156 of the template's ~390 Vörulisti codes exist in DK (5 of 75 stones);
  the rest come out unpriced in quotes until they are added to DK.
- DK's `CurrencyCode` is the purchase currency; sales prices are ISK.
- `/Product/modified/{date}` filters on a stock timestamp, not `RecordModified`,
  so it can't drive an incremental sync — hence the full pull.

## Jobs & scheduling

Configured in `payload.config.ts → jobs`. On a dedicated server, `autoRun` both
schedules due tasks and runs queued jobs in-process. To scale out, set
`DISABLE_AUTORUN=true` and run a dedicated worker:

```bash
pnpm payload jobs:run --cron "* * * * *" --all-queues --handle-schedules
```

---

## Verification scripts

```bash
# Full pipeline via Local API (live DK prices, creates inquiry, runs job, checks .xlsx)
DISABLE_AUTORUN=true DESIGNER_EMAIL=d@test.local SALES_EMAIL=s@test.local \
  pnpm exec tsx scripts/verify-pipeline.mts

# Run a queue and list inquiry statuses
pnpm exec tsx scripts/run-jobs.mts inquiries

# Smoke-test the dkPlus client (needs a real DK_API_KEY in the env)
pnpm exec tsx scripts/dk-smoke.mts

# Sync the DK catalog now (same as the nightly job)
pnpm exec tsx scripts/sync-catalog.mts
```

---

## Deployment (single VPS via Docker)

```bash
# Generate committed migrations from your schema (do this in dev, commit them):
pnpm payload migrate:create

# On the server:
docker compose up -d --build
```

`docker-compose.yml` runs Postgres + the app (which runs `payload migrate`, builds,
and starts with in-process job autoRun). Media and Postgres data persist in volumes.
Do **not** rely on Drizzle push in production — use the committed migration files.
