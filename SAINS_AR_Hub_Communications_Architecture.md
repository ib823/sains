# SAINS AR Hub — Exhaustive Communications Architecture
## All System Integrations: Direction, Protocol, Frequency, Security, Business Scenarios, Roles

**Version:** 1.0 — March 2026
**Status:** Locked outline confirmed. All 9 architectural questions answered.
**Scope:** Phase 1 and Phase 2 combined. AR function only.

---

## GOVERNING PRINCIPLES

Before the detail, three principles govern every communication in this document.

**Principle 1 — AR Hub is the AR subledger, not the operational system.**
iWRS and SiBMA remain operational. The AR Hub owns the financial AR position. iWRS owns
the customer operational record. These are complementary, not competing.

**Principle 2 — The AR Hub never is the point of collection.**
Every payment originates in an operational system (iWRS counter, bank, payment gateway,
agent system). The AR Hub receives, reconciles, and clears. Counter staff, agents, and
customers never post directly into the AR Hub.

**Principle 3 — Segregation of duties is enforced at the integration boundary.**
The person or system that originates a financial event is never the same as the system
that records its financial consequence. iWRS originates. AR Hub records and clears.
SAP GL receives the summary. No single system controls the full cycle.

---

## SAAB — ONE-TIME MIGRATION ONLY

SAAB (legacy accounting system) is excluded from all ongoing communications.
It is a data source for the cutover migration only.

**Migration scope:** Open AR items as at go-live date, opening GL balances, historical
provision data for MFRS 9 baseline. One-time extract, transform, load into AR Hub.
After go-live, SAAB is read-only reference. No ongoing communication. No adapter needed.

---

## SYSTEM 1 — SAP S/4HANA PUBLIC CLOUD

### Overview

One API. One direction. No inbound. No middleware required.

The AR Hub owns the AR subledger entirely. SAP owns the General Ledger.
They touch at exactly one point: the AR Hub posts summary journal entries into SAP's GL
daily. SAP never sends anything back except a document number in the HTTP response.

### Communication Map

```
AR Hub ──[HTTPS POST]──► SAP Journal Entry API
SAP    ──[HTTP 201 + document number]──► AR Hub (response only, not a separate call)
```

---

### Scenario 1.1 — Daily GL Summary Batch

**Business context:** Every business day, all financial movements in the AR Hub
(invoices raised, payments received, adjustments posted, deposits collected) must be
reflected in SAP's General Ledger as balanced journal entries. This is the core financial
reporting feed. The SAP GL is the source of truth for SAINS's published financial
statements. The AR Hub is the source of truth for individual account positions.

**Trigger:** Automated job. Runs at 02:00 MYT daily (10 minutes after the AR Hub's
own daily reconciliation jobs complete).

**Who initiates:** SystemProcess role. Automated. No human intervention unless retry
is required.

**Direction:** AR Hub → SAP. Outbound only.

**Protocol:**
- HTTPS TLS 1.3
- OAuth2 Client Credentials Grant (token fetched from SAP token endpoint, cached 50 min)
- CSRF token fetched before each POST (SAP OData V2 requirement)
- OData V2 POST to `API_JOURNAL_ENTRY_POST`
- Payload: JSON (UBL-compliant journal entry structure)

**Frequency:** Once per calendar day. Single batch covering all prior-day transactions.

**What SAP receives per posting type:**

| Transaction Type | Debit GL | Credit GL | AR Hub Source |
|---|---|---|---|
| Invoices raised | AR Control Account | Water Revenue | Invoice records (status OPEN) |
| Payments received | Bank Clearing Account | AR Control Account | Payment records (status ALLOCATED) |
| Credit adjustments | Water Revenue | AR Control Account | Adjustment records (CREDIT, posted) |
| Debit adjustments | AR Control Account | Water Revenue | Adjustment records (DEBIT, posted) |
| Deposits received | Bank Clearing Account | Deposit Liability | Deposit records (status HELD) |

**Aggregation rule:** All transactions of the same type on the same day are aggregated
into a single journal line pair per GL account per cost centre. SAP never sees individual
customer transactions. It sees: "On 20 March 2026, AR Control Account increased by
RM 2,847,392.45 across Seremban branch." Individual detail lives in the AR Hub only.

**Idempotency:** The `GLPostingBatch.idempotencyKey` field (format: `YYYYMMDD_DAILY`)
prevents duplicate posting. Before each batch is submitted, the GL posting handler
checks whether an ACCEPTED batch with the same key already exists. If it does, the
submission is skipped and logged.

**Error handling:** If SAP returns an error, the batch status is set to FAILED.
The Finance Manager receives an alert. The batch can be retried via the `approveRetry`
action in the AR Hub admin interface. SAP document number is stored in
`GLPostingLine.glPostingRef` on success.

**Roles involved:**
- SystemProcess — initiates batch
- FinanceManager — approves retry on failure
- Auditor — read-only view of all batches and document numbers

---

### Scenario 1.2 — Write-Off GL Posting

**Business context:** When a Finance Manager, CFO, or Board approves a write-off,
the financial consequence must be immediately posted to SAP. The AR Hub decreases
the AR Control account and decreases the Provision for Doubtful Debts account.

**Trigger:** Approval action on WriteOff entity. Immediate on approval, not batched
with the daily job.

**Direction:** AR Hub → SAP. Outbound only.

**Protocol:** Same as Scenario 1.1.

**Frequency:** Ad-hoc. Every approved write-off generates one posting.

**What SAP receives:**
- Debit: Provision for Doubtful Debts
- Credit: AR Control Account
- Reference: Write-off approval reference number

**Roles involved:**
- FinanceSupervisor — approves write-offs ≤ RM 500
- FinanceManager — approves write-offs RM 501–RM 5,000
- CFO — approves write-offs RM 5,001–RM 50,000
- Board (via CFO submission) — approves write-offs > RM 50,000

---

### Scenario 1.3 — Deposit Refund GL Posting

**Business context:** When a Finance Manager approves a deposit refund (account closed,
deposit returned to customer), the liability must be released in SAP.

**Trigger:** `approveRefund` action on DepositRecord entity.

**Direction:** AR Hub → SAP. Outbound only.

**What SAP receives:**
- Debit: Deposit Liability Account
- Credit: Accounts Payable Clearing Account (awaiting bank payment execution in SAP)

**Roles involved:**
- FinanceSupervisor — initiates refund
- FinanceManager — approves and triggers GL posting

---

### Scenario 1.4 — Bad Debt Provision GL Posting (Monthly)

**Business context:** At month-end, the MFRS 9 ECL calculation determines the required
provision balance. The movement (increase or decrease) is posted to SAP.

**Trigger:** `approveRun` action on ECLCalculationRun entity, followed by `postToGL`.

**Direction:** AR Hub → SAP. Outbound only.

**Frequency:** Once per month, on or before business day 4 of the following month.

**What SAP receives:**
- If provision increases: Debit Bad Debt Expense / Credit Provision for Doubtful Debts
- If provision decreases: Debit Provision / Credit Bad Debt Expense (reversal)

**Roles involved:**
- FinanceManager — approves ECL run
- CFO — may additionally approve for board reporting periods
- Auditor — reviews provision calculation before approval

---

### Scenario 1.5 — Period-End Accrual GL Posting

**Business context:** On the last day of each month, water consumed but not yet billed
represents revenue earned but not yet invoiced. This is a contract asset under MFRS 15
and must be accrued.

**Trigger:** Automated job on last calendar day of each month, 03:00 MYT.

**Direction:** AR Hub → SAP. Outbound only.

**Frequency:** Once per month.

**What SAP receives:**
- Debit: Accrued Revenue (Balance Sheet)
- Credit: Water Revenue (P&L)

**Reversed:** On the first day of the following month, the accrual is automatically
reversed by SAP (standard SAP accrual reversal functionality). No separate AR Hub
posting required for the reversal.

**Roles involved:**
- SystemProcess — initiates automatically
- FinanceManager — reviews and approves if accrual amount is outside expected range

---

### Scenario 1.6 — PAAB Remittance Liability Posting (Monthly)

**Business context:** PAAB (Pengurusan Aset Air Berhad) charges are collected from
customers as part of the water bill. SAINS holds these as a liability and remits monthly.
The AR Hub records the liability accrual. The actual bank transfer is executed in SAP.

**Trigger:** Monthly batch on the 1st business day of each month.

**Direction:** AR Hub → SAP. Outbound only.

**What SAP receives:**
- Debit: PAAB Liability Account
- Credit: Accounts Payable (PAAB vendor)

**Roles involved:**
- SystemProcess — initiates
- FinanceManager — approves before posting

---

### Scenario 1.7 — Manual Posting Upload (fallback alternative)

**Business context:** If the OAuth2 Communication Arrangement is not configured or
the API credential has expired, a Finance Admin can download the posting file from the
AR Hub and upload it manually to SAP using SAP's standard data import tools.

**How it works:**
- Finance Admin opens the GL Posting Batches list in the AR Hub admin app
- Downloads the batch as a CSV in SAP Journal Entry upload format
- Logs into SAP and uses the standard mass upload transaction
- Returns to AR Hub, manually sets the batch status to ACCEPTED and enters the SAP
  document number

**This is the fallback, not the standard.** The automated API call is operationally
superior. Manual upload is documented here only because it is contractually supported
(it was what the ABeam tender response committed to) and it is what Finance must do
during any period where the API credential has not yet been configured.

**Roles involved:**
- FinanceAdmin — downloads and uploads
- FinanceManager — approves the manual confirmation in AR Hub

---

## SYSTEM 2 — iWRS (Water Revenue and Collection System)

### Overview

iWRS is the operational system of record for SAINS's 490,000 customer accounts. The AR
Hub is the financial subledger. These two systems have a permanent, ongoing, bidirectional
communication relationship that runs for the operational lifetime of both systems.

Because iWRS's technical outbound capability has not been confirmed, all three
integration patterns are documented. When the iWRS vendor is engaged, one pattern
will be selected. The business scenarios and data requirements are identical regardless
of which technical pattern is implemented.

### Three Technical Integration Patterns for iWRS

**Pattern A — iWRS has a REST API (preferred)**
iWRS exposes REST endpoints. The AR Hub subscribes to event notifications (webhook)
or polls on a schedule. iWRS pushes events: account created, account updated, invoice
generated, payment received. This is real-time capable and the cleanest architecture.

**Pattern B — iWRS generates batch files**
iWRS produces CSV or fixed-width files on a schedule (end of day, end of billing cycle).
Files are deposited on an SFTP server. The AR Hub polls the SFTP server and processes
the files. This is T+1 for daily data. Acceptable for most scenarios except account
master sync which requires near-real-time.

**Pattern C — AR Hub queries iWRS database directly (last resort)**
If iWRS has no outbound capability, the AR Hub connects to iWRS's database via a
read-only service account and runs scheduled queries. This is operationally risky because
it creates a direct database dependency — any iWRS schema change breaks the AR Hub.
It should only be used if Patterns A and B are both unavailable. It requires the iWRS
vendor's explicit sign-off on the read-only account and schema stability guarantees.

---

### Scenario 2.1 — Account Created in iWRS → AR Hub (real-time)

**Business context:** A new customer connection is approved. iWRS creates the customer
account. Within minutes, the AR Hub must have a matching CustomerAccount record so that
when the first invoice is generated by SiBMA and passed through iWRS, the AR Hub can
receive and post it against a known account.

**Timing requirement:** Real-time or within 5 minutes. If the AR Hub does not have the
account by the time the first invoice event arrives, the invoice goes to suspense.
At 490K accounts with ongoing new connections, this will happen daily.

**Direction:** iWRS → AR Hub

**Data fields required from iWRS:**
- Account number (primary key linkage)
- Legal name
- IC/BRN number (encrypted in transit)
- Account type (DOM, COM_S, COM_L, IND, GOV, INST)
- Service address (all fields)
- Correspondence address
- Primary and secondary phone
- Email address (if provided at registration)
- Branch code
- Tariff band
- Meter reference
- Connection size (mm)
- Account open date
- Billing basis (metered, estimated, flat rate)

**Pattern A implementation:** iWRS POSTs a JSON event to AR Hub endpoint
`POST /ar/inbound/account-created`. AR Hub creates CustomerAccount record.
Acknowledges with 201 Created + AR Hub account UUID.

**Pattern B implementation:** Daily delta file on SFTP. AR Hub polls at 06:00 MYT.
Processes new accounts from prior day. Gap: accounts opened after 06:00 the prior day
and before 06:00 today. These require a suspense resolution workflow.

**Pattern C implementation:** AR Hub queries `SELECT * FROM IWRS_ACCOUNTS WHERE
CREATED_DATE >= :lastSyncTimestamp`. Runs every 5 minutes. Read-only service account.

**Roles involved:**
- SystemProcess — processes inbound event
- FinanceAdmin — resolves any suspense invoices for unmatched accounts
- BILStaff — no action needed; this is fully automated

---

### Scenario 2.2 — Account Updated in iWRS → AR Hub (near-real-time)

**Business context:** Customer changes address, phone number, or email. Customer
changes account holder name (transfer of property). Account type changes (reclassification
from domestic to commercial). The AR Hub must stay in sync for dunning notices, eInvoice
buyer details, and MFRS 9 provision segmentation.

**Direction:** iWRS → AR Hub

**Data fields that trigger an update event:**
- Legal name change
- Any address field change
- Phone or email change
- Account type reclassification
- Tariff band change
- Account closure (accountStatus → CLOSED)
- Voluntary disconnection status
- Meter reference change (meter replacement)

**Critical:** The AR Hub processes restricted field changes through the AccountChangeRequest
workflow (Part 2 spec). When iWRS sends an update for a restricted field, the AR Hub
creates an AccountChangeRequest in APPROVED status (since iWRS is the authoritative
source) rather than PENDING. The change is applied immediately. An audit log entry
records that the change originated from iWRS.

**Frequency:** Event-driven (Pattern A), daily delta (Pattern B), 5-minute poll (Pattern C).

**Roles involved:**
- SystemProcess — applies update
- FinanceAdmin — reviews exception cases where update conflicts with AR Hub state

---

### Scenario 2.3 — Account Closed in iWRS → AR Hub

**Business context:** Customer terminates service. iWRS closes the account. The AR Hub
must stop dunning, calculate final balance, trigger deposit refund process, and post
the account closure journal entry.

**Direction:** iWRS → AR Hub

**AR Hub actions on receipt:**
1. Check balanceOutstanding. If > 0, do NOT close — flag for Finance review
2. If balanceOutstanding = 0 and balanceDeposit > 0, initiate deposit refund workflow
3. If both zero, set accountStatus = CLOSED
4. Cancel any active PTP or payment plan
5. Freeze dunning at current level

**Roles involved:**
- SystemProcess — processes event
- FinanceAdmin — reviews accounts that cannot be closed due to outstanding balance

---

### Scenario 2.4 — Invoice Generated by SiBMA, Passed Through iWRS → AR Hub

**Business context:** SiBMA generates the monthly water bill based on meter readings.
SiBMA passes the invoice data to iWRS (SiBMA → iWRS is SiBMA's internal process).
iWRS then fires an invoice event to the AR Hub. The AR Hub creates the Invoice record
and the open item. This is the fundamental AR creation event.

**Direction:** iWRS → AR Hub

**Frequency:** Monthly per account. With 490,000 accounts and staggered billing cycles,
this is a continuous daily flow — approximately 16,000 invoices per day spread across
the month.

**Data fields required:**
- Invoice number (unique, from SiBMA/iWRS)
- Account number
- Invoice date
- Due date (invoice date + standard payment terms, typically 30 days)
- Billing period from / to
- Line items (water consumption charge, base charge, sewerage, PAAB, any others)
- Amount per line, tax category, tax amount
- Total invoice amount
- Consumption in m³
- Meter read: previous and current
- Meter read type (actual or estimated)
- Source system identifier

**AR Hub actions on receipt:**
1. Match invoiceNumber to accountNumber — resolve to CustomerAccount.ID
2. Check buyerTIN status — if commercial and TIN not verified, set status HELD_NO_TIN
3. Check consumption reasonableness against ConsumptionProfile — if anomalous, create ConsumptionAnomaly
4. Increment invoice sequence counter for eInvoice purposes
5. Create Invoice record with status OPEN
6. Update CustomerAccount.balanceOutstanding
7. Write AuditTrailEntry
8. If einvoiceRequired = true, queue for MyInvois submission

**Roles involved:**
- SystemProcess — processes event
- FinanceAdmin — resolves HELD_NO_TIN invoices
- BILSupervisor — reviews consumption anomalies

---

### Scenario 2.5 — Counter Payment Recorded in iWRS → AR Hub

**Business context:** Customer pays at a SAINS counter. Counter staff use iWRS to
record the payment and print a receipt. iWRS fires a payment event to the AR Hub.
The AR Hub's Payment Orchestrator runs the clearing engine and allocates the payment
against open invoices.

**Direction:** iWRS → AR Hub

**Frequency:** Real-time or near-real-time. Counter operations run 08:00–17:00 MYT
on business days. Volume estimated at 2,000–5,000 counter transactions per day across
all branches.

**Data fields required:**
- Payment reference (iWRS-generated receipt number)
- Account number
- Payment date
- Value date
- Channel: COUNTER_CASH, COUNTER_CHEQUE, or COUNTER_CARD
- Amount
- Cashier ID
- Counter code / branch code
- For cheque: cheque number, bank, clearance due date

**Special handling for cheques:** When channel = COUNTER_CHEQUE, the Payment Orchestrator
creates the payment record with status CLEARING_PENDING. The invoice is NOT cleared
immediately. Clearing is held for T+3 business days until Finance Admin confirms clearance
or marks as bounced. iWRS must be notified of the cheque clearance status so its own
records stay in sync.

**Roles involved:**
- BILStaff — records payment in iWRS (no AR Hub access for this transaction)
- SystemProcess — AR Hub Payment Orchestrator processes event
- FinanceAdmin — confirms cheque clearance in AR Hub
- FinanceSupervisor — handles bounced cheques

---

### Scenario 2.6 — AR Hub Balance Query ← iWRS (read)

**Business context:** When a counter staff member opens a customer account in iWRS,
iWRS should display the current AR position: total outstanding balance, oldest overdue
invoice, dunning level, active payment plan status, and deposit held. The AR Hub is
the authoritative source for this data.

**Direction:** iWRS calls AR Hub → AR Hub responds. Inbound to AR Hub (read only).

**Protocol:** iWRS calls AR Hub OData endpoint:
`GET /ar/CustomerAccounts?$filter=accountNumber eq '{accNo}'&$select=balanceOutstanding,dunningLevel,isPaymentPlan,balanceDeposit`

**Authentication:** iWRS uses a service account with BILStaff role JWT. Read-only.

**Frequency:** On-demand. Every time a counter staff member opens an account in iWRS.

**Response time SLA:** < 300ms P99 (HANA indexed query — well within capability).

**What iWRS displays to counter staff:**
- Total outstanding balance
- Dunning level and since-date
- Active disputes flag
- Payment plan flag
- Deposit amount held
- Last payment date and amount

**Roles involved:**
- iWRS service account (BILStaff role) — system-to-system call
- BILStaff — sees the data in iWRS UI, does not touch AR Hub directly

---

### Scenario 2.7 — Disconnection Decision: AR Hub → iWRS

**Business context:** When a dunning Level 4 account has been reviewed and a
BIL Supervisor or Finance Supervisor authorises disconnection in the AR Hub, iWRS
must be notified so it can update the account's operational status and the field
operations team can action the physical disconnection.

**Direction:** AR Hub → iWRS. Outbound.

**Trigger:** Manual authorisation by BILSupervisor or FinanceSupervisor in the AR Hub
Dunning Management app.

**Data sent to iWRS:**
- Account number
- Disconnection authorisation reference
- Authorised by (user ID)
- Authorisation date
- Dunning level at authorisation
- Outstanding balance at authorisation

**iWRS action on receipt:** Updates account operational status to PENDING_DISCONNECTION.
If Metis integration is live, iWRS or the AR Hub creates the Metis work order (see
System 8 — Metis). If Metis is not yet integrated, the field team is notified via
the disconnection queue in iWRS.

**Pattern A:** AR Hub POSTs to iWRS REST endpoint.
**Pattern B:** AR Hub writes to a disconnection queue file on shared SFTP. iWRS polls.
**Pattern C:** AR Hub writes to an iWRS staging table. iWRS reads from it.

**Roles involved:**
- BILSupervisor — authorises disconnection
- FinanceSupervisor — may also authorise
- SystemProcess — executes the outbound call after authorisation

---

### Scenario 2.8 — Reconnection Notification: AR Hub → iWRS

**Business context:** When a disconnected account's outstanding balance is fully cleared,
the AR Hub must notify iWRS so the reconnection process can be initiated and the
account's operational status updated.

**Direction:** AR Hub → iWRS. Outbound. Triggered automatically when clearing engine
resolves all open invoices on a TEMP_DISCONNECTED account to zero balance.

**Data sent to iWRS:**
- Account number
- Cleared balance amount
- Payment reference that cleared the balance
- Clearance date and time

**Roles involved:**
- SystemProcess — automatic trigger on payment clearance
- BILSupervisor — reviews reconnection queue in iWRS

---

## SYSTEM 3 — SiBMA (Water Billing System)

SiBMA communicates exclusively with iWRS. SiBMA does not communicate directly with
the AR Hub. iWRS is the single outbound point for all SiBMA-originated data.

From the AR Hub's perspective, invoice data arrives from iWRS (Scenario 2.4).
Whether that data originated in SiBMA is irrelevant to the AR Hub. The AR Hub never
needs to know which billing engine produced an invoice — it only needs the invoice data
in a format it can process.

**No direct SiBMA ↔ AR Hub communication. No adapter needed.**

---

## SYSTEM 4 — PAYMENT CHANNELS (all eight)

### Overview

Eight payment channels feed into the AR Hub's Payment Orchestrator. The Orchestrator
normalises all channels into a single PaymentOrchestratorEvent, resolves the account,
and runs the clearing engine. The AR Hub never originates a payment — it always receives.

**The four integration patterns:**

| Pattern | Channels | Direction | Mechanism |
|---|---|---|---|
| 1 — iWRS-originated | Counter cash, cheque, card | iWRS → AR Hub | Event/file from iWRS (Scenario 2.5) |
| 2 — Direct inbound | JomPAY, Agent, Bank EFT, Bayaran Pukal | External → AR Hub | SFTP file or HTTP POST |
| 3 — AR Hub bidirectional | DuitNow QR, eMandate | AR Hub ↔ PayNet | REST API, webhook |
| 4 — Customer self-service | FPX via iSAINS | Three sub-scenarios | See below |

---

### Scenario 4.1 — JomPAY (Pattern 2)

**Business context:** Customer pays their SAINS water bill at any of 42 Malaysian banks
using JomPAY and SAINS's registered Biller Code. The transaction is processed by the
bank's JomPAY infrastructure. The acquiring bank aggregates all JomPAY transactions
for SAINS for the day and deposits a reconciliation file on SFTP by 08:00 MYT.

**Direction:** Bank SFTP → AR Hub. One direction. Daily batch.

**Protocol:** SFTP over SSH-2. RSA 4096 key pair authentication. File format: CSV
(PayNet standard JomPAY reconciliation format).

**Frequency:** Once daily. File covers T-1 transactions (yesterday's payments).

**AR Hub job:** `sains-ar-jompay-download` — scheduled 08:30 MYT daily via BTP Job
Scheduler (Option A) or node-cron (Option B).

**Processing flow:**
1. AR Hub polls bank SFTP, downloads reconciliation file
2. `jompay-adapter.parseReconciliationFile()` parses CSV
3. Each line matched against CustomerAccount.accountNumber
4. Matched: PaymentOrchestratorEvent created with status RESOLVED
5. Unmatched: PaymentOrchestratorEvent created with status SUSPENSE
6. Payment Orchestrator runs clearing engine on RESOLVED events
7. Finance Admin reviews SUSPENSE items within 3 business days

**Reconciliation:** Total JomPAY amount per day must match the bank statement credit
for the same day. Discrepancy = bank statement reconciliation exception.

**Roles involved:**
- SystemProcess — downloads file and runs matching
- FinanceAdmin — resolves suspense items
- FinanceSupervisor — approves suspense items above RM 1,000 threshold

---

### Scenario 4.2 — DuitNow QR (Pattern 3)

**Business context:** Every invoice generated by the AR Hub (Phase 2) has an associated
DuitNow QR code. The QR is printed on paper bills and embedded in digital invoices and
WhatsApp messages. Customer scans the QR using any Malaysian banking app. PayNet
processes the payment and sends a real-time webhook to the AR Hub.

**Sub-scenario A — QR generation (AR Hub → PayNet):**
Direction: AR Hub → PayNet (outbound, called internally — no external API call needed
for payload generation; the QR payload is computed locally using the EMVCo TLV algorithm
in `duitnow-adapter.js`).

For QR image generation, an npm library (qrcode) renders the payload string into a
PNG. No PayNet API call is required for payload generation.

PayNet registration required: SAINS registers as a DuitNow merchant via PayNet's
merchant onboarding portal. This produces a Merchant ID used in the QR payload.

**Sub-scenario B — Payment notification (PayNet → AR Hub):**
Direction: PayNet → AR Hub. Inbound webhook.

Protocol: HTTPS POST to `POST /payment/processWebhookNotification`.
Security: HMAC-SHA256 signature in `X-PayNet-Signature` header. Validated by
`duitnow-adapter.validateWebhookSignature()` before any processing.

Response time: AR Hub must respond 200 OK within 5 seconds or PayNet retries.

**Frequency:** Real-time. Every QR scan that results in a successful payment.

**AR Hub actions on webhook receipt:**
1. Validate HMAC signature
2. Resolve billRef to CustomerAccount
3. Create PaymentOrchestratorEvent with status RESOLVED
4. Mark DuitNowQRCode.status = PAID
5. Payment Orchestrator clears invoice

**Roles involved:**
- SystemProcess — processes webhook and runs clearing
- FinanceAdmin — reviews any failed webhook processing

---

### Scenario 4.3 — PayNet eMandate / Direct Debit (Pattern 3)

**Business context:** Customer authorises a recurring direct debit mandate online.
On the billing due date, the AR Hub submits a debit instruction to PayNet. PayNet
debits the customer's bank account and returns the result.

**Sub-scenario A — Mandate registration:**
Direction: AR Hub → PayNet REST API. Returns registration URL.
BILStaff or customer is redirected to PayNet's mandate registration portal.
Customer authenticates at their bank and approves.
PayNet sends a callback to the AR Hub confirming mandate is ACTIVE.

**Sub-scenario B — Monthly debit run:**
Direction: AR Hub → PayNet REST API (debit instruction). PayNet → AR Hub (debit result).

Timing: 2nd business day of each month at 07:00 MYT.

Processing flow:
1. Job fetches all eMandate records with status = ACTIVE
2. For each mandate, fetches the outstanding balance from the CustomerAccount
3. Submits debit instruction to PayNet for min(outstandingBalance, maxAmountPerDebit)
4. PayNet processes debit (typically by 09:00 MYT same day)
5. PayNet returns result: SUCCESS or RETURNED with return code
6. SUCCESS: AR Hub creates payment record, clears invoices
7. RETURNED: AR Hub records failed debit, increments consecutiveFailures counter
8. If consecutiveFailures ≥ 3: suspend mandate, alert Finance Admin, resume standard
   dunning path for the account

**Return codes (PayNet standard):**
- NSF: Insufficient funds → increment failure count
- INVALID_ACCOUNT: Account closed at bank → suspend mandate immediately
- STOPPED: Customer stopped payment at bank → suspend, alert Finance Admin
- DECEASED: → suspend, alert FinanceSupervisor for compassionate handling

**Roles involved:**
- BILStaff — initiates mandate registration for counter walk-in customers
- Customer — self-registers via iSAINS
- SystemProcess — monthly debit run
- FinanceAdmin — reviews suspended mandates and NSF returns

---

### Scenario 4.4 — Agent Collection / Agensi Kutipan (Pattern 2)

**Business context:** Third-party collection agents collect payments from customers
on SAINS's behalf (door-to-door, kiosk, etc.). The agent system generates a daily
remittance file containing all collections. This file is deposited on the agent's SFTP
server. The AR Hub downloads, processes, and clears.

**Direction:** Agent SFTP → AR Hub. Inbound batch.

**Protocol:** SFTP SSH-2. Per-agent RSA key pair.

**Frequency:** Daily. File covers prior-day collections.

**Processing flow:**
1. AR Hub polls each agent SFTP at 09:30 MYT daily
2. `jompay-adapter.js` (or a dedicated agent-adapter) parses file
3. Each line validated: amount > 0, date valid, account reference present
4. Matched: PaymentOrchestratorEvent RESOLVED
5. Unmatched: PaymentOrchestratorEvent SUSPENSE
6. Total must equal agent remittance advice amount — discrepancy generates alert

**Critical control:** The agent remittance total must be reconciled against the bank
deposit from the same agent on the same day. The AR Hub's bank statement reconciliation
(System 6) confirms that the agent remittance file total matches a bank credit.

**Roles involved:**
- SystemProcess — downloads and processes file
- FinanceAdmin — resolves suspense items and discrepancies
- FinanceSupervisor — approves reconciliation sign-off

---

### Scenario 4.5 — Bayaran Pukal (Pattern 2, three scenarios)

**Business context:** Government agencies and large commercial entities pay water bills
in bulk (one payment covering multiple account numbers). Three variants depending on
how SAINS receives the data.

**Scenario 4.5A — Government portal CSV/Excel:**
Finance Admin logs into the Bayaran Pukal government portal, downloads the payment
allocation file, and uploads it into the AR Hub's batch import interface (same
`CollectionImportBatch` workflow as agent collection).
Direction: Manual inbound. Finance Admin uploads via AR Hub UI.
Frequency: Manual, typically daily or per payment notification.

**Scenario 4.5B — Bank SFTP file:**
The bank that processes Bayaran Pukal bulk payments deposits a file on SFTP.
AR Hub polls same as JomPAY.
Direction: Bank SFTP → AR Hub. Automated daily batch.

**Scenario 4.5C — Direct HTTP POST:**
The Bayaran Pukal system sends a real-time HTTP POST to the AR Hub's inbound payment
endpoint.
Direction: Bayaran Pukal → AR Hub. Real-time inbound.
Protocol: HTTPS POST. API key authentication.

**All three scenarios use the CollectionImportBatch processing engine.**
The channel code is set to BAYARAN_PUKAL for all scenarios.
Finance Admin confirms the batch before it is processed (approval step).

**Roles involved:**
- FinanceAdmin — uploads (4.5A), reviews and approves batch (all)
- SystemProcess — processes batch after approval
- FinanceSupervisor — approves batches above RM 50,000 total

---

### Scenario 4.6 — FPX via iSAINS Customer Portal (Pattern 4, three scenarios)

**Business context:** Customer pays online via iSAINS portal using FPX online banking.
Three scenarios depending on SAINS's technical decision.

**Scenario 4.6A — FPX notifies AR Hub directly (recommended):**
iSAINS is a UI shell. It redirects the customer to the FPX gateway. Customer pays at
their bank. FPX sends a real-time payment notification webhook directly to the AR Hub.
The AR Hub is the registered FPX merchant endpoint.

Direction: FPX gateway → AR Hub webhook. iSAINS → FPX UI redirect.
iWRS is not involved.
Protocol: HTTPS POST webhook. FPX standard notification format.

**Scenario 4.6B — iSAINS records in iWRS first:**
iSAINS receives the FPX success callback. iSAINS posts payment to iWRS. iWRS fires
payment event to AR Hub (Scenario 2.5 pathway).
Direction: FPX → iSAINS → iWRS → AR Hub.
Risk: Three systems in the chain. Any failure between iSAINS and iWRS means the AR Hub
never receives the payment. Customer's balance does not update.

**Scenario 4.6C — iSAINS calls AR Hub directly:**
iSAINS receives FPX callback. iSAINS POSTs payment directly to AR Hub OData endpoint.
Direction: FPX → iSAINS → AR Hub.
Risk: iSAINS becomes a payment-posting system, which means iSAINS must be available
24/7 and must not be down during payment processing windows.

**Recommendation confirmed: Scenario 4.6A.** AR Hub is the FPX merchant. iSAINS is
the UI only. This eliminates iWRS from the digital payment chain and ensures the AR Hub
has an authoritative payment record with the FPX transaction reference.

**iSAINS balance display:** iSAINS still calls the AR Hub read API for balance display.
This is unchanged across all three scenarios.

**Roles involved:**
- Customer — initiates payment in iSAINS
- SystemProcess — AR Hub receives and processes FPX webhook
- FinanceAdmin — reviews any failed or unmatched FPX notifications

---

### Scenario 4.7 — Manual EFT / Bank Transfer (via Bank Statement)

**Business context:** Customer or government entity makes a direct bank transfer to
SAINS's account. No prior notification to SAINS. The payment appears on the bank
statement. The AR Hub's bank statement reconciliation engine identifies the credit
and attempts auto-match.

**Direction:** Bank statement file → AR Hub (see System 6 — Bank Statement).

This is not a separate payment integration. It flows through the bank statement
reconciliation pathway. The payment is only recorded in the AR Hub once a Finance Admin
matches the bank statement line to a customer account.

**Roles involved:**
- SystemProcess — downloads bank statement, runs auto-match
- FinanceAdmin — manually matches unresolved lines
- FinanceSupervisor — approves reconciliation

---

### Scenario 4.8 — WhatsApp Payment Reminder and Link (Notification, not payment)

**Business context:** The AR Hub sends a WhatsApp message to customers with overdue
accounts, containing a payment link. The link directs the customer to FPX or DuitNow
payment. The actual payment follows Scenario 4.2 (DuitNow) or 4.6 (FPX).

**Direction:** AR Hub → Meta WhatsApp Business API → Customer phone. Outbound only.

**Protocol:** HTTPS POST to Meta Cloud API. Bearer token authentication. Pre-approved
message templates only.

**Frequency:** Daily at 09:00 MYT for all accounts at dunning Level 1 and above that
have opted in to WhatsApp notifications.

**Opt-out handling:** Customer replies 'STOP' or 'BERHENTI'. The AR Hub's WhatsApp
webhook (inbound) receives this, sets whatsAppOptOut = true on CustomerAccount, and
suppresses all future WhatsApp messages to that number. PDPA compliance.

**Roles involved:**
- SystemProcess — sends reminders automatically
- Customer — can opt out

---

## SYSTEM 5 — LHDN MYINVOIS

### Overview

SAINS is in Phase 1 of LHDN's e-invoice mandate (August 2024). Full compliance is
mandatory now. All applicable invoices must be submitted to LHDN's MyInvois system.

Direction: AR Hub → LHDN only. LHDN returns UUID and validation status in the HTTP
response. There is no separate inbound call from LHDN to the AR Hub.

---

### Scenario 5.1 — Individual B2B / Commercial e-Invoice Submission

**Business context:** Commercial, industrial, and institutional accounts with verified
Buyer TINs require individual e-invoices. Each invoice is submitted to LHDN as a
separate document.

**Trigger:** Two paths:
- Automated: Invoice created with einvoiceRequired = true and einvoiceStatus = PENDING.
  Queued for submission. Job runs every 2 hours.
- Manual: Finance Admin triggers submitToEInvoice action for a specific invoice.

**Direction:** AR Hub → LHDN MyInvois API.

**Protocol:** HTTPS TLS 1.3. OAuth2 Client Credentials. UBL 2.1 JSON document.
Digital signature required (SHA256withRSA using MCMC-issued certificate).
Rate limit: 100 requests per minute.

**Frequency:** Continuous queue processing, every 2 hours.

**Submission process:**
1. `myinvois-adapter.buildInvoiceDocument()` creates UBL 2.1 JSON
2. `myinvois-adapter.signDocument()` applies digital signature
3. `myinvois-adapter.submitDocuments()` POSTs to LHDN API (up to 100 per batch)
4. LHDN runs 7 validators (structure, core fields, signature, taxpayer, code, duplicate, currency)
5. ACCEPTED: AR Hub stores lhdnUUID, calculates 72-hour cancellation deadline
6. REJECTED: AR Hub sets einvoiceStatus = REJECTED, logs to EInvoiceErrorLog

**HELD_NO_TIN handling:** If a commercial account's Buyer TIN is not verified,
the invoice is set to status HELD_NO_TIN. It cannot be submitted. Finance Admin
must verify the TIN via the `verifyBuyerTIN` action, which releases the hold and
re-queues the invoice.

**Roles involved:**
- SystemProcess — processes submission queue automatically
- FinanceAdmin — resolves HELD_NO_TIN invoices, retries failed submissions
- FinanceSupervisor — approves manual submission of flagged invoices

---

### Scenario 5.2 — Consolidated B2C e-Invoice (Monthly)

**Business context:** Domestic residential accounts (490K majority) are B2C transactions.
Under LHDN's consolidated e-invoice provision, all B2C transactions for a calendar month
can be aggregated into a single consolidated e-invoice. This must be submitted within
7 calendar days after month-end.

**Trigger:** Automated job on the 5th calendar day of each month at 09:00 MYT.
(This gives 5 of the 7 allowed days as processing buffer.)

**Direction:** AR Hub → LHDN MyInvois API.

**Buyer details (LHDN mandated for B2C):**
- Buyer TIN: EI00000000010 (standard LHDN placeholder for general public)
- Buyer name: General Public

**What is aggregated:** All domestic invoices for the prior month where einvoiceRequired = false.
Single UBL document with one line item: "Consolidated Water Service Charges — YYYY-MM".

**Finance Manager approves** the consolidated batch in the AR Hub before submission.
This is a financial sign-off, not a technical step.

**Roles involved:**
- SystemProcess — generates consolidated batch
- FinanceManager — approves before submission
- FinanceAdmin — submits or re-submits on failure
- CFO — reviews for board reporting months

---

### Scenario 5.3 — e-Invoice Cancellation (within 72 hours)

**Business context:** An invoice was accepted by LHDN but the transaction needs to be
reversed (billing error, duplicate invoice, customer dispute resolved). LHDN allows
cancellation within 72 hours of the validation timestamp.

**Trigger:** Finance Admin initiates `cancelEInvoice` action in the AR Hub e-Invoice
Excellence app. AR Hub checks whether the 72-hour window is still open. If yes,
it calls the LHDN cancellation API. If no, it rejects the cancellation action and
instructs Finance Admin to raise a Credit Note instead.

**Direction:** AR Hub → LHDN MyInvois API (PUT to document state endpoint).

**What happens in the AR Hub after cancellation:**
- Invoice einvoiceStatus = CANCELLED
- The underlying AR Invoice status is determined separately (reversal is a separate action)

**Roles involved:**
- FinanceAdmin — initiates cancellation
- FinanceSupervisor — approves cancellation for invoices above RM 5,000

---

### Scenario 5.4 — Credit Note (after 72-hour window)

**Business context:** Invoice was accepted by LHDN but the 72-hour cancellation window
has expired. To correct the invoice, a Credit Note must be issued. The Credit Note is
a separate e-invoice document with a negative amount, linked to the original by the
original invoice's LHDN UUID.

**Trigger:** Finance Admin initiates `raiseCreditNote` action in the AR Hub.
The AR Hub creates a new Invoice record with invoiceType = CREDIT_NOTE.
The credit note is queued for e-invoice submission as per Scenario 5.1.

**Direction:** AR Hub → LHDN (new document submission).

**Roles involved:**
- FinanceAdmin — raises credit note
- FinanceSupervisor — approves credit note above RM 1,000
- FinanceManager — approves credit note above RM 10,000

---

## SYSTEM 6 — BANK STATEMENTS (MT940 / CAMT.053)

### Overview

SAINS holds bank accounts with multiple Malaysian banks. Daily bank statements provide
the reconciliation backbone — they confirm that what the AR Hub has recorded as received
matches what the bank has actually received. This is a non-negotiable daily close control.

Direction: Bank SFTP → AR Hub. AR Hub reads; bank never reads from AR Hub.

---

### Scenario 6.1 — Daily Bank Statement Download and Auto-Match

**Business context:** Every banking day, each SAINS operating bank generates a statement
file covering all credits and debits for the prior day. The AR Hub downloads these files,
imports them, and attempts to auto-match each credit line to an existing payment record
in the AR Hub.

**Direction:** Bank SFTP → AR Hub. Inbound.

**Protocol:** SFTP SSH-2. Per-bank RSA key pair (one per bank — Maybank, CIMB, etc.).
File format: MT940 (current standard). CAMT.053 XML (future ISO 20022 standard).

**Frequency:** Three times daily — 08:00, 12:00, 18:00 MYT. Some banks support
real-time via CAMT.053 push; this is bank-dependent.

**Auto-matching logic:**
1. For each credit line in the bank statement, extract the bankReference field
2. Search AR Hub payments for a payment where bankReference matches
3. If exact match found: mark statement line as MATCHED, set matchConfidence = AUTO_HIGH
4. If no exact match: leave as UNMATCHED, queue for Finance Admin manual review

**Manual match:** Finance Admin opens BankStatementImports in the AR Hub, sees UNMATCHED
lines, and manually associates each with a payment or creates a new suspense payment.

**Reconciliation sign-off:** Finance Manager approves reconciliation via `approveReconciliation`
action once all lines are matched or resolved. This creates a ReconciliationRecord with
status APPROVED.

**Roles involved:**
- SystemProcess — downloads file, runs auto-match
- FinanceAdmin — manually matches unresolved lines
- FinanceSupervisor — reviews high-value unmatched items
- FinanceManager — approves daily reconciliation

---

## SYSTEM 7 — iSAINS CUSTOMER PORTAL AND MOBILE APP

### Overview

iSAINS is a consumer of AR Hub data. It reads from the AR Hub to display balances,
invoices, and payment history. It may also originate payments (Scenario 4.6).
The AR Hub never pushes to iSAINS — iSAINS always calls the AR Hub.

---

### Scenario 7.1 — Customer Balance and Invoice Display

**Business context:** Customer opens iSAINS app or portal. iSAINS displays current
outstanding balance, last payment, invoice history, and DuitNow QR for the latest
unpaid invoice.

**Direction:** iSAINS → AR Hub. Read only. Inbound to AR Hub.

**Protocol:** HTTPS OData V4 GET. Customer OAuth2 JWT (separate Keycloak/XSUAA customer
realm from staff realm).

**Endpoints called:**
- `GET /ar/CustomerAccounts?$filter=accountNumber eq '{accNo}'&$select=balanceOutstanding,dunningLevel,lastPaymentDate`
- `GET /ar/Invoices?$filter=account_ID eq '{id}' and status in ('OPEN','PARTIAL')&$orderby=dueDate asc`
- `GET /payment/DuitNowQRCodes?$filter=invoice_ID eq '{invId}' and status eq 'ACTIVE'`

**Frequency:** On-demand. Every page load in iSAINS.

**Roles involved:**
- Customer (separate OAuth2 realm) — read-only access to own account data only
- iSAINS service account — fetches data on behalf of authenticated customer

---

### Scenario 7.2 — Customer PTP Self-Service

**Business context:** Customer with overdue balance cannot pay in full but commits to
pay by a specific date. Customer initiates PTP via iSAINS. This creates a PTPSelfService
record in the AR Hub and freezes dunning escalation.

**Direction:** iSAINS → AR Hub. Inbound POST.

**Protocol:** HTTPS OData V4 POST to `POST /collections/PTPSelfServices`.

**AR Hub actions:**
1. Validate: only one active PTP per account at a time
2. Validate: promisedPaymentDate must be within 30 days
3. Validate: promisedAmount > 0 and ≤ outstandingBalance
4. Create PTPSelfService record
5. Link to ar.PromiseToPay record (Phase 1 entity)
6. Set dunning escalation suspended flag

**Roles involved:**
- Customer — self-service via iSAINS
- BILSupervisor — can override or cancel customer-initiated PTPs
- SystemProcess — checks PTP compliance on promisedPaymentDate

---

### Scenario 7.3 — Customer Dispute Submission

**Business context:** Customer believes their bill is incorrect and submits a dispute
via iSAINS. The AR Hub creates a Dispute record and holds the invoice from dunning
escalation until the dispute is resolved.

**Direction:** iSAINS → AR Hub. Inbound POST.

**Protocol:** HTTPS OData V4 POST to `POST /ar/Disputes`.

**Roles involved:**
- Customer — submits dispute via iSAINS
- FinanceAdmin — reviews and processes dispute
- FinanceSupervisor — approves resolution involving credit note or adjustment

---

## SYSTEM 8 — METIS (WORK ORDER SYSTEM)

### Overview

Metis manages field work orders for SAINS's technical operations. The AR Hub interacts
with Metis in two scenarios: disconnection work order creation and reconnection
notification. Both are bidirectional — AR Hub sends, Metis acknowledges or confirms
completion.

---

### Scenario 8.1 — Disconnection Work Order: AR Hub → Metis

**Business context:** BIL Supervisor authorises disconnection of a Level 4 dunning
account. The AR Hub creates the disconnection work order in Metis. Metis assigns it
to a field team. The field team physically disconnects the supply.

**Direction:** AR Hub → Metis. Outbound.

**Trigger:** Manual. BILSupervisor clicks the authorise disconnection action in the
AR Hub Dunning Management app.

**Data sent to Metis:**
- Account number
- Customer name
- Service address (full)
- Meter reference
- Authorisation reference
- Authorised by (user ID)
- Requested disconnection date
- Outstanding balance at authorisation
- Dunning level at authorisation

**Protocol:** HTTPS REST POST to Metis work order creation API.
Authentication: API key or OAuth2 (to be confirmed with Metis vendor).

**Roles involved:**
- BILSupervisor — authorises disconnection in AR Hub
- SystemProcess — AR Hub sends work order to Metis on authorisation
- FinanceSupervisor — may also authorise for certain account types

---

### Scenario 8.2 — Disconnection Completion: Metis → AR Hub

**Business context:** Field team completes physical disconnection. Metis marks the work
order complete. Metis notifies the AR Hub. AR Hub updates CustomerAccount.accountStatus
to TEMP_DISCONNECTED.

**Direction:** Metis → AR Hub. Inbound.

**Protocol:** HTTPS POST to AR Hub endpoint. Metis sends work order completion event.

**AR Hub actions on receipt:**
1. Verify work order reference matches an authorised disconnection
2. Update CustomerAccount.accountStatus = TEMP_DISCONNECTED
3. Record disconnection date
4. Write AuditTrailEntry
5. Suspend dunning escalation (account is now in disconnected state)

**Roles involved:**
- SystemProcess — processes Metis completion event
- BILSupervisor — notified of completed disconnection

---

### Scenario 8.3 — Reconnection Notification: AR Hub → Metis

**Business context:** TEMP_DISCONNECTED account's balance is fully cleared (payment
received and allocated). AR Hub automatically triggers reconnection. Metis receives
the reconnection work order. Field team reconnects supply.

**Direction:** AR Hub → Metis. Outbound. Automatic on payment clearance.

**Trigger:** Payment Orchestrator clearing engine detects that all open invoices for
a TEMP_DISCONNECTED account have been cleared to zero.

**Data sent to Metis:**
- Account number
- Reconnection authorisation reference
- Balance cleared (zero)
- Payment reference that achieved clearance
- Clearance date and time

**Roles involved:**
- SystemProcess — automatic trigger
- BILSupervisor — notified of reconnection queue

---

## SYSTEM 9 — SPAN REGULATORY REPORTING

### Overview

SPAN (Suruhanjaya Perkhidmatan Air Negara) is SAINS's utility regulator. SAINS must
submit performance KPI reports to SPAN monthly and quarterly. The AR Hub auto-generates
the report. Finance Manager reviews. CFO submits.

Direction: AR Hub generates. Human submits to SPAN (electronic or document).

---

### Scenario 9.1 — Monthly KPI Report Generation

**Business context:** By the 5th business day of each month, SAINS must prepare the
previous month's AR KPI data for SPAN review. The AR Hub's analytics engine calculates
all required metrics directly from transactional data.

**AR Hub generates:**
- Total connections
- Total billed (RM)
- Total collected (RM)
- Collection ratio (collected / billed)
- Outstanding debt (RM)
- Bad debt written off (RM)
- Bad debt provision (RM)
- Billing accuracy rate (actual reads / total reads)
- Complaints received and resolved
- Average complaint resolution days
- Disconnection count
- Reconnection count

**Direction:** Internal calculation within AR Hub. No external call for generation.

**Trigger:** Automated job on 5th calendar day of each month.

**Roles involved:**
- SystemProcess — generates report
- FinanceManager — reviews and approves report in AR Hub
- CFO — approves final submission

---

### Scenario 9.2 — Electronic SPAN Submission

**Business context:** SPAN provides an online portal for electronic KPI submission.
Certain KPIs are submitted electronically. Finance Admin or CFO logs into the SPAN
portal and submits the approved AR Hub report.

**Direction:** Human uploads from AR Hub to SPAN portal. Not an automated API call
(SPAN does not have a confirmed public submission API).

**AR Hub provides:** Export button in the SPAN KPI Reports Fiori app. Downloads the
approved report in SPAN's required format (Excel or CSV).

**Roles involved:**
- FinanceManager — approves report
- CFO — logs into SPAN portal and submits

---

### Scenario 9.3 — Manual Document Submission

**Business context:** KPIs not covered by the electronic portal are submitted via
email or physical document to SPAN. The AR Hub generates the report narrative and
supporting schedules. Finance team formats and submits manually.

**Direction:** Internal AR Hub report → manual submission by Finance team.

**Roles involved:**
- FinanceAdmin — prepares supporting schedules
- FinanceManager — signs off report narrative
- CFO — submits to SPAN

---

## SYSTEM 10 — STAFF IDENTITY (Active Directory / LDAP / ep2p)

### Overview

Staff authentication uses SAINS's existing Active Directory. The AR Hub does not
maintain its own user directory. All user identity comes from AD via the identity
provider layer (XSUAA for Option A, Keycloak for Option B).

Direction: One-way, at login only. No business data flows through this integration.

---

### Scenario 10.1 — Staff Login Authentication

**Business context:** Any SAINS staff member accesses the AR Hub. Their credentials
are validated against SAINS Active Directory. Their role assignments in the IdP
determine what they can see and do in the AR Hub.

**Direction:** Browser → IdP (XSUAA or Keycloak) → LDAP/AD. Authentication only.

**Protocol:** OIDC/OAuth2 for browser-to-IdP. LDAPS (port 636) for IdP-to-AD.

**Role assignment:** Roles (BILStaff, FinanceAdmin, etc.) are assigned in the IdP
(XSUAA role collections or Keycloak realm roles). The IdP checks AD group membership
and maps to AR Hub roles. The AR Hub never reads AD directly.

**Frequency:** Every login session. Token refresh every 50 minutes.

**Roles involved:** Every staff user. No business data involved.

---

### Scenario 10.2 — User Provisioning and Deprovisioning

**Business context:** New staff member joins SAINS. IT creates their AD account.
IT assigns them to the appropriate AD group. The AR Hub's IdP picks up the group
membership at next login. No separate provisioning step needed in the AR Hub.

When staff member leaves: AD account disabled. AR Hub session tokens expire at their
next refresh (maximum 1 hour). No active session can continue after AD account
is disabled.

**Direction:** IT Admin → AD (manual). IdP reads AD. No AR Hub involvement.

**Roles involved:** ICTManager — manages AD groups for AR Hub role assignments.

---

## SYSTEM 11 — EMAIL AND NOTIFICATIONS (SMTP)

### Overview

The AR Hub sends email notifications for eight business scenarios. All are outbound.
No email system sends to the AR Hub. Direction is always AR Hub → SMTP → recipient.

Option A: SAP Alert Notification Service handles email routing.
Option B: Nodemailer connects directly to SAINS SMTP server.
The email content is identical in both options. The sending infrastructure differs.

---

### Scenario 11.1 — Dunning Notice Email to Customer

**Business context:** AR Hub dunning engine escalates an account. Email notice sent to
customer's registered email address.

**Recipients:** Customer (emailAddress on CustomerAccount).
**Trigger:** Dunning engine escalation job. Daily 01:00 MYT.
**Tone:** Determined by dunning path (FRIENDLY at Level 1, STANDARD at Level 2,
FIRM at Level 3).
**Language:** Bahasa Malaysia (primary), English option.

---

### Scenario 11.2 — Postal Queue Alert to Finance Admin

**Business context:** Accounts reaching dunning Level 3 or 4 require postal notices
under Act 655. The AR Hub queues these and sends Finance Admin an alert email with
the postal dispatch list.

**Recipients:** Finance Admin distribution list (configurable TBC).
**Trigger:** Daily after dunning run completes.
**Content:** List of accounts requiring postal dispatch, addresses, notice types.

---

### Scenario 11.3 — Fraud Alert Assignment Email

**Business context:** Fraud detection engine creates a HIGH or MEDIUM severity alert.
Finance Manager or Finance Supervisor is assigned and notified by email.

**Recipients:** Finance Manager (HIGH severity), Finance Supervisor (MEDIUM severity).
**Trigger:** Fraud alert creation event.
**Content:** Account number, alert pattern, alert description, link to AR Hub alert.

---

### Scenario 11.4 — GL Posting Failure Alert

**Business context:** Daily GL posting batch fails (SAP API error, balance validation
failure, expired credential). Finance Manager must be notified immediately.

**Recipients:** Finance Manager.
**Trigger:** GL posting handler on FAILED status.
**SLA:** Alert must be sent within 5 minutes of failure.

---

### Scenario 11.5 — eInvoice Cancellation Deadline Alert

**Business context:** An accepted LHDN e-invoice is approaching its 72-hour
cancellation window. Finance Admin must be alerted in time to either cancel or decide
to raise a credit note.

**Recipients:** Finance Admin.
**Trigger:** Job runs every 4 hours. Identifies invoices where cancelDeadline is
within 8 hours.

---

### Scenario 11.6 — Period Close Step Notification

**Business context:** A period close checklist step becomes due (e.g., Day 3 step
becomes actionable). The assigned Finance Admin or Supervisor is notified.

**Recipients:** Finance Admin (operational steps), Finance Supervisor (approval steps).
**Trigger:** Period close job on each business day during close week.

---

### Scenario 11.7 — Auditor Confirmation Letters

**Business context:** External auditor requests AR balance confirmation for sampled
accounts. The AR Hub generates confirmation letters and emails them to the auditor firm.

**Recipients:** External auditor firm email (configurable per audit engagement).
**Trigger:** FinanceManager initiates `generateAuditorConfirmationLetters` action.
**Content:** Account number, legal name, balance as at confirmation date, request
for response.

---

### Scenario 11.8 — eMandate Return / Failed Debit Alert

**Business context:** Direct debit instruction returns NSF or other failure code.
Finance Admin must review and decide whether to retry, suspend the mandate, or
initiate standard dunning.

**Recipients:** Finance Admin.
**Trigger:** eMandate debit run completion with RETURNED status on any debit.

---

## COMPLETE COMMUNICATION SUMMARY

### By Direction

| Direction | Count | Key Links |
|---|---|---|
| AR Hub → SAP | 7 scenarios | GL journal entries only. No customer data. |
| iWRS → AR Hub | 5 scenarios | Accounts, invoices, payments — the core operational feed |
| AR Hub → iWRS | 2 scenarios | Disconnection auth, reconnection notification |
| AR Hub ← iWRS | 1 scenario | Balance query (iWRS reads AR Hub) |
| Payment channels → AR Hub | 7 scenarios | All payment types inbound to Orchestrator |
| AR Hub ↔ PayNet | 2 scenarios | DuitNow QR and eMandate — bidirectional |
| AR Hub → LHDN | 4 scenarios | eInvoice submission, cancellation, credit note |
| Bank SFTP → AR Hub | 1 scenario | MT940/CAMT.053 bank statement |
| iSAINS → AR Hub | 3 scenarios | Balance read, PTP, dispute |
| AR Hub ↔ Metis | 3 scenarios | Disconnection work order, completion, reconnection |
| AR Hub → SPAN | 3 scenarios | KPI report (human-mediated submission) |
| AD → IdP → AR Hub | 2 scenarios | Authentication only |
| AR Hub → SMTP | 8 scenarios | Operational alerts and notifications |

### By Frequency

| Frequency | Scenarios |
|---|---|
| Real-time / event-driven | Account created (2.1), DuitNow QR webhook (4.2), FPX webhook (4.6A), Metis completion (8.2), fraud alert email (11.3), GL failure alert (11.4) |
| Near-real-time (< 5 min) | Account updated (2.2), counter payment (2.5), eMandate result (4.3B) |
| Multiple times daily | Bank statement download — 3× (6.1), eInvoice cancellation deadline check — every 4h (11.5), eInvoice submission queue — every 2h (5.1) |
| Daily | JomPAY (4.1), agent collection (4.4), daily GL batch (1.1), iSAINS balance read (on demand), WhatsApp reminders (4.8), dunning email (11.2) |
| Monthly | Consolidated B2C eInvoice (5.2), ECL provision (1.4), period accrual (1.5), PAAB remittance (1.6), eMandate debit run (4.3B), SPAN report (9.1) |
| Ad-hoc / event | Write-off posting (1.2), deposit refund posting (1.3), disconnection work order (8.1), reconnection (8.3), PTP creation (7.2), dispute (7.3) |
| One-time | SAAB migration (cutover only) |

### By Role — Who Initiates or Approves

| Role | Scenarios they own |
|---|---|
| SystemProcess | All automated jobs — daily GL, JomPAY, eMandate debit run, eInvoice queue, dunning, bank statement, WhatsApp reminders, all matching and clearing |
| BILStaff | Counter payments in iWRS (no AR Hub access for posting). iSAINS balance reads via iWRS. |
| BILSupervisor | Disconnection authorisation (8.1), PTP override, reconnection queue review |
| FinanceAdmin | Cheque clearance confirmation, suspense resolution, TIN verification, manual batch upload (Bayaran Pukal 4.5A), bank statement manual match, eInvoice HELD_NO_TIN resolution, period close steps |
| FinanceSupervisor | Write-off ≤ RM 500, eInvoice cancellation for invoices ≤ RM 5,000, reconciliation approval, high-value suspense, failed eMandate review |
| FinanceManager | Write-off RM 501–5,000, GL posting retry, consolidated eInvoice approval, ECL run approval, SPAN report approval, period close sign-off, reconciliation sign-off |
| CFO | Write-off > RM 50,000, ECL annual review, SPAN submission, auditor confirmation letter engagement |
| Auditor | Read-only access to GL posting batches, ECL runs, AuditTrailEntry, provision matrices |
| ICTManager | User provisioning in IdP, channel config maintenance, GL mapping updates |
| Customer | iSAINS balance view, PTP self-service, dispute submission, WhatsApp opt-out |

---

## OPEN ITEMS REQUIRING VENDOR CONFIRMATION

The following items cannot be finalised until external parties are engaged.
Each one affects a specific integration pattern.

| Item | System | Impact if unconfirmed |
|---|---|---|
| iWRS REST API specification | iWRS vendor | Determines Pattern A vs B vs C for all iWRS scenarios |
| iWRS event schema for invoices and payments | iWRS vendor | Determines the `iwrs-adapter.js` field mapping |
| Metis work order creation API | Metis vendor | Required for Scenario 8.1 automation |
| Metis completion event format | Metis vendor | Required for Scenario 8.2 |
| JomPAY Biller Code registration | PayNet | Required for Scenario 4.1 — no Biller Code = no JomPAY |
| DuitNow Merchant ID | PayNet | Required for Scenario 4.2 QR payload |
| eMandate Originator ID | PayNet | Required for Scenario 4.3 |
| LHDN MyInvois Client ID / Secret | LHDN portal | Required for all Scenario 5.x |
| MCMC digital certificate | MCMC-licensed CA | Required for Scenario 5.1–5.4 signing |
| SPAN electronic portal format | SPAN | Determines export format for Scenario 9.2 |
| Bayaran Pukal operator and file format | SAINS Finance | Determines which of 4.5A/B/C applies |
| iSAINS FPX merchant endpoint ownership | SAINS ICT | Determines which of 4.6A/B/C applies |

---

*End of Communications Architecture Document.*
*Version 1.0. All 11 system groups documented. All business scenarios covered.*
*All roles mapped. All open items listed.*
