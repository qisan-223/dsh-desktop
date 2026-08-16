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
import type { Context } from '@deepseek-ai/cordis';
/**
 * Resolve the vision API key from the credentials seam, then the environment.
 * @param ctx - the host context owning the (optional) credentials service.
 * @returns the API key, or `undefined` when no source supplies one.
 */
export declare function resolveVisionApiKey(ctx: Context): Promise<string | undefined>;
/**
 * Describe one image through the vision API, falling back across candidate models.
 * @param apiKey - the Zhipu platform API key.
 * @param data - raw encoded image bytes.
 * @param mediaType - the image media type (e.g. `image/png`).
 * @returns the text description produced by the first model that answers.
 * @throws when every candidate model fails.
 */
export declare function describeImage(apiKey: string, data: Uint8Array, mediaType: string): Promise<string>;
//# sourceMappingURL=vision-bridge.d.ts.map