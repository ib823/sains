'use strict';

const cds = require('@sap/cds');
const axios = require('axios');

const logger = cds.log('notification-service');

async function _getANSClient() {
  const vcap = process.env.VCAP_SERVICES ? JSON.parse(process.env.VCAP_SERVICES) : {};
  const ans = vcap['alert-notification']?.[0]?.credentials;
  if (!ans) {
    logger.warn('SAP Alert Notification Service not bound — notifications will be logged only');
    return null;
  }
  return ans;
}

async function sendEmail(params) {
  const ans = await _getANSClient();

  if (!ans) {
    logger.info('EMAIL (dev mode, not sent)', { to: params.to, subject: params.subject });
    _logToSimulatorInbox('EMAIL', params.to, params.subject, params.body, params.accountNumber);
    return { success: true, messageId: 'DEV_MODE', dev: true };
  }

  try {
    const event = {
      body: {
        eventType: 'SAINS_AR_EMAIL_NOTIFICATION',
        eventTimestamp: Date.now(),
        severity: 'INFO',
        category: 'NOTIFICATION',
        subject: params.subject,
        body: params.body,
        tags: {
          recipientEmail: params.to,
          templateKey: params.templateKey || 'generic',
        },
        resource: {
          resourceName: 'SAINS-AR-Hub',
          resourceType: 'application',
        }
      }
    };

    const tokenResponse = await axios.post(ans.oauth_url + '/oauth/token',
      'grant_type=client_credentials',
      { auth: { username: ans.client_id, password: ans.client_secret },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const token = tokenResponse.data.access_token;

    const response = await axios.post(ans.url + '/cf/producer/v1/resource-events',
      event,
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 15000 }
    );

    logger.info('Email notification queued via ANS', { to: params.to, status: response.status });
    return { success: true, messageId: response.data?.id, dev: false };

  } catch (error) {
    logger.error('Email notification failed', { to: params.to, error: error.message });
    return { success: false, error: error.message };
  }
}

async function sendSMS(params) {
  const gatewayUrl = process.env.SMS_GATEWAY_URL;
  const apiKey = process.env.SMS_GATEWAY_API_KEY;

  if (!gatewayUrl || !apiKey) {
    logger.info('SMS (dev mode, not sent)', { to: params.to });
    _logToSimulatorInbox('SMS', params.to, 'SMS Message', params.message, params.accountNumber);
    return { success: true, dev: true };
  }

  const mobileRegex = /^\+60[0-9]{8,10}$/;
  if (!mobileRegex.test(params.to)) {
    logger.warn('SMS skipped — invalid Malaysian mobile number format', { to: params.to });
    return { success: false, error: 'Invalid mobile number format' };
  }

  const message = params.message.substring(0, 160);

  try {
    const response = await axios.post(`${gatewayUrl}/send`, {
      to: params.to,
      message: message,
      from: '/* TBC: SAINS sender ID registered with MCMC */',
      api_key: apiKey,
    }, { timeout: 15000 });

    logger.info('SMS sent', { to: params.to, status: response.data?.status });
    return { success: true, messageId: response.data?.messageId };

  } catch (error) {
    logger.error('SMS failed', { to: params.to, error: error.message });
    return { success: false, error: error.message };
  }
}

async function queuePostalNotice(params) {
  const db = await cds.connect.to('db');

  await db.run(
    UPDATE('sains.ar.DunningHistory').set({
      postalDispatchedAt: new Date().toISOString(),
      postalReference: `POSTAL-QUEUE-${Date.now()}`,
    }).where({ ID: params.dunningHistoryID })
  );

  await sendEmail({
    to: '/* TBC: Finance Admin distribution list for postal queue */',
    subject: `[SAINS AR] Postal notice queued — ${params.noticeType} — ${params.accountNumber}`,
    body: `A postal notice requires printing and dispatch.\n\n` +
          `Account: ${params.accountNumber}\n` +
          `Customer: ${params.customerName}\n` +
          `Type: ${params.noticeType}\n` +
          `Address:\n${params.address}\n\n` +
          `Print from Dunning Management app and dispatch today.\n` +
          `Record dispatch date in the system once sent.`,
    templateKey: 'postal_queue_alert',
  });

  logger.info('Postal notice queued', {
    accountNumber: params.accountNumber,
    noticeType: params.noticeType,
  });

  return { success: true, queued: true };
}

async function sendSystemAlert(params) {
  const ans = await _getANSClient();
  if (!ans) {
    logger.warn('SYSTEM ALERT (ANS not bound)', params);
    return;
  }

  try {
    const tokenResponse = await axios.post(ans.oauth_url + '/oauth/token',
      'grant_type=client_credentials',
      { auth: { username: ans.client_id, password: ans.client_secret },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const token = tokenResponse.data.access_token;

    await axios.post(ans.url + '/cf/producer/v1/resource-events', {
      body: {
        eventType: 'SAINS_AR_SYSTEM_ALERT',
        eventTimestamp: Date.now(),
        severity: params.severity || 'WARNING',
        category: 'ALERT',
        subject: params.subject,
        body: params.body,
        tags: { alertType: params.alertType || 'SYSTEM' },
        resource: { resourceName: 'SAINS-AR-Hub', resourceType: 'application' },
      }
    }, { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
         timeout: 15000 });

  } catch (error) {
    logger.error('System alert delivery failed', { error: error.message, params });
  }
}

// Simulator inbox capture — logs all dev-mode notifications for the POC dashboard
async function _logToSimulatorInbox(channel, recipient, subject, body, accountNumber) {
  try {
    const db = await cds.connect.to('db');
    const { v4: uuidv4 } = require('uuid');
    await db.run(INSERT.into('sains.simulator.NotificationInbox').entries({
      ID: uuidv4(),
      channel,
      recipient: (recipient || '').substring(0, 200),
      subject: (subject || '').substring(0, 500),
      body: body || '',
      status: 'SENT',
      accountNumber: accountNumber || null,
    }));
  } catch (err) {
    // Simulator logging must not break business logic
    logger.debug(`Simulator inbox log skipped: ${err.message}`);
  }
}

module.exports = { sendEmail, sendSMS, queuePostalNotice, sendSystemAlert };
