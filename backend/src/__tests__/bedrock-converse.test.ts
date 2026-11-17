import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

import {
  backoffDelayMs,
  converse,
  isRetryableBedrockError,
  promptVersion,
} from '../lib/bedrock-converse.js';

function namedError(name: string, httpStatusCode?: number): Error {
  const err = new Error(name) as Error & { $metadata?: { httpStatusCode?: number } };
  err.name = name;
  if (httpStatusCode) err.$metadata = { httpStatusCode };
  return err;
}

const okResponse = (text: string) => ({
  output: { message: { role: 'assistant', content: [{ text }] } },
  usage: { inputTokens: 12, outputTokens: 3 },
});

function fakeClient(...outcomes: Array<Error | ReturnType<typeof okResponse>>) {
  const send = jest.fn();
  for (const outcome of outcomes) {
    if (outcome instanceof Error) send.mockRejectedValueOnce(outcome);
    else send.mockResolvedValueOnce(outcome);
  }
  return { client: { send } as unknown as BedrockRuntimeClient, send };
}

const baseOptions = { modelId: 'm', prompt: 'hi', maxTokens: 10, operation: 'test' };

describe('bedrock-converse', () => {
  beforeEach(() => {
    jest.spyOn(Math, 'random').mockReturnValue(0); // zero backoff delay
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('returns text and token usage', async () => {
    const { client } = fakeClient(okResponse('  hello  '));
    const res = await converse(client, baseOptions);
    expect(res.text).toBe('hello');
    expect(res.inputTokens).toBe(12);
    expect(res.outputTokens).toBe(3);
  });

  it('retries throttling and then succeeds', async () => {
    const { client, send } = fakeClient(
      namedError('ThrottlingException'),
      namedError('ServiceUnavailableException'),
      okResponse('ok')
    );
    const res = await converse(client, baseOptions);
    expect(res.text).toBe('ok');
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxRetries', async () => {
    const { client, send } = fakeClient(
      namedError('ThrottlingException'),
      namedError('ThrottlingException'),
      namedError('ThrottlingException')
    );
    await expect(converse(client, { ...baseOptions, maxRetries: 2 })).rejects.toThrow(
      'ThrottlingException'
    );
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-retryable errors', async () => {
    const { client, send } = fakeClient(namedError('ValidationException'));
    await expect(converse(client, baseOptions)).rejects.toThrow('ValidationException');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('fails on an empty response', async () => {
    const { client } = fakeClient(okResponse('   '));
    await expect(converse(client, baseOptions)).rejects.toThrow('empty response');
  });

  it('classifies retryable errors, including HTTP 429', () => {
    expect(isRetryableBedrockError(namedError('ThrottlingException'))).toBe(true);
    expect(isRetryableBedrockError(namedError('SomethingElse', 429))).toBe(true);
    expect(isRetryableBedrockError(namedError('AccessDeniedException'))).toBe(false);
    expect(isRetryableBedrockError('boom')).toBe(false);
  });

  it('keeps the backoff within the cap', () => {
    expect(backoffDelayMs(0, 20_000, () => 0.999)).toBeLessThan(1_000);
    expect(backoffDelayMs(10, 20_000, () => 0.999)).toBeLessThan(20_000);
    expect(backoffDelayMs(3, 20_000, () => 0)).toBe(0);
  });

  it('changes the prompt version when the prompt changes', () => {
    expect(promptVersion('a')).toBe(promptVersion('a'));
    expect(promptVersion('a')).not.toBe(promptVersion('b'));
  });
});
