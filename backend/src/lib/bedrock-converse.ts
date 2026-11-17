import { createHash } from 'node:crypto';
import {
  ConverseCommand,
  type BedrockRuntimeClient,
  type ContentBlock,
} from '@aws-sdk/client-bedrock-runtime';

// Shared Bedrock Converse wrapper. The SAME file lives in every app
// (read-worthy, cloud-confessions, community-organizer-hub, mis-viviendas,
// aws-announcements-hub) so they share one request format, one retry policy and
// one structured log line. Keep the copies in sync (formatting follows each repo).
//
// Failure policy (what callers do when this throws, after retries):
//   - Moderation / classification: fail safe to HUMAN REVIEW, never auto-approve.
//   - Scoring / enrichment with a deterministic equivalent: fall back to it.
//   - Output the user asked for (drafts, diagnoses): surface a clear error so the
//     user can retry; never fabricate a result.
//   - Optional decoration (e.g. "why it matters" lines): omit it.

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 20_000;
const PROMPT_VERSION_LENGTH = 8;

const RETRYABLE_ERROR_NAMES = new Set([
  'ThrottlingException',
  'TooManyRequestsException',
  'ServiceQuotaExceededException',
  'ServiceUnavailableException',
  'InternalServerException',
]);

export interface ConverseOptions {
  /** Model id or application inference profile ARN. */
  modelId: string;
  system?: string;
  /** Plain user text, or content blocks when the request carries an image. */
  prompt: string | ContentBlock[];
  maxTokens: number;
  temperature?: number;
  /** Label for the log line, e.g. 'moderation'. */
  operation: string;
  /** Optional {@link promptVersion} of the static prompt template, logged to correlate behaviour with prompt edits. */
  promptVersion?: string;
  /** Retries after the first attempt. Lower it on synchronous API paths. */
  maxRetries?: number;
  maxDelayMs?: number;
}

export interface ConverseResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/** Short, stable hash of a STATIC prompt template: changes whenever the prompt is edited. */
export function promptVersion(...parts: string[]): string {
  return createHash('sha256')
    .update(parts.join('\n'))
    .digest('hex')
    .slice(0, PROMPT_VERSION_LENGTH);
}

export function isRetryableBedrockError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return RETRYABLE_ERROR_NAMES.has(err.name) || status === 429;
}

/** Exponential backoff with full jitter: random delay in [0, min(cap, base * 2^attempt)]. */
export function backoffDelayMs(
  attempt: number,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  random: () => number = Math.random
): number {
  const ceiling = Math.min(maxDelayMs, DEFAULT_BASE_DELAY_MS * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function converse(
  client: BedrockRuntimeClient,
  options: ConverseOptions
): Promise<ConverseResult> {
  const { modelId, system, prompt, maxTokens, temperature, operation } = options;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const content: ContentBlock[] = typeof prompt === 'string' ? [{ text: prompt }] : prompt;
  const command = new ConverseCommand({
    modelId,
    system: system ? [{ text: system }] : undefined,
    messages: [{ role: 'user', content }],
    inferenceConfig: { maxTokens, temperature },
  });

  const startedAt = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await client.send(command);
      const text = (res.output?.message?.content ?? [])
        .map((block) => block.text ?? '')
        .join('')
        .trim();
      if (!text) throw new Error('Bedrock returned an empty response');
      const result: ConverseResult = {
        text,
        inputTokens: res.usage?.inputTokens ?? 0,
        outputTokens: res.usage?.outputTokens ?? 0,
      };
      console.log(
        JSON.stringify({
          stage: 'bedrock-converse',
          operation,
          promptVersion: options.promptVersion,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          latencyMs: Date.now() - startedAt,
          retries: attempt,
        })
      );
      return result;
    } catch (err) {
      if (!isRetryableBedrockError(err) || attempt >= maxRetries) throw err;
      const delayMs = backoffDelayMs(attempt, options.maxDelayMs);
      console.warn(
        JSON.stringify({
          stage: 'bedrock-retry',
          operation,
          attempt: attempt + 1,
          maxRetries,
          delayMs,
          error: err instanceof Error ? err.name : String(err),
        })
      );
      await sleep(delayMs);
    }
  }
}
