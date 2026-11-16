// Shared by the enhancement providers: one error type and the .env readers.

export class EnhanceError extends Error {
    constructor(message, status = 502) {
        super(message);
        this.status = status;
    }
}

function configError(message) {
    return new EnhanceError(`.env: ${message}`, 500);
}

export function readBoolean(name, defaultValue) {
    const value = process.env[name]?.trim().toLowerCase();
    if (!value) return defaultValue;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw configError(`${name} must be true or false`);
}

export function readInteger(name, defaultValue, min, max = Number.MAX_SAFE_INTEGER) {
    const value = process.env[name]?.trim();
    if (!value) return defaultValue;
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) {
        throw configError(`${name} must be a whole number from ${min}${max === Number.MAX_SAFE_INTEGER ? '' : ` to ${max}`}`);
    }
    return number;
}

export function readChoice(name, defaultValue, choices) {
    const value = process.env[name]?.trim();
    if (!value) return defaultValue;
    const match = choices.find((choice) => choice.toLowerCase() === value.toLowerCase());
    if (!match) throw configError(`${name} must be one of ${choices.join(', ')}`);
    return match;
}
