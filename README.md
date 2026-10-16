# Node.js Development Test — Product CRUD Manager

Developed by Iqra Nawaz. Express 5, SQLite (better-sqlite3), bcrypt, JWT and Shopify GraphQL Admin API. This is a single-store API integration; it has no merchant-facing UI or multi-store installation flow.

## Setup

1. On Windows x64, use Node.js **24.21.0** and npm **11.19.0** (the verified versions) and open a terminal in the extracted project folder.
2. Run `npm ci --ignore-scripts` using the included, unchanged lockfile. See the native-installation explanation and smoke test below; plain `npm ci` can unnecessarily invoke native build tools with this dependency/npm combination.
3. Copy `.env.example` to `.env`. Replace the JWT placeholder with your own random secret of at least 32 characters; never share the file. Configure Shopify credentials and use only the shop slug in `SHOPIFY_SHOP`, without `.myshopify.com`.
4. Run `node server.js`. The default URL is `http://127.0.0.1:3000`; `PORT` can override it.

### Tested Windows installation procedure

Prerequisites: Windows x64, the Node/npm versions above, and access to the npm registry (or an approved registry mirror containing the locked packages). Install into a newly extracted folder; do not copy another project's `node_modules`. The verified prebuilt path does not require Python, Visual Studio Build Tools or a Windows SDK.

```powershell
node --version
npm --version
npm ci --ignore-scripts
node -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); if(db.prepare('SELECT 1 AS ok').get().ok!==1) process.exit(1); db.close(); const bcrypt=require('bcrypt'); const hash=bcrypt.hashSync('temporary-native-check',12); if(!bcrypt.compareSync('temporary-native-check',hash)||bcrypt.compareSync('wrong-password',hash)) process.exit(1); console.log('SQLite and bcrypt native checks passed');"
Copy-Item .env.example .env
# Configure the new .env with your own credentials before starting.
node server.js
```

Copy the template only on a fresh installation; do not overwrite an existing `.env`. Configure Shopify credentials as described below. Starting the server initializes SQLite automatically; the original developer database is not needed. For local assessment tests, follow the development reset and Postman sections below.

### Why installation scripts are skipped for this lockfile

The locked native dependencies are `better-sqlite3@13.0.3` (Node >=22) and `bcrypt@6.0.0` (Node >=18). Both package tarballs include Windows x64 native binaries. SQLite loads `better-sqlite3/prebuilds/win32-x64.node`; bcrypt loads `bcrypt/prebuilds/win32-x64/bcrypt.node`. bcrypt's normal install script is `node-gyp-build`; skipping it does not disable runtime password hashing when its bundled binary loads.

In the tested npm 11.19.0 lockfile-driven install, better-sqlite3's `gypfile: false` is absent from the in-memory lockfile package metadata. npm detects `binding.gyp` and synthesizes `node-gyp rebuild`, despite the package's bundled prebuild. node-gyp then tries to configure a compiler toolchain; the plain installation failed because this machine lacks a Windows SDK. This is an installation/toolchain issue, not evidence that SQLite needs to be removed. A matching upstream report is [better-sqlite3 issue #1516](https://github.com/WiseLibs/better-sqlite3/issues/1516).

The prebuilt procedure was tested in a fresh directory with its **own initially empty npm cache**. Logs confirmed fresh registry downloads. The loaded native files matched binaries in independently downloaded tarballs whose integrity matched `package-lock.json`. SQLite create/insert/reopen and bcrypt cost-12 hash/correct-password/wrong-password checks passed. This did not depend on copying cached builds or the developer's installed modules.

`--ignore-scripts` skips all dependency lifecycle scripts for that installation. It is appropriate here only because this exact locked dependency set and its native binaries were exercised; do not set it globally or assume it works after changing dependencies. Keep `package-lock.json` and run the smoke test above. Verification covers this Windows x64 environment, not every Windows installation, CPU architecture, OS, Node version or future package release. Platform runtime libraries and compatible binaries must still be available.

If a supported prebuilt binary cannot load, do not ignore the error or claim the installation succeeded. A source-build installation requires compatible Python and Visual Studio Build Tools with the **Desktop development with C++** workload, including a Windows SDK, followed by `npm ci` and the same smoke tests. That complete source-build procedure was **not** successfully tested in this environment. Other platforms need separate verification.

SQLite creates `products.db` automatically in the working directory. Always start from the project folder. Startup performs additive, repeatable migrations, including `users.token_version INTEGER NOT NULL DEFAULT 0`, without deleting users or products. Back up an existing database before deploying migrations. Never delete a database to apply an update. Tokens created before the token-version release require a fresh login; users and passwords are preserved.

Shopify credentials are currently required at startup, even for local-only use. For isolated offline testing use synthetic placeholders and a mocked Shopify transport; never send those placeholders to Shopify. For real integration, install your authorized app on a development store in the same Shopify organization, grant `read_products` and `write_products`, and configure its client ID/secret. Client credentials authentication is for same-organization stores. See [Shopify authentication documentation](https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant?lang=node).

## Endpoints

| Method | Endpoint | Access / purpose |
|---|---|---|
| GET | `/` | Public server status |
| POST | `/products` | JWT; create local product |
| GET | `/products` | Public local product list |
| GET | `/products/:id` | Public local product lookup |
| PUT | `/products/:id` | JWT; replace local product fields |
| DELETE | `/products/:id` | JWT; delete local product |
| POST | `/auth/signup` | Register |
| POST | `/auth/login` | Obtain JWT |
| POST | `/auth/forgot-password` | Request development recovery |
| POST | `/auth/reset-password` | Consume single-use token |
| GET | `/shopify/products` | JWT; first 20 Shopify products |
| POST | `/shopify/products` | JWT; create DRAFT product |
| PUT | `/shopify/products/:id` | JWT; update title/description |
| DELETE | `/shopify/products/:id` | JWT; delete product |

Signup body: `{"name":"Reviewer","email":"reviewer@example.com","password":"ChooseYourOwnPassword"}`. Login uses `email` and `password`. Copy the returned JWT into `Authorization: Bearer <jwt_token>`. Passwords require at least 8 characters and at most 72 UTF-8 bytes. Local create/update body: `{"name":"Example","description":"Optional description","price":12.5,"stock":3}`. Price must be nonnegative, stock a nonnegative safe integer, and local IDs positive safe integers.

Shopify create/update accepts `title` and `description`; update needs at least one. URL IDs are the numeric suffix of `gid://shopify/Product/<id>`. Local SQLite products and Shopify products are independent. Shopify prices, variants, inventory, pagination beyond 20, and publishing are not implemented.

## Development-only password reset

No email delivery is implemented. The generic forgot-password response records a request and does not claim that email was sent. Production responses never include generated reset tokens; generated tokens are never logged in any environment.

For a private local session, set process environment variables in PowerShell before starting the server:

```powershell
$env:NODE_ENV = 'development'
$env:ALLOW_DEV_RESET_TOKEN = 'true'
node server.js
```

Only exact development mode, explicit `true`, and a loopback request allow `resetToken` in the response. Use `http://127.0.0.1:3000`. Do not enable this behind a publicly accessible proxy. `.env.example` disables it by default; Postman settings do not set server environment variables.

1. POST `/auth/forgot-password` with `{"email":"reviewer@example.com"}`.
2. In the opted-in local response, use the fresh `resetToken` in POST `/auth/reset-password`: `{"token":"<fresh_token>","newPassword":"ChooseAnotherPassword"}`.
3. Tokens expire after 15 minutes and cannot be reused. A new request invalidates previous reset tokens.
4. Successful reset atomically changes the password and increments the user's token version. **All earlier JWTs receive 401 on protected endpoints.** Public product reads remain public.
5. Login with the new password to obtain a working JWT. The old password no longer works.

## Postman

Import `postman/My Collection.postman_collection.json` (v2.1) and `postman/Local Review.postman_environment.json`. Select the Local Review environment and set `base_url`. Run **Local assessment** against a test database: it generates a disposable user, obtains a JWT, tests CRUD, deletes its own product, and tests recovery, old JWT rejection and new JWT authorization. Existing products are not deliberately selected, but the run creates an account; use an isolated test database. With local reset opt-in disabled, dependent recovery checks skip instead of passing.

The collection uses `{{jwt_token}}`, `{{reset_token}}` and captured product IDs. Authentication endpoints override bearer auth with No Auth. Exported credential placeholders are blank. Never share an environment after testing without clearing credentials, tokens and IDs.

All Shopify requests skip by default. Set `run_shopify_reads=true` only for authorized reads. For **each individually approved** Shopify mutation, set `allow_shopify_mutations=true`; the pre-request guard consumes the opt-in and resets it to false. Update/delete require a numeric `shopify_product_id`, ideally from an approved disposable create. Never run live writes unattended. Test mocks do not prove live write permissions or results.

## Logging, rate limits and errors

Method and URL are logged before rate limiting and JSON parsing, including malformed JSON and oversized requests. Query parameter names remain visible; **all query values are redacted**, including unfamiliar credential names. Request bodies and authorization headers are not logged. Do not put credentials in URL path segments.

All POST attempts, including malformed input and successful requests, count per IP and endpoint in a 15-minute fixed window:

| Endpoint | Attempts per window |
|---|---:|
| `/auth/signup` | 20 |
| `/auth/login` | 30 |
| `/auth/forgot-password` | 10 |
| `/auth/reset-password` | 20 |

Excess attempts receive 429 and `Retry-After` in seconds. One complete Postman run stays below these limits; repeated runs can hit the limit. Wait for the window rather than disabling protection on a public service. State is bounded to 10,000 IP/endpoint buckets and expired entries are cleaned up. At capacity, new buckets are rejected temporarily. State is per-process and resets at restart: production multi-instance deployments need a shared limiter and additional account-based abuse controls. Express does not trust arbitrary forwarded-IP headers; configure trusted proxies deliberately before deployment. Users behind one NAT share limits.

Status codes: 200 success, 201 created, 400 invalid input, 401 invalid/expired/revoked JWT, 404 absent resource/route, 409 duplicate email, 413 excessive body, 429 local auth limit, 500 unexpected internal failure. Shopify connection/protocol failures return 502; Shopify HTTP throttling/unavailability and GraphQL THROTTLED return 503 with Retry-After; a 10-second upstream timeout returns 504. No automatic write retries occur. Product existence is read before update/delete and checked again after mutation errors, so ordinary field validation remains 400 rather than being mislabeled 404. A 404 indicates no product visible to the authorized Shopify client; insufficient upstream permission is treated as an upstream error. [Shopify error reference](https://shopify.dev/docs/api/usage/response-codes).

## Verification and submission scope

Use `node --check server.js`, `node --check database.js`, `node --check shopify.js`, `node --check request-security.js`, and `node --check test-shopify.js`. Run the Postman local folder and `npm audit --omit=dev`. `npm test` is still the original placeholder, not an automated test suite. `test-shopify.js` performs a live read/auth check and prints product data; it does not test writes. The external audit harness uses temporary databases and mocked Shopify responses. Live authentication/read were verified in the earlier audit; live create/update/delete remain unverified.

Before any later approved ZIP, include source (including `request-security.js`), README, package.json, package-lock.json, .env.example, .gitignore and both clean Postman exports. Exclude `.env`, node_modules, private databases and sidecars, populated token environments, logs and audit/backup artifacts. `.gitignore` does not filter a manually created ZIP. No final ZIP or submission email is part of this correction phase.

Remaining production limitations include no reset email, public local product reads, shared product privileges for all registered users, an in-memory IP-only limiter, no merchant UI, and SQLite floating-point prices. The API rejects fractional stock, but the existing SQLite table does not enforce integer storage directly. These are documented scope limits, not silently added features.
