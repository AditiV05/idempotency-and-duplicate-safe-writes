# Idempotency and Duplicate-Safe Writes

Build duplicate-safe `POST /incidents` endpoint that returns one durable result when same logical request arrives more than once.

## Why This Repository Exists

Current starter inserts incident on every request. It has no idempotency record, duplicate claim, stored replay result, or durable paging job. Supplied tests describe required contract.

## Repository Structure

```text
.
├── db/
│   └── schema.sql              # incidents table; add idempotency and paging tables
├── scripts/
│   └── resetDb.js              # recreates exercise database
├── src/
│   ├── app.js                  # Express route and error handler
│   ├── auth.js                 # provides authenticated exercise tenant/user
│   ├── db.js                   # PostgreSQL connection
│   └── incidents.js            # broken handler to repair
├── tests/
│   └── idempotency.test.js     # 14 supplied contract tests
├── docker-compose.yml          # local PostgreSQL on port 54329
├── package.json
└── package-lock.json
```

## Prerequisites

- Git
- Node.js 18 or newer
- npm
- Docker with Docker Compose
- GitHub account

## Setup

1. Fork repository to your GitHub account.
2. Clone your fork:

```bash
git clone https://github.com/<your-username>/idempotency-and-duplicate-safe-writes.git
cd idempotency-and-duplicate-safe-writes
git checkout -b idempotent-incidents
```

3. Start PostgreSQL and install dependencies:

```bash
docker compose up -d
npm install
```

4. Reset database and run tests:

```bash
npm run db:reset
npm test
```

Starter tests fail until required schema and handler are implemented. This is expected.

## What to Implement

### Database

Add:

- scoped idempotency record with key, request hash, state, replay metadata, and expiry;
- unique ownership for authenticated tenant + operation + key;
- durable paging-job table.

### Handler

Implement:

- required `Idempotency-Key` validation;
- authenticated tenant scope;
- canonical request hash;
- atomic key claim before incident creation;
- completed replay, changed-request conflict, and processing response;
- one transaction for key, incident, paging job, and completed response.

Do not call external queue/provider inside database transaction.

### README Decisions

Explain:

1. why database uniqueness is needed;
2. how request contents are canonicalized and compared;
3. what 24-hour expiry means;
4. why paging job is stored in same transaction;
5. privacy and size risks of stored responses.

## Test Coverage

Supplied tests check:

- missing key;
- first request;
- sequential replay;
- replay response header;
- changed payload conflict;
- tenant isolation;
- 20 concurrent duplicates;
- exactly one incident and paging job;
- lost response retry;
- processing and failed states;
- transaction rollback;
- canonical hash;
- stored scope and operation.

Do not change tests.

## Submit Pull Request

```bash
git add .
git commit -m "Implement duplicate-safe incident creation"
git push -u origin idempotent-incidents
```

Open pull request from `idempotent-incidents` into your fork's `main` branch. Include:

- summary of approach;
- design decisions;
- passing test output.

Submit pull-request URL, not repository homepage, branch, commit, or PDF link.

## Troubleshooting

**Docker port conflict:** stop process using port 54329 or change port consistently in Compose and `DATABASE_URL`.

**Database connection failed:** wait until PostgreSQL is healthy, then run `npm run db:reset` again.

**Tests say idempotency table is missing:** implement schema TODOs and rerun reset before tests.

**Resetting production data:** never point `DATABASE_URL` at shared or production database. Reset script is destructive.

## Design Decisions

### 1. Why database uniqueness is needed

A check before the write is not enough, because 20 requests can all read "key not seen" and then all write. The primary key on `(tenant_id, operation, key)` decides the one owner atomically. The claim is an `INSERT ... ON CONFLICT` that runs before the incident is created. A concurrent duplicate waits for the owner to commit, then reads the completed record and replays it. If the owner is stuck, `lock_timeout` stops the wait after 5 seconds and the caller gets `409 operation_in_progress`.

The tenant comes from the authenticated user, never from the request body, so two tenants can use the same key without colliding. The operation is stored as `POST:/incidents`.

| Situation | Response |
|---|---|
| Key missing | `400 idempotency_key_required` |
| New key | `201`, creates the incident and paging job |
| Same key, same request, completed | The stored `201`, with `Idempotent-Replayed: true` |
| Same key, changed request | `409 idempotency_key_conflict` |
| Same key, still processing | `409 operation_in_progress` |
| Same key, marked failed | `409 prior_operation_failed` |

The handler does its whole write in one transaction, so it never commits `processing` or `failed` itself. If the write fails, everything rolls back, including the key, and a retry runs cleanly. Those two states are still honoured if a record holds them, such as one written by a future multi-step flow or by an operator.

### 2. How request contents are canonicalised and compared

Only `title`, `severity`, and `serviceId` define the action. `title` is trimmed and `serviceId` is lowercased, because those differences do not change the meaning. The three values go into an array in a fixed order, and the SHA-256 of that JSON is stored as `request_hash`. So property order and extra fields do not change the hash, while a changed title, severity, or service does. Validation runs before the claim, so a rejected request does not use up its key.

### 3. What 24-hour expiry means

A key protects against duplicates for 24 hours after it is claimed. After that, the same key is treated as new: the claim takes over the expired record atomically and creates a new incident, even if the body changed. So a client must not retry an old request after 24 hours and expect a replay.

Expired records stay in the table until something removes them. This exercise has no cleanup job, and production would need a scheduled delete.

### 4. Why the paging job is stored in the same transaction

The key, the incident, the paging job, and the completed response commit together or not at all. Otherwise, a crash could leave an incident with no page, or a page for an incident that does not exist. A database transaction cannot include an outside call, so the handler never calls a provider. It stores a job row, and a worker sends the page after commit. `paging_jobs.incident_id` is unique, so an incident has only one job, and the job `id` is a stable identity the provider call can use to stay safe to repeat. This exercise does not include the worker.

### 5. Privacy and size risks of stored responses

Each completed key keeps a full copy of the response for 24 hours or more, and it includes the incident title. A title can contain sensitive details, so this copy has the same access rules as the incident: it is only readable within the same tenant and key. It also keeps old data after the incident changes, so a replay shows the result as it was first returned, and deleting an incident does not remove this copy.

For size, each record is small, but a title has no length limit beyond Express's default 100 KB body limit, and rows build up until they are cleaned up. A production version should limit title length, delete expired records on a schedule, and avoid storing anything a replay does not need.
