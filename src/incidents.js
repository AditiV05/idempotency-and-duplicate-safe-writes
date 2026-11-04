const { createHash } = require('crypto');
const { db } = require('./db');

const OPERATION = 'POST:/incidents';
const SEVERITIES = ['P1', 'P2', 'P3', 'P4'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_KEY_LENGTH = 255;
const LOCK_TIMEOUT_CODE = '55P03';

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

// Only the fields that define the action, in one fixed form.
function canonicalRequest({ title, severity, serviceId }) {
  return {
    title: typeof title === 'string' ? title.trim() : title,
    severity,
    serviceId: typeof serviceId === 'string' ? serviceId.toLowerCase() : serviceId
  };
}

function hashRequest(body) {
  const { title, severity, serviceId } = canonicalRequest(body);
  // An array fixes the order, so property order in the request cannot change the hash.
  return createHash('sha256').update(JSON.stringify([serviceId, severity, title])).digest('hex');
}

function isValidRequest({ title, severity, serviceId }) {
  return typeof title === 'string' && title !== '' && SEVERITIES.includes(severity) && isUuid(serviceId);
}

// Inserts the key, or takes over a record past its expiry. Returns null if a live
// record already owns this key. A concurrent claim waits here until the owner commits.
function claimKey(t, tenantId, key, requestHash) {
  return t.oneOrNone(
    `INSERT INTO idempotency_keys (tenant_id, operation, key, request_hash, state, expires_at)
     VALUES ($1, $2, $3, $4, 'processing', now() + interval '24 hours')
     ON CONFLICT (tenant_id, operation, key) DO UPDATE
       SET request_hash = EXCLUDED.request_hash,
           state = 'processing',
           response_status = NULL,
           response_body = NULL,
           created_at = now(),
           expires_at = EXCLUDED.expires_at
       WHERE idempotency_keys.expires_at <= now()
     RETURNING key`,
    [tenantId, OPERATION, key, requestHash]
  );
}

function readExisting(existing, requestHash) {
  if (!existing) return { status: 409, body: { error: 'operation_in_progress' } };
  if (existing.request_hash !== requestHash) return { status: 409, body: { error: 'idempotency_key_conflict' } };
  if (existing.state === 'completed') {
    return { status: existing.response_status, body: existing.response_body, replayed: true };
  }
  if (existing.state === 'failed') return { status: 409, body: { error: 'prior_operation_failed' } };
  return { status: 409, body: { error: 'operation_in_progress' } };
}

async function createOrReplay(tenantId, key, request, requestHash) {
  return db.tx(async t => {
    // A duplicate waits for the owner to commit, but not without limit.
    await t.none(`SET LOCAL lock_timeout = '5s'`);

    const claimed = await claimKey(t, tenantId, key, requestHash);
    if (!claimed) {
      const existing = await t.oneOrNone(
        `SELECT request_hash, state, response_status, response_body
         FROM idempotency_keys
         WHERE tenant_id = $1 AND operation = $2 AND key = $3`,
        [tenantId, OPERATION, key]
      );
      return readExisting(existing, requestHash);
    }

    const incident = await t.one(
      `INSERT INTO incidents (tenant_id, service_id, title, severity)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [tenantId, request.serviceId, request.title, request.severity]
    );
    await t.none(`INSERT INTO paging_jobs (tenant_id, incident_id) VALUES ($1, $2)`, [tenantId, incident.id]);

    // Serialised once, so the first response and every replay are identical.
    const body = JSON.parse(JSON.stringify(incident));
    await t.none(
      `UPDATE idempotency_keys
       SET state = 'completed', response_status = 201, response_body = $4
       WHERE tenant_id = $1 AND operation = $2 AND key = $3`,
      [tenantId, OPERATION, key, JSON.stringify(body)]
    );
    return { status: 201, body };
  });
}

async function createIncident(req, res) {
  const key = req.get('Idempotency-Key');
  if (!key) return res.status(400).json({ error: 'idempotency_key_required' });
  if (key.length > MAX_KEY_LENGTH) return res.status(400).json({ error: 'idempotency_key_too_long' });
  if (!isUuid(req.user.tenantId)) return res.status(400).json({ error: 'invalid_tenant' });

  // Validated before the claim, so a rejected request does not use up its key.
  const request = canonicalRequest(req.body);
  if (!isValidRequest(request)) return res.status(422).json({ error: 'invalid_request' });

  let result;
  try {
    result = await createOrReplay(req.user.tenantId, key, request, hashRequest(request));
  } catch (err) {
    if (err.code !== LOCK_TIMEOUT_CODE) throw err;
    result = { status: 409, body: { error: 'operation_in_progress' } };
  }

  if (result.replayed) res.set('Idempotent-Replayed', 'true');
  return res.status(result.status).json(result.body);
}

module.exports = { createIncident, hashRequest };
