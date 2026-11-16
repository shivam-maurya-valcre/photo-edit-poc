# Photo editor POC API (ENG-6529)

One image in, enhanced image out, from Autoenhance or Claid.ai. No database, no storage, no npm packages (Node 20.6+).

## Prerequisites

- Node.js 20.6 or newer (`node --version`). No `npm install` needed: the project has no dependencies.
- An API key for at least one provider: Autoenhance (Settings -> API keys) and/or Claid.ai (dashboard -> API keys).

## Setup

```bash
git clone https://github.com/shivam-maurya-valcre/photo-edit-poc.git
cd photo-edit-poc
cp .env.example .env
```

Then edit `.env`:

1. Set `AUTOENHANCE_API_KEY` and/or `CLAID_API_KEY`.
2. Pick the default provider with `AUTO_FIX_PROVIDER` (`autoenhance` or `claid`).
3. Autoenhance starts in dev mode (`AUTOENHANCE_DEV_MODE=true`): no credits used, results are watermarked. For a clean full-size result set `AUTOENHANCE_DEV_MODE=false` and `AUTOENHANCE_PREVIEW=false`; this uses one credit per image.

`.env` holds your API keys and is git-ignored. Never commit it; only `.env.example` is tracked.

## Run

```bash
npm start                                   # API on http://localhost:3100
npm run enhance -- ./bedroom.jpg            # one file from the terminal -> bedroom_autoenhance.jpg
npm run enhance -- ./bedroom.jpg --provider=claid   # same with Claid -> bedroom_claid.jpg
```

Check it is up: `curl http://localhost:3100/health`. A sample photo, `IMG_3025.JPG`, is included (with `IMG_3025_claid.JPG` as an example Claid result).

Server settings in `.env`:

| Setting | Default | |
|---|---|---|
| `PORT` | `3100` | |
| `ALLOWED_ORIGIN` | `http://localhost:4200` | CORS origin of the editor UI |
| `ALLOWED_URL_HOSTS` | `static-photos.valcre.com,static-photos.dev.valcre.com,res.cloudinary.com` | hosts `?url=` may download from |

## API

| Request | Result |
|---|---|
| `GET /health` | `{ ok, defaultProvider, autoenhance: {...}, claid: {...} }` (non-secret settings; keys show as set / not set) |
| `POST /poc/auto-fix` with the image as the raw body (`Content-Type: image/jpeg`) | enhanced JPEG |
| `POST /poc/auto-fix?url=https://static-photos(.dev).valcre.com/...` | server downloads the photo (host must be in `ALLOWED_URL_HOSTS`), returns enhanced JPEG |

```bash
curl -X POST --data-binary @bedroom.jpg -H 'Content-Type: image/jpeg' \
  http://localhost:3100/poc/auto-fix -o result.jpg
```

Optional on both: `&provider=autoenhance|claid` (default `AUTO_FIX_PROVIDER`), and `&photoId=<id>&propertyId=<id>` (Autoenhance only), stored as Autoenhance metadata so a result can be traced.

Processing takes seconds to a few minutes; the request stays open until it finishes (`AUTOENHANCE_TIMEOUT_SECONDS`, default 300). The photo is then deleted from Autoenhance (`AUTOENHANCE_DELETE_AFTER_DOWNLOAD`).

## Settings sent to Autoenhance (appraisal-safe)

`SAFE_SETTINGS` in `autoenhance.mjs` lists every option Autoenhance accepts, each with the value we need: light, colour, lens, verticals (`PRESERVE_CONTENT`, no heavy crop) and window pull only. Sky replacement, upscale and 360° off; sky, grass, fireplaces, TVs and photographer all `AS_SHOT`. `SAFE_DOWNLOAD_OPTIONS` does the same for the download (`restaged=false`, no disclosure label).

Settings you can change in `.env` (see `.env.example`):

| Setting | Default | |
|---|---|---|
| `AUTOENHANCE_PERSPECTIVE_MODE` | `PRESERVE_CONTENT` | `DEFAULT_ENABLED`, `PRIORITIZE_PERSPECTIVE`, `OFF` |
| `AUTOENHANCE_PRIVACY` | `false` | blur faces and licence plates |
| `AUTOENHANCE_AI_VERSION` | empty | pin the model, e.g. a `.x` version from your Autoenhance account |
| `AUTOENHANCE_FORMAT` | `jpeg` | `png`, `webp`, `avif`, `jxl` |
| `AUTOENHANCE_QUALITY` | `90` | 1-90 |
| `AUTOENHANCE_MAX_WIDTH` | empty (full size) | px |
| `AUTOENHANCE_DELETE_AFTER_DOWNLOAD` | `true` | |
| `AUTOENHANCE_POLL_INTERVAL_MS` | `3000` | |
| `AUTOENHANCE_TIMEOUT_SECONDS` | `300` | |

An invalid value stops the server at start-up with a message naming the setting.

## Claid.ai

`claid.mjs` sends the photo in one multipart request (`POST https://api.claid.ai/v1/image/edit/upload`) and gets the result in the same request, usually in seconds, then downloads it from Claid's temporary storage (kept 24 hours by Claid). `CLAID_SETTINGS` lists the operations: automatic light and colour fix (`hdr`), JPEG artifact removal only when needed, no upscaling, no polish, no resizing or generative edits.

| Setting | Default | |
|---|---|---|
| `CLAID_API_KEY` | none | from the Claid dashboard |
| `CLAID_HDR_INTENSITY` | `100` | 0-100, 0 = off |
| `CLAID_DECOMPRESS` | `auto` | `off`, `moderate`, `strong` |
| `CLAID_POLISH` | `false` | redraws detail to look sharper |
| `CLAID_QUALITY` | `90` | JPEG quality 1-100 |
| `CLAID_TIMEOUT_SECONDS` | `120` | |

To make the editor's Auto-fix button use Claid, set `AUTO_FIX_PROVIDER=claid` and restart.
