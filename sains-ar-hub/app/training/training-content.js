/**
 * SAINS AR Hub — Training Content Definitions
 *
 * 48 steps across 4 page types:
 *   - Launchpad: 15 steps (0–14)
 *   - Demo: 9 steps (0–8)
 *   - Simulator: 17 steps (0–16)
 *   - Fiori (generic): 7 steps (0–6)
 */
(function () {
  'use strict';

  window.TrainingContent = {

    // ══════════════════════════════════════════════════════════════════════
    // PAGE 1: LAUNCHPAD  (15 steps, 0–14)
    // ══════════════════════════════════════════════════════════════════════

    launchpad: [

      /* ── Step 0 ── */
      {
        target: null,
        title: 'Welcome to SAINS AR Hub Training',
        position: 'auto',
        content: `
          <div style="text-align:center;margin-bottom:12px">
            <span style="font-size:48px">🎓</span>
            <h3 style="margin:8px 0 4px">Let&rsquo;s Learn the System Together</h3>
            <p style="color:#6b7280;margin:0">This guided walkthrough covers the <strong>Launchpad</strong> &mdash; your home screen for the entire AR Hub.</p>
          </div>
          <p><strong>You will learn:</strong></p>
          <ul>
            <li>What each section of the Launchpad does</li>
            <li>How to navigate between pages</li>
            <li>What the KPIs mean</li>
            <li>How roles control visibility</li>
            <li>How to search and find any app</li>
          </ul>
          <p style="background:#f0f9ff;padding:8px 12px;border-radius:6px;margin-top:8px">
            <strong>Tip:</strong> 15 steps, approximately 8 minutes. Press <kbd>Esc</kbd> to pause at any time &mdash; your progress is saved.
          </p>
        `
      },

      /* ── Step 1 ── */
      {
        target: '.header',
        title: 'System Header — Where Am I?',
        position: 'bottom',
        content: `
          <p>The gradient banner at the top identifies the system you are in. Three things to notice:</p>
          <ul>
            <li><strong>"SAINS AR Hub"</strong> &mdash; This is the Accounts Receivable management system</li>
            <li><strong>"Syarikat Air Negeri Sembilan"</strong> &mdash; The water utility company this system serves</li>
            <li><strong>"POC Environment"</strong> badge &mdash; You are working with test data, not real customer records</li>
          </ul>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> In production the badge turns <span style="color:#dc3545;font-weight:bold">red</span> &mdash; that means real customer data. Handle with care.
          </p>
        `
      },

      /* ── Step 2 ── */
      {
        target: '#headerStats',
        title: 'KPI Summary Strip — System Health at a Glance',
        position: 'bottom',
        content: `
          <p>These five cards give you an instant health check of the entire system:</p>
          <table style="width:100%;border-collapse:collapse;font-size:13px;margin:8px 0">
            <thead><tr style="background:#f1f5f9"><th style="padding:4px 8px;text-align:left">KPI</th><th style="padding:4px 8px;text-align:left">What It Means</th></tr></thead>
            <tbody>
              <tr><td style="padding:4px 8px"><strong>50 Accounts</strong></td><td style="padding:4px 8px">POC sample &mdash; production will show ~490,000</td></tr>
              <tr><td style="padding:4px 8px"><strong>150 Invoices</strong></td><td style="padding:4px 8px">Total water bills across all statuses</td></tr>
              <tr><td style="padding:4px 8px"><strong>120 Payments</strong></td><td style="padding:4px 8px">Transactions from all 8 payment channels</td></tr>
              <tr><td style="padding:4px 8px"><strong>13 Services</strong></td><td style="padding:4px 8px">Backend OData services &mdash; all should be online</td></tr>
              <tr><td style="padding:4px 8px"><strong>Live <span style="color:#22c55e">&#9679;</span></strong></td><td style="padding:4px 8px">Green dot = system operational</td></tr>
            </tbody>
          </table>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> If numbers are zero or unexpectedly low, the database may have been recently reset or there is a connectivity issue.
          </p>
        `
      },

      /* ── Step 3 ── */
      {
        target: '#userSelect',
        title: 'Role Switcher — See the System Through Different Eyes',
        position: 'bottom',
        content: `
          <p>This dropdown lets you impersonate different user roles to see how each staff member experiences the system.</p>
          <table style="width:100%;border-collapse:collapse;font-size:13px;margin:8px 0">
            <thead><tr style="background:#f1f5f9"><th style="padding:4px 8px;text-align:left">Role</th><th style="padding:4px 8px;text-align:left">Access</th></tr></thead>
            <tbody>
              <tr><td style="padding:4px 8px"><strong>Super Admin</strong></td><td style="padding:4px 8px">Sees everything &mdash; all 31 tiles</td></tr>
              <tr><td style="padding:4px 8px"><strong>Finance Admin / Supervisor / Manager / CFO</strong></td><td style="padding:4px 8px">Financial operations &mdash; higher roles approve larger amounts</td></tr>
              <tr><td style="padding:4px 8px"><strong>BIL Staff / Supervisor</strong></td><td style="padding:4px 8px">Billing &mdash; invoices, adjustments, meter reads</td></tr>
              <tr><td style="padding:4px 8px"><strong>Counter Staff</strong></td><td style="padding:4px 8px">Walk-in payments only (cash, cheque, card)</td></tr>
              <tr><td style="padding:4px 8px"><strong>Collections Officer</strong></td><td style="padding:4px 8px">Dunning, PTP, payment plans, disconnection</td></tr>
              <tr><td style="padding:4px 8px"><strong>Auditor</strong></td><td style="padding:4px 8px">Read-only access to all data</td></tr>
              <tr><td style="padding:4px 8px"><strong>Customer (Alice)</strong></td><td style="padding:4px 8px">Self-service portal view</td></tr>
            </tbody>
          </table>
          <p><strong>How to use:</strong> Click the dropdown, select a role &mdash; the tiles immediately filter to show only what that role can access.</p>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> In production with SAP BTP XSUAA, roles are assigned by IT admin &mdash; there is no manual switcher.
          </p>
        `
      },

      /* ── Step 4 ── */
      {
        target: '#roleTags',
        title: 'Role Quick-Filter Chips — One-Click Role Switching',
        position: 'bottom',
        content: `
          <p>These chips are shortcuts to quickly switch between common role views:</p>
          <ul>
            <li><strong>SuperAdmin</strong> &mdash; All 31 tiles visible</li>
            <li><strong>Finance</strong> &mdash; Invoices, payments, write-offs, GL, KPIs</li>
            <li><strong>BIL</strong> &mdash; Invoices, adjustments, meter reads</li>
            <li><strong>Counter</strong> &mdash; Payment processing only</li>
            <li><strong>Collections</strong> &mdash; Dunning, PTP, payment plans, fraud</li>
            <li><strong>Auditor</strong> &mdash; All tiles, read-only mode</li>
          </ul>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> Use these during demos to quickly show role-based filtering without opening the dropdown.
          </p>
        `
      },

      /* ── Step 5 ── */
      {
        target: '.breadcrumb-bar',
        title: 'Breadcrumb Navigation — Always Know Where You Are',
        position: 'bottom',
        content: `
          <p>The breadcrumb trail shows your current location and provides quick navigation between the three main areas:</p>
          <ul>
            <li><strong>Launchpad</strong> &mdash; This page (the main app hub)</li>
            <li><strong>Demo</strong> &mdash; 11-slide executive presentation</li>
            <li><strong>Simulator</strong> &mdash; External system testing tool</li>
          </ul>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> Click <strong>Launchpad</strong> in the breadcrumb from anywhere to return to this page.
          </p>
        `
      },

      /* ── Step 6 ── */
      {
        target: '.search-bar',
        title: 'Search Bar — Find Any App Instantly',
        position: 'bottom',
        content: `
          <p>Type any keyword to instantly filter tiles by name or description.</p>
          <table style="width:100%;border-collapse:collapse;font-size:13px;margin:8px 0">
            <thead><tr style="background:#f1f5f9"><th style="padding:4px 8px;text-align:left">Type</th><th style="padding:4px 8px;text-align:left">Shows</th></tr></thead>
            <tbody>
              <tr><td style="padding:4px 8px"><code>invoice</code></td><td style="padding:4px 8px">Invoice Management</td></tr>
              <tr><td style="padding:4px 8px"><code>dunning</code></td><td style="padding:4px 8px">Dunning Management</td></tr>
              <tr><td style="padding:4px 8px"><code>fraud</code></td><td style="padding:4px 8px">Fraud Detection</td></tr>
              <tr><td style="padding:4px 8px"><code>deposit</code></td><td style="padding:4px 8px">Deposit Management</td></tr>
              <tr><td style="padding:4px 8px"><code>LHDN</code></td><td style="padding:4px 8px">e-Invoice (MyInvois)</td></tr>
              <tr><td style="padding:4px 8px"><code>leakage</code></td><td style="padding:4px 8px">Adjustments (matches description)</td></tr>
              <tr><td style="padding:4px 8px"><code>SPAN</code></td><td style="padding:4px 8px">SPAN Regulatory Reports</td></tr>
              <tr><td style="padding:4px 8px"><code>QR</code></td><td style="padding:4px 8px">DuitNow QR Payments</td></tr>
            </tbody>
          </table>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> The counter shows how many tiles match. Clear the search to show all tiles again.
          </p>
        `
      },

      /* ── Step 7 ── */
      {
        target: '.quick-actions',
        title: 'Quick Actions Bar — Shortcuts to Essential Tools',
        position: 'bottom',
        content: `
          <p>Four shortcut buttons for the most-used tools:</p>
          <ul>
            <li><strong>Guided Demo</strong> &mdash; Opens the 11-slide executive presentation</li>
            <li><strong>Simulator</strong> &mdash; Opens the External System Simulator for testing events</li>
            <li><strong>System Health</strong> &mdash; Runs a JSON health check on all services</li>
            <li><strong>OData Index</strong> &mdash; Lists all OData API endpoints (for developers)</li>
          </ul>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> If you are new to the system, start with the <strong>Guided Demo</strong> button.
          </p>
        `
      },

      /* ── Step 8 ── */
      {
        target: '[data-category="core-ar"] .tile:first-child',
        title: 'Understanding a Tile — Anatomy of Every App Card',
        position: 'right',
        content: `
          <p>Every tile on the Launchpad has five parts:</p>
          <ul>
            <li><strong>Icon</strong> &mdash; Coloured circle (top-left) identifying the module</li>
            <li><strong>Badge</strong> &mdash; Record count (top-right, e.g. "50 records")</li>
            <li><strong>Title</strong> &mdash; Bold application name</li>
            <li><strong>Description</strong> &mdash; Gray text explaining what the app does</li>
            <li><strong>Tooltip</strong> &mdash; Hover to see the OData service path (for developers)</li>
          </ul>
          <p><strong>Click anywhere on the tile</strong> to open that app in a new tab as a SAP Fiori List Report.</p>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> The <code>data-roles</code> attribute on each tile controls which roles can see it.
          </p>
        `
      },

      /* ── Step 9 ── */
      {
        target: '[data-category="core-ar"]',
        title: 'Core Accounts Receivable — The Heart of the System (6 Apps)',
        position: 'bottom',
        content: `
          <p>These six apps form the foundation of the AR system:</p>
          <ul>
            <li><strong>Customer Accounts</strong> &mdash; All 490,000 consumer accounts across Negeri Sembilan. Your starting point for any customer lookup.</li>
            <li><strong>Invoice Management</strong> &mdash; Water bills generated from SiBMA/iWRS. Create, view, reverse, and submit to e-Invoice.</li>
            <li><strong>Payment Processing</strong> &mdash; Transactions from all 8 channels. The FIFO clearing engine auto-matches payments to oldest invoices first.</li>
            <li><strong>Adjustments</strong> &mdash; Meter corrections, leakage claims, tariff reclassification, fraud detection, and goodwill credits.</li>
            <li><strong>Deposit Management</strong> &mdash; Security deposits, refunds, dormancy tracking, and unclaimed money (Akta Wang Tak Dituntut).</li>
            <li><strong>Dispute Management</strong> &mdash; Customer disputes with auto-hold &mdash; disputed invoices are automatically excluded from dunning.</li>
          </ul>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> FIFO = First In, First Out. Payments always clear the oldest invoice first.
          </p>
        `
      },

      /* ── Step 10 ── */
      {
        target: '[data-category="collections"]',
        title: 'Collections & Dunning — From Reminder to Legal Action (5 Apps)',
        position: 'top',
        content: `
          <p>The full collections lifecycle, compliant with <strong>Act 655</strong> (Water Services Industry Act):</p>
          <ul>
            <li><strong>Dunning Management</strong> &mdash; 5-level escalation:
              <br>L1 = 14 days &mdash; SMS reminder
              <br>L2 = 30 days &mdash; Formal notice
              <br>L3 = 45 days &mdash; Disconnection warning
              <br>L4 = 60 days &mdash; Disconnection order
              <br>L5 = 90 days &mdash; Legal action</li>
            <li><strong>Promise to Pay (PTP)</strong> &mdash; Customer payment commitments with compliance monitoring</li>
            <li><strong>Payment Plans</strong> &mdash; Up to 12-month instalments. Auto-suppresses dunning while plan is active.</li>
            <li><strong>Write-Off Processing</strong> &mdash; 3-level approval:
              <br>Supervisor &lt; RM 500
              <br>Manager &lt; RM 5,000
              <br>CFO &lt; RM 20,000
              <br>Auto GL posting on approval.</li>
            <li><strong>Fraud Detection</strong> &mdash; 10 patterns including double write-off, large adjustment, quick reversal, self-payment, and agent anomaly.</li>
          </ul>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> Vulnerable customers (e.g. OKU, Warga Emas) are automatically capped at Level 2 &mdash; they are never disconnected.
          </p>
        `
      },

      /* ── Step 11 ── */
      {
        target: '[data-category="payment-innovation"]',
        title: 'Payment Innovation (Phase 2) — Digital Payment Channels (4 Apps)',
        position: 'top',
        content: `
          <p>Modern digital payment channels introduced in Phase 2:</p>
          <ul>
            <li><strong>Payment Orchestrator</strong> &mdash; Unified event-driven processing. Auto-matching, duplicate detection, and suspense account resolution.</li>
            <li><strong>DuitNow QR</strong> &mdash; EMVCo QR code generated per invoice. Customer scans with any Malaysian bank app. Real-time webhook confirmation.</li>
            <li><strong>JomPAY</strong> &mdash; Daily CSV reconciliation file via SFTP from acquiring bank. Auto-matching to customer accounts.</li>
            <li><strong>eMandate</strong> &mdash; PayNet direct debit. Monthly auto-debit on due date. Return codes: NSF (Non-Sufficient Funds), Invalid Account, Stopped by Customer, Deceased.</li>
          </ul>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> Total 8 payment channels: Counter Cash, Counter Cheque, Counter Card, FPX, DuitNow QR, JomPAY, eMandate, Bank Transfer.
          </p>
        `
      },

      /* ── Step 12 ── */
      {
        target: '[data-category="einvoice"]',
        title: 'e-Invoice, Analytics, Integration & Customer Portal',
        position: 'top',
        content: `
          <p><strong>e-Invoice (LHDN MyInvois) &mdash; 3 Apps:</strong></p>
          <ul>
            <li>LHDN MyInvois submission &mdash; B2B individual with buyer TIN + B2C monthly consolidated</li>
            <li>Digital Certificate management for SHA-256 signing</li>
            <li>B2C Consolidated invoice batching</li>
          </ul>
          <p><strong>Analytics &mdash; 5 Apps:</strong></p>
          <ul>
            <li>KPI Dashboard &mdash; DSO (Days Sales Outstanding), collection efficiency, bad debt ratio</li>
            <li>Consumption Anomalies &mdash; Z-score detection for unusual usage</li>
            <li>SPAN Regulatory Reports</li>
            <li>ECL Provisioning (MFRS 9 compliance)</li>
            <li>Auditor Confirmation Letters</li>
          </ul>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> DSO = average number of days it takes to collect payment after an invoice is issued.
          </p>
        `
      },

      /* ── Step 13 ── */
      {
        target: '[data-category="integration"]',
        title: 'System Integration & Monitoring (4 Apps)',
        position: 'top',
        content: `
          <p>Four apps for monitoring how AR Hub connects to external systems:</p>
          <ul>
            <li><strong>iWRS Integration Log</strong> &mdash; Event log for all iWRS communications (Pattern A = account, Pattern B = invoice, Pattern C = payment)</li>
            <li><strong>Metis Work Orders</strong> &mdash; Disconnection and reconnection work orders dispatched to field teams. Auto-reconnection triggered when payment is received.</li>
            <li><strong>External System Simulator</strong> &mdash; <span style="color:#22c55e;font-weight:bold">LIVE</span> testing tool for all external systems (POC environment only)</li>
            <li><strong>GL Account Mappings</strong> &mdash; Configuration showing how each transaction type maps to SAP S/4HANA GL accounts</li>
          </ul>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> The Simulator is your best friend for testing &mdash; use it to create accounts, generate invoices, and trigger payments.
          </p>
        `
      },

      /* ── Step 14 ── */
      {
        target: null,
        title: 'Launchpad Training Complete!',
        position: 'auto',
        content: `
          <div style="text-align:center;margin-bottom:12px">
            <span style="font-size:48px">🏆</span>
            <h3 style="margin:8px 0 4px">Excellent! You&rsquo;ve Completed the Launchpad Training</h3>
          </div>
          <p><strong>You now know how to:</strong></p>
          <ul>
            <li>Read the KPI summary strip</li>
            <li>Switch roles to see different perspectives</li>
            <li>Search for any app by keyword</li>
            <li>Understand all 8 sections and 31 apps</li>
            <li>Navigate between Launchpad, Demo, and Simulator</li>
          </ul>
          <p><strong>Suggested next steps:</strong></p>
          <ul>
            <li>Visit the <strong>Demo</strong> page for the executive presentation</li>
            <li>Try the <strong>Simulator</strong> to create test data</li>
            <li>Open <strong>Customer Accounts</strong> to explore a Fiori List Report</li>
          </ul>
          <p style="background:#f0f9ff;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> You can re-run this training any time via the <strong>Training Mode</strong> button.
          </p>
        `
      }

    ],

    // ══════════════════════════════════════════════════════════════════════
    // PAGE 2: DEMO PRESENTATION  (9 steps, 0–8)
    // ══════════════════════════════════════════════════════════════════════

    demo: [

      /* ── Step 0 ── */
      {
        target: null,
        title: 'Demo Presentation — Training Guide',
        position: 'auto',
        content: `
          <div style="text-align:center;margin-bottom:12px">
            <span style="font-size:48px">🎬</span>
            <h3 style="margin:8px 0 4px">How to Use the Executive Demo</h3>
          </div>
          <p><strong>You will learn:</strong></p>
          <ul>
            <li>How to navigate between slides</li>
            <li>What each slide covers</li>
            <li>How to perform live demos during the presentation</li>
            <li>Tips for presenting to stakeholders</li>
          </ul>
          <p style="background:#f0f9ff;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> This training has 9 steps. The presentation itself has 11 slides.
          </p>
        `
      },

      /* ── Step 1 ── */
      {
        target: '.pres-nav',
        title: 'Slide Navigation Controls',
        position: 'bottom',
        content: `
          <p>How to move between slides:</p>
          <ul>
            <li><strong>Previous / Next</strong> buttons on screen</li>
            <li>Keyboard: <kbd>&larr;</kbd> <kbd>&rarr;</kbd> arrow keys or <kbd>Space</kbd> bar</li>
            <li>The counter (e.g. <strong>"1 / 11"</strong>) shows your current position</li>
            <li>Press <kbd>F</kbd> for fullscreen mode (ideal for projector)</li>
          </ul>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> Fullscreen + arrow keys is the most professional way to present.
          </p>
        `
      },

      /* ── Step 2 ── */
      {
        target: '[data-slide="0"]',
        title: 'Slide 1 — Title Slide',
        position: 'right',
        content: `
          <p>The opening slide sets the context:</p>
          <ul>
            <li><strong>System name</strong> &mdash; SAINS AR Hub</li>
            <li><strong>Purpose</strong> &mdash; Integrated AR Management</li>
            <li><strong>Context</strong> &mdash; POC Demonstration</li>
            <li><strong>Client</strong> &mdash; SAINS (Syarikat Air Negeri Sembilan)</li>
          </ul>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> Spend about 30 seconds here. Introduce yourself and set expectations.
          </p>
        `
      },

      /* ── Step 3 ── */
      {
        target: '[data-slide="1"]',
        title: 'Slide 2 — System Overview (6 Value Pillars)',
        position: 'right',
        content: `
          <p>This slide presents the six core value propositions:</p>
          <ul>
            <li><strong>490,000 Accounts</strong> &mdash; Full customer base</li>
            <li><strong>8 Payment Channels</strong> &mdash; Counter, FPX, DuitNow, JomPAY, eMandate, bank transfer, cheque, card</li>
            <li><strong>LHDN e-Invoice</strong> &mdash; MyInvois B2B + B2C ready</li>
            <li><strong>SPAN Compliant</strong> &mdash; Regulatory reporting</li>
            <li><strong>Intelligent Collections</strong> &mdash; 5-level dunning, risk scoring</li>
            <li><strong>Full Audit Trail</strong> &mdash; Every transaction tracked</li>
          </ul>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> Ask the audience <em>&ldquo;How many payment channels do you currently support?&rdquo;</em> before revealing.
          </p>
        `
      },

      /* ── Step 4 ── */
      {
        target: '[data-slide="2"]',
        title: 'Slide 3 — Architecture Diagram',
        position: 'right',
        content: `
          <p>Shows how AR Hub sits as the central subledger:</p>
          <ul>
            <li><strong>Inbound</strong> &mdash; iWRS, Banks (SFTP), PayNet (DuitNow/FPX/JomPAY/eMandate), Metis</li>
            <li><strong>AR Hub</strong> &mdash; Central processing engine</li>
            <li><strong>Outbound</strong> &mdash; SAP S/4HANA (GL), LHDN (e-Invoice), WhatsApp/SMS (notifications), iSAINS (customer portal)</li>
          </ul>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> Key talking point: <em>&ldquo;The same codebase deploys to BTP with zero code changes.&rdquo;</em>
          </p>
        `
      },

      /* ── Step 5 ── */
      {
        target: '[data-slide="3"]',
        title: 'Slides 4–9 — Six Live Demo Scenarios',
        position: 'right',
        content: `
          <p>These six slides each contain a live demo scenario:</p>
          <table style="width:100%;border-collapse:collapse;font-size:13px;margin:8px 0">
            <thead><tr style="background:#f1f5f9"><th style="padding:4px 8px;text-align:left">#</th><th style="padding:4px 8px;text-align:left">Scenario</th></tr></thead>
            <tbody>
              <tr><td style="padding:4px 8px">1</td><td style="padding:4px 8px">New Customer &amp; First Invoice</td></tr>
              <tr><td style="padding:4px 8px">2</td><td style="padding:4px 8px">DuitNow QR Payment (real-time)</td></tr>
              <tr><td style="padding:4px 8px">3</td><td style="padding:4px 8px">Dunning Lifecycle &amp; Disconnection</td></tr>
              <tr><td style="padding:4px 8px">4</td><td style="padding:4px 8px">Bank Statement Reconciliation (MT940)</td></tr>
              <tr><td style="padding:4px 8px">5</td><td style="padding:4px 8px">e-Invoice Submission to LHDN</td></tr>
              <tr><td style="padding:4px 8px">6</td><td style="padding:4px 8px">GL Posting &amp; Financial Controls</td></tr>
            </tbody>
          </table>
          <p><strong>How to perform:</strong> Each slide has blue <strong>&ldquo;Open App&rdquo;</strong> links. Click them to open the relevant app. Use the <strong>Simulator</strong> in another tab to trigger events.</p>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> Open the Simulator in a separate browser tab <strong>before</strong> starting the demo.
          </p>
        `
      },

      /* ── Step 6 ── */
      {
        target: null,
        title: 'Understanding Key Message Boxes',
        position: 'auto',
        content: `
          <p>Each demo scenario ends with a <strong>Key Message</strong> box. These are the business-value statements to deliver:</p>
          <ul>
            <li><strong>Scenario 1:</strong> &ldquo;Data flows from iWRS to AR Hub in milliseconds &mdash; no manual entry.&rdquo;</li>
            <li><strong>Scenario 2:</strong> &ldquo;Payment received, matched, and cleared in under 1 second &mdash; fully automated.&rdquo;</li>
            <li><strong>Scenario 3:</strong> &ldquo;5-level dunning compliant with Act 655 &mdash; vulnerable customers protected.&rdquo;</li>
            <li><strong>Scenario 4:</strong> &ldquo;Bank reconciliation runs 3x daily &mdash; no manual matching required.&rdquo;</li>
            <li><strong>Scenario 5:</strong> &ldquo;B2B and B2C e-Invoices submitted to LHDN &mdash; consolidated monthly.&rdquo;</li>
            <li><strong>Scenario 6:</strong> &ldquo;Every ringgit is tracked from invoice to GL &mdash; complete audit trail.&rdquo;</li>
          </ul>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> Read these key messages aloud during the presentation for maximum impact.
          </p>
        `
      },

      /* ── Step 7 ── */
      {
        target: '[data-slide="9"]',
        title: 'Slides 10–11 — Roadmap & Closing',
        position: 'right',
        content: `
          <p><strong>Slide 10 &mdash; Implementation Roadmap:</strong></p>
          <ul>
            <li><strong>Phase 1:</strong> BTP Provisioning &mdash; same codebase, zero code changes</li>
            <li><strong>Phase 2:</strong> External Connections &mdash; 12 adapters (iWRS, banks, PayNet, LHDN, Metis, etc.)</li>
            <li><strong>Phase 3:</strong> UAT &amp; Go-Live &mdash; same codebase validated</li>
          </ul>
          <p><strong>Slide 11 &mdash; Thank You:</strong> Closing slide with an <strong>&ldquo;Explore the System&rdquo;</strong> button linking back to the Launchpad.</p>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> End with: <em>&ldquo;This is not a mockup &mdash; this is production-grade code running live.&rdquo;</em>
          </p>
        `
      },

      /* ── Step 8 ── */
      {
        target: null,
        title: 'Demo Training Complete!',
        position: 'auto',
        content: `
          <div style="text-align:center;margin-bottom:12px">
            <span style="font-size:48px">🎤</span>
            <h3 style="margin:8px 0 4px">You&rsquo;re Ready to Present!</h3>
          </div>
          <p><strong>You now know how to:</strong></p>
          <ul>
            <li>Navigate all 11 slides with keyboard or buttons</li>
            <li>Perform 6 live demo scenarios</li>
            <li>Deliver the key business-value messages</li>
            <li>Explain the architecture and roadmap</li>
          </ul>
          <p><strong>Pre-presentation checklist:</strong></p>
          <ul>
            <li>Open the Simulator in a separate tab</li>
            <li>Test a few events to confirm the system is responsive</li>
            <li>Switch to fullscreen (<kbd>F</kbd>) before the audience arrives</li>
            <li>Keep the Launchpad open in another tab for live app demos</li>
          </ul>
        `
      }

    ],

    // ══════════════════════════════════════════════════════════════════════
    // PAGE 3: SIMULATOR DASHBOARD  (17 steps, 0–16)
    // ══════════════════════════════════════════════════════════════════════

    simulator: [

      /* ── Step 0 ── */
      {
        target: null,
        title: 'External System Simulator — Training Guide',
        position: 'auto',
        content: `
          <div style="text-align:center;margin-bottom:12px">
            <span style="font-size:48px">⚙️</span>
            <h3 style="margin:8px 0 4px">Your Testing Control Room</h3>
          </div>
          <p><strong>You will learn:</strong></p>
          <ul>
            <li>What each tab does</li>
            <li>How to fill in forms correctly</li>
            <li>How to read responses</li>
            <li>How to verify results in the Event Log</li>
          </ul>
          <p style="background:#f0f9ff;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> 16 steps total. Use the Previous/Next buttons to skip to the tabs you need.
          </p>
        `
      },

      /* ── Step 1 ── */
      {
        target: '.header',
        title: 'Dashboard Header — Environment & Timestamp',
        position: 'bottom',
        content: `
          <p>Three things to notice in the header:</p>
          <ul>
            <li><strong>Title</strong> &mdash; Confirms this is the External System Simulator (testing tool)</li>
            <li><strong>POC badge</strong> &mdash; You are in a safe test environment</li>
            <li><strong>Last Updated timestamp</strong> &mdash; Statistics auto-refresh every 15 seconds</li>
          </ul>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> Everything you do here creates real records in the database. Experiment freely &mdash; this is what the POC is for.
          </p>
        `
      },

      /* ── Step 2 ── */
      {
        target: '.stats',
        title: 'Statistics Cards — Event Counters',
        position: 'bottom',
        content: `
          <p>Six cards track your testing activity:</p>
          <table style="width:100%;border-collapse:collapse;font-size:13px;margin:8px 0">
            <thead><tr style="background:#f1f5f9"><th style="padding:4px 8px;text-align:left">Card</th><th style="padding:4px 8px;text-align:left">What It Counts</th></tr></thead>
            <tbody>
              <tr><td style="padding:4px 8px"><strong>Total Events</strong></td><td style="padding:4px 8px">All simulation events triggered</td></tr>
              <tr><td style="padding:4px 8px"><strong>iWRS Events</strong></td><td style="padding:4px 8px">Account, invoice, and counter payment events</td></tr>
              <tr><td style="padding:4px 8px"><strong>Payment Events</strong></td><td style="padding:4px 8px">DuitNow, FPX, JomPAY, eMandate events</td></tr>
              <tr><td style="padding:4px 8px"><strong>e-Invoice</strong></td><td style="padding:4px 8px">LHDN response simulations</td></tr>
              <tr><td style="padding:4px 8px"><strong>GL Postings</strong></td><td style="padding:4px 8px">SAP journal entries generated</td></tr>
              <tr><td style="padding:4px 8px"><strong>Notifications</strong></td><td style="padding:4px 8px">Emails, SMS, WhatsApp messages captured</td></tr>
            </tbody>
          </table>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> If a counter does not increase after submitting a form, check the response panel for error messages.
          </p>
        `
      },

      /* ── Step 3 ── */
      {
        target: '.tabs',
        title: 'Tab Navigation — 11 External Systems',
        position: 'bottom',
        content: `
          <p>Each tab simulates one external system:</p>
          <table style="width:100%;border-collapse:collapse;font-size:13px;margin:8px 0">
            <thead><tr style="background:#f1f5f9"><th style="padding:4px 8px;text-align:left">Tab</th><th style="padding:4px 8px;text-align:left">System</th><th style="padding:4px 8px;text-align:left">What It Simulates</th></tr></thead>
            <tbody>
              <tr><td style="padding:4px 8px">iWRS</td><td style="padding:4px 8px">iWRS / SiBMA</td><td style="padding:4px 8px">Accounts, invoices, counter payments</td></tr>
              <tr><td style="padding:4px 8px">Bank</td><td style="padding:4px 8px">Maybank / CIMB / RHB</td><td style="padding:4px 8px">MT940 bank statements</td></tr>
              <tr><td style="padding:4px 8px">LHDN</td><td style="padding:4px 8px">LHDN MyInvois</td><td style="padding:4px 8px">e-Invoice acceptance / rejection</td></tr>
              <tr><td style="padding:4px 8px">DuitNow</td><td style="padding:4px 8px">PayNet DuitNow</td><td style="padding:4px 8px">QR code real-time payment</td></tr>
              <tr><td style="padding:4px 8px">FPX</td><td style="padding:4px 8px">PayNet FPX</td><td style="padding:4px 8px">Online banking IPN</td></tr>
              <tr><td style="padding:4px 8px">JomPAY</td><td style="padding:4px 8px">PayNet JomPAY</td><td style="padding:4px 8px">Batch CSV reconciliation</td></tr>
              <tr><td style="padding:4px 8px">eMandate</td><td style="padding:4px 8px">PayNet eMandate</td><td style="padding:4px 8px">Direct debit mandate &amp; results</td></tr>
              <tr><td style="padding:4px 8px">Metis</td><td style="padding:4px 8px">Metis Field</td><td style="padding:4px 8px">Work order completion</td></tr>
              <tr><td style="padding:4px 8px">SAP GL</td><td style="padding:4px 8px">SAP S/4HANA</td><td style="padding:4px 8px">Journal entry viewer (read-only)</td></tr>
              <tr><td style="padding:4px 8px">Inbox</td><td style="padding:4px 8px">Notification Hub</td><td style="padding:4px 8px">Captured messages (read-only)</td></tr>
              <tr><td style="padding:4px 8px">Event Log</td><td style="padding:4px 8px">Audit Trail</td><td style="padding:4px 8px">Complete event history (read-only)</td></tr>
            </tbody>
          </table>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> The last 3 tabs (SAP GL, Inbox, Event Log) are read-only viewers &mdash; no forms to fill in.
          </p>
        `
      },

      /* ── Step 4 ── */
      {
        target: '#tab-iwrs .card:first-child',
        activateTab: 'iwrs',
        title: 'iWRS — Simulate Account Created (Pattern A)',
        position: 'right',
        content: `
          <p><strong>Purpose:</strong> Simulates iWRS sending a new customer account to AR Hub.</p>
          <p><strong>Fields to fill in:</strong></p>
          <ul>
            <li><strong>Account Number</strong> &mdash; 10-digit (e.g. 7000000001)</li>
            <li><strong>Customer Name</strong> &mdash; Full name</li>
            <li><strong>ID Number</strong> &mdash; IC number or Business Registration Number</li>
            <li><strong>ID Type</strong> &mdash; IC or BRN</li>
            <li><strong>Account Type</strong> &mdash; DOM (Domestic), COM (Commercial), IND (Industrial), GOV (Government)</li>
            <li><strong>Address, Phone, Email</strong></li>
            <li><strong>Branch</strong> &mdash; SAINS branch office</li>
            <li><strong>Tariff Code</strong> &mdash; Pricing tier</li>
            <li><strong>Meter Reference</strong> &mdash; Physical meter ID</li>
          </ul>
          <p><strong>Action:</strong> Click <strong>&ldquo;Create Account&rdquo;</strong> &mdash; AR Hub creates the customer record.</p>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> IC numbers are encrypted with AES-256 at rest and masked in the UI for PDPA compliance.
          </p>
        `
      },

      /* ── Step 5 ── */
      {
        target: '#tab-iwrs .card:nth-child(2)',
        activateTab: 'iwrs',
        title: 'iWRS — Simulate Invoice Generated',
        position: 'right',
        content: `
          <p><strong>Purpose:</strong> Simulates iWRS/SiBMA generating a water bill.</p>
          <p><strong>Fields:</strong></p>
          <ul>
            <li><strong>Account Number</strong> &mdash; Must be an existing account</li>
            <li><strong>Total Amount</strong> &mdash; Invoice amount in RM</li>
            <li><strong>Tax Amount</strong> &mdash; SST if applicable</li>
            <li><strong>Consumption</strong> &mdash; Water usage in cubic metres</li>
            <li><strong>Previous / Current Meter Read</strong></li>
          </ul>
          <p><strong>What happens:</strong></p>
          <ul>
            <li>Invoice created with status <strong>OPEN</strong></li>
            <li>Due date set to 21 days from issue</li>
            <li>Account balance increases by the invoice amount</li>
            <li>Commercial accounts are flagged for e-Invoice submission</li>
          </ul>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> To test the full cycle, create an invoice here then pay it using the DuitNow tab.
          </p>
        `
      },

      /* ── Step 6 ── */
      {
        target: '#tab-iwrs .card:nth-child(3)',
        activateTab: 'iwrs',
        title: 'iWRS — Simulate Counter Payment',
        position: 'right',
        content: `
          <p><strong>Purpose:</strong> Simulates a walk-in payment at a SAINS counter.</p>
          <p><strong>Fields:</strong></p>
          <ul>
            <li><strong>Account Number</strong> &mdash; Must have outstanding invoices</li>
            <li><strong>Amount</strong> &mdash; Payment amount in RM</li>
            <li><strong>Channel</strong> &mdash; Cash, Cheque, or Card</li>
            <li><strong>Cashier ID</strong> &mdash; Staff identifier</li>
          </ul>
          <p><strong>What happens:</strong></p>
          <ul>
            <li>Payment created with status <strong>ALLOCATED</strong></li>
            <li>FIFO clearing engine runs &mdash; oldest invoices cleared first</li>
            <li>Invoice status changes to <strong>CLEARED</strong></li>
            <li>Account balance decreases</li>
            <li>GL journal entry posted automatically</li>
          </ul>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> FIFO example: if Jan (RM 50) and Feb (RM 80) are outstanding and customer pays RM 100, Jan is fully cleared (RM 50) and Feb is partially cleared (RM 50 of RM 80).
          </p>
        `
      },

      /* ── Step 7 ── */
      {
        target: '#tab-bank',
        activateTab: 'bank',
        title: 'Bank Statements — Generate MT940 File',
        position: 'auto',
        content: `
          <p><strong>Purpose:</strong> Generates a sample MT940 bank statement file.</p>
          <p><strong>Fields:</strong></p>
          <ul>
            <li><strong>Bank Name</strong> &mdash; Maybank, CIMB, or RHB</li>
            <li><strong>Statement Date</strong> &mdash; Date of the statement</li>
            <li><strong>Transaction Count</strong> &mdash; Number of credit entries to generate</li>
          </ul>
          <p><strong>Response:</strong> Shows raw MT940 SWIFT-format content with opening balance, credit entries, and closing balance.</p>
          <p><strong>In production:</strong> Banks deliver MT940 files via SFTP 3 times daily. AR Hub parses and auto-matches transactions.</p>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> AR Hub also supports <strong>CAMT.053</strong> (ISO 20022) for banks that have migrated to the new standard.
          </p>
        `
      },

      /* ── Step 8 ── */
      {
        target: '#tab-lhdn',
        activateTab: 'lhdn',
        title: 'LHDN MyInvois — Simulate e-Invoice Response',
        position: 'auto',
        content: `
          <p><strong>Purpose:</strong> Simulates LHDN responding to an e-invoice submission batch.</p>
          <p><strong>Fields:</strong></p>
          <ul>
            <li><strong>Submission Batch ID</strong> &mdash; The batch reference from AR Hub</li>
            <li><strong>Response Type</strong> &mdash; Fully Accepted, Partially Accepted, or Rejected</li>
          </ul>
          <p><strong>What happens:</strong></p>
          <ul>
            <li>Batch status updated (ACCEPTED / PARTIAL / REJECTED)</li>
            <li>Individual invoices receive LHDN UUIDs</li>
            <li>72-hour cancellation deadline set for accepted invoices</li>
          </ul>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> The 72-hour cancellation rule is enforced automatically &mdash; after 72 hours, e-invoices cannot be cancelled.
          </p>
        `
      },

      /* ── Step 9 ── */
      {
        target: '#tab-duitnow',
        activateTab: 'duitnow',
        title: 'DuitNow QR — Simulate Real-Time Payment',
        position: 'auto',
        content: `
          <p><strong>Purpose:</strong> Simulates a customer scanning a DuitNow QR code and paying.</p>
          <p><strong>Fields:</strong></p>
          <ul>
            <li><strong>Account Number</strong> &mdash; Customer account with outstanding invoices</li>
            <li><strong>Amount</strong> &mdash; Payment amount in RM</li>
          </ul>
          <p><strong>What happens (in milliseconds):</strong></p>
          <ul>
            <li>PayNet webhook received by AR Hub</li>
            <li>Payment record created</li>
            <li>FIFO clearing engine runs</li>
            <li>Invoice status changes to <strong>CLEARED</strong></li>
            <li>Account balance updated</li>
            <li>GL journal entry posted</li>
            <li>If account was disconnected, reconnection work order may be triggered</li>
          </ul>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> This is the most impressive demo for stakeholders. Try opening the Customer Account in one tab and the Simulator in another &mdash; pay and watch the balance update in real time.
          </p>
        `
      },

      /* ── Step 10 ── */
      {
        target: '#tab-fpx',
        activateTab: 'fpx',
        title: 'FPX — Simulate Online Banking Payment (IPN)',
        position: 'auto',
        content: `
          <p><strong>Purpose:</strong> Simulates FPX sending an Instant Payment Notification after online banking.</p>
          <p><strong>Fields:</strong></p>
          <ul>
            <li><strong>Seller Order No</strong> &mdash; AR Hub transaction reference</li>
            <li><strong>Amount</strong> &mdash; Payment amount in RM</li>
            <li><strong>Buyer Bank</strong> &mdash; Customer&rsquo;s bank</li>
            <li><strong>Status</strong> &mdash; <code>00</code> (Approved) or <code>99</code> (Failed)</li>
          </ul>
          <p><strong>If approved:</strong> Same flow as DuitNow &mdash; payment created, FIFO clearing, balance updated, GL posted.</p>
          <p><strong>If failed:</strong> Event logged but no clearing occurs. Customer is notified to retry.</p>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> FPX = website redirect flow (customer clicks &ldquo;Pay&rdquo; on portal). DuitNow = scan-and-pay with phone camera.
          </p>
        `
      },

      /* ── Step 11 ── */
      {
        target: '#tab-jompay',
        activateTab: 'jompay',
        title: 'JomPAY — Generate Reconciliation CSV',
        position: 'auto',
        content: `
          <p><strong>Purpose:</strong> Generates a batch CSV file in PayNet JomPAY format.</p>
          <p><strong>Fields:</strong></p>
          <ul>
            <li><strong>Batch Date</strong> &mdash; Date of the reconciliation file</li>
            <li><strong>Transaction Count</strong> &mdash; Number of payment entries</li>
          </ul>
          <p><strong>How JomPAY works in production:</strong></p>
          <ol>
            <li>Customer pays via ATM, mobile, or internet banking using Biller Code + Ref-1</li>
            <li>Acquiring bank collects transactions</li>
            <li>CSV file deposited on SFTP (daily by 08:00 MYT)</li>
            <li>AR Hub downloads and parses the CSV</li>
            <li>Auto-matches to customer accounts</li>
            <li>Unmatched items flagged to suspense account</li>
          </ol>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> JomPAY is a batch process (daily). DuitNow is real-time (milliseconds). Both are supported simultaneously.
          </p>
        `
      },

      /* ── Step 12 ── */
      {
        target: '#tab-emandate',
        activateTab: 'emandate',
        title: 'eMandate — Mandate Registration & Debit Results',
        position: 'auto',
        content: `
          <p>This tab has <strong>two forms</strong>:</p>
          <p><strong>Form 1 &mdash; Mandate Registration:</strong></p>
          <ul>
            <li><strong>Mandate Reference</strong> &mdash; Unique mandate ID</li>
            <li><strong>Bank Code</strong> &mdash; Customer&rsquo;s bank</li>
            <li><strong>Status</strong> &mdash; Active (bank approved) or Rejected (bank declined)</li>
          </ul>
          <p><strong>Form 2 &mdash; Monthly Debit Result:</strong></p>
          <ul>
            <li><strong>Mandate ID</strong> &mdash; Reference to active mandate</li>
            <li><strong>Amount</strong> &mdash; Debit amount in RM</li>
            <li><strong>Return Code</strong> &mdash; Success, NSF (Non-Sufficient Funds), Invalid Account, Stopped by Customer, Deceased</li>
          </ul>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> eMandate auto-debits on the due date each month. Failed debits (NSF, etc.) are retried once then escalated to dunning.
          </p>
        `
      },

      /* ── Step 13 ── */
      {
        target: '#tab-metis',
        activateTab: 'metis',
        title: 'Metis — Work Order Completion',
        position: 'auto',
        content: `
          <p><strong>Purpose:</strong> Simulates Metis field team completing a work order.</p>
          <p><strong>Fields:</strong></p>
          <ul>
            <li><strong>Work Order Reference</strong> &mdash; The WO number from AR Hub</li>
            <li><strong>Completion Type</strong> &mdash; Disconnected or Reconnected</li>
            <li><strong>Completion Date</strong> &mdash; When field work was done</li>
          </ul>
          <p><strong>What happens:</strong></p>
          <ul>
            <li><strong>Disconnected</strong> &mdash; Account status changes to <strong>TEMP_DISCONNECTED</strong></li>
            <li><strong>Reconnected</strong> &mdash; Account status changes to <strong>ACTIVE</strong></li>
          </ul>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> When a disconnected customer pays their outstanding balance, AR Hub automatically sends a reconnection work order to Metis &mdash; no manual intervention needed.
          </p>
        `
      },

      /* ── Step 14 ── */
      {
        target: '.tab[data-tab="gl"]',
        title: 'SAP GL Log & Notification Inbox — View-Only Tabs',
        position: 'bottom',
        content: `
          <p><strong>SAP GL Log:</strong> Shows all journal entries AR Hub has generated for SAP S/4HANA.</p>
          <ul>
            <li>Columns: Document #, Batch, Date, Type, Debit (RM), Credit (RM), Lines, Status</li>
            <li>Click <strong>Refresh</strong> to load latest entries</li>
          </ul>
          <p><strong>Notification Inbox:</strong> Captures all outbound notifications.</p>
          <ul>
            <li>All channels: Email, SMS, WhatsApp, Postal</li>
            <li>Shows channel icon, subject, body, recipient</li>
            <li>In production these go to real recipients; in POC they are captured here for verification</li>
          </ul>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> Always check the Notification Inbox after triggering dunning events to verify the correct messages were sent.
          </p>
        `
      },

      /* ── Step 15 ── */
      {
        target: '.tab[data-tab="eventlog"]',
        title: 'Event Log — Complete Audit Trail',
        position: 'bottom',
        content: `
          <p>The Event Log records every interaction between external systems and AR Hub.</p>
          <p><strong>Columns:</strong></p>
          <ul>
            <li><strong>Time</strong> &mdash; Exact timestamp</li>
            <li><strong>System</strong> &mdash; Color-coded badge: <span style="color:#3b82f6">iWRS = blue</span>, <span style="color:#22c55e">PayNet = green</span>, <span style="color:#f97316">LHDN = orange</span>, <span style="color:#ef4444">Metis = red</span>, <span style="color:#6b7280">Bank/SAP = gray</span></li>
            <li><strong>Direction</strong> &mdash; IN (received) or OUT (sent)</li>
            <li><strong>Event Type</strong> &mdash; What happened</li>
            <li><strong>Account</strong> &mdash; Related customer account</li>
            <li><strong>Amount</strong> &mdash; Transaction value (if applicable)</li>
            <li><strong>Status</strong> &mdash; Processing result</li>
            <li><strong>ms</strong> &mdash; Processing time in milliseconds</li>
          </ul>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> The <strong>ms</strong> column is your proof of performance &mdash; most operations complete in under 100ms.
          </p>
        `
      },

      /* ── Step 16 ── */
      {
        target: null,
        title: 'Simulator Training Complete!',
        position: 'auto',
        content: `
          <div style="text-align:center;margin-bottom:12px">
            <span style="font-size:48px">🔧</span>
            <h3 style="margin:8px 0 4px">You&rsquo;re a Simulator Expert!</h3>
          </div>
          <p><strong>You now know how to:</strong></p>
          <ul>
            <li>Create customer accounts from iWRS</li>
            <li>Generate invoices and counter payments</li>
            <li>Trigger all digital payments (DuitNow, FPX, JomPAY, eMandate)</li>
            <li>Generate MT940 bank statements</li>
            <li>Simulate LHDN e-Invoice responses</li>
            <li>Complete Metis disconnection/reconnection work orders</li>
            <li>Verify everything in the Event Log, GL Log, and Notification Inbox</li>
          </ul>
          <p><strong>Try this exercise:</strong></p>
          <ol>
            <li>Create a new account (iWRS tab)</li>
            <li>Generate an invoice for that account</li>
            <li>Pay with DuitNow QR</li>
            <li>Check the Event Log for all three events</li>
            <li>Verify the account balance is <strong>RM 0.00</strong></li>
          </ol>
        `
      }

    ],

    // ══════════════════════════════════════════════════════════════════════
    // PAGE 4: FIORI LIST REPORT (Generic, 7 steps, 0–6)
    // ══════════════════════════════════════════════════════════════════════

    fiori: [

      /* ── Step 0 ── */
      {
        target: null,
        title: 'SAP Fiori List Report — Training Guide',
        position: 'auto',
        content: `
          <div style="text-align:center;margin-bottom:12px">
            <span style="font-size:48px">📋</span>
            <h3 style="margin:8px 0 4px">Working with Fiori Data Views</h3>
          </div>
          <p>Every tile on the Launchpad opens as a <strong>List Report + Object Page</strong>. This training teaches you the pattern that is identical across all 31 apps.</p>
          <p><strong>You will learn:</strong></p>
          <ul>
            <li>How to search, filter, and sort data</li>
            <li>How to read the data table</li>
            <li>How to navigate to record details</li>
            <li>How to use action buttons</li>
            <li>How to understand status colours</li>
          </ul>
          <p style="background:#f0f9ff;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> This is generic training &mdash; the pattern is identical across all 31 apps.
          </p>
        `
      },

      /* ── Step 1 ── */
      {
        target: '.sapUshellShellHead',
        title: 'SAP Shell Bar — Global Navigation',
        position: 'bottom',
        content: `
          <p>The shell bar provides global navigation:</p>
          <ul>
            <li><strong>SAP Logo</strong> (left) &mdash; Click to navigate home</li>
            <li><strong>Page Title</strong> (centre) &mdash; Shows which app you are in</li>
            <li><strong>User Avatar</strong> (right) &mdash; Your profile, settings, and sign-out</li>
          </ul>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> Click the SAP logo at any time to return to the Fiori Launchpad.
          </p>
        `
      },

      /* ── Step 2 ── */
      {
        target: '.sapUiCompFilterBar',
        title: 'Filter Bar — Narrow Down Your Data',
        position: 'bottom',
        content: `
          <p><strong>How to filter in 5 steps:</strong></p>
          <ol>
            <li>Click <strong>&ldquo;Adapt Filters&rdquo;</strong> to see all available filter fields</li>
            <li>Add the fields you want to filter by</li>
            <li>Enter values (equals, contains, range, etc.)</li>
            <li>Click <strong>&ldquo;Go&rdquo;</strong> to apply filters</li>
            <li>Click <strong>&ldquo;Clear&rdquo;</strong> to reset all filters</li>
          </ol>
          <p>You can <strong>Save as Variant</strong> to remember your favourite filter combinations.</p>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> Useful filters to try: Status = <code>OVERDUE</code>, Channel = <code>DUITNOW_QR</code>, Account Type = <code>DOM</code>.
          </p>
        `
      },

      /* ── Step 3 ── */
      {
        target: '.sapUiCompSmartTable',
        title: 'Data Table — Your Records at a Glance',
        position: 'bottom',
        content: `
          <p><strong>Reading the table:</strong></p>
          <ul>
            <li>Each row = one record</li>
            <li>Click a column header to sort (ascending/descending)</li>
            <li>Click any row to open the detail (Object Page)</li>
            <li>Use checkboxes for bulk selection</li>
          </ul>
          <p><strong>Toolbar actions:</strong></p>
          <ul>
            <li><strong>Settings</strong> (gear icon) &mdash; Add, remove, or reorder columns</li>
            <li><strong>Export</strong> (download icon) &mdash; Export to Excel or CSV</li>
            <li><strong>Create</strong> (+) &mdash; Create a new record</li>
            <li><strong>Delete</strong> &mdash; Delete selected records (with confirmation)</li>
          </ul>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> Use the gear icon to add columns that are hidden by default &mdash; many useful fields are available.
          </p>
        `
      },

      /* ── Step 4 ── */
      {
        target: null,
        title: 'Status Badges & Colour Coding — Universal Legend',
        position: 'auto',
        content: `
          <p>Colours are consistent across all apps:</p>
          <div style="margin:8px 0">
            <span style="display:inline-block;background:#dcfce7;color:#166534;padding:2px 10px;border-radius:12px;font-size:13px;margin:2px">Active</span>
            <span style="display:inline-block;background:#dcfce7;color:#166534;padding:2px 10px;border-radius:12px;font-size:13px;margin:2px">Cleared</span>
            <span style="display:inline-block;background:#dcfce7;color:#166534;padding:2px 10px;border-radius:12px;font-size:13px;margin:2px">Approved</span>
            <span style="display:inline-block;background:#dcfce7;color:#166534;padding:2px 10px;border-radius:12px;font-size:13px;margin:2px">Success</span>
          </div>
          <div style="margin:8px 0">
            <span style="display:inline-block;background:#dbeafe;color:#1e40af;padding:2px 10px;border-radius:12px;font-size:13px;margin:2px">Open</span>
            <span style="display:inline-block;background:#dbeafe;color:#1e40af;padding:2px 10px;border-radius:12px;font-size:13px;margin:2px">New</span>
            <span style="display:inline-block;background:#dbeafe;color:#1e40af;padding:2px 10px;border-radius:12px;font-size:13px;margin:2px">Pending</span>
          </div>
          <div style="margin:8px 0">
            <span style="display:inline-block;background:#ffedd5;color:#9a3412;padding:2px 10px;border-radius:12px;font-size:13px;margin:2px">Overdue</span>
            <span style="display:inline-block;background:#ffedd5;color:#9a3412;padding:2px 10px;border-radius:12px;font-size:13px;margin:2px">Warning</span>
            <span style="display:inline-block;background:#ffedd5;color:#9a3412;padding:2px 10px;border-radius:12px;font-size:13px;margin:2px">Pending Approval</span>
          </div>
          <div style="margin:8px 0">
            <span style="display:inline-block;background:#fee2e2;color:#991b1b;padding:2px 10px;border-radius:12px;font-size:13px;margin:2px">Rejected</span>
            <span style="display:inline-block;background:#fee2e2;color:#991b1b;padding:2px 10px;border-radius:12px;font-size:13px;margin:2px">Failed</span>
            <span style="display:inline-block;background:#fee2e2;color:#991b1b;padding:2px 10px;border-radius:12px;font-size:13px;margin:2px">Disconnected</span>
            <span style="display:inline-block;background:#fee2e2;color:#991b1b;padding:2px 10px;border-radius:12px;font-size:13px;margin:2px">Fraud</span>
          </div>
          <div style="margin:8px 0">
            <span style="display:inline-block;background:#f3f4f6;color:#4b5563;padding:2px 10px;border-radius:12px;font-size:13px;margin:2px">Closed</span>
            <span style="display:inline-block;background:#f3f4f6;color:#4b5563;padding:2px 10px;border-radius:12px;font-size:13px;margin:2px">Cancelled</span>
            <span style="display:inline-block;background:#f3f4f6;color:#4b5563;padding:2px 10px;border-radius:12px;font-size:13px;margin:2px">Written Off</span>
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:13px;margin:8px 0">
            <thead><tr style="background:#f1f5f9"><th style="padding:4px 8px;text-align:left">App</th><th style="padding:4px 8px;text-align:left">Green</th><th style="padding:4px 8px;text-align:left">Blue</th><th style="padding:4px 8px;text-align:left">Orange</th><th style="padding:4px 8px;text-align:left">Red</th></tr></thead>
            <tbody>
              <tr><td style="padding:4px 8px">Invoices</td><td style="padding:4px 8px">Cleared</td><td style="padding:4px 8px">Open</td><td style="padding:4px 8px">Overdue</td><td style="padding:4px 8px">Rejected</td></tr>
              <tr><td style="padding:4px 8px">Payments</td><td style="padding:4px 8px">Success</td><td style="padding:4px 8px">Pending</td><td style="padding:4px 8px">Suspense</td><td style="padding:4px 8px">Failed</td></tr>
              <tr><td style="padding:4px 8px">Write-Offs</td><td style="padding:4px 8px">Approved</td><td style="padding:4px 8px">New</td><td style="padding:4px 8px">Pending Approval</td><td style="padding:4px 8px">Rejected</td></tr>
              <tr><td style="padding:4px 8px">Accounts</td><td style="padding:4px 8px">Active</td><td style="padding:4px 8px">New</td><td style="padding:4px 8px">Warning</td><td style="padding:4px 8px">Disconnected</td></tr>
            </tbody>
          </table>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> Click any row to see the full context behind the status badge.
          </p>
        `
      },

      /* ── Step 5 ── */
      {
        target: null,
        title: 'Object Page — Full Record Detail',
        position: 'auto',
        content: `
          <p>When you click a row in the table, you navigate to the <strong>Object Page</strong>:</p>
          <ul>
            <li><strong>Header</strong> &mdash; Record ID, status badge, key metrics</li>
            <li><strong>Section Tabs</strong> &mdash; General information, Related Entities, Notes, Change History</li>
            <li><strong>Edit button</strong> &mdash; Switches from display mode to edit mode. Make changes, then Save or Cancel.</li>
          </ul>
          <p style="background:#fef3cd;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> Many fields are clickable links that navigate to related entities (e.g. click an Account Number on an Invoice to jump to that Customer Account).
          </p>
        `
      },

      /* ── Step 6 ── */
      {
        target: null,
        title: 'Fiori App Training Complete!',
        position: 'auto',
        content: `
          <div style="text-align:center;margin-bottom:12px">
            <span style="font-size:48px">✅</span>
            <h3 style="margin:8px 0 4px">You Can Now Use Any Fiori App!</h3>
          </div>
          <p><strong>The pattern you have learned:</strong></p>
          <ol>
            <li><strong>Filter</strong> &mdash; Narrow down your data</li>
            <li><strong>Table</strong> &mdash; Browse and sort records</li>
            <li><strong>Click row</strong> &mdash; Open the Object Page</li>
            <li><strong>Object Page</strong> &mdash; View full detail with sections</li>
            <li><strong>Edit</strong> &mdash; Modify and save</li>
            <li><strong>Colours</strong> &mdash; Green/Blue/Orange/Red/Gray tell the story</li>
          </ol>
          <p>This pattern is <strong>identical across all 31 apps</strong>. Once you know one, you know them all.</p>
          <p style="background:#f0f9ff;padding:8px 12px;border-radius:6px">
            <strong>Tip:</strong> Bookmark your most-used apps as favourites. In production, the SAP Fiori Launchpad supports personalised tiles.
          </p>
        `
      }

    ]

  };

})();
