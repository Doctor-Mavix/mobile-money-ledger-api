-- CreateEnum
CREATE TYPE "WalletStatus" AS ENUM ('active', 'frozen', 'closed');

-- CreateEnum
CREATE TYPE "WalletKind" AS ENUM ('user', 'system');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('completed', 'failed');

-- CreateTable
CREATE TABLE "wallets" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "kind" "WalletKind" NOT NULL DEFAULT 'user',
    "currency" TEXT NOT NULL,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "status" "WalletStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfers" (
    "id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "source_wallet_id" TEXT NOT NULL,
    "target_wallet_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "TransferStatus" NOT NULL,
    "reference" TEXT,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "transfer_id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "balance_after" BIGINT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallets_actor_id_currency_key" ON "wallets"("actor_id", "currency");

-- CreateIndex
CREATE INDEX "transfers_actor_id_created_at_id_idx" ON "transfers"("actor_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "transfers_source_wallet_id_created_at_idx" ON "transfers"("source_wallet_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "transfers_target_wallet_id_created_at_idx" ON "transfers"("target_wallet_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "transfers_actor_id_idempotency_key_key" ON "transfers"("actor_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "ledger_entries_wallet_id_created_at_id_idx" ON "ledger_entries"("wallet_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "ledger_entries_transfer_id_idx" ON "ledger_entries"("transfer_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_wallet_id_sequence_key" ON "ledger_entries"("wallet_id", "sequence");

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "transfers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Everything below is hand-written: Prisma's schema language has no syntax for
-- CHECK constraints or triggers, so these guarantees would be lost if this file
-- were ever regenerated from the schema alone. See prisma/schema.prisma.
-- ---------------------------------------------------------------------------

-- A user wallet may never go negative. The transfer path already locks the row and refuses an
-- overdraft; this is the second lock on the same door, because application logic is the part
-- that gets refactored. A `system` wallet is exempt on purpose: it is the counterpart of money
-- issued to users, so its balance is the negative of everything in circulation.
ALTER TABLE "wallets"
  ADD CONSTRAINT "wallets_balance_non_negative"
  CHECK ("kind" = 'system' OR "balance" >= 0);

-- A movement of nothing is not a movement; it would pad the ledger without changing a balance.
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_amount_not_zero" CHECK ("amount" <> 0);

ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_sequence_positive" CHECK ("sequence" >= 1);

ALTER TABLE "transfers"
  ADD CONSTRAINT "transfers_amount_positive" CHECK ("amount" > 0);

-- Append-only, enforced by the database rather than by convention. Without this, "the ledger is
-- never modified" is a statement about the code we wrote today, and a single well-meaning
-- `updateMany` in a future release quietly turns the audit trail into an editable table.
--
-- TRUNCATE deliberately still works: it fires only TRUNCATE triggers, which lets `migrate reset`
-- and the integration suite clear the table. Correcting a posted entry is a new pair of entries.
CREATE OR REPLACE FUNCTION "ledger_entries_append_only"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only: % is refused', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "ledger_entries_no_update_or_delete"
  BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "ledger_entries_append_only"();
