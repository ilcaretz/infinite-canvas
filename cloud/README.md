# Infinite Canvas on Cloudflare (Worker + D1 + R2)
npm install
npm run typecheck && npm test
echo -n "password" | node scripts/hash-password.mjs alice      # prints a USERS entry (repeat per user, join with commas)
npx wrangler login
npx wrangler d1 create infinite-canvas                          # put the database_id into wrangler.toml
npm run db:init                                                 # applies schema.sql to the remote D1
npx wrangler secret put USERS                                   # name:pbkdf2$...,name2:pbkdf2$...
npx wrangler secret put SESSION_SECRET                          # long random string
npx wrangler secret put S3_ENDPOINT                             # https://<ACCOUNT_ID>.r2.cloudflarestorage.com
npx wrangler secret put S3_ACCESS_KEY_ID
npx wrangler secret put S3_SECRET_ACCESS_KEY
npm --prefix ../web run build                                   # web/dist is served as static assets
npm run deploy
# R2 bucket CORS: allow GET, HEAD, PUT from the workers.dev origin, expose ETag
