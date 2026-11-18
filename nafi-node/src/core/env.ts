export const env = (k: string, d?: string): string | undefined => process.env[k] ?? d;
