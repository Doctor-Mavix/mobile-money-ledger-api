#!/usr/bin/env bash
# End-to-end walk against a running server, over real HTTP.
#
# The integration suite proves the invariants; this proves the wiring — that every route is
# actually mounted, reachable and guarded once the whole application is booted the way it is
# booted in production. A harness that registers modules by hand cannot prove that.
#
#   pnpm dev            # in another terminal, on PORT=3020
#   ./scripts/smoke.sh
#
# Accounts are created per run under a random suffix, so the script is re-runnable: an actor
# whose second factor is already on cannot be driven from here, since its secret is sealed in
# the row and never readable again.
set -euo pipefail

cd "$(dirname "$0")/.."

# 127.0.0.1 rather than localhost: the server binds IPv4, and `localhost` may resolve to ::1.
ROOT="${ROOT:-http://127.0.0.1:3020}"
BASE="${BASE:-$ROOT/api/v1}"
ORIGIN="${ORIGIN:-http://localhost:5173}"
PASSWORD="${PASSWORD:-Fintech-Local-2026!}"

RUN=$(node -e 'process.stdout.write(Math.random().toString(36).slice(2, 8))')
FAILURES=0

# The throttle counts per client address, and a full walk is a burst. Each call arrives from a
# different one, exactly as the integration suite does it.
BLOCK="10.$((RANDOM % 256)).$((RANDOM % 256))"
ADDRESS=0
next_address() {
  ADDRESS=$((ADDRESS + 1))
  printf '%s.%d' "$BLOCK" "$((ADDRESS % 250))"
}

LAST_STATUS=''
LAST_BODY=''

# call METHOD PATH [TOKEN] [BODY] [IDEMPOTENCY_KEY]
call() {
  local method=$1 path=$2 token=${3:-} body=${4:-} idem=${5:-} raw
  local args=(-sS -X "$method" "$BASE$path" -H "origin: $ORIGIN")
  args+=(-H "x-forwarded-for: $(next_address)")

  [[ -n $token ]] && args+=(-H "authorization: Bearer $token")
  [[ -n $idem ]] && args+=(-H "idempotency-key: $idem")
  [[ -n $body ]] && args+=(-H 'content-type: application/json' -d "$body")

  raw=$(curl "${args[@]}" -w $'\n%{http_code}')
  LAST_STATUS=${raw##*$'\n'}
  LAST_BODY=${raw%$'\n'*}
}

# Writes to a file rather than to a variable: a PDF is binary, and a shell variable stops at
# the first NUL byte.
# download PATH TOKEN OUTFILE
download() {
  LAST_BODY=''
  LAST_STATUS=$(curl -sS -o "$3" -w '%{http_code}' -X GET "$BASE$1" \
    -H "origin: $ORIGIN" -H "x-forwarded-for: $(next_address)" -H "authorization: Bearer $2")
}

probe() {
  LAST_BODY=''
  LAST_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' "$1" -H "origin: $ORIGIN" \
    -H "x-forwarded-for: $(next_address)")
}

# Reads the whole of stdin before parsing: a body split across chunks is not a parse error.
field() {
  node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      const body = JSON.parse(raw);
      const value = process.argv[1].split(".").reduce((node, key) => node?.[key], body);
      process.stdout.write(value === undefined || value === null ? "" : String(value));
    });
  ' "$1" <<<"$LAST_BODY"
}

totp() {
  node --input-type=module -e '
    import { Secret, TOTP } from "otpauth";
    const totp = new TOTP({
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(process.argv[1]),
    });
    process.stdout.write(totp.generate());
  ' "$1"
}

key() { printf 'smoke-%s-%s%s' "$RUN" "$RANDOM" "$RANDOM"; }

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# expect EXPECTED_STATUS LABEL
expect() {
  if [[ $LAST_STATUS == "$1" ]]; then
    printf '  \033[32mok\033[0m   %-3s  %s\n' "$LAST_STATUS" "$2"
  else
    printf '  \033[31mFAIL\033[0m %-3s  %s (expected %s)\n       %s\n' \
      "$LAST_STATUS" "$2" "$1" "$LAST_BODY"
    FAILURES=$((FAILURES + 1))
  fi
}

# same ACTUAL EXPECTED LABEL
same() {
  if [[ $1 == "$2" ]]; then
    printf '  \033[32mok\033[0m   --   %s\n' "$3"
  else
    printf '  \033[31mFAIL\033[0m --   %s (got %s, expected %s)\n' "$3" "$1" "$2"
    FAILURES=$((FAILURES + 1))
  fi
}

# BSD date on macOS, GNU date elsewhere.
day_offset() {
  date -u -v"$1"d '+%Y-%m-%dT%H:%M:%S.000Z' 2>/dev/null ||
    date -u -d "$1 days" '+%Y-%m-%dT%H:%M:%S.000Z'
}

PERIOD="from=$(day_offset -1)&to=$(day_offset +1)"

# provision LABEL ACTOR_TYPE ROLE -> echoes the email
provision() {
  local email="$1-$RUN@fintech.local"
  pnpm --silent admin:create --email "$email" --password "$PASSWORD" --type "$2" --role "$3" \
    --name "Smoke $1" >/dev/null
  printf '%s' "$email"
}

# sign_in EMAIL ACTOR_TYPE -> echoes the access token
sign_in() {
  call POST /auth/login '' "{\"email\":\"$1\",\"password\":\"$PASSWORD\",\"actorType\":\"$2\"}"
  if [[ $LAST_STATUS != 200 ]]; then
    printf 'sign-in failed for %s: %s %s\n' "$1" "$LAST_STATUS" "$LAST_BODY" >&2
    exit 1
  fi
  field data.accessToken
}

# enable_mfa TOKEN -> echoes the base32 secret
enable_mfa() {
  local secret
  call POST /auth/mfa/setup "$1"
  secret=$(field data.secret)
  call POST /auth/mfa/confirm "$1" "{\"code\":\"$(totp "$secret")\"}"
  if [[ $LAST_STATUS != 200 ]]; then
    printf 'mfa confirm failed: %s %s\n' "$LAST_STATUS" "$LAST_BODY" >&2
    exit 1
  fi
  printf '%s' "$secret"
}

# open_wallet TOKEN CURRENCY -> echoes the wallet id
#
# It reports its own result rather than leaving that to `expect`: the call site captures the id
# through a subshell, and a status set inside one never reaches the caller.
open_wallet() {
  call POST /wallets "$1" "{\"currency\":\"$2\"}"
  if [[ $LAST_STATUS != 201 ]]; then
    printf 'wallet open failed: %s %s\n' "$LAST_STATUS" "$LAST_BODY" >&2
    exit 1
  fi
  printf '  \033[32mok\033[0m   201  POST /wallets\n' >&2
  field data.id
}

# balance_of TOKEN WALLET_ID -> echoes the balance, in minor units
balance_of() {
  call GET "/wallets/$2" "$1"
  field data.balance
}

step 'probes'
probe "$ROOT/health"
expect 200 'GET /health'
probe "$ROOT/ready"
expect 200 'GET /ready'

step 'a money route without a token'
call GET /wallets
expect 401 'GET /wallets unauthenticated'

step "provisioning actors (run $RUN)"
ADMIN_EMAIL=$(provision admin agent admin)
AGENT_EMAIL=$(provision agent agent agent)
ALICE_EMAIL=$(provision alice user customer)
BOB_EMAIL=$(provision bob user customer)
printf '  %s\n  %s\n  %s\n  %s\n' "$ADMIN_EMAIL" "$AGENT_EMAIL" "$ALICE_EMAIL" "$BOB_EMAIL"

ADMIN=$(sign_in "$ADMIN_EMAIL" agent)
AGENT=$(sign_in "$AGENT_EMAIL" agent)
ALICE=$(sign_in "$ALICE_EMAIL" user)
BOB=$(sign_in "$BOB_EMAIL" user)

step 'enabling the second factor, which every movement of money requires'
AGENT_SECRET=$(enable_mfa "$AGENT")
ALICE_SECRET=$(enable_mfa "$ALICE")
BOB_SECRET=$(enable_mfa "$BOB")
printf '  three actors now carry a second factor\n'

step 'opening wallets'
AGENT_WALLET=$(open_wallet "$AGENT" XOF)
ALICE_WALLET=$(open_wallet "$ALICE" XOF)
BOB_WALLET=$(open_wallet "$BOB" XOF)

call POST /wallets "$ALICE" '{"currency":"XOF"}'
expect 409 'POST /wallets, a second wallet in the same currency'

call GET /wallets "$ALICE"
expect 200 'GET /wallets'

call GET "/wallets/$ALICE_WALLET" "$ALICE"
expect 200 'GET /wallets/:id'
same "$(field data.balance)" '0' 'a new wallet opens empty'

call GET "/wallets/$ALICE_WALLET" "$BOB"
expect 404 'GET /wallets/:id belonging to someone else'

step 'cash-in at the counter'
call POST /transfers/cash-in "$AGENT" \
  "{\"walletId\":\"$ALICE_WALLET\",\"amount\":\"750000\",\"mfaCode\":\"$(totp "$AGENT_SECRET")\"}" \
  "$(key)"
expect 201 'POST /transfers/cash-in'
same "$(balance_of "$ALICE" "$ALICE_WALLET")" '750000' 'the money landed'

call POST /transfers/cash-in "$ALICE" \
  "{\"walletId\":\"$ALICE_WALLET\",\"amount\":\"1000\",\"mfaCode\":\"$(totp "$ALICE_SECRET")\"}" \
  "$(key)"
expect 403 'POST /transfers/cash-in without the agent role'

step 'a transfer between two holders'
TRANSFER_KEY=$(key)
TRANSFER_BODY="{\"sourceWalletId\":\"$ALICE_WALLET\",\"targetWalletId\":\"$BOB_WALLET\",\"amount\":\"25000\",\"mfaCode\":\"$(totp "$ALICE_SECRET")\",\"reference\":\"Loyer aout\"}"
call POST /transfers "$ALICE" "$TRANSFER_BODY" "$TRANSFER_KEY"
expect 201 'POST /transfers'
TRANSFER_ID=$(field data.id)

# Replayed, not posted twice: the second call returns the first result rather than a second
# movement, which is the whole point of the key.
call POST /transfers "$ALICE" "$TRANSFER_BODY" "$TRANSFER_KEY"
expect 200 'POST /transfers replayed under the same key'
same "$(field data.id)" "$TRANSFER_ID" 'the replay returns the first transfer'
same "$(balance_of "$ALICE" "$ALICE_WALLET")" '725000' 'the money moved exactly once'
same "$(balance_of "$BOB" "$BOB_WALLET")" '25000' 'and landed exactly once'

call POST /transfers "$ALICE" "$TRANSFER_BODY"
expect 400 'POST /transfers without an Idempotency-Key'

call POST /transfers "$ALICE" \
  "{\"sourceWalletId\":\"$ALICE_WALLET\",\"targetWalletId\":\"$BOB_WALLET\",\"amount\":\"1000\",\"mfaCode\":\"000000\"}" \
  "$(key)"
expect 401 'POST /transfers with a wrong second factor'

call POST /transfers "$ALICE" \
  "{\"sourceWalletId\":\"$ALICE_WALLET\",\"targetWalletId\":\"$BOB_WALLET\",\"amount\":\"99999999\",\"mfaCode\":\"$(totp "$ALICE_SECRET")\"}" \
  "$(key)"
expect 422 'POST /transfers beyond the balance'
same "$(field error.code)" 'INSUFFICIENT_FUNDS' 'and says why'

step 'reading transfers back'
call GET /transfers "$ALICE"
expect 200 'GET /transfers'

call GET "/transfers/$TRANSFER_ID" "$BOB"
expect 200 'GET /transfers/:id, visible to the payee'

call GET "/transfers/$TRANSFER_ID" "$AGENT"
expect 404 'GET /transfers/:id, hidden from a third party'

step 'cash-out at the counter'
call POST /transfers/cash-out "$AGENT" \
  "{\"walletId\":\"$BOB_WALLET\",\"amount\":\"5000\",\"mfaCode\":\"$(totp "$AGENT_SECRET")\"}" \
  "$(key)"
expect 201 'POST /transfers/cash-out'
same "$(balance_of "$BOB" "$BOB_WALLET")" '20000' 'the notes left the platform'

step 'the ledger'
call GET "/ledger/wallets/$ALICE_WALLET?limit=1" "$ALICE"
expect 200 'GET /ledger/wallets/:id'
same "$(field meta.hasMore)" 'true' 'a page of one leaves more behind'
CURSOR=$(field meta.nextCursor)

call GET "/ledger/wallets/$ALICE_WALLET?limit=10&cursor=$CURSOR" "$ALICE"
expect 200 'GET /ledger/wallets/:id, the next page'
same "$(field meta.hasMore)" 'false' 'and the rest fits on it'

call GET "/ledger/wallets/$ALICE_WALLET" "$BOB"
expect 404 'GET /ledger/wallets/:id belonging to someone else'

call GET /ledger/integrity "$ALICE"
expect 403 'GET /ledger/integrity without the back-office role'

call GET /ledger/integrity "$ADMIN"
expect 200 'GET /ledger/integrity'
same "$(field data.consistent)" 'true' 'the book reads back consistent'
same "$(field data.globalSum)" '0' 'and every franc has a counterpart'

step 'statements'
download "/statements/wallets/$ALICE_WALLET?$PERIOD&format=csv" "$ALICE" /tmp/smoke-statement.csv
expect 200 'GET /statements/wallets/:id?format=csv'
if grep -q 'Loyer aout' /tmp/smoke-statement.csv; then
  printf '  \033[32mok\033[0m   --   the CSV carries the label the payer wrote\n'
else
  printf '  \033[31mFAIL\033[0m --   the CSV lost the reference\n'
  FAILURES=$((FAILURES + 1))
fi

download "/statements/wallets/$ALICE_WALLET?$PERIOD&format=pdf" "$ALICE" /tmp/smoke-statement.pdf
expect 200 'GET /statements/wallets/:id?format=pdf'
same "$(head -c 5 /tmp/smoke-statement.pdf)" '%PDF-' 'and the bytes really are a PDF'

download "/statements/wallets/$ALICE_WALLET?$PERIOD" "$BOB" /dev/null
expect 404 'GET /statements/wallets/:id belonging to someone else'

step 'freezing an account'
call POST "/wallets/$ALICE_WALLET/freeze" "$ADMIN" '{}'
expect 200 'POST /wallets/:id/freeze'
same "$(field data.status)" 'frozen' 'the wallet is frozen'

call POST /transfers "$ALICE" \
  "{\"sourceWalletId\":\"$ALICE_WALLET\",\"targetWalletId\":\"$BOB_WALLET\",\"amount\":\"1000\",\"mfaCode\":\"$(totp "$ALICE_SECRET")\"}" \
  "$(key)"
expect 403 'a frozen wallet cannot send'

call POST "/wallets/$ALICE_WALLET/freeze" "$ALICE" '{}'
expect 403 'POST /wallets/:id/freeze without the back-office role'

call POST "/wallets/$ALICE_WALLET/unfreeze" "$ADMIN" '{}'
expect 200 'POST /wallets/:id/unfreeze'
same "$(field data.status)" 'active' 'the wallet is active again'

call POST /transfers "$BOB" \
  "{\"sourceWalletId\":\"$BOB_WALLET\",\"targetWalletId\":\"$ALICE_WALLET\",\"amount\":\"1000\",\"mfaCode\":\"$(totp "$BOB_SECRET")\"}" \
  "$(key)"
expect 201 'and money flows again'

step 'the book, once more, after everything above'
call GET /ledger/integrity "$ADMIN"
expect 200 'GET /ledger/integrity'
same "$(field data.consistent)" 'true' 'still consistent'
same "$(field data.globalSum)" '0' 'still balanced'

# The agent's own wallet is opened and never moved on purpose: a balance check has to get the
# untouched case right too.
same "$(balance_of "$AGENT" "$AGENT_WALLET")" '0' 'an untouched wallet stayed at zero'

if [[ $FAILURES -eq 0 ]]; then
  printf '\n\033[1;32mdone — every route answered as expected\033[0m\n'
else
  printf '\n\033[1;31m%d check(s) failed\033[0m\n' "$FAILURES"
  exit 1
fi
