// Photo editor POC API. No database, no storage: one image in, one enhanced image out.
//
//   POST /poc/auto-fix            body = raw image bytes (Content-Type image/*)
//   POST /poc/auto-fix?url=<url>  server downloads the image from the URL first
//   optional on both: &provider=autoenhance|claid  (default AUTO_FIX_PROVIDER in .env)
//                     &photoId=<id>&propertyId=<id>  stored as Autoenhance metadata for tracing
//   GET  /health
//
// Run: npm start   (reads .env)

import { createServer } from 'node:http';
import { enhanceImage, readConfig } from './autoenhance.mjs';
import { enhanceImageWithClaid, readClaidConfig } from './claid.mjs';
import { EnhanceError, readChoice } from './shared.mjs';

const PORT = Number(process.env.PORT || 3100);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:4200';
const PROVIDERS = ['autoenhance', 'claid'];
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const ALLOWED_URL_HOSTS = (process.env.ALLOWED_URL_HOSTS || 'static-photos.valcre.com,static-photos.dev.valcre.com,res.cloudinary.com')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);

function log(message) {
    console.log(`${new Date().toISOString()} ${message}`);
}

function setCors(req, res) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    // The Valcre app adds its own headers (e.g. `client`, Authorization); allow whatever the preflight asks for.
    // Safe for a local POC because the origin is still restricted to ALLOWED_ORIGIN.
    res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type, Authorization');
    res.setHeader('Access-Control-Expose-Headers', 'X-Enhance-Provider, X-Autoenhance-Image-Id, X-Processing-Seconds');
}

function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) throw new EnhanceError('Image is larger than 20 MB', 413);
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

async function readImageFromUrl(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new EnhanceError('url is not a valid URL', 400);
    }
    if (url.protocol !== 'https:' || !ALLOWED_URL_HOSTS.includes(url.hostname)) {
        throw new EnhanceError(`url host must be one of: ${ALLOWED_URL_HOSTS.join(', ')}`, 400);
    }
    const response = await fetch(url);
    if (!response.ok) throw new EnhanceError(`Could not download the image (${response.status})`, 400);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_UPLOAD_BYTES) throw new EnhanceError('Image is larger than 20 MB', 413);
    return { buffer, name: decodeURIComponent(url.pathname.split('/').pop() || 'photo.jpg') };
}

// Ids only (digits, letters, dashes), so nothing unexpected is stored with a third party.
function readTraceMetadata(url, sourceUrl) {
    const metadata = {};
    for (const key of ['photoId', 'propertyId']) {
        const value = url.searchParams.get(key);
        if (value && /^[\w-]{1,64}$/.test(value)) metadata[key] = value;
    }
    if (sourceUrl) metadata.sourcePath = new URL(sourceUrl).pathname.slice(0, 200);
    return metadata;
}

function readDefaultProvider() {
    return readChoice('AUTO_FIX_PROVIDER', 'autoenhance', PROVIDERS);
}

function readProvider(url) {
    const value = url.searchParams.get('provider');
    if (!value) return readDefaultProvider();
    const provider = PROVIDERS.find((name) => name === value.toLowerCase());
    if (!provider) throw new EnhanceError(`provider must be one of: ${PROVIDERS.join(', ')}`, 400);
    return provider;
}

async function handleAutoFix(req, res, url) {
    const provider = readProvider(url);
    const sourceUrl = url.searchParams.get('url');
    const { buffer, name } = sourceUrl
        ? await readImageFromUrl(sourceUrl)
        : { buffer: await readBody(req), name: url.searchParams.get('name') || 'photo.jpg' };

    if (!buffer.length) throw new EnhanceError('Send the image as the request body, or pass ?url=', 400);

    const metadata = readTraceMetadata(url, sourceUrl);
    log(`auto-fix start [${provider}]: ${name} (${Math.round(buffer.length / 1024)} KB), Metadata: ${Object.keys(metadata).length ? JSON.stringify(metadata) : ''}`);
    const providerLog = (msg) => log(`  ${msg}`);
    const result =
        provider === 'claid'
            ? await enhanceImageWithClaid(buffer, name, providerLog)
            : await enhanceImage(buffer, name, providerLog, metadata);
    // Everything except the image bytes.
    const { buffer: resultBuffer, ...resultInfo } = result;
    log(`auto-fix done [${provider}] in ${result.seconds}s (${Math.round(resultBuffer.length / 1024)} KB): ${JSON.stringify(resultInfo, null, 4)}`);

    res.writeHead(200, {
        'Content-Type': result.contentType,
        'Cache-Control': 'no-store',
        'X-Enhance-Provider': provider,
        ...(provider === 'autoenhance' ? { 'X-Autoenhance-Image-Id': result.imageId } : {}),
        'X-Processing-Seconds': String(result.seconds),
    });
    res.end(result.buffer);
}

const server = createServer(async (req, res) => {
    setCors(req, res);
    const url = new URL(req.url, `http://${req.headers.host}`);

    try {
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            return res.end();
        }
        if (req.method === 'GET' && url.pathname === '/health') {
            // Non-secret settings only; the API key is reported as set / not set.
            return sendJson(res, 200, { ok: true, defaultProvider: readDefaultProvider(), autoenhance: readConfig(), claid: readClaidConfig() });
        }
        if (req.method === 'POST' && url.pathname === '/poc/auto-fix') {
            return await handleAutoFix(req, res, url);
        }
        sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
        const status = error instanceof EnhanceError ? error.status : 500;
        log(`error ${status}: ${error.message}`);
        if (!res.headersSent) sendJson(res, status, { error: error.message });
        else res.end();
    }
});

let config;
let claidConfig;
try {
    config = readConfig();
    claidConfig = readClaidConfig();
    readDefaultProvider();
} catch (error) {
    console.error(error.message);
    process.exit(1);
}

// Autoenhance can take a few minutes; keep the request open a minute longer than the slower provider's timeout.
server.requestTimeout = (Math.max(config.timeoutSeconds, claidConfig.timeoutSeconds) + 60) * 1000;

server.listen(PORT, () => {
    log(`Photo editor POC API on http://localhost:${PORT} (CORS: ${ALLOWED_ORIGIN})`);
    const { apiKeySet, ...settings } = config;
    const { apiKeySet: claidKeySet, ...claidSettings } = claidConfig;
    log(`default provider: ${readDefaultProvider()}`);
    log(`autoenhance settings: ${JSON.stringify(settings)}`);
    log(`claid settings: ${JSON.stringify(claidSettings)}`);
    if (!apiKeySet) log('WARNING: AUTOENHANCE_API_KEY is not set; provider=autoenhance will fail.');
    if (!claidKeySet) log('WARNING: CLAID_API_KEY is not set; provider=claid will fail.');
});
