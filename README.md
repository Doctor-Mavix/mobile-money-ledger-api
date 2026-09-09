# Fintech — wallets, transfers and an append-only ledger

A mobile-money backend: multi-currency wallets, transfers between holders, cash-in and cash-out
at an agent counter, a double-entry ledger the database refuses to modify, and account
statements in CSV and PDF. Built on the OrangCode Express 5 + TypeScript template, with
**PostgreSQL as the only engine** — the template ships two, this project narrowed
`DB_PROVIDER` to one and says why.

One property is the point of the exercise: **two simultaneous transfers can never overdraw a
wallet.** It is not asserted in a comment, it is proved by a test that fires ten transfers at
once against a balance that funds five, and it has been checked by removing the lock and
watching the test fail.

---

## Table of contents

- [What is in the box](#what-is-in-the-box)
- [Requirements](#requirements)
- [Installation](#installation)
- [Running it](#running-it)
- [The money journey, in curl](#the-money-journey-in-curl)
- [The API](#the-api)
- [How money is represented](#how-money-is-represented)
- [How a transfer cannot overdraw an account](#how-a-transfer-cannot-overdraw-an-account)
- [How a retry cannot pay twice](#how-a-retry-cannot-pay-twice)
- [Why the ledger cannot be edited](#why-the-ledger-cannot-be-edited)
- [Statements](#statements)
- [Project structure](#project-structure)
- [Configuration](#configuration)
- [Testing](#testing)
- [Scripts](#scripts)
- [Security summary](#security-summary)

---

## What is in the box

| Module          | What it owns                                                                   |
| --------------- | ------------------------------------------------------------------------------ |
| `auth`          | Register, verify, login, TOTP MFA, refresh rotation, sessions, password reset  |
| `wallet`        | One wallet per holder per currency, its balance, its status, the house wallets |
| `ledger`        | The double-entry journal, its per-wallet sequence, and the integrity audit     |
| `transfer`      | Transfers, cash-in, cash-out: the ACID posting path, idempotency, step-up MFA  |
| `statement`     | A period of history rendered to CSV or PDF, streamed rather than buffered      |
| `health`        | `/health` and `/ready`, mounted at the root, outside the API prefix            |
| `notifications` | Shared kit module: a notification per movement, read state                     |

Everything else — storage, queue, cache, distributed locks, realtime, OTP, i18n, PDF and CSV
rendering — comes from the shared services kit in `src/shared/`.

| Module      |  Files |     Lines | Routes |
| ----------- | -----: | --------: | -----: |
| `wallet`    |      9 |       603 |      5 |
| `ledger`    |      7 |       649 |      2 |
| `transfer`  |     11 |     1 218 |      5 |
| `statement` |      5 |       473 |      1 |
| **Total**   | **32** | **2 943** | **13** |

Plus `src/shared/money/` (153 lines), the money primitive the template did not have.

Three new tables — `wallets`, `transfers`, `ledger_entries` — on top of the template's five.

---

## Requirements

- **Node.js >= 22** — pinned in `.nvmrc`, `nvm use` picks it up.
- **pnpm >= 10** — `corepack enable` is enough.
- **Docker** with Compose v2, for the local stack.

The stack uses non-default ports on purpose, so it never collides with a local server:

| Service    | Port(s)     | Notes                                         |
| ---------- | ----------- | --------------------------------------------- |
| PostgreSQL | `5434`      | `SELECT … FOR UPDATE` is load-bearing here    |
| Redis      | `6383`      | rate limit, login throttle, idempotency locks |
| MinIO      | `9030/9031` | console at http://localhost:9031              |
| Mailpit    | `1028/8028` | web interface at http://localhost:8028        |

The application listens on **`3020`**.

---

## Installation

```bash
nvm use
pnpm install
cp .env.example .env
```

Three secrets have no default and the process refuses to boot without them. They must differ
from each other:

```bash
# once per variable: JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, MFA_SECRET_KEY
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Then bring the stack up and run the migrations:

```bash
docker compose up -d
pnpm db:deploy
```

`db:deploy` rather than `db:push`: the migrations carry CHECK constraints and a trigger that
**Prisma's schema language cannot express**, so they exist only in the SQL files. A database
built by pushing the schema would look identical in Prisma Studio and would happily let you
`UPDATE` the ledger.

---

## Running it

```bash
pnpm dev          # tsx watch, reloads on save
pnpm build && pnpm start
```

- API: `http://localhost:3020/api/v1`
- Reference: `http://localhost:3020/docs` — Swagger UI, generated from the routes and their Zod
  schemas at boot, so it cannot drift from the code
- Health: `http://localhost:3020/health` — **at the root, not under the API prefix**, because a
  load balancer probe should not depend on the API version

---

## The money journey, in curl

`./scripts/smoke.sh` walks all of this against a running server and checks every status code.
The abridged version:

```bash
API=http://localhost:3020/api/v1

# 1. An operator with the agent role. Roles are only ever read from the token, and registration
#    always produces a role-less actor, so the counter staff is provisioned from the shell.
pnpm admin:create --email agent@fintech.local --password '…' --type agent --role agent

curl -s -X POST $API/auth/login -H 'content-type: application/json' \
  -d '{"email":"alice@fintech.local","password":"…"}'
# -> data.accessToken ; export ALICE=…

# 2. A second factor. Without it the account can read a balance but cannot move a franc.
curl -s -X POST $API/auth/mfa/setup -H "authorization: Bearer $ALICE"
# -> data.secret, data.qrCodeDataUrl
curl -s -X POST $API/auth/mfa/confirm -H "authorization: Bearer $ALICE" \
  -H 'content-type: application/json' -d '{"code":"123456"}'

# 3. A wallet. One per holder per currency — a second XOF wallet is a 409.
curl -s -X POST $API/wallets -H "authorization: Bearer $ALICE" \
  -H 'content-type: application/json' -d '{"currency":"XOF"}'
# -> 201 { id, currency: "XOF", balance: "0", status: "active" }

# 4. Cash in at the counter. The operator's own code, not the holder's.
curl -s -X POST $API/transfers/cash-in -H "authorization: Bearer $AGENT" \
  -H 'content-type: application/json' -H 'idempotency-key: kiosk-2026-08-21-0001' \
  -d '{"walletId":"'$ALICE_WALLET'","amount":"750000","mfaCode":"654321"}'
# -> 201. Amounts are strings of minor units: "750000" is 750 000 XOF, which has no cents.

# 5. A transfer. The same key twice returns the first result with a 200, never a second movement.
curl -s -X POST $API/transfers -H "authorization: Bearer $ALICE" \
  -H 'content-type: application/json' -H 'idempotency-key: 8f1c…' \
  -d '{"sourceWalletId":"'$ALICE_WALLET'","targetWalletId":"'$BOB_WALLET'",
       "amount":"25000","mfaCode":"123456","reference":"Loyer aout"}'
# -> 201 { id, status: "completed", replayed: false, … }

# 6. The history, newest first, paged by cursor
curl -s "$API/ledger/wallets/$ALICE_WALLET?limit=20" -H "authorization: Bearer $ALICE"
# -> { data: [ { amount: "-25000", balanceAfter: "725000", sequence: 2 }, … ],
#      meta: { nextCursor: "eyJ2Ijoi…", hasMore: true } }

# 7. A statement for the month
curl -s "$API/statements/wallets/$ALICE_WALLET?from=2026-08-01T00:00:00Z\
&to=2026-08-31T23:59:59Z&format=pdf" -H "authorization: Bearer $ALICE" -o releve.pdf

# 8. The audit, for the back office only
curl -s $API/ledger/integrity -H "authorization: Bearer $ADMIN"
# -> { consistent: true, globalSum: "0", unbalancedTransferIds: [], wallets: [ … ] }
```

---

## The API

Every route below is prefixed with `API_PREFIX` (`/api/v1` by default). A route is protected
unless it is listed as public.

### Wallets

| Method | Path                    | Guard   | What it does                                    |
| ------ | ----------------------- | ------- | ----------------------------------------------- |
| `POST` | `/wallets`              | holder  | Opens one — `409` if that currency already held |
| `GET`  | `/wallets`              | holder  | The caller's own wallets                        |
| `GET`  | `/wallets/:id`          | owner   | `404`, not `403`, for someone else's            |
| `POST` | `/wallets/:id/freeze`   | `admin` | `200` — a status changes, nothing is created    |
| `POST` | `/wallets/:id/unfreeze` | `admin` | `200`                                           |

### Transfers

All three writes require an `Idempotency-Key` header and an `mfaCode` in the body. Both are
mandatory: a `400` and a `403` respectively, never a default.

| Method | Path                  | Guard   | What it does                                       |
| ------ | --------------------- | ------- | -------------------------------------------------- |
| `POST` | `/transfers`          | owner   | `201` posted · `200` replayed · `422` short funds  |
| `POST` | `/transfers/cash-in`  | `agent` | Counter deposit: house wallet → holder             |
| `POST` | `/transfers/cash-out` | `agent` | Counter withdrawal: holder → house wallet          |
| `GET`  | `/transfers`          | holder  | Cursor-paged, both sides of the caller's movements |
| `GET`  | `/transfers/:id`      | party   | Visible to payer and payee; `404` to anyone else   |

### Ledger

| Method | Path                  | Guard   | What it does                                    |
| ------ | --------------------- | ------- | ----------------------------------------------- |
| `GET`  | `/ledger/wallets/:id` | owner   | Entries newest first, cursor-paged              |
| `GET`  | `/ledger/integrity`   | `admin` | Re-reads the whole book and says if it balances |

### Statements

| Method | Path                      | Guard | What it does                                 |
| ------ | ------------------------- | ----- | -------------------------------------------- |
| `GET`  | `/statements/wallets/:id` | owner | `?from=&to=&format=csv\|pdf`, csv by default |

The period is capped at one year and must not be inverted; both are `400`.

Auth, sessions, MFA and notifications are the template's own routes and are unchanged.

---

## How money is represented

A balance is a **`bigint` of minor units**, from the `BIGINT` column to the JSON boundary. It is
never a `number` and never a `float`.

At the boundary it becomes a **string of digits**: `"750000"`. That is not decoration.
`JSON.stringify` throws on a `bigint`, and the obvious fix — casting to `Number` first — is
silent and wrong. A single amount is capped at 10¹⁵ so it would in fact survive a double; a
_balance_ is not capped, because a house wallet holds the negative of everything ever issued.
`src/shared/money/money.test.ts` asserts exactly that: `9007199254740993` comes back as
`9007199254740992` through a JSON number, and comes back intact through a string.

How many digits the minor unit has is **data, not a hard-coded 100**:

| Currency | Minor digits | `formatMoney(750000, …)` |
| -------- | -----------: | ------------------------ |
| `XOF`    |            0 | `750 000 XOF`            |
| `EUR`    |            2 | `7 500,00 EUR`           |
| `USD`    |            2 | `7 500,00 USD`           |

The franc CFA has no subdivision. A formatter that divides by 100 prints every West African
amount a hundred times too small, which is the kind of bug that survives a code review because
it looks like arithmetic.

The thousands separator is a narrow no-break space, written in the source as the escape
`'\u202f'` rather than as the character: a literal one is indistinguishable from a space in a
diff, and any editor that normalises whitespace would silently change every printed amount. The
test asserts its code point, not its appearance.

---

## How a transfer cannot overdraw an account

The whole guarantee lives in one method, `PrismaLedgerRepository.post`:

```sql
SELECT "id", "currency", "balance", "status", "kind"
FROM "wallets"
WHERE "id" IN ($1, $2)
ORDER BY "id"
FOR UPDATE
```

- **`FOR UPDATE`** is what makes it safe. Without it, two requests read the same balance, both
  conclude there is enough, and both write — the second write erases the first, and the wallet
  is overdrawn. With it, the second request blocks on the row until the first commits, then
  re-reads a balance that already includes the first movement.
- **`ORDER BY "id"`** is what stops it deadlocking. Two transfers in opposite directions between
  the same pair would each hold the row the other waits for; a fixed lock order makes that
  impossible.
- **The sequence numbers are read inside the same lock**, which is what makes them gapless.

Everything — the `transfers` row, both balance updates, both ledger entries — happens in one
Prisma interactive transaction. Either all of it commits or none of it does.

Three further guards sit behind that:

- a **CHECK constraint**, `wallets_balance_non_negative`, exempting `system` wallets;
- a **self-transfer refusal**, because a movement onto one wallet locks one row, reads the same
  balance twice, and posts two entries that cancel — the one shape `FOR UPDATE` cannot catch;
- a **currency match**, because two wallets in different currencies have no exchange rate here.

**This was verified by breaking it.** With `FOR UPDATE` commented out, the concurrency test went
from _5 accepted, 5 refused, final balance 0_ to _10 accepted_. Worth recording: the stored
balance stayed at `4000` — **positive** — while the ledger recorded all ten debits, for a total
of `-10000`. The CHECK constraint never fired, because the lost update hid the overdraft from
it. A constraint cannot replace the lock; it can only catch what the lock lets through.

---

## How a retry cannot pay twice

A client that times out does not know whether its transfer happened. It will retry. Two
mechanisms make that safe, and they solve **different** problems:

1. **`UNIQUE (actor_id, idempotency_key)`** on `transfers` is the durable answer. A replay finds
   the existing row and returns it with a `200` and `replayed: true`, so the caller can tell a
   replay from a fresh movement.
2. **A Redis lock on `transfer:<actorId>:<key>`**, taken without waiting, is what stops two
   _simultaneous_ retries from both reaching the insert and one of them dying on the unique
   index instead of replaying cleanly.

The lock protects idempotency. The row lock protects the balance. Neither substitutes for the
other, and conflating them is the mistake this project was written to avoid.

A refused transfer is recorded too, with `status: 'failed'` and a `failureReason`. Replaying it
returns the refusal rather than trying again — otherwise a retry loop turns a declined payment
into an accepted one the moment the balance moves.

---

## Why the ledger cannot be edited

`ledger_entries` carries a trigger:

```sql
CREATE TRIGGER "ledger_entries_no_update_or_delete"
  BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "ledger_entries_append_only"();
```

Without it, "the ledger is never modified" is a statement about the code we wrote today, and one
well-meaning `updateMany` in a future release quietly turns the audit trail into an editable
table. With it, the guarantee survives the code. Correcting a posted entry is a **new pair of
entries**, which is what double-entry bookkeeping has always meant.

`TRUNCATE` deliberately still works — it fires only TRUNCATE triggers — so `migrate reset` and
the test suite can clear the table.

Every movement writes **two** entries whose amounts sum to zero. That makes the audit trivial
and total:

- every wallet's `balance` column equals the sum of its entries;
- every wallet's last `balanceAfter` equals its balance, and the running balance is continuous;
- the per-wallet `sequence` is gapless from 1;
- every `transferId` groups to zero;
- **the sum of every entry in the table is zero.**

`GET /ledger/integrity` runs all five inside a single `RepeatableRead` snapshot. That isolation
level is not a detail: spread over separate statements, the check would compare a balance from
before a movement with the entries from after it and report a healthy book as broken. An
integrity check that cries wolf under load is worse than none, because the one time it is right
nobody will believe it.

Cash-in and cash-out are not exceptions to double entry. They move money to and from a **system
wallet** owned by a reserved actor, whose balance is the negative of everything in circulation —
which is why the CHECK constraint exempts `kind = 'system'` and why the global sum is still zero.

---

## Statements

`GET /statements/wallets/:id?from=…&to=…&format=csv|pdf` renders a period of history.

- **Ownership is checked before a single byte is written.** A stream that discovers the refusal
  halfway has already sent `200 OK` and a `Content-Disposition`. The test asserts the `404`
  carries **no** `Content-Disposition` at all.
- **The rows are streamed**, 500 at a time by `sequence`, so a year of history costs bounded
  memory rather than one array.
- **`Content-Disposition: attachment`**, always. Served inline, a statement is HTML in the API's
  own origin — and the reference column contains text the payer chose.
- **`Cache-Control: no-store`**, because the file is somebody's bank statement.
- The reference column prints **the label the payer wrote**, falling back to the transfer id
  when there is none. A column of UUIDs answers nothing, and "what did I pay on the 12th" is the
  question a statement exists for.

---

## Project structure

```
src/
  core/                 the framework — decorators, DI, errors, config, openapi, pagination
  modules/
    auth/               register, login, MFA, sessions, guard
    wallet/
      sql/              Prisma repository — the only file that knows Prisma
    ledger/
      sql/
        ledger.prisma.repository.ts   post(): the FOR UPDATE transaction
    transfer/
      step-up.ts        re-proving identity mid-session, the primitive the kit lacks
    statement/
    health/
  shared/               media, storage, queue, cache, lock, realtime, i18n, documents…
    money/              bigint minor units, currency exponents, formatting
prisma/migrations/      CHECK constraints and the append-only trigger live here, by hand
tests/                  harness, seeded actors, setup
scripts/                smoke.sh, admin:create
```

Each module is a folder with a `*.module.ts`, and `MODULES_ENABLED` decides which ones mount.
A module never imports a concrete implementation of anything shared — it resolves a token.

**No Prisma type crosses a repository boundary.** A service sees `LedgerEntry`, never a
`Prisma.LedgerEntryGetPayload<…>`.

One caveat this project found and the others did not: `wallet`, `ledger` and `transfer` are
three modules but **one extraction unit**. They can be lifted out together; they cannot be
lifted out separately, because the posting transaction spans all three tables. Splitting them
would replace it with a saga, and a saga cannot promise that two simultaneous transfers never
overdraw an account. The module boundary is right; the _service_ boundary is around all three.

---

## Configuration

Every variable is validated at boot by a Zod schema. An invalid one stops the process — there is
no "start and fail on the first request". `.env.example` documents all of them; the ones that
matter most here:

| Variable             | Note                                                              |
| -------------------- | ----------------------------------------------------------------- |
| `DB_PROVIDER`        | `postgres`, and only that — the choice is documented, not offered |
| `DATABASE_URL`       | Row locks and CHECK constraints are why this is not MongoDB       |
| `REDIS_URL`          | Idempotency locks live here; not optional in production           |
| `JWT_ACCESS_SECRET`  | >= 32 chars, no default                                           |
| `JWT_REFRESH_SECRET` | >= 32 chars, must differ from the access secret                   |
| `MFA_SECRET_KEY`     | Encrypts TOTP secrets at rest; must differ from both              |
| `QUEUE_ENABLED`      | `false` runs jobs inline — fine in tests, wrong in production     |
| `CORS_ORIGINS`       | Required in production, where `*` is refused                      |
| `DOCS_PASSWORD`      | An open reference is refused in production                        |

---

## Testing

```bash
pnpm test              # everything
pnpm test:unit         # no database needed
pnpm test:integration  # needs docker compose up -d
pnpm test:coverage
```

**16 files, 156 tests.** The integration suites run against the real stack — a real Postgres, a
real Redis, real argon2 hashing, real TOTP. Nothing that matters is mocked, on the principle
that a mock that agrees with your assumptions only proves your assumptions.

The invariants that are guarded rather than assumed:

- **Ten concurrent transfers against a balance that funds five** yield exactly five `201`s, five
  `422 INSUFFICIENT_FUNDS`, a final balance of exactly `0`, a gapless sequence and a consistent
  ledger. Verified by removing `FOR UPDATE` and watching all ten succeed.
- **`UPDATE` and `DELETE` on `ledger_entries` are refused by the database**, asserted against a
  raw connection rather than through the service.
- **A user wallet cannot go negative** and **a system wallet can**, both asserted with raw SQL.
- **The whole book reads back consistent**, with the three properties asserted separately: a
  bare `consistent: false` does not say which one broke.
- **A replayed idempotency key moves the money once**, with the balance checked on both sides.
- **A statement for someone else's wallet is refused before any byte is written.**

Compiling proves nothing. `./scripts/smoke.sh` calls **all 13 money routes** against a running
server — 55 checks, real HTTP, real second factors — and exits non-zero if any status differs
from what is documented above.

---

## Scripts

| Command              | What it does                                                    |
| -------------------- | --------------------------------------------------------------- |
| `pnpm dev`           | Watch mode on port 3020                                         |
| `pnpm db:deploy`     | Applies the migrations, including the hand-written SQL          |
| `pnpm db:migrate`    | Creates a migration in development                              |
| `pnpm admin:create`  | `--email … --password … [--type agent] [--role admin]`          |
| `./scripts/smoke.sh` | The end-to-end walk; needs a running server, exits 1 on failure |
| `pnpm typecheck`     | `tsc --noEmit`                                                  |
| `pnpm lint`          | Type-aware ESLint                                               |
| `pnpm format`        | Prettier                                                        |

---

## Security summary

- **Every movement of money needs a second factor**, checked at the moment of the movement, not
  at login. A stolen access token is enough to read a balance; it must not be enough to empty
  one. An account without MFA enabled is **refused**, not waved through — otherwise "MFA is
  mandatory for transfers" is a suggestion.
- **Every movement of money needs an `Idempotency-Key`.** No default, no fallback to a generated
  one: an endpoint that works without a key will be called without one.
- **Authorisation is deny-by-default** — a route without `@Public()` is guarded, so forgetting a
  decorator locks a route rather than opening one.
- **Someone else's wallet is a `404`, not a `403`.** A `403` confirms the id exists.
- **Cash-in and cash-out are behind the `agent` role**, freeze and unfreeze behind `admin`, and
  roles are only ever read from the token.
- **Ownership is checked in the service, not the controller**, where a second caller cannot
  bypass it.
- **The database enforces what the application promises**: non-negative balances, non-zero
  amounts, positive transfer amounts, one wallet per holder per currency, and an append-only
  ledger.
- **Passwords** — argon2id, cost from the environment.
- **Tokens** — 15-minute access token, rotating refresh token with reuse detection.
- **MFA secrets** — encrypted at rest under a key that is not the JWT key.
- **Throttling** — per account _and_ per IP, counted in Redis so the quota is shared across
  instances.
- **Validation** — every body, query and param goes through Zod before a handler sees it; the
  same schema generates the OpenAPI document.
- **Statements** — `attachment` and `no-store`, always.
- **Errors** — one envelope, no stack traces off the machine, one request id per log line.

### Known residual risk

`MfaService.verifyForActor` has **no replay protection inside the 30-second TOTP window**. A code
observed once can be used again until it expires. For a transfer that matters more than it does
for a login, and closing it means remembering consumed codes — which is a template concern, not
a fintech one. It is recorded in `insights/15_RAPPORT_ECARTS_FINTECH.md` rather than patched
here, because the fix belongs in the kit.
