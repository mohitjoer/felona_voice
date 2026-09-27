/**
 * MissingCredentialsError — thrown when a provider is asked to open a live
 * stream without the credentials it needs.
 *
 * Constructing a provider is deliberately cheap and side-effect free, so that
 * text-only usage (`interact()`, graph visualization) never requires an audio
 * API key. The check therefore happens at `createStream()` — the point where
 * audio is actually about to flow.
 */
export class MissingCredentialsError extends Error {
  readonly provider: string;
  readonly configHint: string;

  constructor(provider: string, configHint: string) {
    super(
      `${provider} requires an API key to open a speech stream. ` +
        `Configure it with ${configHint}. ` +
        `(Text-only usage such as interact() does not need one.)`,
    );
    this.name = "MissingCredentialsError";
    this.provider = provider;
    this.configHint = configHint;
  }
}
