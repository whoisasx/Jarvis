import Anthropic from '@anthropic-ai/sdk';
import type {ContentBlockParam, MessageParam} from '@anthropic-ai/sdk/resources/messages';
import {GoogleGenAI} from '@google/genai';
import OpenAI from 'openai';
import {logEvent} from './logger.js';

export interface LlmGenerateRequest {
  system: string;
  prompt: string;
  screenshotBase64?: string;
  screenshotMediaType?: 'image/png' | 'image/jpeg' | 'image/webp';
  maxTokens?: number;
  temperature?: number;
  responseMimeType?: 'application/json' | 'text/plain';
  metadata?: Record<string, unknown>;
}

export interface LlmRuntime {
  readonly provider: string;
  readonly model: string;
  generate(request: LlmGenerateRequest): Promise<string>;
}

export class CloudLlmRuntime implements LlmRuntime {
  private readonly anthropic: Anthropic | null;
  private readonly gemini: GoogleGenAI | null;

  constructor(
    public readonly provider: 'anthropic' | 'gemini',
    apiKey: string,
    public readonly model: string,
  ) {
    this.anthropic = provider === 'anthropic' ? new Anthropic({apiKey}) : null;
    this.gemini = provider === 'gemini' ? new GoogleGenAI({apiKey}) : null;
  }

  async generate(request: LlmGenerateRequest): Promise<string> {
    await logEvent({
      kind: 'llm_request',
      provider: this.provider,
      model: this.model,
      ...(request.metadata ?? {}),
    });

    let text: string;
    if (this.provider === 'anthropic') {
      text = await this.generateAnthropic(request);
    } else {
      text = await this.generateGemini(request);
    }

    await logEvent({kind: 'llm_response', provider: this.provider, model: this.model, raw: text});
    return text;
  }

  private async generateAnthropic(request: LlmGenerateRequest): Promise<string> {
    const content: ContentBlockParam[] = [{type: 'text', text: request.prompt}];
    if (request.screenshotBase64) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: request.screenshotMediaType ?? 'image/png',
          data: request.screenshotBase64,
        },
      });
    }
    const messages: MessageParam[] = [{role: 'user', content}];
    const response = await this.anthropic!.messages.create({
      model: this.model,
      max_tokens: request.maxTokens ?? 1024,
      temperature: request.temperature ?? 0,
      system: request.system,
      messages,
    });
    return response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');
  }

  private async generateGemini(request: LlmGenerateRequest): Promise<string> {
    const parts: Array<{text: string} | {inlineData: {mimeType: string; data: string}}> = [
      {text: request.prompt},
    ];
    if (request.screenshotBase64) {
      parts.push({
        inlineData: {
          mimeType: request.screenshotMediaType ?? 'image/png',
          data: request.screenshotBase64,
        },
      });
    }
    const response = await this.gemini!.models.generateContent({
      model: this.model,
      contents: [{role: 'user', parts}],
      config: {
        systemInstruction: request.system,
        maxOutputTokens: request.maxTokens ?? 1024,
        temperature: request.temperature ?? 0,
        responseMimeType: request.responseMimeType ?? 'application/json',
      },
    });
    return response.text ?? '';
  }
}

export class LocalLlmRuntime implements LlmRuntime {
  readonly provider = 'local';

  constructor(public readonly model: string) {}

  async generate(request: LlmGenerateRequest): Promise<string> {
    const responseStream = await fetch('http://localhost:8080/chat', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        prompt: request.prompt,
        provider: 'deepseek',
        metadata: {modelType: 'instant', allowedTools: ['Search']},
      }),
    }) as any;

    let buffer = '';
    let fullResponse = '';
    for await (const chunk of responseStream.body) {
      buffer += new TextDecoder().decode(chunk);
      const parts = buffer.split('\x1E');
      buffer = parts.pop()!;
      for (const part of parts) {
        if (!part.trim()) continue;
        const data = JSON.parse(part);
        fullResponse += data.text;
      }
    }
    return fullResponse;
  }
}

export class OpenAILlmRuntime implements LlmRuntime {
  readonly provider = 'openai';
  readonly model: string;

  constructor(private readonly apiKey: string, model: string) {
    this.model = model;
  }

  async generate(request: LlmGenerateRequest): Promise<string> {
    await logEvent({
      kind: 'llm_request',
      provider: this.provider,
      model: this.model,
      ...(request.metadata ?? {}),
    });

    const openai = new OpenAI({apiKey: this.apiKey});
    const response = await openai.chat.completions.create({
      model: this.model,
      messages: [
        {role: 'system', content: request.system},
        {role: 'user', content: request.prompt},
      ],
      temperature: request.temperature ?? 0,
      max_tokens: request.maxTokens ?? 1024,
    });

    const text = response.choices?.[0]?.message?.content ?? '';
    await logEvent({kind: 'llm_response', provider: this.provider, model: this.model, raw: text});
    return text;
  }
}
