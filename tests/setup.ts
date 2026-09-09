import 'reflect-metadata';

process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] ??= 'silent';
process.env['CORS_ORIGINS'] ??= 'http://localhost:5173';

// The global env only has to be *valid*; integration tests open their own connection
// from TEST_POSTGRES_URL.
process.env['DATABASE_URL'] ??= 'postgresql://fintech:fintech@127.0.0.1:5434/fintech';
process.env['REDIS_URL'] ??= 'redis://127.0.0.1:6383';

// Jobs run inline under test: an upload must have produced its variants by the time the
// request returns, or every assertion would be racing a worker.
process.env['QUEUE_ENABLED'] ??= 'false';
// Sockets need a listening HTTP server, which supertest does not provide.
process.env['REALTIME_ENABLED'] ??= 'false';

// Test-only secrets, and deliberately not the ones in .env: a test run must never be able to
// mint a token the development server would accept.
process.env['JWT_ACCESS_SECRET'] ??= 'test-access-secret-0123456789abcdef';
process.env['JWT_REFRESH_SECRET'] ??= 'test-refresh-secret-0123456789abcdef';
process.env['MFA_SECRET_KEY'] ??= 'test-mfa-secret-key-0123456789abcdef';
// The lowest argon2 cost the env schema accepts. Real parameters would add seconds to every
// test that logs in, and what is being tested is the flow, not the KDF.
process.env['ARGON2_MEMORY_COST'] ??= '8192';
process.env['ARGON2_TIME_COST'] ??= '2';

// MinIO from the dev stack: the media tests write real objects and read them back.
process.env['S3_ENDPOINT'] ??= 'http://127.0.0.1:9030';
process.env['S3_BUCKET'] ??= 'fintech-media';
process.env['S3_ACCESS_KEY'] ??= 'fintech';
process.env['S3_SECRET_KEY'] ??= 'fintech-secret';
