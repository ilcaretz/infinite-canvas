// A real .env (APP_PASSWORD, STORAGE_DRIVER=s3, HOST ...) must never leak into the unit tests: real env vars win over .env.
process.env.APP_PASSWORD = '';
process.env.STORAGE_DRIVER = 'local';
process.env.HOST = '';
process.env.TRUST_PROXY = '';
