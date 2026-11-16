// Claid.ai client: one multipart upload, result comes back in the same request, then download it. Everything stays in memory.
// API reference: https://docs.claid.ai/image-editing-api/upload-api-reference.md

import { EnhanceError, readBoolean, readChoice, readInteger } from './shared.mjs';

const UPLOAD_URL = 'https://api.claid.ai/v1/image/edit/upload';

const DECOMPRESS_MODES = ['off', 'auto', 'moderate', 'strong'];

/**
 * Every Claid operation relevant to photo correction, set for appraisal photos:
 * fix light and colour, never invent content or change the framing.
 * `undefined` = not sent. Values that come from .env are filled in by `buildOperations`.
 */
const CLAID_SETTINGS = {
    adjustments: {
        // ML colour and lighting balance; 100 is Claid's recommended intensity (.env CLAID_HDR_INTENSITY).
        hdr: { intensity: 100, stitching: false },
        // Manual relative tweaks (-100 to 100, sharpness 0 to 100). Left to HDR.
        exposure: undefined,
        saturation: undefined,
        contrast: undefined,
        sharpness: undefined,
    },
    restorations: {
        // Remove JPEG artifacts only when Claid detects them (.env CLAID_DECOMPRESS).
        decompress: 'auto',
        // No AI upscaling: it renders new pixels that were never photographed.
        upscale: undefined,
        // Redraws parts of the image to look sharper (.env CLAID_POLISH). Off: it changes detail.
        polish: false,
    },
    // Not used: resizing, padding, background removal, generative edits. The photo keeps its size and content.
};

const CLAID_OUTPUT = {
    format: { type: 'jpeg', quality: 90, progressive: true }, // .env CLAID_QUALITY
};

/** Non-secret Claid settings. */
export function readClaidConfig() {
    return {
        apiKeySet: Boolean(process.env.CLAID_API_KEY),
        hdrIntensity: readInteger('CLAID_HDR_INTENSITY', CLAID_SETTINGS.adjustments.hdr.intensity, 0, 100),
        decompress: readChoice('CLAID_DECOMPRESS', CLAID_SETTINGS.restorations.decompress, DECOMPRESS_MODES),
        polish: readBoolean('CLAID_POLISH', CLAID_SETTINGS.restorations.polish),
        quality: readInteger('CLAID_QUALITY', CLAID_OUTPUT.format.quality, 1, 100),
        timeoutSeconds: readInteger('CLAID_TIMEOUT_SECONDS', 120, 10),
    };
}

function buildOperations(config) {
    const { adjustments, restorations } = CLAID_SETTINGS;
    return {
        adjustments: {
            ...adjustments,
            hdr: config.hdrIntensity > 0 ? { ...adjustments.hdr, intensity: config.hdrIntensity } : undefined,
        },
        restorations: {
            ...restorations,
            decompress: config.decompress === 'off' ? undefined : config.decompress,
            // Claid documents only `true`; leave it out when off.
            polish: config.polish || undefined,
        },
    };
}

/**
 * Enhances one image with Claid and returns the result.
 * @param {Buffer} imageBuffer original image bytes
 * @param {string} imageName file name (Claid names the output after it)
 * @param {(msg: string) => void} log progress logger
 * @returns {Promise<{ buffer: Buffer, contentType: string, imageId: string, seconds: number }>}
 */
export async function enhanceImageWithClaid(imageBuffer, imageName, log = () => {}) {
    const apiKey = process.env.CLAID_API_KEY;
    if (!apiKey) throw new EnhanceError('CLAID_API_KEY is not set. Add it to .env.', 500);
    const config = readClaidConfig();
    const started = Date.now();
    const signal = AbortSignal.timeout(config.timeoutSeconds * 1000);

    // 1. Upload with the operations; Claid processes it within this request.
    const request = { operations: buildOperations(config), output: { format: { ...CLAID_OUTPUT.format, quality: config.quality } } };
    const form = new FormData();
    // Claid recommends a file name without extension, since the output format decides it.
    form.append('file', new Blob([imageBuffer], { type: 'image/jpeg' }), imageName.replace(/\.[^.]+$/, '') || 'photo');
    // `data` must be a plain text field; a Blob would be sent as a file part and Claid rejects it (422 "str type expected").
    form.append('data', JSON.stringify(request));
    log(`claid request: ${JSON.stringify(request)}`);

    const response = await fetchOrTimeout(UPLOAD_URL, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal }, config);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        const reason = body.error_message || body.message || JSON.stringify(body).slice(0, 300);
        throw new EnhanceError(`Claid failed (${response.status}): ${reason}`, response.status === 401 ? 401 : 502);
    }
    const output = body.data?.output ?? {};
    if (!output.tmp_url) throw new EnhanceError(`Claid returned no result URL: ${JSON.stringify(body).slice(0, 300)}`);
    log(`processed: ${output.width}x${output.height} ${output.format ?? ''}`);

    // 2. Download the result from Claid's temporary storage (kept by Claid for 24 hours).
    const download = await fetchOrTimeout(output.tmp_url, { signal }, config);
    if (!download.ok) throw new EnhanceError(`Claid result download failed (${download.status})`);

    return {
        buffer: Buffer.from(await download.arrayBuffer()),
        contentType: download.headers.get('content-type') || output.mime || 'image/jpeg',
        imageId: output.object_key || '',
        seconds: Math.round((Date.now() - started) / 1000),
    };
}

async function fetchOrTimeout(url, options, config) {
    try {
        return await fetch(url, options);
    } catch (error) {
        if (error.name === 'TimeoutError') throw new EnhanceError(`Claid did not finish within ${config.timeoutSeconds}s`, 504);
        throw new EnhanceError(`Could not reach Claid: ${error.message}`);
    }
}
