// Enhance one local file from the terminal (no server needed), e.g. for the deck comparison.
// Usage: npm run enhance -- <input.jpg> [output.jpg] [--provider=claid]

import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { enhanceImage } from './autoenhance.mjs';
import { enhanceImageWithClaid } from './claid.mjs';

const args = process.argv.slice(2);
const provider = (args.find((arg) => arg.startsWith('--provider='))?.split('=')[1] || process.env.AUTO_FIX_PROVIDER || 'autoenhance').toLowerCase();
const [input, outputArg] = args.filter((arg) => !arg.startsWith('--'));
if (!input || !['autoenhance', 'claid'].includes(provider)) {
    console.error('Usage: npm run enhance -- <input.jpg> [output.jpg] [--provider=autoenhance|claid]');
    process.exit(1);
}

const output = outputArg || input.replace(extname(input), `_${provider}${extname(input) || '.jpg'}`);

try {
    const buffer = await readFile(input);
    const enhance = provider === 'claid' ? enhanceImageWithClaid : enhanceImage;
    const result = await enhance(buffer, basename(input), (msg) => console.log(msg));
    await writeFile(output, result.buffer);
    console.log(`Saved ${output} (${result.seconds}s, image ${result.imageId})`);
} catch (error) {
    console.error(error.message);
    process.exit(1);
}
