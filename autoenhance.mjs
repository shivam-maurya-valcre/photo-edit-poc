// Autoenhance v3 client: create image -> upload -> poll -> download -> delete. Everything stays in memory.
// API reference: https://api.autoenhance.ai/docs/openapi.spec

import { EnhanceError, readBoolean, readChoice, readInteger } from './shared.mjs';

const BASE_URL = 'https://api.autoenhance.ai/v3/images';

const PERSPECTIVE_MODES = ['OFF', 'DEFAULT_ENABLED', 'PRESERVE_CONTENT', 'PRIORITIZE_PERSPECTIVE'];
const DOWNLOAD_FORMATS = ['jpeg', 'png', 'webp', 'avif', 'jxl'];

/**
 * Every option Autoenhance accepts when an image is created, set for appraisal photos:
 * correct light, colour and geometry, never change what is in the photo.
 * `undefined` = not sent (Autoenhance default / not used). Values that come from .env are filled in by `buildImageSettings`.
 */
const SAFE_SETTINGS = {
    // Light, colour, contrast, white balance.
    enhance: true,
    // Remove lens distortion.
    lens_correction: true,
    // Straighten verticals and horizontals...
    perspective_correction: true,
    // ...without cropping away parts of the property (.env AUTOENHANCE_PERSPECTIVE_MODE).
    perspective_correction_mode: 'PRESERVE_CONTENT',
    // Recover detail in blown-out windows, but keep the real view through them.
    window_pull_type: 'ONLY_WINDOWS',
    // No fake sky.
    sky_replacement: true,
    cloud_type: undefined,
    // Keep the original resolution; no AI-invented detail.
    upscale: false,
    // Blur faces and licence plates (.env AUTOENHANCE_PRIVACY).
    privacy: false,
    // Nothing painted in or removed.
    restage: {
        sky: 'AS_SHOT',
        grass: 'AS_SHOT',
        fire_in_fireplaces: 'AS_SHOT',
        tvs: 'AS_SHOT',
        photographer: 'AS_SHOT',
    },
    // Regular photos, not 360°.
    threesixty: false,
    tripod_hide: true,
    // Model version (.env AUTOENHANCE_AI_VERSION); empty = Autoenhance default.
    ai_version: undefined,
    // Not used: dashboard presets, finetuning, orders, user feedback rating.
    preset_id: undefined,
    finetune_settings: undefined,
    order_id: undefined,
    rating: undefined,
    // Per request: image_name and metadata (see `enhanceImage`).
};

/** Every option Autoenhance accepts when downloading the result. Values from .env are filled in by `buildDownloadQuery`. */
const SAFE_DOWNLOAD_OPTIONS = {
    format: 'jpeg', // .env AUTOENHANCE_FORMAT
    quality: 90, // .env AUTOENHANCE_QUALITY (1-90)
    max_width: undefined, // .env AUTOENHANCE_MAX_WIDTH; empty = full size
    preview: true, // .env AUTOENHANCE_PREVIEW
    // Serve the enhanced photo without any restaging, even if some was ever switched on.
    restaged: false,
    watermark: false, // dev mode adds its own TEST MODE watermark regardless
    visible_disclosure: false,
    finetuned: undefined,
    dpi: undefined,
    scale: undefined,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** All non-secret settings, read from .env on every call so a restart is the only step after editing it. */
export function readConfig() {
    return {
        apiKeySet: Boolean(process.env.AUTOENHANCE_API_KEY),
        // Dev mode: no credits used, result carries a watermark.
        devMode: readBoolean('AUTOENHANCE_DEV_MODE', true),
        // Preview: lower-quality result; false purchases the full-size image (uses a credit).
        preview: readBoolean('AUTOENHANCE_PREVIEW', true),
        aiVersion: process.env.AUTOENHANCE_AI_VERSION?.trim() || undefined,
        perspectiveMode: readChoice('AUTOENHANCE_PERSPECTIVE_MODE', SAFE_SETTINGS.perspective_correction_mode, PERSPECTIVE_MODES),
        privacy: readBoolean('AUTOENHANCE_PRIVACY', SAFE_SETTINGS.privacy),
        format: readChoice('AUTOENHANCE_FORMAT', SAFE_DOWNLOAD_OPTIONS.format, DOWNLOAD_FORMATS),
        quality: readInteger('AUTOENHANCE_QUALITY', SAFE_DOWNLOAD_OPTIONS.quality, 1, 90),
        maxWidth: readInteger('AUTOENHANCE_MAX_WIDTH', SAFE_DOWNLOAD_OPTIONS.max_width, 1),
        deleteAfterDownload: readBoolean('AUTOENHANCE_DELETE_AFTER_DOWNLOAD', true),
        pollIntervalMs: readInteger('AUTOENHANCE_POLL_INTERVAL_MS', 3000, 1000),
        timeoutSeconds: readInteger('AUTOENHANCE_TIMEOUT_SECONDS', 300, 30),
    };
}

function buildImageSettings(config, imageName, metadata) {
    return {
        ...SAFE_SETTINGS,
        perspective_correction_mode: config.perspectiveMode,
        privacy: config.privacy,
        ai_version: config.aiVersion,
        image_name: imageName,
        metadata,
    };
}

function buildDownloadQuery(config) {
    const options = {
        ...SAFE_DOWNLOAD_OPTIONS,
        format: config.format,
        quality: config.quality,
        max_width: config.maxWidth,
        preview: config.preview,
    };
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) {
        if (value !== undefined) query.set(key, String(value));
    }
    return query;
}

function headers(apiKey, config, extra = {}) {
    return {
        'x-api-key': apiKey,
        ...(config.devMode ? { 'x-dev-mode': 'true' } : {}),
        ...extra,
    };
}

async function failWith(step, response) {
    const body = await response.text().catch(() => '');
    throw new EnhanceError(`Autoenhance ${step} failed (${response.status}): ${body.slice(0, 300)}`, response.status === 401 ? 401 : 502);
}

/**
 * Enhances one image and returns the result.
 * @param {Buffer} imageBuffer original image bytes
 * @param {string} imageName file name shown in the Autoenhance dashboard
 * @param {(msg: string) => void} log progress logger
 * @param {Record<string, string>} metadata stored with the image in Autoenhance, for tracing (e.g. Valcre photo id)
 * @returns {Promise<{ buffer: Buffer, contentType: string, imageId: string, seconds: number }>}
 */
export async function enhanceImage(imageBuffer, imageName, log = () => {}, metadata = {}) {
    const apiKey = process.env.AUTOENHANCE_API_KEY;
    if (!apiKey) {
        throw new EnhanceError('AUTOENHANCE_API_KEY is not set. Copy .env.example to .env and add your key.', 500);
    }
    const config = readConfig();
    log('Autoenhance config: ' + JSON.stringify(config, null, 4));
    const started = Date.now();

    // 1. Register the image and get a one-time upload URL.
    const createResponse = await fetch(`${BASE_URL}/`, {
        method: 'POST',
        headers: headers(apiKey, config, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(buildImageSettings(config, imageName, { source: 'valcre-photo-editor-poc', ...metadata })),
    });
    if (!createResponse.ok) await failWith('create image', createResponse);
    const created = await createResponse.json();
    const imageId = created.image_id;
    const uploadUrl = created.upload_url || created.s3PutObjectUrl;
    log(`Register the image and get a one-time upload URL: ${imageId}`);

    try {
        // 2. Upload the bytes. The signed URL carries the Content-Type it was signed for; send exactly that.
        const signedContentType = new URL(uploadUrl).searchParams.get('content-type') || 'image/jpeg';
        const uploadResponse = await fetch(uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': signedContentType },
            body: imageBuffer,
        });
        if (!uploadResponse.ok) await failWith('upload', uploadResponse);
        log('uploaded, waiting for processing... signed content type: ' + signedContentType);

        // 3. Poll until processed (Autoenhance has no progress or webhook in the API).
        while (true) {
            if (Date.now() - started > config.timeoutSeconds * 1000) {
                throw new EnhanceError(`Autoenhance did not finish within ${config.timeoutSeconds}s (image ${imageId})`, 504);
            }
            await sleep(config.pollIntervalMs);
            const statusResponse = await fetch(`${BASE_URL}/${imageId}`, { headers: headers(apiKey, config) });
            if (!statusResponse.ok) await failWith('status check', statusResponse);
            const image = await statusResponse.json();
            if (image.error || ['error', 'failed'].includes(String(image.status).toLowerCase())) {
                throw new EnhanceError(`Autoenhance could not process image ${imageId}: ${image.status_reason || image.error || image.status}`);
            }
            log(`status: ${image.status}`);
            if (image.status === 'processed') break;
        }

        // 4. Download the enhanced image (binary).
        const downloadResponse = await fetch(`${BASE_URL}/${imageId}/enhanced?${buildDownloadQuery(config)}`, {
            headers: headers(apiKey, config),
        });
        if (!downloadResponse.ok) await failWith('download', downloadResponse);
        const buffer = Buffer.from(await downloadResponse.arrayBuffer());

        return {
            buffer,
            contentType: downloadResponse.headers.get('content-type') || `image/${config.format}`,
            imageId,
            seconds: Math.round((Date.now() - started) / 1000),
        };
    } finally {
        // 5. Don't leave client photos with a third party: delete the image, whether it succeeded or not.
        if (config.deleteAfterDownload) await deleteImage(apiKey, config, imageId, log);
    }
}

async function deleteImage(apiKey, config, imageId, log) {
    try {
        const response = await fetch(`${BASE_URL}/${imageId}`, { method: 'DELETE', headers: headers(apiKey, config) });
        log(response.ok ? `deleted image ${imageId} from Autoenhance` : `WARNING: could not delete image ${imageId} (${response.status})`);
    } catch (error) {
        log(`WARNING: could not delete image ${imageId}: ${error.message}`);
    }
}
