/**
 * Vision bridge: pasted images meet a model that cannot take image input.
 *
 * Instead of refusing the prompt (the pre-bridge behavior), this module turns
 * each pasted image into a text description through the Zhipu GLM vision API
 * (OpenAI-compatible), so the prompt can still be submitted and the main model
 * can reason about the image content through the description.
 *
 * The API key resolves, in order, from:
 *  1. the credentials service reference `GLM_VISION_API_KEY`
 *     (`$DSH_HOME/.credentials.yaml` or a launching environment variable), then
 *  2. the process environment variable `GLM_VISION_API_KEY`.
 *
 * @module @deepseek-ai/dsh-host-apiproxy/vision-bridge
 */
import { request as httpsRequest } from 'node:https';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
/** OpenAI-compatible chat-completions endpoint of the Zhipu platform. */
const VISION_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
/** Candidate vision models, tried in order until one answers. */
const VISION_MODELS = ['glm-4.6v-flash', 'glm-4v-flash'];
/** The instruction the vision model receives for every pasted image. */
const DESCRIBE_PROMPT = '请客观、详细地描述这张图片的内容，包括其中的文字、物体、人物、界面布局、图表数据、错误信息等所有可读信息。直接输出描述，不要添加开场白。';
/** Upper bound for one vision API round trip; pasted images must not hang a prompt forever. */
const REQUEST_TIMEOUT_MS = 90_000;
/**
 * Resolve the vision API key from the credentials seam, then the environment.
 * @param ctx - the host context owning the (optional) credentials service.
 * @returns the API key, or `undefined` when no source supplies one.
 */
export async function resolveVisionApiKey(ctx) {
    const credentials = ctx.get('credentials');
    const fromService = credentials === undefined
        ? undefined
        : (await credentials.resolve(credentialRef('GLM_VISION_API_KEY')))?.value;
    if (fromService !== undefined && fromService.length > 0)
        return fromService;
    const fromEnv = process.env.GLM_VISION_API_KEY;
    if (fromEnv !== undefined && fromEnv.length > 0)
        return fromEnv;
    return undefined;
}
/** Extract the assistant text from a chat-completions reply body. */
function textOf(body) {
    const parsed = body;
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim().length > 0)
        return content.trim();
    if (Array.isArray(content)) {
        const joined = content
            .filter((part) => typeof part === 'object' && part !== null)
            .map(part => part.text ?? '')
            .join('');
        if (joined.trim().length > 0)
            return joined.trim();
    }
    throw new Error('vision API returned no text content');
}
/** One authenticated chat-completions call against the Zhipu vision API. */
function callVision(apiKey, model, data, mediaType) {
    return new Promise((resolvePromise, rejectPromise) => {
        const payload = JSON.stringify({
            model,
            messages: [{
                    role: 'user',
                    content: [
                        { type: 'image_url', image_url: { url: `data:${mediaType};base64,${Buffer.from(data).toString('base64')}` } },
                        { type: 'text', text: DESCRIBE_PROMPT },
                    ],
                }],
            temperature: 0.1,
            max_tokens: 1024,
            stream: false,
        });
        const req = httpsRequest(VISION_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
            timeout: REQUEST_TIMEOUT_MS,
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode !== 200) {
                    rejectPromise(new Error(`vision API HTTP ${res.statusCode}: ${raw.slice(0, 500)}`));
                    return;
                }
                try {
                    resolvePromise(textOf(JSON.parse(raw)));
                }
                catch (error) {
                    rejectPromise(error instanceof Error ? error : new Error(String(error)));
                }
            });
        });
        req.on('timeout', () => req.destroy(new Error('vision API request timed out')));
        req.on('error', rejectPromise);
        req.end(payload);
    });
}
/**
 * Describe one image through the vision API, falling back across candidate models.
 * @param apiKey - the Zhipu platform API key.
 * @param data - raw encoded image bytes.
 * @param mediaType - the image media type (e.g. `image/png`).
 * @returns the text description produced by the first model that answers.
 * @throws when every candidate model fails.
 */
export async function describeImage(apiKey, data, mediaType) {
    let lastError;
    for (const model of VISION_MODELS) {
        try {
            return await callVision(apiKey, model, data, mediaType);
        }
        catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
        }
    }
    throw new Error(`vision API failed for every candidate model: ${lastError?.message ?? 'unknown error'}`);
}
//# sourceMappingURL=vision-bridge.js.map