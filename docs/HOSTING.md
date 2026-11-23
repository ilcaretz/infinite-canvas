# Hosting the board online (2 people)

The same code runs two ways:

| | Local (default) | Online |
|---|---|---|
| `STORAGE_DRIVER` | `local` | `s3` (Cloudflare R2) |
| `APP_PASSWORD` | empty (no login) | set |
| Files | `DATA_DIR` on this PC | R2 bucket |
| `board.sqlite` | `DATA_DIR` | `DATA_DIR` of the machine running the server (boards, comments, item positions - small) |

**Why R2 and direct transfers.** Cloudflare's free plan terms do not allow serving video / large files through its proxy or
Tunnel, and the proxy / Tunnel cap request bodies (about 100 MB). So in online mode **media bytes never pass through the app
server**:

- Browsers download originals, previews and thumbnails from R2 through **presigned GET links** (the API hands them out; Range
  requests work because R2 serves them; links are cached per file for about 50 min so the browser cache keeps working, and the
  open board swaps in fresh ones automatically).
- Browsers upload originals straight to R2 with a **presigned PUT** (files up to 100 MB) or a **multipart upload** (bigger:
  64 MiB parts, 3 in parallel, resumable - parts already in the bucket are not sent again, and the part links are renewed on resume).
- The app server only signs links, then `POST /api/uploads/:id/complete` makes it stream the object back from R2 to compute the
  sha256 (de-duplication), download it to `DATA_DIR\tmp`, build previews / thumbnails with ffmpeg + sharp, write them back to R2
  and delete the tmp copy. That traffic is server to R2, which is allowed. Only small JSON and the web page go through the
  tunnel / proxy.

Instant on-board preview while uploading (browser object URL) is unchanged.

## 1. Create the R2 bucket, token and CORS (about 10 min, one time)

1. Cloudflare dashboard -> **R2 Object Storage** -> *Create bucket* (e.g. `board-media`, location *Automatic*). R2 needs a payment
   method on the account but the free allowance (10 GB storage, no egress fees) is plenty to start.
2. Note your **Account ID** (R2 overview page, right side). The S3 endpoint is
   `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.
3. R2 overview -> **Manage API tokens** -> *Create API token* -> permission **Object Read & Write** -> *Specify bucket(s)* ->
   pick `board-media` only -> Create. Copy the **Access Key ID** and **Secret Access Key** (shown once) - these are the S3
   credentials. (Use the S3 credential pair, not the "token value".)
4. Bucket -> **Settings** -> **CORS Policy** -> *Add* -> paste (replace the origin with the address people open the board at):

```json
[
  {
    "AllowedOrigins": ["https://board.example.com"],
    "AllowedMethods": ["GET", "HEAD", "PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"],
    "MaxAgeSeconds": 3600
  }
]
```

   - `PUT` is the browser upload, `GET`/`HEAD` the media and PDF viewing, `ETag` must be exposed so multipart uploads can read
     the part ETags (if it is not, the board still works: the server then lists the parts from the bucket itself).
   - A quick tunnel gets a new random `https://<words>.trycloudflare.com` address every start: either list it here each time or use
     `"AllowedOrigins": ["*"]` while testing (the signed links are the secret, not the origin). For `http://localhost:5180` add
     that origin too.
   - If you set the policy with `wrangler` or the S3 API instead of the dashboard, wrap the same rule as `{"CORSRules": [ ... ]}`
     (the field names are the dashboard's; verify against the current Cloudflare R2 CORS docs when you paste).
5. Recommended: bucket -> Settings -> **Object lifecycle rules** -> add *Abort incomplete multipart uploads after 1 day*
   (cancelled / abandoned big uploads otherwise keep their parts).
6. Put the values in `.env` (next to `start.bat` / in `/opt/board/.env`):

```ini
STORAGE_DRIVER=s3
S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
S3_BUCKET=board-media
S3_ACCESS_KEY_ID=<Access Key ID>
S3_SECRET_ACCESS_KEY=<Secret Access Key>
S3_REGION=auto
PRESIGN_TTL_S=3600
APP_PASSWORD=<a long passphrase>
HOST=127.0.0.1          # 0.0.0.0 only on a VPS / in Docker
TRUST_PROXY=true        # behind cloudflared / Caddy
```

`.env` is git-ignored; never commit it. With `STORAGE_DRIVER=s3` the server refuses to start if an `S3_*` key is missing.

## 2. Move existing local boards to the bucket (optional)

1. Stop the board.
2. Dry run (lists what would be sent, contacts nothing): `node scripts\migrate-local-to-r2.mjs --dry-run`
3. Upload: `node scripts\migrate-local-to-r2.mjs` (same keys as on disk; objects already in the bucket with the same size are
   skipped, so it can be re-run; `--force` re-sends, `--concurrency N`, `--data-dir <folder>`).
4. Copy `DATA_DIR\board.sqlite` (with `board.sqlite-wal` / `-shm` if present, board stopped) into the `DATA_DIR` of the server
   that will run online, then start it with `STORAGE_DRIVER=s3`.

## 3a. Option A - run on this PC + Cloudflare Tunnel

Good for trying it out or while the PC is on anyway. The board is only reachable while the PC and the board window are running.

1. Set `.env` as above but keep `HOST=127.0.0.1` (cloudflared runs on the same PC and connects locally) and `TRUST_PROXY=true`.
2. Start the board (`start.bat`).
3. Install `cloudflared` (`winget install Cloudflare.cloudflared`).
4. **Quick tunnel** (testing; no account or domain needed, random address that changes every start):
   `cloudflared tunnel --url http://localhost:5180` -> it prints `https://<random>.trycloudflare.com`. Send that to your
   collaborator; add the address to the R2 CORS list (or use `*` while testing).
5. **Named tunnel** (stable address; needs a **domain whose DNS is on the Cloudflare account**):
   ```
   cloudflared tunnel login
   cloudflared tunnel create board
   cloudflared tunnel route dns board board.example.com
   ```
   `%USERPROFILE%\.cloudflared\config.yml`:
   ```yaml
   tunnel: board
   credentials-file: C:\Users\<you>\.cloudflared\<TUNNEL-ID>.json
   ingress:
     - hostname: board.example.com
       service: http://localhost:5180
     - service: http_status:404
   ```
   Run `cloudflared tunnel run board` (or `cloudflared service install` to run it as a Windows service). Use
   `https://board.example.com` as the CORS origin.

Only the page and small JSON calls use the tunnel; video, images and PDFs go browser <-> R2 directly, which stays within
Cloudflare's rules for the free plan. Do not set `HOST=0.0.0.0` here: nothing else should reach the port.

## 3b. Option B - small Linux VPS

Always on, ~1 GB RAM is enough (ffmpeg transcodes are the heavy part; 2 GB is comfortable). Any provider.

**Without Docker (Node 22 + systemd)**

```bash
sudo apt update && sudo apt install -y ffmpeg git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
sudo useradd --system --create-home --home-dir /opt/board --shell /usr/sbin/nologin board
# copy the app to /opt/board (git clone, rsync or scp; exclude node_modules, dist, data, .env)
sudo -u board bash -c 'cd /opt/board && npm run install:all && npm run build'
sudo -u board nano /opt/board/.env          # contents as in step 1; HOST=127.0.0.1 behind Caddy, TRUST_PROXY=true
sudo chmod 600 /opt/board/.env
sudo cp /opt/board/deploy/board.service /etc/systemd/system/board.service
sudo systemctl daemon-reload && sudo systemctl enable --now board
journalctl -u board -f
```
`DATA_DIR` is `/var/lib/board` (set in the unit). Optional: `sudo apt install libreoffice-writer` for DOCX previews.

**With Docker**

```bash
cp .env.example .env && nano .env            # steps above
docker compose -f deploy/docker-compose.yml up -d --build
```
The compose file publishes `127.0.0.1:5180` only and keeps `board.sqlite` in the `board-data` volume
(add `--build-arg WITH_LIBREOFFICE=1` in the Dockerfile build for DOCX previews).

**HTTPS in front** (either way): the board speaks plain http on loopback; put Caddy (or nginx) in front, e.g. `Caddyfile`:
```
board.example.com {
    reverse_proxy 127.0.0.1:5180
}
```
Point the domain's DNS at the VPS; Caddy gets the certificate by itself. Because media bypasses the server, the domain may also
sit behind Cloudflare's proxy (orange cloud) - only the page and JSON pass through it. Alternatively run `cloudflared` on the VPS
exactly as in option A.

## 4. Security notes

- `APP_PASSWORD` set -> every page and `/api` route needs the login (`/login` and `/api/health` are open). Constant-time
  password check, signed httpOnly `SameSite=Lax` session cookie (30 days, `Secure` automatically when the request came in over https),
  10 failed attempts per IP per 15 min. Changing the password logs everyone out. `/logout` ends a session.
- Behind a proxy set `TRUST_PROXY` so the rate limit sees real client IPs - and only then: with it on, the server believes
  `X-Forwarded-For`, so the port must not be reachable except through the proxy (keep `HOST=127.0.0.1` or firewall the port).
- The signed media links are bearer links valid for `PRESIGN_TTL_S`; anyone who has one can fetch that file until it expires.
- "Show in folder" is loopback-only and hidden when `STORAGE_DRIVER=s3`.
- Backup: R2 holds the media; back up `board.sqlite` (stop the server, copy the file). Without it the media are orphans.

## 5. What cannot be verified without real credentials

Everything above is unit-tested against a mocked S3 client (no network). Still to check once with a real bucket: the CORS rule
in a real browser (PUT, ETag header, video Range seeking, PDF.js fetch), a >100 MB multipart upload over a real link
(and an interrupted one resuming), R2's handling of the presigned `response-*` overrides, tunnel behaviour with the board open
for hours, and cookie `Secure` over the real https address.
