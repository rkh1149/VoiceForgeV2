const DEFAULT_GENERATED_APP_PREFIX = "voiceforgev2";

function normalizePrefix(value: string | undefined): string {
  const normalized = (value ?? DEFAULT_GENERATED_APP_PREFIX)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || DEFAULT_GENERATED_APP_PREFIX;
}

export const GENERATED_APP_PREFIX = normalizePrefix(
  process.env.VOICEFORGE_GENERATED_APP_PREFIX,
);

export function getGeneratedAppName(slug: string): string {
  return `${GENERATED_APP_PREFIX}-${slug}`;
}
